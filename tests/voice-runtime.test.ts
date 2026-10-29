import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import type { ReasoningFactory } from '../src/reasoning/types.js';
import { VoiceRuntime, type VoiceOutput } from '../src/runtime.js';
import type { NativeVoiceCommand, DesktopContext } from '../src/desktop/voice-types.js';
import type { ScreenFrameCapture } from '../src/desktop/visual-types.js';
import type { TranscriptionOptions, TranscriptionSession } from '../src/speech/types.js';

const context: DesktopContext = { platform: 'test', capturedAt: '2026-10-28T00:00:00.000Z',
  activeWindow: { id: 'one', application: 'Editor' }, selectedText: 'original selection',
  pointer: { x: 12, y: 30, window: { id: 'two', application: 'Terminal' } }, warnings: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const reason: ReasoningFactory = async () => 'Which window?';
const runtimes: VoiceRuntime[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.close(); vi.useRealTimers(); });
function fixture(capture: (signal: AbortSignal) => Promise<DesktopContext> = async () => ({ ...structuredClone(context), capturedAt: new Date().toISOString() }),
  interpret: ReasoningFactory = reason, captureFrame: () => Promise<ScreenFrameCapture> = async () => { throw new Error('no screen'); }) {
  let clock = 0;
  const commands: NativeVoiceCommand[] = [];
  const outputs: VoiceOutput[] = [];
  const sessions: Array<{ options: TranscriptionOptions; ready: ReturnType<typeof deferred<void>>;
    final: ReturnType<typeof deferred<string>>; audio: Buffer[]; commit: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  const runtime = new VoiceRuntime({
    input: { ready: Promise.resolve(), done: new Promise(() => {}), send: (command) => commands.push(command), close: async () => {} },
    apiKey: 'fixture-key', model: 'fixture-model', captureContext: capture,
    captureFrame, reason: interpret,
    now: () => clock, emit: (output) => outputs.push(output),
    transcribe: (options): TranscriptionSession => {
      const ready = deferred<void>(); const final = deferred<string>();
      const audio: Buffer[] = []; const commit = vi.fn(); const close = vi.fn();
      sessions.push({ options, ready, final, audio, commit, close });
      return { ready: ready.promise, finished: final.promise, append: (chunk) => audio.push(Buffer.from(chunk)), commit, close };
    },
  });
  runtimes.push(runtime);
  return { runtime, commands, outputs, sessions, time: (value: number) => { clock = value; },
    id: () => { const command = commands.findLast((value) => value.type === 'start'); if (!command || !('turnId' in command)) throw new Error('no turn'); return command.turnId; } };
}
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

describe('live voice turn lifecycle', () => {
  it('pairs a complete phrase with full-frame trails, publishes text and metadata, and releases images', async () => {
    const data = (await sharp({ create: { width: 100, height: 100, channels: 3, background: 'white' } }).jpeg().toBuffer()).toString('base64');
    const epoch = Date.parse('2026-10-28T12:00:00Z');
    vi.useFakeTimers({ now: epoch });
    let request: Parameters<ReasoningFactory>[0] | undefined;
    let received: Parameters<ReasoningFactory>[0]['visual'] | undefined;
    const f = fixture(undefined, async (input) => {
      request = input;
      received = structuredClone(input.visual);
      expect(input.history.frames[0]?.image.data).toBe(data);
      return 'The number is 42.';
    }, async () => ({ capturedAt: new Date().toISOString(), display: { id: 'display', bounds: { x: 0, y: 0, width: 200, height: 200 } },
      image: { mimeType: 'image/jpeg', width: 100, height: 100, data }, warnings: [] }));
    f.runtime.toggle(); const id = f.id(); await flush();
    f.runtime.handle({ type: 'audio-started', turnId: id });
    for (const atMs of [100, 200]) {
      f.time(atMs);
      f.runtime.handle({ type: 'pointer', turnId: id, capturedAt: new Date(epoch + atMs).toISOString(), x: atMs / 2, y: 80, displayId: 'display' });
    }
    f.time(300); f.runtime.handle({ type: 'audio', turnId: id, capturedAt: new Date(epoch + 100).toISOString(),
      startSample: 0, timing: 'device', data: Buffer.alloc(4800).toString('base64') });
    f.time(600); f.runtime.toggle(); f.runtime.handle({ type: 'audio-stopped', turnId: id });
    // The final phrase arrives after capture stops and still joins the correct frame.
    f.time(620); f.sessions[0]!.options.onPhrase({ id: 'p1', text: 'What number is this?', startSample: 0, endSample: 2400, boundary: 'stop' });
    f.sessions[0]!.final.resolve('What number is this?');
    await vi.waitFor(() => expect(f.outputs.some((output) => output.type === 'result')).toBe(true));
    const result = f.outputs.find((output) => output.type === 'result');
    expect(result).toMatchObject({ response: 'The number is 42.', visualContext: { frames: [{ frameId: 'f1', phraseIds: ['p1'],
      trailImageIncluded: true, trails: [{ points: [{ x: 0.25, y: 0.4, atMs: 100 }, { x: 0.5, y: 0.4, atMs: 200 }] }] }] } });
    expect(received?.frames[0]?.image).toMatchObject({ width: 100, height: 100 });
    expect(JSON.stringify(result)).not.toContain(data);
    expect(JSON.stringify(result)).not.toContain(received?.frames[0]?.image?.data);
    expect(request?.visual.frames).toEqual([]);
    expect(request?.history.frames).toEqual([]);
  });

  it('starts only on activation, streams before stop, and measures the full turn', async () => {
    const f = fixture();
    expect(f.sessions).toHaveLength(0);
    f.runtime.toggle(); const id = f.id();
    await flush();
    f.time(20); f.runtime.handle({ type: 'audio-started', turnId: id });
    f.time(30); f.runtime.handle({ type: 'audio', turnId: id, capturedAt: new Date().toISOString(),
      startSample: 0, timing: 'estimated', data: Buffer.alloc(4800, 1).toString('base64') });
    f.time(40); f.sessions[0]!.ready.resolve(); await flush();
    f.time(50); f.sessions[0]!.options.onPartial('');
    f.time(60); f.sessions[0]!.options.onPartial('hello');
    expect(f.sessions[0]!.audio[0]![0]).toBe(1);
    expect(f.outputs).toContainEqual({ type: 'partial', turnId: id, text: 'hello' });
    f.time(100); f.runtime.toggle();
    expect(f.sessions[0]!.commit).not.toHaveBeenCalled();
    f.runtime.handle({ type: 'audio-stopped', turnId: id });
    expect(f.sessions[0]!.commit).toHaveBeenCalledOnce();
    f.time(160); f.sessions[0]!.final.resolve('hello world'); await flush();
    const result = f.outputs.find((output) => output.type === 'result');
    expect(result).toMatchObject({ type: 'result', turnId: id, transcript: 'hello world',
      response: 'Which window?',
      attention: { contexts: [{ context: { selectedText: 'original selection' } }],
        audio: { firstReceivedAtMs: 30, durationMs: 100, samples: 2400 } },
      latency: { activationToListeningMs: 20, activationToFirstAudioMs: 30, activationToProviderReadyMs: 40,
        activationToFirstTranscriptMs: 60, stopToFinalTranscriptMs: 60, stopToResultMs: 60,
        contextCaptureMs: 0, visualPreparationMs: 0, reasoningMs: 0, stopToResponseMs: 60, recordingMs: 100, totalMs: 160 } });
    expect(f.commands.at(-1)).toEqual({ type: 'settled', turnId: id });
    expect(f.outputs.at(-1)).toEqual({ type: 'state', state: 'ready' });
    f.runtime.toggle(); expect(f.sessions).toHaveLength(2);
  });

  it('starts audio despite slow context and freezes it at stop without delaying the response', async () => {
    vi.useFakeTimers();
    const f = fixture(() => new Promise(() => {}));
    f.runtime.toggle(); const id = f.id();
    expect(f.commands[0]).toEqual({ type: 'start', turnId: id });
    f.runtime.handle({ type: 'audio-started', turnId: id });
    f.runtime.toggle(); f.runtime.handle({ type: 'audio-stopped', turnId: id });
    f.sessions[0]!.final.resolve('speech still works');
    await flush();
    expect(f.outputs).toContainEqual({ type: 'transcript', turnId: id, text: 'speech still works' });
    await flush();
    const result = f.outputs.find((output) => output.type === 'result');
    expect(result?.type === 'result' && result.attention.warnings).toContain('No window/selection context was captured for this turn.');
  });

  it('waits for cleanup acknowledgment and ignores late events from cancelled turns', async () => {
    const f = fixture(); f.runtime.toggle(); const old = f.id();
    f.runtime.cancel(); f.runtime.toggle();
    expect(f.sessions).toHaveLength(1);
    expect(f.sessions[0]!.options.signal.aborted).toBe(true);
    f.runtime.handle({ type: 'audio-stopped', turnId: old });
    f.runtime.toggle(); const current = f.id();
    expect(current).not.toBe(old);
    f.sessions[0]!.options.onPartial('stale');
    f.sessions[0]!.options.onPhrase({ id: 'stale', text: 'stale', startSample: 0, endSample: 1, boundary: 'stop' });
    f.sessions[0]!.final.resolve('stale');
    f.runtime.handle({ type: 'audio', turnId: old, data: 'AAA=', capturedAt: new Date().toISOString(), startSample: 0, timing: 'device' });
    f.runtime.handle({ type: 'audio-stopped', turnId: old }); await flush();
    expect(f.sessions[1]!.audio).toHaveLength(0);
    expect(f.outputs.filter((output) => output.type === 'result' || output.type === 'partial')).toEqual([]);
  });

  it('recovers from a provider failure without restarting the helper', async () => {
    const f = fixture(); f.runtime.toggle(); const id = f.id();
    f.sessions[0]!.final.reject(new Error('Speech connection failed.')); await flush();
    expect(f.commands.at(-1)).toEqual({ type: 'cancel', turnId: id });
    f.runtime.handle({ type: 'audio-stopped', turnId: id });
    f.runtime.toggle(); expect(f.sessions).toHaveLength(2);
  });

  it('prepares timed phrases while listening and carries their capture intervals into the response', async () => {
    const epoch = Date.parse('2026-10-28T12:00:00Z');
    vi.useFakeTimers({ now: epoch });
    const f = fixture(); f.runtime.toggle(); const id = f.id(); await flush();
    f.time(50); f.runtime.handle({ type: 'audio-started', turnId: id });
    f.time(300); f.runtime.handle({ type: 'audio', turnId: id, capturedAt: new Date(epoch + 100).toISOString(),
      startSample: 0, timing: 'device', data: Buffer.alloc(4800).toString('base64') });
    f.time(500); f.sessions[0]!.options.onPhrase({ id: 'p1', text: 'use this', startSample: 0, endSample: 2400, boundary: 'pause' });
    f.sessions[0]!.options.onPartial('use this');
    expect(f.outputs.some((output) => output.type === 'result')).toBe(false);
    expect(f.outputs.filter((output) => output.type === 'state').at(-1)).toMatchObject({ state: 'listening' });
    f.time(600); f.runtime.toggle();
    f.runtime.handle({ type: 'audio-stopped', turnId: id });
    f.time(620); f.sessions[0]!.final.resolve('use this'); await flush();
    expect(f.outputs.find((output) => output.type === 'result')).toMatchObject({
      attention: { transcript: [{ text: 'use this', startMs: 100, endMs: 200, receivedAtMs: 500, timing: 'device' }] },
      latency: { activationToFirstPhraseMs: 500, maxPhraseFinalizationMs: 300, maxAudioDeliveryLagMs: 100, stopToFinalTranscriptMs: 20 },
    });
  });

  it('replaces partial text rather than concatenating corrections and rejects mismatched audio offsets', () => {
    const f = fixture(); f.runtime.toggle(); const id = f.id();
    f.sessions[0]!.options.onPartial('use that');
    f.sessions[0]!.options.onPartial('use this here');
    expect(f.outputs.at(-1)).toMatchObject({ type: 'partial', text: 'use this here' });
    f.runtime.handle({ type: 'audio', turnId: id, capturedAt: new Date().toISOString(),
      startSample: 2400, timing: 'device', data: Buffer.alloc(4800).toString('base64') });
    expect(f.sessions[0]!.audio).toEqual([]);
    expect(f.commands.at(-1)).toEqual({ type: 'cancel', turnId: id });
  });

  it('accepts Escape while processing and never publishes the abandoned result', async () => {
    const f = fixture(); f.runtime.toggle(); const id = f.id();
    f.runtime.toggle(); f.runtime.handle({ type: 'audio-stopped', turnId: id });
    f.runtime.handle({ type: 'cancel' });
    f.sessions[0]!.final.resolve('discard me'); await flush();
    f.runtime.handle({ type: 'audio-stopped', turnId: id });
    expect(f.outputs.some((output) => output.type === 'result')).toBe(false);
    expect(f.outputs.at(-1)).toEqual({ type: 'state', state: 'ready' });
  });

  it('cancels a pending reasoning request, discards attention, and ignores its late response', async () => {
    const final = deferred<Awaited<ReturnType<ReasoningFactory>>>();
    let request: Parameters<ReasoningFactory>[0] | undefined;
    const f = fixture(undefined, async (input) => { request = input; return final.promise; });
    f.runtime.toggle(); const id = f.id(); await flush();
    f.runtime.toggle(); f.runtime.handle({ type: 'audio-stopped', turnId: id });
    f.sessions[0]!.final.resolve('use this'); await flush();
    expect(f.outputs.at(-1)).toMatchObject({ type: 'state', state: 'interpreting' });
    expect(request?.history.contexts).toHaveLength(1);
    f.runtime.handle({ type: 'cancel' });
    expect(request?.signal.aborted).toBe(true);
    expect(request?.history.contexts).toHaveLength(0);
    f.runtime.handle({ type: 'audio-stopped', turnId: id });
    final.resolve(await reason(request!)); await flush();
    expect(f.outputs.some((output) => output.type === 'result')).toBe(false);
    expect(f.outputs.at(-1)).toMatchObject({ type: 'state', state: 'ready' });
  });

  it('bounds response latency and remains cancellable if interpretation stalls', async () => {
    vi.useFakeTimers(); const f = fixture(undefined, () => new Promise(() => {}));
    f.runtime.toggle(); const id = f.id(); await flush();
    f.runtime.toggle(); f.runtime.handle({ type: 'audio-stopped', turnId: id });
    f.sessions[0]!.final.resolve('use this'); await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.outputs).toContainEqual({ type: 'error', turnId: id, message: 'Reasoning timed out. Try a shorter request.' });
    expect(f.commands.at(-1)).toEqual({ type: 'cancel', turnId: id });
  });

  it('stops the runtime when native cancellation cleanup cannot be confirmed', async () => {
    vi.useFakeTimers(); const f = fixture(); f.runtime.toggle(); f.runtime.cancel();
    const failure = expect(f.runtime.fatal).rejects.toThrow('cleanup could not be confirmed');
    await vi.advanceTimersByTimeAsync(2000); await failure;
    f.runtime.toggle(); expect(f.sessions).toHaveLength(1);
  });

  it('bounds startup and long recordings', async () => {
    vi.useFakeTimers(); const f = fixture(); f.runtime.toggle(); const first = f.id();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.commands.at(-1)).toEqual({ type: 'cancel', turnId: first });
    f.runtime.handle({ type: 'audio-stopped', turnId: first }); f.runtime.toggle();
    const second = f.id(); f.runtime.handle({ type: 'audio-started', turnId: second });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.commands.at(-1)).toEqual({ type: 'stop', turnId: second });
  });
});
