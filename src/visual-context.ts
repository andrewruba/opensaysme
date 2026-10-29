import type { AttentionFrame, AttentionHistory, ContextSample, CursorSample } from './attention.js';

/** Normalized image coordinates, with the original turn-relative capture time. */
export interface FramePoint { x: number; y: number; atMs: number }
export interface FrameContext {
  frameId: string;
  atMs: number;
  startMs: number;
  endMs: number;
  phraseIds: string[];
  contextIds: string[];
  trails: Array<{ points: FramePoint[] }>;
  pointer: FramePoint | null;
  warnings: string[];
}

const frameRadiusMs = 750;
const maxCursorGapMs = 250;
const maxTrailPoints = 128;

function windowIdentity(sample: ContextSample): string | null {
  const window = sample.context.activeWindow;
  return window ? JSON.stringify([window.application, window.id]) : null;
}

function normalize(sample: CursorSample, frame: AttentionFrame): FramePoint | null {
  const { x, y, width, height } = frame.display.bounds;
  if (sample.displayId !== frame.display.id || width <= 0 || height <= 0
    || !Number.isFinite(sample.x) || !Number.isFinite(sample.y)
    || sample.x < x || sample.y < y || sample.x >= x + width || sample.y >= y + height) return null;
  return { x: (sample.x - x) / width, y: (sample.y - y) / height, atMs: sample.atMs };
}

function sameDisplay(a: AttentionFrame, b: AttentionFrame): boolean {
  const first = a.display.bounds; const second = b.display.bounds;
  return a.display.id === b.display.id && first.x === second.x && first.y === second.y
    && first.width === second.width && first.height === second.height;
}

/** Associate nearby observations, not semantic targets or inferred word times. */
export function alignFrames(history: AttentionHistory): FrameContext[] {
  const frames = [...history.frames].sort((a, b) => a.atMs - b.atMs);
  const contexts = [...history.contexts].sort((a, b) => a.atMs - b.atMs);
  const cursor = [...history.cursor].sort((a, b) => a.atMs - b.atMs);
  // Selection changes do not split paths, but unknown focus starts a new era.
  const boundaries = contexts.filter((sample, index) => index === 0
    || windowIdentity(sample) !== windowIdentity(contexts[index - 1]!));
  const eraAt = (atMs: number) => boundaries.findLastIndex((sample) => sample.atMs <= atMs);

  return frames.map((frame, index) => {
    const previous = frames[index - 1]; const next = frames[index + 1];
    const era = eraAt(frame.atMs);
    const eraStart = boundaries[era]?.atMs ?? 0;
    const eraEnd = boundaries[era + 1]?.atMs ?? Infinity;
    const startMs = Math.max(0, frame.atMs - frameRadiusMs, eraStart,
      previous ? (previous.atMs + frame.atMs) / 2 : 0);
    const endMs = Math.min(history.durationMs, frame.atMs + frameRadiusMs, eraEnd,
      next ? (frame.atMs + next.atMs) / 2 : Infinity);
    const warnings = ['Screen content may change between sampled captures; nearby cursor and speech observations are approximate context.'];
    const trails: FrameContext['trails'] = [];
    let path: FramePoint[] | undefined;
    let lastAt = -Infinity;
    let pointCount = 0;
    for (const sample of cursor) {
      if (sample.atMs < startMs || sample.atMs > endMs) continue;
      const point = eraAt(sample.atMs) === era ? normalize(sample, frame) : null;
      if (!point) { path = undefined; continue; }
      if (pointCount === maxTrailPoints) {
        warnings.push(`Cursor trails are limited to the first ${maxTrailPoints} observations in this interval.`);
        break;
      }
      if (!path || sample.atMs - lastAt > maxCursorGapMs) {
        path = []; trails.push({ points: path });
      }
      path.push(point); pointCount++; lastAt = sample.atMs;
    }

    const lastCursor = cursor.findLast((sample) => sample.atMs <= frame.atMs);
    let pointer = lastCursor && eraAt(lastCursor.atMs) === era ? normalize(lastCursor, frame) : null;
    if (pointer && lastCursor) {
      // A held position cannot survive observed display switches or geometry changes.
      const interveningFrames = frames.filter((sample) => sample.atMs > lastCursor.atMs && sample.atMs <= frame.atMs);
      const priorDisplayFrame = frames.findLast((sample) => sample.atMs <= lastCursor.atMs && sample.display.id === frame.display.id);
      if (interveningFrames.some((sample) => !sameDisplay(sample, frame))
        || (priorDisplayFrame && !sameDisplay(priorDisplayFrame, frame))) pointer = null;
    }
    if (pointer && frame.atMs - pointer.atMs > maxCursorGapMs) {
      warnings.push(`Last observed cursor position is ${Math.round(frame.atMs - pointer.atMs)} ms older than this frame; no new position is inferred.`);
    }
    if (era < 0 || windowIdentity(boundaries[era]!) === null) {
      warnings.push('The active window was unknown at capture; cursor paths do not establish window continuity.');
    }

    const priorContext = contexts.findLast((sample) => sample.atMs <= startMs);
    const contextIds = contexts.filter((sample) => (sample === priorContext || sample.atMs > startMs && sample.atMs <= endMs)
      && eraAt(sample.atMs) === era).map((sample) => sample.id);
    const phraseIds = history.transcript.filter((phrase) => phrase.text.trim() && phrase.timing !== 'unavailable'
      && phrase.startMs !== null && phrase.endMs !== null && Number.isFinite(phrase.startMs) && Number.isFinite(phrase.endMs)
      && phrase.startMs >= 0 && phrase.endMs > phrase.startMs && phrase.startMs < endMs && phrase.endMs > startMs).map((phrase) => phrase.id);
    return { frameId: frame.id, atMs: frame.atMs, startMs, endMs, phraseIds, contextIds, trails, pointer, warnings };
  });
}
