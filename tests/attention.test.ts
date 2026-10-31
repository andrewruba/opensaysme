import { afterEach, expect, it, vi } from 'vitest';
import { AttentionCollector, attentionSummary } from '../src/attention.js';
import type { ScreenFrameCapture } from '../src/desktop/visual-types.js';
import type { DesktopContext } from '../src/desktop/voice-types.js';
import { DesktopError, desktopMessages } from '../src/desktop/errors.js';

const epoch = Date.parse('2026-10-28T12:00:00.000Z');
const collectors: AttentionCollector[] = [];
afterEach(() => { collectors.splice(0).forEach((collector) => collector.discard()); vi.useRealTimers(); });
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function fixture() {
  vi.useFakeTimers({ now: epoch });
  const controller = new AbortController();
  const timestamp = () => new Date().toISOString();
  const frame: ScreenFrameCapture = { capturedAt: timestamp(), display: { id: 'display', bounds: { x: -1440, y: 0, width: 1440, height: 900 } },
    image: { mimeType: 'image/jpeg', width: 1440, height: 900, data: '/9j/AA==' }, warnings: [] };
  const context: DesktopContext = { platform: 'test', capturedAt: timestamp(), activeWindow: { id: 'source', application: 'Editor' }, selectedText: 'selected region', warnings: [] };
  const captureFrame = vi.fn(async () => ({ ...structuredClone(frame), capturedAt: timestamp() }));
  const captureContext = vi.fn(async () => ({ ...structuredClone(context), capturedAt: timestamp() }));
  const collector = new AttentionCollector({ captureFrame, captureContext, epochStart: epoch, now: () => Date.now() - epoch,
    signal: controller.signal, frameIntervalMs: 100, contextIntervalMs: 100 });
  collectors.push(collector);
  const pointer = (x: number, y = 100, capturedAt = timestamp()) => collector.pointer({ type: 'pointer', turnId: 'turn', capturedAt, x, y, displayId: 'display' });
  const audio = (startSample: number, capturedAtMs: number, samples: number, timing: 'device' | 'estimated' = 'device') => collector.audio({
    type: 'audio', turnId: 'turn', startSample, capturedAt: new Date(epoch + capturedAtMs).toISOString(), timing, data: 'AAA=',
  }, samples * 2);
  return { collector, controller, captureFrame, captureContext, frame, context, pointer, audio };
}

it('preserves generic attention paths and changing source/destination context without labeling gestures', async () => {
  const f = fixture(); await flush();
  for (const [x, y] of [[-100, 100], [-120, 110], [-100, 120], [-80, 110], [-100, 100]]) {
    f.pointer(x!, y!); await vi.advanceTimersByTimeAsync(100);
  }
  f.context.activeWindow = { id: 'target', application: 'Terminal' };
  f.frame.image.data = '/9j/AQ==';
  f.audio(0, 100, 9600);
  f.collector.phrase({ id: 'p1', startSample: 0, endSample: 9600, boundary: 'pause', text: 'use this' });
  await vi.advanceTimersByTimeAsync(100);
  const history = f.collector.freeze();
  expect(history.frames).toHaveLength(7);
  expect(history.contexts.map((entry) => entry.context.activeWindow?.id)).toEqual(['source', 'target']);
  expect(history.cursor.map((entry) => [entry.x, entry.y])).toEqual([[-100, 100], [-120, 110], [-100, 120], [-80, 110], [-100, 100]]);
  expect(history.frames[0]!.display.bounds.x).toBe(-1440);
  expect(history.transcript[0]).toMatchObject({ startMs: 100, endMs: 500, receivedAtMs: 500, text: 'use this', timing: 'device' });
  expect(history.cursor[0]).not.toHaveProperty('gesture');
  expect(history.warnings[0]).toContain('not word timestamps');
});

it('retains later captures of unchanged screens, coalesces context, and bounds long histories', async () => {
  let f = fixture(); await vi.advanceTimersByTimeAsync(1000);
  const stable = f.collector.freeze();
  expect(stable.frames).toHaveLength(11);
  expect(stable.frames.at(-1)?.atMs).toBe(1000);
  expect(stable.frames[0]?.image).toEqual(stable.frames.at(-1)?.image);
  expect(stable.contexts).toHaveLength(1);
  f = fixture(); await flush();
  for (let i = 1; i <= 50; i++) {
    f.frame.image.data = Buffer.from([255, 216, 255, i]).toString('base64');
    f.context.selectedText = `selection-${i}`;
    await vi.advanceTimersByTimeAsync(100);
  }
  const history = f.collector.freeze();
  expect(history.frames).toHaveLength(12);
  expect(history.frames[0]!.id).toBe('f1');
  expect(history.frames.at(-1)!.id).toBe('f51');
  expect(history.contexts).toHaveLength(24);
  expect(history.contexts.at(-1)!.context.selectedText).toBe('selection-50');
});

it('aborts in-flight capture and rejects late samples when the turn freezes', async () => {
  const f = fixture(); await flush();
  let resolve!: (frame: ScreenFrameCapture) => void;
  let captureSignal: AbortSignal | undefined;
  f.captureFrame.mockImplementationOnce(async (...args: unknown[]) => {
    captureSignal = args[0] as AbortSignal;
    return await new Promise<ScreenFrameCapture>((yes) => { resolve = yes; });
  });
  await vi.advanceTimersByTimeAsync(100);
  const history = f.collector.freeze();
  expect(captureSignal?.aborted).toBe(true);
  resolve({ ...f.frame, image: { ...f.frame.image, data: '/9j/AQ==' } });
  f.pointer(400); await vi.advanceTimersByTimeAsync(5000);
  expect(history.frames).toHaveLength(1);
  expect(history.cursor).toHaveLength(0);
  expect(f.captureFrame).toHaveBeenCalledTimes(2);
  f.audio(0, 0, 2400);
  f.collector.phrase({ id: 'p1', startSample: 0, endSample: 2400, boundary: 'stop', text: 'delivered after stop' });
  expect(history.transcript.at(-1)?.text).toBe('delivered after stop');
});

it('discards screenshots and context on cancellation and omits image bytes from terminal output', async () => {
  const f = fixture(); await flush();
  const history = f.collector.freeze();
  const output = attentionSummary(history);
  expect(JSON.stringify(output)).not.toContain('/9j/');
  f.controller.abort();
  expect(history.frames).toEqual([]);
  expect(history.contexts).toEqual([]);
  expect(output.frames).toHaveLength(1);
});

it('reports native clock jumps and does not present transcript delivery as speech timing', async () => {
  const f = fixture(); await flush();
  await vi.advanceTimersByTimeAsync(100);
  f.pointer(10, 10, new Date(epoch + 50_000).toISOString());
  f.audio(0, 50_000, 2400);
  f.collector.phrase({ id: 'p1', startSample: 0, endSample: 2400, boundary: 'stop', text: 'this' });
  const history = f.collector.freeze();
  expect(history.cursor[0]).toMatchObject({ atMs: 100, receivedAtMs: 100 });
  expect(history.warnings.some((warning) => warning.includes('outside its request interval'))).toBe(true);
  expect(history.transcript[0]).toMatchObject({ receivedAtMs: 100, startMs: null, endMs: null, timing: 'unavailable' });
});

it('orders delayed phrases by captured audio, accepts a drained tail, and ignores cancelled callbacks', async () => {
  const f = fixture(); await vi.advanceTimersByTimeAsync(200);
  f.audio(0, 50, 2400);
  f.audio(2400, 150, 1200);
  const history = f.collector.freeze();
  await vi.advanceTimersByTimeAsync(500);
  f.audio(3600, 200, 1200);
  f.collector.phrase({ id: 'second', startSample: 2400, endSample: 4800, boundary: 'stop', text: 'over here' });
  await vi.advanceTimersByTimeAsync(300);
  f.collector.phrase({ id: 'first', startSample: 0, endSample: 2400, boundary: 'pause', text: 'use this' });
  expect(history.transcript.map(({ text, startMs, endMs, receivedAtMs }) => ({ text, startMs, endMs, receivedAtMs }))).toEqual([
    { text: 'use this', startMs: 50, endMs: 150, receivedAtMs: 1000 },
    { text: 'over here', startMs: 150, endMs: 250, receivedAtMs: 700 },
  ]);
  const summary = attentionSummary(history);
  f.controller.abort();
  f.collector.phrase({ id: 'late', startSample: 0, endSample: 2400, boundary: 'stop', text: 'stale' });
  expect(history.transcript).toEqual([]);
  expect(summary.transcript).toHaveLength(2);
});

it('continues context capture after unknown screen failures without claiming permission denial', async () => {
  const f = fixture();
  f.captureFrame.mockRejectedValue(new Error('private native exception'));
  await vi.advanceTimersByTimeAsync(10_000);
  const history = f.collector.freeze();
  expect(f.captureFrame).toHaveBeenCalledTimes(2);
  expect(history.contexts).toHaveLength(1);
  expect(JSON.stringify(history)).not.toContain('private native exception');
  expect(history.warnings.some((warning) => warning.includes('Screen capture failed without a known cause'))).toBe(true);
});

it('preserves permission and timeout reasons while deduplicating local recovery feedback', async () => {
  vi.useFakeTimers({ now: epoch });
  const onDesktopIssue = vi.fn();
  const captureFrame = vi.fn(async () => { throw new DesktopError('screen-permission-required'); });
  const captureContext = vi.fn(async () => ({ platform: 'darwin', capturedAt: new Date().toISOString(),
    activeWindow: null, warnings: [], issues: ['permission-required' as const] }));
  const collector = new AttentionCollector({ captureFrame, captureContext, epochStart: epoch,
    now: () => Date.now() - epoch, signal: new AbortController().signal, onDesktopIssue });
  collectors.push(collector); await vi.advanceTimersByTimeAsync(6000);
  expect(onDesktopIssue.mock.calls).toEqual([['screen-permission-required'], ['permission-required']]);
  expect(collector.freeze().warnings).toContain(desktopMessages['screen-permission-required']);
  expect(captureFrame).toHaveBeenCalledTimes(2);

  const timeout = vi.fn();
  const pending = new AttentionCollector({ captureFrame: async () => new Promise(() => {}), captureContext,
    epochStart: epoch, now: () => Date.now() - epoch, signal: new AbortController().signal,
    captureTimeoutMs: 10, onDesktopIssue: timeout });
  collectors.push(pending); await vi.advanceTimersByTimeAsync(11);
  expect(timeout).toHaveBeenCalledWith('timeout');
});

it('forwards native screen capture timeouts unchanged to recovery feedback', async () => {
  vi.useFakeTimers({ now: epoch });
  const onDesktopIssue = vi.fn();
  const collector = new AttentionCollector({
    captureFrame: async () => { throw new DesktopError('screen-capture-timeout'); },
    captureContext: async () => ({ platform: 'darwin', capturedAt: new Date().toISOString(), activeWindow: null, warnings: [] }),
    epochStart: epoch, now: () => Date.now() - epoch, signal: new AbortController().signal, onDesktopIssue,
  });
  collectors.push(collector); await flush();
  expect(onDesktopIssue).toHaveBeenCalledExactlyOnceWith('screen-capture-timeout');
  expect(collector.freeze().warnings).toContain(desktopMessages['screen-capture-timeout']);
});
