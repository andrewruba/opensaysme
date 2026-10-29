import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createTranscriptionSession, openAITranscription } from '../src/speech/openai.js';
import { PhraseSegmenter } from '../src/speech/phrases.js';
import type { TranscriptionPhrase } from '../src/speech/types.js';

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];
  terminate = vi.fn(() => { this.readyState = WebSocket.CLOSED; this.emit('close'); });
  send(value: string, callback: (error?: Error) => void) { this.sent.push(JSON.parse(value)); callback(); }
  receive(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}
const resolvedSession = { type: 'transcription', audio: { input: {
  format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'gpt-live-transcribe' }, turn_detection: null,
} } };
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((fn) => fn()); vi.useRealTimers(); });
function fixture() {
  const socket = new Socket(); const controller = new AbortController(); const partials: string[] = [];
  const phrases: TranscriptionPhrase[] = [];
  const session = createTranscriptionSession({ apiKey: 'fixture-private-key', model: 'gpt-live-transcribe',
    signal: controller.signal, onPartial: (text) => partials.push(text), onPhrase: (phrase) => phrases.push(phrase) }, () => socket as unknown as WebSocket);
  cleanups.push(() => session.close());
  socket.emit('open');
  const ready = () => socket.receive({ type: 'session.updated', session: resolvedSession });
  return { socket, controller, partials, phrases, session, ready };
}
function pcm(ms: number, amplitude = 1200): Buffer {
  const data = Buffer.alloc(ms * 48);
  for (let i = 0; i < data.length; i += 2) data.writeInt16LE((i % 4 ? -1 : 1) * amplitude, i);
  return data;
}
const phraseAudio = () => Buffer.concat([pcm(200), pcm(400, 0)]);
const commitAck = (id: string, previous: string | null = null) => ({ type: 'input_audio_buffer.committed', item_id: id, previous_item_id: previous });
const completion = (id: string, transcript: string) => ({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript });

describe('phrase segmentation', () => {
  it('keeps exact PCM intervals independent of native chunk boundaries', () => {
    const input = Buffer.concat([phraseAudio(), pcm(4200)]);
    const segment = (chunkBytes: number) => {
      const segmenter = new PhraseSegmenter();
      const parts = [];
      for (let offset = 0; offset < input.length; offset += chunkBytes) parts.push(...segmenter.append(input.subarray(offset, offset + chunkBytes)));
      expect(Buffer.concat(parts.map((part) => part.pcm))).toEqual(input);
      return [...parts.flatMap((part) => part.interval ? [part.interval] : []), segmenter.finish()];
    };
    expect(segment(634)).toEqual(segment(input.length));
    expect(segment(4800)).toEqual([
      { startSample: 0, endSample: 14_400, boundary: 'pause' },
      { startSample: 14_400, endSample: 110_400, boundary: 'limit' },
      { startSample: 110_400, endSample: 115_200, boundary: 'stop' },
    ]);
  });

  it('bounds continuous speech and silence without treating silence as word timing', () => {
    for (const amplitude of [0, 1200]) {
      const segmenter = new PhraseSegmenter();
      const parts = segmenter.append(pcm(8000, amplitude));
      expect(parts.map((part) => part.interval)).toEqual([
        { startSample: 0, endSample: 96_000, boundary: 'limit' },
        { startSample: 96_000, endSample: 192_000, boundary: 'limit' },
      ]);
      expect(segmenter.finish()).toBeUndefined();
    }
  });
});

describe('streaming transcription protocol', () => {
  it('buffers connection startup, streams before commit, and matches completion to its item', async () => {
    const f = fixture();
    expect(f.socket.sent[0]).toEqual({ type: 'session.update', session: {
      ...resolvedSession, audio: { input: { ...resolvedSession.audio.input,
        transcription: { model: 'gpt-live-transcribe', delay: 'low' } } },
    } });
    f.session.append(Buffer.alloc(4800, 1));
    expect(f.socket.sent).toHaveLength(1);
    f.ready(); await f.session.ready;
    expect(f.socket.sent[1]?.type).toBe('input_audio_buffer.append');
    f.socket.receive({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'turn1', delta: 'hello' });
    expect(f.partials).toEqual(['hello']);
    f.session.append(Buffer.alloc(4800)); f.session.commit();
    expect(f.socket.sent.at(-1)).toEqual({ type: 'input_audio_buffer.commit' });
    // Completion can be held until the explicit commit acknowledgment arrives.
    f.socket.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'turn1', transcript: 'hello world' });
    f.socket.receive({ type: 'input_audio_buffer.committed', item_id: 'turn1' });
    await expect(f.session.finished).resolves.toBe('hello world');
    expect(f.phrases).toEqual([{ id: 'turn1', text: 'hello world', startSample: 0, endSample: 4800, boundary: 'stop' }]);
    expect(f.socket.terminate).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.socket.sent)).not.toContain('fixture-private-key');
  });

  it('defers an early stop until the connection is configured', async () => {
    const f = fixture(); f.session.append(Buffer.alloc(4800)); f.session.commit();
    expect(f.socket.sent).toHaveLength(1); f.ready();
    expect(f.socket.sent.map((value) => value.type)).toEqual(['session.update', 'input_audio_buffer.append', 'input_audio_buffer.commit']);
    f.socket.receive({ type: 'input_audio_buffer.committed', item_id: 'one' });
    f.socket.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: '' });
    await expect(f.session.finished).resolves.toBe('');
  });

  it('finalizes bounded phrases during capture and orders delayed completions by capture', async () => {
    const f = fixture(); f.ready();
    f.session.append(phraseAudio());
    expect(f.socket.sent.at(-1)?.type).toBe('input_audio_buffer.commit');
    f.socket.receive(commitAck('first'));
    f.session.append(pcm(300)); f.session.commit();
    f.socket.receive(commitAck('second', 'first'));
    let finished = false;
    void f.session.finished.then(() => { finished = true; });
    f.socket.receive(completion('second', 'over here'));
    expect(f.phrases).toEqual([]);
    await Promise.resolve(); expect(finished).toBe(false);
    f.socket.receive(completion('first', 'use this'));
    await expect(f.session.finished).resolves.toBe('use this over here');
    expect(f.phrases).toEqual([
      { id: 'first', text: 'use this', startSample: 0, endSample: 14_400, boundary: 'pause' },
      { id: 'second', text: 'over here', startSample: 14_400, endSample: 21_600, boundary: 'stop' },
    ]);
    expect(f.partials.at(-1)).toBe('use this over here');
  });

  it('publishes a completed phrase before stopping without ending the voice turn', async () => {
    const f = fixture(); f.ready(); f.session.append(phraseAudio());
    f.socket.receive(commitAck('first'));
    f.socket.receive(completion('first', 'use this'));
    expect(f.phrases).toHaveLength(1);
    expect(f.socket.terminate).not.toHaveBeenCalled();
    // Stop exactly at the pause boundary: no empty final commit or extra wait.
    f.session.commit();
    await expect(f.session.finished).resolves.toBe('use this');
    expect(f.socket.sent.filter((event) => event.type === 'input_audio_buffer.commit')).toHaveLength(1);
  });

  it('preserves a short final fragment without extending its capture interval', async () => {
    const f = fixture(); f.ready(); f.session.append(phraseAudio());
    f.socket.receive(commitAck('first')); f.socket.receive(completion('first', 'this'));
    f.session.append(pcm(20)); f.session.commit();
    const append = f.socket.sent.filter((event) => event.type === 'input_audio_buffer.append');
    const sentBytes = append.reduce((sum, event) => sum + Buffer.from(event.audio as string, 'base64').length, 0);
    expect(sentBytes).toBe(700 * 48); // 620 ms captured plus 80 ms silent padding.
    expect(Buffer.from(append.at(-1)!.audio as string, 'base64')).toEqual(Buffer.alloc(80 * 48));
    f.socket.receive(commitAck('second', 'first')); f.socket.receive(completion('second', 'too'));
    await expect(f.session.finished).resolves.toBe('this too');
    expect(f.phrases.at(-1)).toEqual({ id: 'second', text: 'too', startSample: 14_400, endSample: 14_880, boundary: 'stop' });
  });

  it('preserves startup audio/commit ordering and matches completions arriving before ACKs', async () => {
    const f = fixture();
    f.session.append(phraseAudio()); f.session.append(pcm(200)); f.session.commit(); f.ready();
    expect(f.socket.sent.map((event) => event.type)).toEqual([
      'session.update', 'input_audio_buffer.append', 'input_audio_buffer.commit', 'input_audio_buffer.append', 'input_audio_buffer.commit',
    ]);
    f.socket.receive(completion('second', 'destination'));
    f.socket.receive(completion('first', 'source'));
    expect(f.phrases).toEqual([]);
    f.socket.receive(commitAck('first'));
    expect(f.phrases).toHaveLength(1);
    f.socket.receive(commitAck('second', 'first'));
    await expect(f.session.finished).resolves.toBe('source destination');
  });

  it('corrects partial text in place and does not append later items in arrival order', async () => {
    const f = fixture(); f.ready(); f.session.append(phraseAudio()); f.socket.receive(commitAck('first'));
    f.socket.receive({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'first', delta: 'us' });
    f.session.append(pcm(200)); f.session.commit(); f.socket.receive(commitAck('second', 'first'));
    f.socket.receive({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'second', delta: 'over' });
    expect(f.partials.at(-1)).toBe('us over');
    f.socket.receive(completion('first', 'use this'));
    expect(f.partials.at(-1)).toBe('use this over');
    f.socket.receive(completion('second', 'over here'));
    await expect(f.session.finished).resolves.toBe('use this over here');
  });

  it('returns an empty transcript for silence without inventing word timestamps', async () => {
    const f = fixture(); f.ready(); f.session.append(pcm(1000, 0)); f.session.commit();
    f.socket.receive(commitAck('silent')); f.socket.receive(completion('silent', ''));
    await expect(f.session.finished).resolves.toBe('');
    expect(f.phrases).toEqual([{ id: 'silent', text: '', startSample: 0, endSample: 24_000, boundary: 'stop' }]);
  });

  it('keeps phrase sample intervals stable despite delayed provider delivery', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.ready(); f.session.append(phraseAudio()); f.session.commit();
    await vi.advanceTimersByTimeAsync(2500);
    f.socket.receive(commitAck('late')); f.socket.receive(completion('late', 'this'));
    await expect(f.session.finished).resolves.toBe('this');
    expect(f.phrases[0]).toMatchObject({ startSample: 0, endSample: 14_400 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out missing phrase ACKs or completions and clears outstanding timers', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.ready(); f.session.append(phraseAudio()); f.session.append(phraseAudio()); f.session.commit();
    f.socket.receive(completion('first', 'hello'));
    const failure = expect(f.session.finished).rejects.toThrow('15 seconds');
    await vi.advanceTimersByTimeAsync(15000); await failure;
    expect(f.phrases).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an inconsistent commit chain rather than attaching words to wrong audio', async () => {
    const f = fixture(); f.ready(); f.session.append(phraseAudio()); f.session.append(phraseAudio()); f.session.commit();
    f.socket.receive(commitAck('second', 'unknown'));
    await expect(f.session.finished).rejects.toThrow('invalid transcription event');
    expect(f.phrases).toEqual([]);
  });

  it('cancels already streaming phrases and ignores late completions', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.ready(); f.session.append(phraseAudio()); f.session.append(phraseAudio());
    f.socket.receive(commitAck('first'));
    f.controller.abort();
    f.socket.receive(completion('first', 'must not appear'));
    await expect(f.session.finished).rejects.toThrow('cancelled');
    expect(f.phrases).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a mismatched negotiated format before sending audio', async () => {
    const f = fixture(); f.session.append(Buffer.alloc(4800));
    f.socket.receive({ type: 'session.updated', session: { type: 'transcription' } });
    await expect(f.session.finished).rejects.toThrow('invalid transcription event');
    expect(f.socket.sent).toHaveLength(1);
  });

  it('cancels pending audio and ignores late provider events', async () => {
    const f = fixture(); f.session.append(Buffer.alloc(4800)); f.controller.abort(); f.ready();
    f.socket.receive({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'old', delta: 'late' });
    await expect(f.session.finished).rejects.toThrow('cancelled');
    expect(f.partials).toEqual([]); expect(f.phrases).toEqual([]); expect(f.socket.sent).toHaveLength(1);
  });

  it('rejects a transcript for another item', async () => {
    const f = fixture(); f.ready(); f.session.append(Buffer.alloc(4800)); f.session.commit();
    f.socket.receive({ type: 'input_audio_buffer.committed', item_id: 'expected' });
    f.socket.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'wrong', transcript: 'private text' });
    await expect(f.session.finished).rejects.toThrow('invalid transcription event');
  });

  it('never echoes provider error payloads', async () => {
    const f = fixture();
    f.socket.receive({ type: 'error', error: { message: 'private-key or transcript' } });
    await expect(f.session.finished).rejects.toThrow('rejected the request');
    await expect(f.session.finished).rejects.not.toThrow('private-key');
  });

  it('bounds pending audio and socket backpressure', async () => {
    const pending = fixture(); pending.session.append(Buffer.alloc(480002));
    await expect(pending.session.finished).rejects.toThrow('buffering limit');
    const slow = fixture(); slow.ready(); slow.socket.bufferedAmount = 512 * 1024 - 100;
    slow.session.append(Buffer.alloc(4800));
    await expect(slow.session.finished).rejects.toThrow('buffering limit');
  });

  it('bounds connection and finalization waits without leaking a timer on send failure', async () => {
    vi.useFakeTimers();
    const connecting = fixture();
    const connectFailure = expect(connecting.session.finished).rejects.toThrow('8 seconds');
    await vi.advanceTimersByTimeAsync(8000); await connectFailure;
    const waiting = fixture(); waiting.ready(); waiting.session.append(Buffer.alloc(4800)); waiting.session.commit();
    const finalFailure = expect(waiting.session.finished).rejects.toThrow('15 seconds');
    await vi.advanceTimersByTimeAsync(15000); await finalFailure;
    const slow = fixture(); slow.ready(); slow.session.append(Buffer.alloc(4800)); slow.socket.bufferedAmount = 600000;
    slow.session.commit(); await expect(slow.session.finished).rejects.toThrow('buffering limit');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes and clears phrase timers when the socket throws during a send', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.ready(); f.session.append(pcm(100));
    f.socket.send = () => { throw new Error('private transport details'); };
    f.session.commit();
    await expect(f.session.finished).rejects.toThrow('Could not send audio');
    await expect(f.session.finished).rejects.not.toThrow('private transport');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects recordings too short to commit and malformed PCM', async () => {
    const short = fixture(); short.ready(); short.session.append(Buffer.alloc(100)); short.session.commit();
    await expect(short.session.finished).rejects.toThrow('too short');
    const odd = fixture(); odd.session.append(Buffer.alloc(3));
    await expect(odd.session.finished).rejects.toThrow('invalid PCM16');
  });

  it('validates the selected model and missing key before opening a connection', () => {
    const base = { signal: new AbortController().signal, onPartial: () => {}, onPhrase: () => {} };
    expect(() => openAITranscription({ ...base, model: 'file-only-model', apiKey: 'fixture' })).toThrow('requires speech.model');
    expect(() => openAITranscription({ ...base, model: 'gpt-live-transcribe', apiKey: '' })).toThrow('missing');
  });
});
