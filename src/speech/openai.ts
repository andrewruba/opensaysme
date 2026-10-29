import WebSocket from 'ws';
import { z } from 'zod';
import { PhraseSegmenter, type PhraseInterval } from './phrases.js';
import type { TranscriptionOptions, TranscriptionSession } from './types.js';

export const streamingModel = 'gpt-live-transcribe';
const endpoint = 'wss://api.openai.com/v1/realtime?intent=transcription';
const item = z.string().min(1).max(256);
const deltaSchema = z.object({ item_id: item, delta: z.string().max(65_536) });
const completionSchema = z.object({ item_id: item, transcript: z.string().max(65_536) });
const commitSchema = z.object({ item_id: item, previous_item_id: item.nullable().optional() });
interface Segment {
  interval?: PhraseInterval;
  itemId?: string;
  sentAudio: boolean;
  committed: boolean;
  deadline?: NodeJS.Timeout;
}
interface TranscriptItem { partial: string; final?: string }
type Pending = { pcm: Buffer; segment: Segment } | { commit: Segment };

// One connection per activated turn. Internal phrase commits overlap ongoing
// capture; no second transcription/alignment pass is needed after the stop tap.
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

function joinText(parts: string[]): string {
  return parts.reduce((text, next) => text + (text && next && !/\s$/.test(text) && !/^\s/.test(next) ? ' ' : '') + next, '');
}

// Injectable transport exercises actual item ordering without credentials.
export function createTranscriptionSession(options: TranscriptionOptions, connect: () => WebSocket): TranscriptionSession {
  let socket: WebSocket;
  let ended = false;
  let configured = false;
  let stopping = false;
  let totalBytes = 0;
  let pendingBytes = 0;
  let deltaBytes = 0;
  let finalBytes = 0;
  let publishedPhrases = 0;
  let lastPartial = '';
  let lastCommittedItem: string | null = null;
  const segmenter = new PhraseSegmenter();
  const segments: Segment[] = [];
  const awaitingAck: Segment[] = [];
  const items = new Map<string, TranscriptItem>();
  const pending: Pending[] = [];
  let current: Segment = nextSegment();
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveFinished!: (text: string) => void;
  let rejectFinished!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const finished = new Promise<string>((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject; });
  void ready.catch(() => {});
  void finished.catch(() => {});
  const connectionDeadline = setTimeout(() => fail('Speech provider did not become ready within 8 seconds.'), 8_000);

  function nextSegment(): Segment {
    const segment = { sentAudio: false, committed: false };
    segments.push(segment);
    return segment;
  }
  function cleanup() {
    clearTimeout(connectionDeadline);
    for (const segment of segments) clearTimeout(segment.deadline);
    options.signal.removeEventListener('abort', abort);
    for (const entry of pending) if ('pcm' in entry) entry.pcm.fill(0);
    pending.length = 0;
    pendingBytes = 0;
    segments.length = 0;
    awaitingAck.length = 0;
    items.clear();
    lastPartial = '';
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
    if (socket.bufferedAmount + Buffer.byteLength(payload) > 512 * 1024) {
      fail('Speech connection is too slow; audio buffering limit reached.'); return;
    }
    try { socket.send(payload, (error) => { if (error) fail('Could not send audio to the speech provider.'); }); }
    catch { fail('Could not send audio to the speech provider.'); }
  }
  function sendAudio(pcm: Buffer, segment: Segment) {
    segment.sentAudio = true;
    send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
  }
  function appendAudio(pcm: Buffer, segment: Segment) {
    if (configured) sendAudio(pcm, segment);
    else {
      if (pendingBytes + pcm.length > 480_000) { fail('Speech connection is too slow; audio buffering limit reached.'); return; }
      pending.push({ pcm: Buffer.from(pcm), segment }); pendingBytes += pcm.length;
    }
  }
  function sendCommit(segment: Segment) {
    if (ended) return;
    segment.committed = true;
    awaitingAck.push(segment);
    segment.deadline = setTimeout(() => fail('Speech provider did not finalize a phrase within 15 seconds.'), 15_000);
    send({ type: 'input_audio_buffer.commit' });
  }
  function commitInterval(interval: PhraseInterval) {
    current.interval = interval;
    if (configured) sendCommit(current);
    else pending.push({ commit: current });
    if (!ended) current = nextSegment();
    if (segments.length > 513) fail('Speech turn exceeded its phrase limit.');
  }
  function unassignedSegments() { return segments.filter((segment) => segment.sentAudio && !segment.itemId); }
  function unassignedItems() {
    const assigned = new Set(segments.flatMap((segment) => segment.itemId ? [segment.itemId] : []));
    return [...items.entries()].filter(([id]) => !assigned.has(id));
  }
  function transcriptItem(id: string, complete: boolean): TranscriptItem {
    const existing = items.get(id);
    if (existing) {
      if (existing.final !== undefined) throw new Error('Transcript item already completed.');
      if (complete && !segments.some((segment) => segment.committed && (!segment.itemId || segment.itemId === id))) {
        throw new Error('Premature completion.');
      }
      return existing;
    }
    const assigned = segments.find((segment) => segment.itemId === id);
    const available = unassignedSegments();
    if (!assigned && (!available.length || (complete && !available.some((segment) => segment.committed)))) throw new Error('Unexpected transcript item.');
    const result: TranscriptItem = { partial: '' };
    items.set(id, result);
    if (unassignedItems().length > available.length) throw new Error('Unexpected transcript item.');
    return result;
  }
  function publish() {
    // An uncommitted live item has no ACK yet. Display it only when there is one
    // possible slot; ambiguous late items wait for their ACK rather than guess.
    const unknown = unassignedItems();
    const available = unassignedSegments();
    const parts: string[] = [];
    for (const segment of segments) {
      const value = segment.itemId ? items.get(segment.itemId)
        : unknown.length === 1 && available.length === 1 && available[0] === segment ? unknown[0]![1] : undefined;
      if (!value || (!value.partial && value.final === undefined)) break;
      parts.push(value.final ?? value.partial);
    }
    const partial = joinText(parts);
    if (Buffer.byteLength(partial) > 65_536) throw new Error('Transcript too large.');
    if (partial !== lastPartial) { lastPartial = partial; options.onPartial(partial); }
    if (ended) return;
    // Final phrases are delivered in capture order even if provider completion
    // order differs. Their intervals never depend on when network events arrive.
    while (publishedPhrases < segments.length) {
      const segment = segments[publishedPhrases]!;
      const value = segment.itemId ? items.get(segment.itemId) : undefined;
      if (!segment.interval || !segment.itemId || value?.final === undefined) break;
      clearTimeout(segment.deadline);
      publishedPhrases++;
      options.onPhrase({ id: segment.itemId, text: value.final, ...segment.interval });
      if (ended) return;
    }
    if (stopping && publishedPhrases === segments.filter((segment) => segment.interval).length) {
      const text = joinText(segments.flatMap((segment) => segment.itemId ? [items.get(segment.itemId)!.final!] : []));
      ended = true;
      resolveFinished(text);
      cleanup();
    }
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
            for (const entry of pending) {
              if (ended) break;
              if ('pcm' in entry) { sendAudio(entry.pcm, entry.segment); entry.pcm.fill(0); }
              else sendCommit(entry.commit);
            }
            pending.length = 0;
            pendingBytes = 0;
            if (!ended) resolveReady();
            break;
          }
          case 'input_audio_buffer.committed': {
            const value = commitSchema.parse(event);
            const segment = awaitingAck.shift();
            if (!segment || segments.some((other) => other.itemId === value.item_id)
              || (value.previous_item_id !== undefined && value.previous_item_id !== lastCommittedItem)) throw new Error('Unexpected commit.');
            segment.itemId = value.item_id;
            lastCommittedItem = value.item_id;
            if (unassignedItems().length > unassignedSegments().length) throw new Error('Unexpected transcript item.');
            if (items.get(value.item_id)?.final !== undefined) clearTimeout(segment.deadline);
            publish();
            break;
          }
          case 'conversation.item.input_audio_transcription.delta': {
            const value = deltaSchema.parse(event);
            deltaBytes += Buffer.byteLength(value.delta);
            if (deltaBytes > 65_536) throw new Error('Transcript too large.');
            transcriptItem(value.item_id, false).partial += value.delta;
            publish();
            break;
          }
          case 'conversation.item.input_audio_transcription.completed': {
            const value = completionSchema.parse(event);
            finalBytes += Buffer.byteLength(value.transcript);
            if (finalBytes > 65_536) throw new Error('Transcript too large.');
            transcriptItem(value.item_id, true).final = value.transcript;
            // Completion can precede its commit ACK. Keep the deadline until both
            // arrive, but do not time out a completed item waiting behind another.
            const segment = segments.find((entry) => entry.itemId === value.item_id);
            if (segment) clearTimeout(segment.deadline);
            publish();
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
      if (stopping) { fail('Audio arrived after the speech turn was committed.'); return; }
      if (!pcm.length || pcm.length % 2 !== 0) { fail('Microphone returned invalid PCM16 audio.'); return; }
      totalBytes += pcm.length;
      if (totalBytes > 120 * 48_000) { fail('Voice turn exceeded its two-minute audio limit.'); return; }
      if (!configured && pendingBytes + pcm.length > 480_000) { fail('Speech connection is too slow; audio buffering limit reached.'); return; }
      for (const part of segmenter.append(pcm)) {
        if (ended) return;
        appendAudio(part.pcm, current);
        if (ended) return;
        if (part.interval) commitInterval(part.interval);
      }
    },
    commit() {
      if (ended || stopping) return;
      if (totalBytes < 4_800) { fail('Recording was too short. Speak for at least a moment before stopping.'); return; }
      stopping = true;
      const interval = segmenter.finish();
      if (interval) {
        // The API requires >=100 ms per commit. Preserve a short final fragment
        // with silence padding, but never extend its captured sample interval.
        const padding = 2_400 - (interval.endSample - interval.startSample);
        if (padding > 0) appendAudio(Buffer.alloc(padding * 2), current);
        if (ended) return;
        commitInterval(interval);
      }
      if (!ended) publish();
    },
    close() { if (!ended) fail('Transcription cancelled.'); },
  };
}
