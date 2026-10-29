import type { NativeVoiceEvent } from './desktop/voice-types.js';

type AudioEvent = Extract<NativeVoiceEvent, { type: 'audio' }>;
export type AudioTiming = 'device' | 'estimated' | 'unavailable';
export interface AudioSummary {
  sampleRate: 24000;
  samples: number;
  durationMs: number;
  firstCapturedAtMs: number | null;
  lastCapturedAtMs: number | null;
  firstReceivedAtMs: number | null;
  maxDeliveryLagMs: number | null;
  timing: AudioTiming;
}
interface CaptureSpan {
  startSample: number; endSample: number;
  startMs: number; endMs: number; timing: AudioTiming;
}
const milliseconds = (samples: number) => samples / 24;
const rounded = (value: number) => Math.round(value * 1000) / 1000;

/** Maps provider sample offsets onto native capture time, never transcript delivery. */
export class AudioTimeline {
  readonly summary: AudioSummary = { sampleRate: 24000, samples: 0, durationMs: 0,
    firstCapturedAtMs: null, lastCapturedAtMs: null, firstReceivedAtMs: null,
    maxDeliveryLagMs: null, timing: 'unavailable' };
  private spans: CaptureSpan[] = [];

  constructor(private readonly epochStart: number, private readonly warn: (message: string) => void) {}

  append(event: AudioEvent, byteLength: number, receivedAtMs: number) {
    const count = byteLength / 2;
    if (!Number.isSafeInteger(count) || count < 1 || event.startSample !== this.summary.samples
      || event.startSample + count > 120 * 24000) {
      throw new Error('Invalid or discontinuous microphone sample sequence.');
    }
    const capturedAtMs = Date.parse(event.capturedAt) - this.epochStart;
    const startMs = Math.max(0, capturedAtMs);
    const endMs = startMs + milliseconds(count);
    const previous = this.spans.at(-1);
    let timing: AudioTiming = event.timing;
    if (!Number.isFinite(capturedAtMs) || capturedAtMs < -50 || endMs > receivedAtMs + 50
      || (previous && (startMs < previous.startMs || startMs < previous.endMs - 1 || startMs > previous.endMs + 50))) {
      timing = 'unavailable';
      this.warn('Audio capture clock was invalid or discontinuous; affected phrases have no desktop-aligned times.');
    }
    if (event.timing === 'estimated') this.warn('Audio capture time is estimated from the native sample clock; device/pipe buffering may shift speech relative to desktop context.');
    // Compact a stable sample clock, allowing timestamp rounding but no cumulative
    // drift. High-rate device taps must not exhaust history before the turn limit.
    if (previous && timing !== 'unavailable' && previous.timing === timing
      && Math.abs(startMs - (previous.startMs + milliseconds(event.startSample - previous.startSample))) <= 1) {
      previous.endSample += count;
      previous.endMs = previous.startMs + milliseconds(previous.endSample - previous.startSample);
    } else {
      if (this.spans.length >= 8192) throw new Error('Microphone capture clock exceeded its discontinuity limit.');
      this.spans.push({ startSample: event.startSample, endSample: event.startSample + count, startMs, endMs, timing });
    }
    const first = this.summary.samples === 0;
    this.summary.samples += count;
    this.summary.durationMs = rounded(milliseconds(this.summary.samples));
    this.summary.firstReceivedAtMs ??= receivedAtMs;
    if (first) this.summary.firstCapturedAtMs = timing === 'unavailable' ? null : rounded(startMs);
    this.summary.lastCapturedAtMs = timing === 'unavailable' ? null : rounded(endMs);
    if (timing !== 'unavailable') {
      this.summary.maxDeliveryLagMs = rounded(Math.max(this.summary.maxDeliveryLagMs ?? 0, receivedAtMs - endMs));
    }
    this.summary.timing = first ? timing : this.summary.timing === 'unavailable' || timing === 'unavailable' ? 'unavailable'
      : this.summary.timing === 'estimated' || timing === 'estimated' ? 'estimated' : 'device';
  }

  interval(startSample: number, endSample: number): { startMs: number | null; endMs: number | null; timing: AudioTiming } {
    if (!Number.isSafeInteger(startSample) || !Number.isSafeInteger(endSample)
      || startSample < 0 || endSample <= startSample || endSample > this.summary.samples) {
      throw new Error('Transcript phrase references audio outside the captured sample range.');
    }
    const spans = this.spans.filter((span) => span.startSample < endSample && span.endSample > startSample);
    const first = spans[0]; const last = spans.at(-1);
    if (!first || !last || spans.some((span) => span.timing === 'unavailable')) {
      return { startMs: null, endMs: null, timing: 'unavailable' };
    }
    const startMs = rounded(first.startMs + milliseconds(startSample - first.startSample));
    const endMs = rounded(last.startMs + milliseconds(endSample - last.startSample));
    if (endMs <= startMs) {
      this.warn('Audio timestamp precision could not resolve a phrase interval; its desktop-aligned times were omitted.');
      return { startMs: null, endMs: null, timing: 'unavailable' };
    }
    return { startMs, endMs,
      timing: spans.some((span) => span.timing === 'estimated') ? 'estimated' : 'device' };
  }

  discard() { this.spans.length = 0; }
}
