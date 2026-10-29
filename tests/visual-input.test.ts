import { afterEach, expect, it, vi } from 'vitest';
import type { AttentionHistory } from '../src/attention.js';
import type { renderTrail } from '../src/visual-render.js';
import { discardVisualContext, prepareVisualContext, visualContextSummary } from '../src/visual-input.js';

afterEach(() => vi.useRealTimers());
const signal = () => new AbortController().signal;
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function history(count = 4): AttentionHistory {
  return { frames: Array.from({ length: count }, (_, i) => ({
    id: `f${i}`, atMs: i * 1500 + 500, receivedAtMs: i * 1500 + 510, capturedAt: '2026-10-28T00:00:00.000Z',
    display: { id: 'screen', bounds: { x: 0, y: 0, width: 1600, height: 900 } },
    image: { mimeType: 'image/jpeg', width: 1600, height: 900, data: '/9j/AA==' }, warnings: [],
  })), cursor: [{ atMs: 400, receivedAtMs: 410, x: 800, y: 450, displayId: 'screen' }],
  contexts: [{ id: 'c0', atMs: 0, receivedAtMs: 10, context: { platform: 'test',
    capturedAt: '2026-10-28T00:00:00.000Z', activeWindow: { id: 'editor', application: 'Editor' }, warnings: [] } }],
  transcript: [{ id: 'p0', startSample: 0, endSample: 24000, startMs: 200, endMs: 1200,
    receivedAtMs: 1400, boundary: 'pause', text: 'what is this?', timing: 'device' }],
  warnings: [], durationMs: count * 1500,
  audio: { sampleRate: 24000, samples: 0, durationMs: 0, firstCapturedAtMs: null, lastCapturedAtMs: null,
    firstReceivedAtMs: null, maxDeliveryLagMs: null, timing: 'unavailable' } };
}

it('runs at most two independent renderers and retains all clean original frames', async () => {
  const captured = history(6), before = structuredClone(captured);
  const gates: Array<ReturnType<typeof deferred<void>>> = [];
  let active = 0, maximum = 0;
  const render = vi.fn<typeof renderTrail>(async (frame) => {
    active++; maximum = Math.max(maximum, active);
    const gate = deferred<void>(); gates.push(gate);
    await gate.promise; active--;
    return { ...frame.image, data: 'annotation' };
  });
  const pending = prepareVisualContext(captured, signal(), render);
  expect(render).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 6; i += 2) {
    gates[i]!.resolve(); gates[i + 1]!.resolve(); await flush();
  }
  const visual = await pending;
  expect(maximum).toBe(2);
  expect(visual.frames.every((frame) => frame.image?.data === 'annotation')).toBe(true);
  expect(captured).toEqual(before);
});

it('keeps originals and timed coordinates after rendering fails without leaking private errors', async () => {
  const captured = history(2), before = structuredClone(captured);
  const render = vi.fn<typeof renderTrail>().mockRejectedValue(new Error('private screenshot content and API key'));
  const visual = await prepareVisualContext(captured, signal(), render);
  expect(visual.frames).toHaveLength(2);
  expect(visual.frames.every((frame) => frame.image === null)).toBe(true);
  expect(visual.frames[0]!.context).toMatchObject({ phraseIds: ['p0'], contextIds: ['c0'], pointer: { x: 0.5, y: 0.5, atMs: 400 } });
  expect(visual.warnings).toHaveLength(2);
  expect(visual.warnings.join(' ')).toContain('clean frame and timed coordinates');
  expect(JSON.stringify(visual)).not.toMatch(/private|API key/);
  expect(captured).toEqual(before);
});

it('bounds retained annotation payload independently of original screenshots', async () => {
  const captured = history(12);
  const render = vi.fn<typeof renderTrail>(async (frame) => ({ ...frame.image, data: 'a'.repeat(900_000) }));
  const visual = await prepareVisualContext(captured, signal(), render);
  expect(visual.frames).toHaveLength(12);
  expect(visual.frames.reduce((sum, frame) => sum + (frame.image?.data.length ?? 0), 0)).toBeLessThanOrEqual(8_000_000);
  expect(visual.frames.filter((frame) => frame.image)).toHaveLength(8);
  expect(visual.warnings).toHaveLength(4);
  expect(captured.frames.every((frame) => frame.image.data === '/9j/AA==')).toBe(true);
});

it('cancels promptly even when an in-flight renderer settles late, without scheduling more frames', async () => {
  const captured = history(4), controller = new AbortController();
  const late = deferred<Awaited<ReturnType<typeof renderTrail>>>();
  const render = vi.fn<typeof renderTrail>().mockImplementation(() => late.promise);
  let outcome = 'pending';
  const pending = prepareVisualContext(captured, controller.signal, render).then(
    () => { outcome = 'resolved'; },
    (error: unknown) => { expect(error).toMatchObject({ name: 'AbortError' }); outcome = 'aborted'; },
  );
  controller.abort(); await flush();
  expect(outcome).toBe('aborted');
  expect(render).toHaveBeenCalledTimes(2);
  expect(render.mock.calls.every((call) => call[2].aborted)).toBe(true);
  late.resolve({ ...captured.frames[0]!.image, data: 'late annotation' });
  await pending; await flush();
  expect(outcome).toBe('aborted');
  expect(render).toHaveBeenCalledTimes(2);
  expect(captured.frames.every((frame) => frame.image.data === '/9j/AA==')).toBe(true);
});

it('returns clean-frame fallback after two seconds and ignores late output mutations', async () => {
  vi.useFakeTimers();
  const captured = history(4), late = deferred<Awaited<ReturnType<typeof renderTrail>>>();
  const render = vi.fn<typeof renderTrail>().mockResolvedValueOnce({ ...captured.frames[0]!.image, data: 'completed annotation' })
    .mockImplementation(() => late.promise);
  let settled = false;
  const pending = prepareVisualContext(captured, signal(), render).then((visual) => { settled = true; return visual; });
  await vi.advanceTimersByTimeAsync(1999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await flush();
  expect(settled).toBe(true);
  const visual = await pending;
  expect(visual.frames[0]!.image?.data).toBe('completed annotation');
  expect(visual.frames.slice(1).every((frame) => frame.image === null)).toBe(true);
  expect(visual.warnings.join(' ')).toContain('two-second limit');
  const frozen = structuredClone(visual);
  late.resolve({ ...captured.frames[0]!.image, data: 'late annotation' }); await flush();
  expect(visual).toEqual(frozen);
  expect(render).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps byte-free summaries useful after image disposal', async () => {
  const visual = await prepareVisualContext(history(1), signal(), async (frame) => ({ ...frame.image, data: 'sensitive-image-bytes' }));
  const summary = visualContextSummary(visual), before = structuredClone(summary);
  const imageHolder = visual.frames[0]!;
  expect(summary.frames[0]).toMatchObject({ frameId: 'f0', trailImageIncluded: true, phraseIds: ['p0'], contextIds: ['c0'] });
  expect(JSON.stringify(summary)).not.toContain('sensitive-image-bytes');
  expect(summary.frames[0]).not.toHaveProperty('image');
  discardVisualContext(visual);
  expect(imageHolder.image).toBeNull();
  expect(visual).toEqual({ frames: [], warnings: [] });
  expect(summary).toEqual(before);
});
