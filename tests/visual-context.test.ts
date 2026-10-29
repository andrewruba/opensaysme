import { expect, it } from 'vitest';
import type { AttentionFrame, AttentionHistory, ContextSample, CursorSample, TranscriptSample } from '../src/attention.js';
import { alignFrames } from '../src/visual-context.js';

function frame(atMs: number, displayId = 'left'): AttentionFrame {
  return { id: `f${atMs}`, atMs, receivedAtMs: atMs + 20, capturedAt: '2026-10-28T00:00:00.000Z',
    display: { id: displayId, bounds: { x: -1920, y: -200, width: 1920, height: 1080 } },
    image: { mimeType: 'image/jpeg', width: 1600, height: 900, data: '/9j/AA==' }, warnings: [] };
}
function cursor(atMs: number, x = -960, displayId: string | null = 'left', y = 340): CursorSample {
  return { atMs, receivedAtMs: atMs + 10, x, y, displayId };
}
function context(atMs: number, window: string | null = 'editor', selectedText?: string): ContextSample {
  return { id: `c${atMs}`, atMs, receivedAtMs: atMs + 10,
    context: { platform: 'test', capturedAt: '2026-10-28T00:00:00.000Z',
      activeWindow: window === null ? null : { id: window, application: 'App' }, selectedText, warnings: [] } };
}
function phrase(id: string, startMs: number | null, endMs: number | null): TranscriptSample {
  return { id, text: 'use this and then that', startMs, endMs, timing: 'device', receivedAtMs: 9000,
    startSample: 0, endSample: 24000, boundary: 'pause' };
}
function history(input: Partial<AttentionHistory> = {}): AttentionHistory {
  return { frames: [frame(1000)], contexts: [context(0)], cursor: [], transcript: [], warnings: [], durationMs: 3000,
    audio: { sampleRate: 24000, samples: 0, durationMs: 0, firstCapturedAtMs: null, lastCapturedAtMs: null,
      firstReceivedAtMs: null, maxDeliveryLagMs: null, timing: 'unavailable' }, ...input };
}

it('maps negative desktop coordinates to the full scaled image and preserves original times', () => {
  const input = history({ cursor: [cursor(900, -1440, 'left', 70), cursor(1000), cursor(1100, -480, 'left', 610)] });
  const before = structuredClone(input);
  const [view] = alignFrames(input);
  expect(view).toMatchObject({ frameId: 'f1000', atMs: 1000, startMs: 250, endMs: 1750,
    trails: [{ points: [{ x: 0.25, y: 0.25, atMs: 900 }, { x: 0.5, y: 0.5, atMs: 1000 }, { x: 0.75, y: 0.75, atMs: 1100 }] }],
    pointer: { x: 0.5, y: 0.5, atMs: 1000 }, contextIds: ['c0'] });
  expect(input).toEqual(before);
});

it('uses global adjacent capture midpoints and breaks paths when display identity is lost or changes', () => {
  const input = history({ frames: [frame(1600, 'right'), frame(1000)], cursor: [
    cursor(900), cursor(950, -800, 'right'), cursor(1000, -700), cursor(1050, -600, null),
    cursor(1100, -500), cursor(1200, 0), cursor(1250, -400), cursor(1350, -300),
  ] });
  const views = alignFrames(input);
  expect(views.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([[250, 1300], [1300, 2350]]);
  expect(views[0]!.trails.map(({ points }) => points.map(({ atMs }) => atMs))).toEqual([[900], [1000], [1100], [1250]]);
  expect(views[1]!.trails).toEqual([]);
  expect(views[1]!.pointer).toBeNull();
});

it('clips windows at focus changes and unknown focus but ignores selection-only changes', () => {
  const input = history({ frames: [frame(1000), frame(1600), frame(2000)],
    contexts: [context(0), context(800, 'editor', 'new selection'), context(1200, 'browser'), context(1800, null), context(2100, 'editor')],
    cursor: [cursor(700), cursor(850), cursor(1000), cursor(1150), cursor(1200), cursor(1300), cursor(1800), cursor(1900), cursor(2100)] });
  const views = alignFrames(input);
  expect(views.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([[250, 1200], [1300, 1800], [1800, 2100]]);
  expect(views[0]!.contextIds).toEqual(['c0', 'c800']);
  expect(views[0]!.trails[0]!.points.map(({ atMs }) => atMs)).toEqual([700, 850, 1000, 1150]);
  expect(views[1]!.trails.flatMap(({ points }) => points.map(({ atMs }) => atMs))).toEqual([1300]);
  expect(views[2]!.trails[0]!.points.map(({ atMs }) => atMs)).toEqual([1800, 1900]);
  expect(views[2]!.warnings.join(' ')).toContain('active window was unknown');
});

it('splits long sample gaps without interpolating and labels the age of a stationary cursor', () => {
  const [view] = alignFrames(history({ cursor: [cursor(300), cursor(400), cursor(800)] }));
  expect(view!.trails.map(({ points }) => points.map(({ atMs }) => atMs))).toEqual([[300, 400], [800]]);
  const [stationary] = alignFrames(history({ cursor: [cursor(100)] }));
  expect(stationary!.trails).toEqual([]);
  expect(stationary!.pointer).toEqual({ x: 0.5, y: 0.5, atMs: 100 });
  expect(stationary!.warnings.join(' ')).toContain('900 ms older');
});

it('does not revive a stale pointer through unknown events, focus changes, or display changes', () => {
  expect(alignFrames(history({ cursor: [cursor(100), cursor(900, -800, null)] }))[0]!.pointer).toBeNull();
  expect(alignFrames(history({ cursor: [cursor(100)], contexts: [context(0), context(600, 'browser')] }))[0]!.pointer).toBeNull();
  expect(alignFrames(history({ cursor: [cursor(100)], frames: [frame(500, 'right'), frame(1000)] }))[1]!.pointer).toBeNull();
  const resized = frame(1000); resized.display.bounds.width = 1280;
  expect(alignFrames(history({ cursor: [cursor(100)], frames: [frame(0), resized] }))[1]!.pointer).toBeNull();
});

it('associates overlapping speech envelopes with multiple views without forcing a target', () => {
  const shared = phrase('shared', 1000, 2200);
  const input = history({ frames: [frame(1000), frame(2000)], transcript: [
    phrase('before', 0, 250), phrase('first', 800, 1000), shared, phrase('last', 2600, 2800),
    { ...phrase('estimated', 1700, 1800), timing: 'estimated' },
  ] });
  const views = alignFrames(input);
  expect(views.map(({ phraseIds }) => phraseIds)).toEqual([['first', 'shared'], ['shared', 'last', 'estimated']]);
  expect(views[0]).not.toHaveProperty('target');
  expect(shared).toEqual(phrase('shared', 1000, 2200));
});

it('omits unavailable, empty, or invalid speech timing rather than using delivery time', () => {
  const [view] = alignFrames(history({ transcript: [
    { ...phrase('unavailable', 800, 1200), timing: 'unavailable' }, phrase('null', null, null),
    { ...phrase('empty', 800, 1200), text: '  ' }, phrase('reversed', 1200, 800), phrase('nan', NaN, 1200), phrase('negative', -10, 1200),
  ] }));
  expect(view!.phraseIds).toEqual([]);
  expect(view!.warnings.join(' ')).toContain('Screen content may change');
});

it('bounds dense paths deterministically without connecting observations beyond the cap', () => {
  const input = history({ cursor: Array.from({ length: 300 }, (_, index) => cursor(800 + index, -1000 + index)) });
  const [view] = alignFrames(input);
  expect(view!.trails.flatMap(({ points }) => points)).toHaveLength(128);
  expect(view!.trails.at(-1)!.points.at(-1)!.atMs).toBe(927);
  expect(view!.pointer!.atMs).toBe(1000);
  expect(view!.warnings.join(' ')).toContain('first 128');
  expect(alignFrames(input)).toEqual([view]);
});
