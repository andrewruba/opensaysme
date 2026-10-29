import { afterEach, expect, it, vi } from 'vitest';
import { AttentionCollector, attentionSummary } from '../src/attention.js';
import type { ScreenFrameCapture } from '../src/desktop/visual-types.js';
import type { DesktopContext } from '../src/desktop/voice-types.js';

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
  return { collector, controller, captureFrame, captureContext, frame, context, pointer };
}

it('preserves generic attention paths and changing source/destination context without labeling gestures', async () => {
  const f = fixture(); await flush();
  for (const [x, y] of [[-100, 100], [-120, 110], [-100, 120], [-80, 110], [-100, 100]]) {
    f.pointer(x!, y!); await vi.advanceTimersByTimeAsync(100);
  }
  f.context.activeWindow = { id: 'target', application: 'Terminal' };
  f.frame.image.data = '/9j/AQ==';
  f.collector.delta('use this');
  await vi.advanceTimersByTimeAsync(100);
  const history = f.collector.freeze();
  expect(history.frames).toHaveLength(2);
  expect(history.contexts.map((entry) => entry.context.activeWindow?.id)).toEqual(['source', 'target']);
  expect(history.cursor.map((entry) => [entry.x, entry.y])).toEqual([[-100, 100], [-120, 110], [-100, 120], [-80, 110], [-100, 100]]);
  expect(history.frames[0]!.display.bounds.x).toBe(-1440);
  expect(history.transcript[0]).toEqual({ receivedAtMs: 500, text: 'use this' });
  expect(history.cursor[0]).not.toHaveProperty('gesture');
  expect(history.warnings[0]).toContain('not word or phrase timestamps');
});

it('coalesces unchanged frames/context and bounds long changing histories', async () => {
  let f = fixture(); await vi.advanceTimersByTimeAsync(1000);
  const stable = f.collector.freeze();
  expect(stable.frames).toHaveLength(1);
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
  f.collector.delta('delivered after stop');
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
  f.collector.delta('this');
  const history = f.collector.freeze();
  expect(history.cursor[0]).toMatchObject({ atMs: 100, receivedAtMs: 100 });
  expect(history.warnings.some((warning) => warning.includes('outside its request interval'))).toBe(true);
  expect(history.transcript[0]).not.toHaveProperty('atMs');
});

it('continues context capture when screen permission is denied and bounds retries', async () => {
  const f = fixture();
  f.captureFrame.mockRejectedValue(new Error('private native exception'));
  await vi.advanceTimersByTimeAsync(10_000);
  const history = f.collector.freeze();
  expect(f.captureFrame).toHaveBeenCalledTimes(2);
  expect(history.contexts).toHaveLength(1);
  expect(JSON.stringify(history)).not.toContain('private native exception');
  expect(history.warnings.some((warning) => warning.includes('Screen capture unavailable'))).toBe(true);
});
