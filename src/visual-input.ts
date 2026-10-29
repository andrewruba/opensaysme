import type { AttentionHistory } from './attention.js';
import type { ScreenFrameCapture } from './desktop/visual-types.js';
import { alignFrames, type FrameContext } from './visual-context.js';
import { renderTrail } from './visual-render.js';

export interface PreparedVisualContext {
  frames: Array<{ context: FrameContext; image: ScreenFrameCapture['image'] | null }>;
  warnings: string[];
}

/** Full images stay intact. Derived copies are optional, bounded, and turn-local. */
export async function prepareVisualContext(
  history: AttentionHistory, signal: AbortSignal, render: typeof renderTrail = renderTrail,
): Promise<PreparedVisualContext> {
  signal.throwIfAborted();
  const visual: PreparedVisualContext = { frames: alignFrames(history).map((context) => ({ context, image: null })), warnings: [] };
  const deadline = new AbortController();
  const rendering = AbortSignal.any([signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(), 2000);
  let rejectStopped!: (reason: unknown) => void;
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const onAbort = () => rejectStopped(rendering.reason);
  rendering.addEventListener('abort', onAbort, { once: true });
  let next = 0;
  let retainedBytes = 0;
  const worker = async () => {
    while (next < visual.frames.length && !rendering.aborted) {
      const item = visual.frames[next++]!;
      const frame = history.frames.find((frame) => frame.id === item.context.frameId)!;
      try {
        const image = await render(frame, item.context, rendering);
        rendering.throwIfAborted();
        if (image && retainedBytes + image.data.length > 8_000_000) {
          visual.warnings.push(`Trail copy for ${frame.id} omitted to bound the image payload; use the clean frame and timed coordinates.`);
        } else if (image) {
          item.image = image;
          retainedBytes += image.data.length;
        }
      } catch {
        if (!rendering.aborted) visual.warnings.push(`Trail copy for ${frame.id} unavailable; use the clean frame and timed coordinates.`);
      }
    }
  };
  try {
    // Bound CPU work while preparing independent frames together.
    await Promise.race([Promise.all([worker(), worker()]), stopped]);
    signal.throwIfAborted();
    return visual;
  } catch (error) {
    if (deadline.signal.aborted && !signal.aborted) {
      visual.warnings.push('Trail rendering reached its two-second limit; some frames have only clean images and timed coordinates.');
      return visual;
    }
    discardVisualContext(visual);
    throw error;
  } finally {
    clearTimeout(timer);
    rendering.removeEventListener('abort', onAbort);
  }
}

export function discardVisualContext(visual: PreparedVisualContext) {
  for (const frame of visual.frames) frame.image = null;
  visual.frames.length = 0;
  visual.warnings.length = 0;
}

/** Print evidence associations and availability, never screenshot bytes. */
export function visualContextSummary(visual: PreparedVisualContext) {
  return { frames: visual.frames.map(({ context, image }) => ({ ...context, trailImageIncluded: image !== null })), warnings: [...visual.warnings] };
}
