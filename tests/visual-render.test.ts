import sharp from 'sharp';
import { beforeAll, expect, it } from 'vitest';
import type { AttentionFrame } from '../src/attention.js';
import type { FrameContext } from '../src/visual-context.js';
import { renderTrail } from '../src/visual-render.js';

let frame: AttentionFrame;
const signal = () => new AbortController().signal;
const point = (x: number, y: number, atMs: number) => ({ x, y, atMs });
function context(overrides: Partial<FrameContext> = {}): FrameContext {
  return { frameId: 'f1', atMs: 500, startMs: 0, endMs: 1000, phraseIds: ['p1'], contextIds: ['c1'], warnings: [],
    trails: [{ points: [point(0.125, 0.5, 100), point(0.375, 0.5, 200), point(0.625, 0.5, 800), point(0.875, 0.5, 900)] }],
    pointer: null, ...overrides };
}
async function pixels(data: string) {
  const decoded = await sharp(Buffer.from(data, 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { ...decoded, at: (x: number, y: number) => [...decoded.data.subarray((y * decoded.info.width + x) * 3, (y * decoded.info.width + x) * 3 + 3)] };
}
function near(actual: number[], expected: number[], tolerance = 8) {
  actual.forEach((value, i) => expect(Math.abs(value - expected[i]!)).toBeLessThanOrEqual(tolerance));
}

beforeAll(async () => {
  const data = Buffer.alloc(400 * 240 * 3, 220);
  for (const [left, top, color] of [[10, 10, [230, 20, 20]], [370, 10, [20, 230, 20]], [10, 210, [20, 20, 230]], [370, 210, [230, 230, 20]]] as const) {
    for (let y = top; y < top + 20; y++) for (let x = left; x < left + 20; x++) {
      data.set(color, (y * 400 + x) * 3);
    }
  }
  frame = { id: 'f1', atMs: 500, receivedAtMs: 510, capturedAt: '2026-10-28T12:00:00.000Z',
    display: { id: 'display', bounds: { x: -1600, y: 100, width: 1600, height: 960 } }, warnings: [],
    image: { mimeType: 'image/jpeg', width: 400, height: 240,
      data: (await sharp(data, { raw: { width: 400, height: 240, channels: 3 } }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer()).toString('base64') } };
});

it('retains the entire image and clean source while placing a visibly timed trail at normalized coordinates', async () => {
  const original = structuredClone(frame);
  const result = await renderTrail(frame, context(), signal());
  expect(result).not.toBeNull();
  expect(frame).toEqual(original);
  expect(result).toMatchObject({ mimeType: 'image/jpeg', width: 400, height: 240 });
  expect(Buffer.from(result!.data, 'base64').byteLength).toBeLessThanOrEqual(700_000);
  const before = await pixels(original.image.data);
  const after = await pixels(result!.data);
  expect([after.info.width, after.info.height]).toEqual([400, 240]);
  for (const [x, y] of [[20, 20], [380, 20], [20, 220], [380, 220], [200, 40]]) near(after.at(x!, y!), before.at(x!, y!));
  const early = after.at(100, 120), late = after.at(300, 120);
  expect(early[0]).toBeLessThan(before.at(100, 120)[0]! - 30);
  expect(late[0]).toBeLessThan(early[0]! - 30);
  expect(late[2]).toBeGreaterThan(late[0]! + 100);
  near(after.at(200, 200), before.at(200, 200));
});

it('does not connect separate trails and can mark a pointer without a trail', async () => {
  const result = await renderTrail(frame, context({ trails: [
    { points: [point(0.1, 0.5, 100), point(0.3, 0.5, 200)] },
    { points: [point(0.7, 0.5, 800), point(0.9, 0.5, 900)] },
  ] }), signal());
  const before = await pixels(frame.image.data), after = await pixels(result!.data);
  near(after.at(200, 120), before.at(200, 120));
  const pointer = await renderTrail(frame, context({ trails: [], pointer: point(0.5, 0.5, 500) }), signal());
  const pointerPixels = await pixels(pointer!.data);
  expect(pointerPixels.at(204, 120)[0]).toBeLessThan(100);
  near(pointerPixels.at(100, 120), before.at(100, 120));
});

it('skips decoding when there is nothing to mark', async () => {
  expect(await renderTrail({ ...frame, image: { ...frame.image, data: 'AAAA' } }, context({ trails: [], pointer: null }), signal())).toBeNull();
});

it('rejects mismatched dimensions and non-JPEG sources before compositing', async () => {
  await expect(renderTrail({ ...frame, image: { ...frame.image, width: 399 } }, context(), signal())).rejects.toThrow('dimensions');
  const png = await sharp(Buffer.from(frame.image.data, 'base64')).png().toBuffer();
  await expect(renderTrail({ ...frame, image: { ...frame.image, data: png.toString('base64') } }, context(), signal())).rejects.toThrow('JPEG');
  await expect(renderTrail({ ...frame, image: { ...frame.image, width: 1601 } }, context(), signal())).rejects.toThrow();
});

it('rejects invalid coordinates, unrelated frames, oversized paths, and reversed time', async () => {
  for (const invalid of [point(-0.1, 0.5, 10), point(1.1, 0.5, 10), point(0.5, NaN, 10), point(0.5, 0.5, Infinity)]) {
    await expect(renderTrail(frame, context({ trails: [], pointer: invalid }), signal())).rejects.toThrow('Invalid cursor');
  }
  await expect(renderTrail(frame, context({ frameId: 'other' }), signal())).rejects.toThrow('different frame');
  await expect(renderTrail(frame, context({ trails: [{ points: Array.from({ length: 1501 }, () => point(0.5, 0.5, 10)) }] }), signal())).rejects.toThrow('limit');
  await expect(renderTrail(frame, context({ trails: [{ points: [point(0.5, 0.5, 20), point(0.6, 0.5, 10)] }] }), signal())).rejects.toThrow('out of order');
});

it('rejects cancellation before decoding and during asynchronous processing', async () => {
  const stopped = new AbortController(); stopped.abort();
  await expect(renderTrail(frame, context(), stopped.signal)).rejects.toMatchObject({ name: 'AbortError' });
  const running = new AbortController();
  const pending = renderTrail(frame, context(), running.signal);
  running.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(frame.image.width).toBe(400);
});
