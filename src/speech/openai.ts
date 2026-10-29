import WebSocket from 'ws';
import { z } from 'zod';
import type { TranscriptionOptions, TranscriptionSession } from './types.js';

export const streamingModel = 'gpt-live-transcribe';
const endpoint = 'wss://api.openai.com/v1/realtime?intent=transcription';
const item = z.string().min(1).max(256);
const deltaSchema = z.object({ item_id: item, delta: z.string().max(65_536) });
const completionSchema = z.object({ item_id: item, transcript: z.string().max(65_536) });
const commitSchema = z.object({ item_id: item });

// One connection per deliberate utterance prevents previous speech/context from
// carrying into later turns. Connect in parallel with mic/context startup.
export function openAITranscription(options: TranscriptionOptions): TranscriptionSession {
  if (options.model !== streamingModel) throw new Error(`Live transcription currently requires speech.model "${streamingModel}". Update your configuration.`);
  if (!options.apiKey.trim()) throw new Error('The configured speech API key is missing.');
  return createTranscriptionSession(options, () => new WebSocket(endpoint, {
    headers: { Authorization: `Bearer ${options.apiKey}` },
    maxPayload: 1024 * 1024,
    handshakeTimeout: 8_000,
    followRedirects: false,
  }));
}

// Injectable transport lets tests exercise the real protocol without credentials.
export function createTranscriptionSession(options: TranscriptionOptions, connect: () => WebSocket): TranscriptionSession {
  let socket: WebSocket;
  let ended = false;
  let configured = false;
  let committing = false;
  let commitSent = false;
  let totalBytes = 0;
  let pendingBytes = 0;
  let transcriptBytes = 0;
  const pending: Buffer[] = [];
  let observedItem: string | undefined;
  let committedItem: string | undefined;
  let completion: z.infer<typeof completionSchema> | undefined;
  let finalDeadline: NodeJS.Timeout | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveFinished!: (text: string) => void;
  let rejectFinished!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const finished = new Promise<string>((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject; });
  void ready.catch(() => {});
  void finished.catch(() => {});
  const connectionDeadline = setTimeout(() => fail('Speech provider did not become ready within 8 seconds.'), 8_000);

  function cleanup() {
    clearTimeout(connectionDeadline);
    clearTimeout(finalDeadline);
    options.signal.removeEventListener('abort', abort);
    for (const chunk of pending) chunk.fill(0);
    pending.length = 0;
    pendingBytes = 0;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
  function fail(message: string) {
    if (ended) return;
    ended = true;
    const error = new Error(message);
    rejectReady(error);
    rejectFinished(error);
    cleanup();
  }
  function abort() { fail('Transcription cancelled.'); }
  function send(value: unknown) {
    if (ended) return;
    const payload = JSON.stringify(value);
    if (socket.bufferedAmount + Buffer.byteLength(payload) > 512 * 1024) { fail('Speech connection is too slow; audio buffering limit reached.'); return; }
    socket.send(payload, (error) => { if (error) fail('Could not send audio to the speech provider.'); });
  }
  function appendNow(chunk: Buffer) { send({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') }); }
  function sendCommit() {
    if (!configured || !committing || commitSent || ended) return;
    commitSent = true;
    finalDeadline = setTimeout(() => fail('Speech provider did not finalize the transcript within 15 seconds.'), 15_000);
    send({ type: 'input_audio_buffer.commit' });
  }
  function acceptItem(id: string) {
    if (observedItem && observedItem !== id) throw new Error('Unexpected transcript item.');
    observedItem = id;
  }
  function finishIfReady() {
    if (!completion || !committedItem || ended) return;
    if (completion.item_id !== committedItem) { fail('Speech provider returned a transcript for an unexpected turn.'); return; }
    ended = true;
    resolveFinished(completion.transcript);
    cleanup();
  }
  try {
    if (options.signal.aborted) throw new Error('cancelled');
    socket = connect();
    options.signal.addEventListener('abort', abort, { once: true });
    socket.on('open', () => send({
      type: 'session.update',
      session: { type: 'transcription', audio: { input: {
        format: { type: 'audio/pcm', rate: 24_000 },
        transcription: { model: options.model, delay: 'low' },
        turn_detection: null,
      } } },
    }));
    socket.on('message', (raw) => {
      if (ended) return;
      try {
        const event: unknown = JSON.parse(raw.toString());
        const header = z.object({ type: z.string() }).parse(event);
        switch (header.type) {
          case 'session.updated': {
            z.object({ session: z.object({ type: z.literal('transcription'), audio: z.object({ input: z.object({
              format: z.object({ type: z.literal('audio/pcm'), rate: z.literal(24_000) }),
              transcription: z.object({ model: z.literal(options.model) }),
              turn_detection: z.null(),
            }) }) }) }).parse(event);
            if (configured) break;
            configured = true;
            clearTimeout(connectionDeadline);
            for (const chunk of pending) { appendNow(chunk); chunk.fill(0); }
            pending.length = 0;
            pendingBytes = 0;
            resolveReady();
            sendCommit();
            break;
          }
          case 'input_audio_buffer.committed': {
            if (!commitSent) throw new Error('Unexpected commit.');
            const value = commitSchema.parse(event);
            acceptItem(value.item_id);
            committedItem = value.item_id;
            finishIfReady();
            break;
          }
          case 'conversation.item.input_audio_transcription.delta': {
            const value = deltaSchema.parse(event);
            acceptItem(value.item_id);
            transcriptBytes += Buffer.byteLength(value.delta);
            if (transcriptBytes > 65_536) throw new Error('Transcript too large.');
            options.onDelta(value.delta);
            break;
          }
          case 'conversation.item.input_audio_transcription.completed': {
            if (!commitSent) throw new Error('Premature completion.');
            completion = completionSchema.parse(event);
            acceptItem(completion.item_id);
            finishIfReady();
            break;
          }
          case 'error':
          case 'conversation.item.input_audio_transcription.failed':
            fail('Speech provider rejected the request. Check the API key, model access, quota, and network.');
            break;
        }
      } catch { fail('Speech provider returned an invalid transcription event.'); }
    });
    socket.on('error', () => fail('Speech connection failed. Check the API key, model access, and network.'));
    socket.on('close', () => { if (!ended) fail('Speech connection closed before transcription finished.'); });
  } catch { fail(options.signal.aborted ? 'Transcription cancelled.' : 'Could not open the speech connection.'); }

  return {
    ready, finished,
    append(pcm) {
      if (ended) return;
      if (committing) { fail('Audio arrived after the speech turn was committed.'); return; }
      if (!pcm.length || pcm.length % 2 !== 0) { fail('Microphone returned invalid PCM16 audio.'); return; }
      totalBytes += pcm.length;
      if (totalBytes > 120 * 48_000) { fail('Voice turn exceeded its two-minute audio limit.'); return; }
      if (configured) appendNow(pcm);
      else {
        if (pendingBytes + pcm.length > 480_000) { fail('Speech connection is too slow; audio buffering limit reached.'); return; }
        pending.push(Buffer.from(pcm));
        pendingBytes += pcm.length;
      }
    },
    commit() {
      if (ended || committing) return;
      if (totalBytes < 4_800) { fail('Recording was too short. Speak for at least a moment before stopping.'); return; }
      committing = true;
      sendCommit();
    },
    close() { if (!ended) fail('Transcription cancelled.'); },
  };
}
