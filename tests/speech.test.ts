import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createTranscriptionSession, openAITranscription } from '../src/speech/openai.js';

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
  const socket = new Socket(); const controller = new AbortController(); const deltas: string[] = [];
  const session = createTranscriptionSession({ apiKey: 'fixture-private-key', model: 'gpt-live-transcribe',
    signal: controller.signal, onDelta: (text) => deltas.push(text) }, () => socket as unknown as WebSocket);
  cleanups.push(() => session.close());
  socket.emit('open');
  const ready = () => socket.receive({ type: 'session.updated', session: resolvedSession });
  return { socket, controller, deltas, session, ready };
}

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
    expect(f.deltas).toEqual(['hello']);
    f.session.append(Buffer.alloc(4800)); f.session.commit();
    expect(f.socket.sent.at(-1)).toEqual({ type: 'input_audio_buffer.commit' });
    // Completion can be held until the explicit commit acknowledgment arrives.
    f.socket.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'turn1', transcript: 'hello world' });
    f.socket.receive({ type: 'input_audio_buffer.committed', item_id: 'turn1' });
    await expect(f.session.finished).resolves.toBe('hello world');
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
    expect(f.deltas).toEqual([]); expect(f.socket.sent).toHaveLength(1);
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

  it('rejects recordings too short to commit and malformed PCM', async () => {
    const short = fixture(); short.ready(); short.session.append(Buffer.alloc(100)); short.session.commit();
    await expect(short.session.finished).rejects.toThrow('too short');
    const odd = fixture(); odd.session.append(Buffer.alloc(3));
    await expect(odd.session.finished).rejects.toThrow('invalid PCM16');
  });

  it('validates the selected model and missing key before opening a connection', () => {
    const base = { signal: new AbortController().signal, onDelta: () => {} };
    expect(() => openAITranscription({ ...base, model: 'file-only-model', apiKey: 'fixture' })).toThrow('requires speech.model');
    expect(() => openAITranscription({ ...base, model: 'gpt-live-transcribe', apiKey: '' })).toThrow('missing');
  });
});
