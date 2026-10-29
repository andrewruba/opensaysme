import { expect, it, vi } from 'vitest';
import { AudioTimeline } from '../src/audio-timeline.js';
import { nativeVoiceEventSchema, type NativeVoiceEvent } from '../src/desktop/voice-types.js';

const epoch = Date.parse('2026-10-28T12:00:00Z');
function event(startSample: number, atMs: number, timing: 'device' | 'estimated' = 'device'): Extract<NativeVoiceEvent, { type: 'audio' }> {
  return { type: 'audio', turnId: 'turn', startSample, capturedAt: new Date(epoch + atMs).toISOString(), timing, data: 'AAA=' };
}

it('maps sample offsets using capture timestamps despite uneven delivery delays', () => {
  const clock = new AudioTimeline(epoch, vi.fn());
  clock.append(event(0, 100), 4800, 600);
  clock.append(event(2400, 200), 4800, 1500);
  expect(clock.interval(1200, 3600)).toEqual({ startMs: 150, endMs: 250, timing: 'device' });
  expect(clock.interval(0, 2400)).toEqual({ startMs: 100, endMs: 200, timing: 'device' });
  expect(clock.interval(2400, 4800)).toEqual({ startMs: 200, endMs: 300, timing: 'device' });
  expect(clock.summary).toMatchObject({ samples: 4800, durationMs: 200, firstCapturedAtMs: 100,
    lastCapturedAtMs: 300, firstReceivedAtMs: 600, maxDeliveryLagMs: 1200 });
});

it('keeps estimated device timing explicit without discarding useful sample alignment', () => {
  const warn = vi.fn(); const clock = new AudioTimeline(epoch, warn);
  clock.append(event(0, 100, 'estimated'), 4800, 600);
  clock.append(event(2400, 200), 4800, 600);
  expect(clock.interval(0, 4800)).toEqual({ startMs: 100, endMs: 300, timing: 'estimated' });
  expect(clock.summary.timing).toBe('estimated');
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('buffering'));
});

it('never substitutes arrival time for an invalid or discontinuous capture clock', () => {
  const warn = vi.fn(); const clock = new AudioTimeline(epoch, warn);
  clock.append(event(0, 100), 4800, 200);
  clock.append(event(2400, 1200), 4800, 1300);
  expect(clock.interval(0, 4800)).toEqual({ startMs: null, endMs: null, timing: 'unavailable' });
  expect(clock.interval(0, 2400)).toMatchObject({ startMs: 100, endMs: 200 });
  expect(clock.summary.timing).toBe('unavailable');
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('discontinuous'));
  const future = new AudioTimeline(epoch, warn);
  future.append(event(0, 5000), 4800, 100);
  expect(future.interval(0, 2400)).toMatchObject({ startMs: null, endMs: null, timing: 'unavailable' });
  const backwards = new AudioTimeline(epoch, warn);
  backwards.append(event(0, 100), 48, 200);
  backwards.append(event(24, 90), 48, 200);
  expect(backwards.interval(0, 48)).toEqual({ startMs: null, endMs: null, timing: 'unavailable' });
  const rounding = new AudioTimeline(epoch, warn);
  rounding.append(event(0, 100), 4800, 200);
  rounding.append(event(2400, 199, 'estimated'), 2, 210);
  expect(rounding.interval(2399, 2401)).toEqual({ startMs: null, endMs: null, timing: 'unavailable' });
});

it('keeps high-rate device callbacks bounded without truncating a two-minute turn', () => {
  const clock = new AudioTimeline(epoch, vi.fn());
  // 1024 input samples at 96 kHz produce 256 output samples per tap.
  for (let start = 0; start < 120 * 24000; start += 256) {
    clock.append(event(start, 100 + start / 24), 512, 200 + start / 24);
  }
  expect(clock.summary.samples).toBe(120 * 24000);
  expect(clock.interval(0, 120 * 24000)).toMatchObject({ startMs: 100, endMs: 120100, timing: 'device' });
});

it('rejects lost/repeated samples and provider intervals outside captured audio', () => {
  const clock = new AudioTimeline(epoch, vi.fn());
  clock.append(event(0, 100), 4800, 200);
  expect(() => clock.append(event(4800, 300), 4800, 400)).toThrow('sample sequence');
  expect(() => clock.append(event(0, 100), 4800, 200)).toThrow('sample sequence');
  expect(() => clock.append(event(2400, 200), 3, 300)).toThrow('sample sequence');
  for (const [start, end] of [[-1, 10], [0.5, 10], [0, 2401], [1, 0]]) {
    expect(() => clock.interval(start!, end!)).toThrow('sample range');
  }
  clock.discard();
  expect(clock.interval(0, 2400)).toMatchObject({ timing: 'unavailable' });
});

it('requires bounded sample offsets and capture timestamp metadata from the native helper', () => {
  expect(nativeVoiceEventSchema.safeParse(event(0, 100)).success).toBe(true);
  for (const patch of [{ startSample: -1 }, { startSample: 0.5 }, { startSample: 120 * 24000 + 1 },
    { capturedAt: 'invalid' }, { timing: 'precise' }, { capturedAt: undefined }]) {
    expect(nativeVoiceEventSchema.safeParse({ ...event(0, 100), ...patch }).success).toBe(false);
  }
});
