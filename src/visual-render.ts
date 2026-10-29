import sharp from 'sharp';
import type { AttentionFrame } from './attention.js';
import { screenFrameCaptureSchema, type ScreenFrameCapture } from './desktop/visual-types.js';
import type { FrameContext } from './visual-context.js';

// Screenshots must not outlive their turn in libvips' operation cache.
sharp.cache(false);

const MAX_PIXELS = 1600 * 1600;
const MAX_OUTPUT_BYTES = 700_000;
const MAX_POINTS = 1500;
type Point = { x: number; y: number; atMs: number };

function validatePoint(point: Point) {
  if (![point.x, point.y, point.atMs].every(Number.isFinite) ||
    point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1 || point.atMs < 0) {
    throw new Error('Invalid cursor coordinates or timestamp for visual rendering.');
  }
}

function overlay(context: FrameContext, width: number, height: number): Buffer | null {
  if (context.trails.length > 128 || context.trails.reduce((sum, trail) => sum + trail.points.length, 0) > MAX_POINTS) {
    throw new Error('Cursor trail exceeds the visual rendering limit.');
  }
  const points = context.trails.flatMap((trail) => trail.points);
  for (const trail of context.trails) {
    let previousAt = -Infinity;
    for (const point of trail.points) {
      validatePoint(point);
      if (point.atMs < previousAt) throw new Error('Cursor trail timestamps are out of order.');
      previousAt = point.atMs;
    }
  }
  if (context.pointer) validatePoint(context.pointer);
  if (!points.length && !context.pointer) return null;

  const firstAt = Math.min(...points.map((point) => point.atMs), context.pointer?.atMs ?? Infinity);
  const lastAt = Math.max(...points.map((point) => point.atMs), context.pointer?.atMs ?? -Infinity);
  const coordinate = (value: number, dimension: number) => Math.min(value * dimension, dimension - 1).toFixed(2);
  const x = (point: Point) => coordinate(point.x, width);
  const y = (point: Point) => coordinate(point.y, height);
  const stroke = Math.max(2, width / 600);
  const marks: string[] = [];
  for (const trail of context.trails) {
    for (let i = 0; i < trail.points.length; i++) {
      const point = trail.points[i]!;
      const previous = trail.points[i - 1] ?? point;
      const opacity = (0.4 + 0.5 * (lastAt === firstAt ? 1 : (point.atMs - firstAt) / (lastAt - firstAt))).toFixed(3);
      // A zero-length round-capped segment preserves isolated observations.
      const path = `M${x(previous)},${y(previous)} L${x(point)},${y(point)}`;
      marks.push(`<g opacity="${opacity}"><path d="${path}" stroke="#11212b" stroke-width="${stroke + 2}"/><path d="${path}" stroke="#00e5ff" stroke-width="${stroke}"/></g>`);
    }
  }
  if (points.length) {
    const endpoint = points.reduce((last, point) => point.atMs >= last.atMs ? point : last);
    marks.push(`<circle cx="${x(endpoint)}" cy="${y(endpoint)}" r="${stroke + 0.5}" fill="#00e5ff" stroke="#11212b" stroke-width="1"/>`);
  }
  if (context.pointer) {
    const pointer = context.pointer;
    marks.push(`<circle cx="${x(pointer)}" cy="${y(pointer)}" r="${stroke + 2}" stroke="#11212b" stroke-width="4"/><circle cx="${x(pointer)}" cy="${y(pointer)}" r="${stroke + 2}" stroke="#00e5ff" stroke-width="2"/>`);
  }
  // Only checked numeric values enter this SVG; no captured text, external assets, or fonts.
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g fill="none" stroke-linecap="round" stroke-linejoin="round">${marks.join('')}</g></svg>`);
}

/** A full-frame model-only copy; the caller retains the clean source separately. */
export async function renderTrail(frame: AttentionFrame, context: FrameContext, signal: AbortSignal): Promise<ScreenFrameCapture['image'] | null> {
  signal.throwIfAborted();
  const image = screenFrameCaptureSchema.shape.image.parse(frame.image);
  if (frame.id !== context.frameId) throw new Error('Cursor trail belongs to a different frame.');
  const svg = overlay(context, image.width, image.height);
  if (!svg) return null;

  const pipeline = sharp(Buffer.from(image.data, 'base64'), { limitInputPixels: MAX_PIXELS, sequentialRead: true, failOn: 'error' });
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    pipeline.destroy();
    rejectAbort(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    return await Promise.race([aborted, (async () => {
      const metadata = await pipeline.metadata();
      signal.throwIfAborted();
      if (metadata.format !== 'jpeg' || metadata.width !== image.width || metadata.height !== image.height) {
        throw new Error('Screenshot JPEG dimensions do not match the supplied frame.');
      }
      pipeline.composite([{ input: svg }]);
      for (const quality of [80, 60, 40]) {
        const output = await pipeline.jpeg({ quality, chromaSubsampling: '4:4:4' }).toBuffer();
        signal.throwIfAborted();
        if (output.byteLength <= MAX_OUTPUT_BYTES) {
          return { mimeType: 'image/jpeg' as const, width: image.width, height: image.height, data: output.toString('base64') };
        }
      }
      throw new Error('Annotated screenshot exceeds the image byte limit.');
    })()]);
  } finally {
    signal.removeEventListener('abort', onAbort);
    // Native processing can finish after cancellation; its output is never returned.
    pipeline.destroy();
  }
}
