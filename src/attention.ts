import type { DesktopContext, NativeVoiceEvent } from './desktop/voice-types.js';
import { desktopContextSchema } from './desktop/voice-types.js';
import { screenFrameCaptureSchema, type ScreenFrameCapture } from './desktop/visual-types.js';
import { AudioTimeline, type AudioSummary, type AudioTiming } from './audio-timeline.js';
import type { TranscriptionPhrase } from './speech/types.js';
import { DesktopError, desktopIssue, desktopMessages, type DesktopIssue } from './desktop/errors.js';

export interface AttentionFrame extends ScreenFrameCapture { id: string; atMs: number; receivedAtMs: number }
export interface ContextSample { id: string; atMs: number; receivedAtMs: number; context: DesktopContext }
export interface CursorSample { atMs: number; receivedAtMs: number; x: number; y: number; displayId: string | null }
export interface TranscriptSample extends TranscriptionPhrase {
  startMs: number | null; endMs: number | null; receivedAtMs: number; timing: AudioTiming;
}
export interface AttentionHistory {
  frames: AttentionFrame[];
  contexts: ContextSample[];
  cursor: CursorSample[];
  transcript: TranscriptSample[];
  warnings: string[];
  durationMs: number;
  audio: AudioSummary;
}
interface AttentionOptions {
  captureContext: (signal: AbortSignal) => Promise<DesktopContext>;
  captureFrame: (signal: AbortSignal) => Promise<ScreenFrameCapture>;
  now: () => number;
  epochStart: number;
  signal: AbortSignal;
  frameIntervalMs?: number;
  contextIntervalMs?: number;
  captureTimeoutMs?: number;
  onDesktopIssue?: (issue: DesktopIssue) => void;
}

// Retain the first and latest observations and thin crowded interior samples.
// No gesture classification or content category influences this selection.
function thin<T extends { atMs: number }>(samples: T[], limit: number) {
  while (samples.length > limit) {
    let remove = 1;
    for (let i = 2; i < samples.length - 1; i++) {
      if (samples[i + 1]!.atMs - samples[i - 1]!.atMs < samples[remove + 1]!.atMs - samples[remove - 1]!.atMs) remove = i;
    }
    samples.splice(remove, 1);
  }
}

export class AttentionCollector {
  private history: AttentionHistory;
  private readonly audioTimeline: AudioTimeline;
  private stopped = false;
  private discarded = false;
  private controller = new AbortController();
  private timers = new Set<NodeJS.Timeout>();
  private frameSequence = 0;
  private contextSequence = 0;
  private lastContext = '';
  private lastCursorAt = -Infinity;
  private transcriptBytes = 0;
  private frameFailures = 0;
  private readonly reportedIssues = new Set<DesktopIssue>();
  private readonly abort = () => this.discard();

  constructor(private readonly options: AttentionOptions) {
    this.audioTimeline = new AudioTimeline(options.epochStart, (message) => this.warn(message));
    this.history = { frames: [], contexts: [], cursor: [], transcript: [], warnings: [
      'Transcript intervals cover committed audio phrases, including pauses; they are not word timestamps. Limit boundaries may split words.',
      'Screen frames are sampled; cursor paths between frames do not prove that screen content stayed unchanged.',
    ], durationMs: 0, audio: this.audioTimeline.summary };
    options.signal.addEventListener('abort', this.abort, { once: true });
    if (options.signal.aborted) { this.discard(); return; }
    void this.collectFrame();
    void this.collectContext();
  }

  private warn(message: string) {
    if (!this.history.warnings.includes(message) && this.history.warnings.length < 16) this.history.warnings.push(message);
  }
  private desktopWarning(issue: DesktopIssue) {
    this.warn(desktopMessages[issue]);
    if (this.reportedIssues.has(issue)) return;
    this.reportedIssues.add(issue);
    try { this.options.onDesktopIssue?.(issue); } catch { /* Optional feedback cannot stop collection. */ }
  }
  private time(capturedAt: string, receivedAtMs: number, requestedAtMs = 0): number {
    // Native clocks are wall timestamps. Map them to the turn's monotonic epoch,
    // reject clock jumps, and retain receipt time to expose IPC/capture delay.
    const value = Date.parse(capturedAt) - this.options.epochStart;
    if (value < requestedAtMs - 50 || value > receivedAtMs + 50 || !Number.isFinite(value)) {
      this.warn('A native capture timestamp was outside its request interval; delivery time was used instead.');
      return receivedAtMs;
    }
    return Math.max(0, Math.min(receivedAtMs, value));
  }
  private later(action: () => void, delay: number) {
    if (this.stopped) return;
    const timer = setTimeout(() => { this.timers.delete(timer); if (!this.stopped) action(); }, delay);
    this.timers.add(timer);
  }
  private async capture<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const local = new AbortController();
    const signal = AbortSignal.any([local.signal, this.controller.signal]);
    let deadline: NodeJS.Timeout | undefined;
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(local.signal.aborted ? new DesktopError('timeout') : new Error('Capture stopped.'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      deadline = setTimeout(() => local.abort(), this.options.captureTimeoutMs ?? 3000);
    });
    try { return await Promise.race([Promise.resolve().then(() => operation(signal)), cancelled]); }
    finally { clearTimeout(deadline); signal.removeEventListener('abort', abort); }
  }
  private async collectFrame() {
    const requested = this.options.now();
    try {
      const frame = screenFrameCaptureSchema.parse(await this.capture(this.options.captureFrame));
      if (this.stopped) return;
      const bytes = Buffer.from(frame.image.data, 'base64');
      if (bytes.length > 1_000_000 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error('Invalid image.');
      const receivedAtMs = this.options.now();
      // Keep repeated captures: a static screen can have new speech or pointer
      // activity, and a historical timestamp must not stand in for a later frame.
      this.history.frames.push({ ...frame, id: `f${++this.frameSequence}`, atMs: this.time(frame.capturedAt, receivedAtMs, requested), receivedAtMs });
      if (this.history.frames.length > 12) this.warn('Screen history was sampled to retain at most twelve representative frames.');
      thin(this.history.frames, 12);
      while (this.history.frames.reduce((sum, item) => sum + item.image.data.length, 0) > 8_000_000) {
        thin(this.history.frames, this.history.frames.length - 1);
        this.warn('Screen history was sampled to fit its image memory limit.');
      }
      frame.warnings.forEach((warning) => this.warn(warning));
      this.frameFailures = 0;
    } catch (error) {
      if (!this.stopped) {
        const issue = desktopIssue(error);
        if (issue) this.desktopWarning(issue);
        else this.warn('Screen capture failed without a known cause. Run opensaysme setup to verify local access.');
        this.frameFailures++;
      }
    } finally {
      // Repeated permission/prerequisite failures must not spawn helpers forever.
      if (this.frameFailures < 2) this.later(() => { void this.collectFrame(); }, this.options.frameIntervalMs ?? 1500);
    }
  }
  private async collectContext() {
    const requested = this.options.now();
    try {
      const context = desktopContextSchema.parse(await this.capture(this.options.captureContext));
      if (this.stopped) return;
      if ((context.selectedText?.length ?? 0) > 4096) {
        context.selectedText = context.selectedText!.slice(0, 4096);
        this.warn('Some selected text was truncated to bound the attention history.');
      }
      for (const window of [context.activeWindow, context.pointer?.window]) if (window?.title) window.title = window.title.slice(0, 1024);
      const fingerprint = JSON.stringify([context.activeWindow, context.selectedText, context.pointer?.window, context.warnings]);
      if (fingerprint !== this.lastContext) {
        const receivedAtMs = this.options.now();
        this.history.contexts.push({ id: `c${++this.contextSequence}`, atMs: this.time(context.capturedAt, receivedAtMs, requested), receivedAtMs, context });
        this.lastContext = fingerprint;
        if (this.history.contexts.length > 24) this.warn('Window/selection history was sampled to retain at most twenty-four observations.');
        thin(this.history.contexts, 24);
      }
      context.warnings.forEach((warning) => this.warn(warning));
      context.issues?.forEach((issue) => this.desktopWarning(issue));
    } catch (error) {
      if (!this.stopped) {
        const issue = desktopIssue(error);
        if (issue) this.desktopWarning(issue);
        else this.warn('Some window or selection context was unavailable without a known cause.');
      }
    } finally { this.later(() => { void this.collectContext(); }, this.options.contextIntervalMs ?? 1000); }
  }

  pointer(event: Extract<NativeVoiceEvent, { type: 'pointer' }>) {
    if (this.stopped) return;
    const receivedAtMs = this.options.now();
    const previous = this.history.cursor.at(-1);
    if (previous && previous.x === event.x && previous.y === event.y && previous.displayId === event.displayId) return;
    const atMs = this.time(event.capturedAt, receivedAtMs);
    if (previous && atMs < previous.atMs) { this.warn('Out-of-order cursor samples were omitted.'); return; }
    if (atMs - this.lastCursorAt < 80 && previous?.displayId === event.displayId) return;
    this.lastCursorAt = atMs;
    this.history.cursor.push({ atMs, receivedAtMs, x: event.x, y: event.y, displayId: event.displayId });
    if (this.history.cursor.length > 1500) { thin(this.history.cursor, 1500); this.warn('Cursor history was thinned to its sample limit.'); }
  }
  phrase(phrase: TranscriptionPhrase): TranscriptSample | undefined {
    // Final phrases can arrive out of order and after visual capture freezes.
    if (this.discarded) return;
    if (this.history.transcript.some((sample) => sample.id === phrase.id
      || (sample.startSample < phrase.endSample && sample.endSample > phrase.startSample))) {
      throw new Error('Duplicate or overlapping transcript phrase.');
    }
    this.transcriptBytes += Buffer.byteLength(phrase.text);
    if (this.transcriptBytes > 65_536 || this.history.transcript.length >= 512) throw new Error('Transcript timing history exceeded its limit.');
    const sample = { ...phrase, ...this.audioTimeline.interval(phrase.startSample, phrase.endSample), receivedAtMs: this.options.now() };
    this.history.transcript.push(sample);
    this.history.transcript.sort((a, b) => a.startSample - b.startSample);
    return sample;
  }
  audio(event: Extract<NativeVoiceEvent, { type: 'audio' }>, byteLength: number) {
    // Native audio drains after the stopping tap; do not lose its final sample offsets.
    if (!this.discarded) this.audioTimeline.append(event, byteLength, this.options.now());
  }
  freeze(): AttentionHistory {
    if (!this.stopped) {
      this.stopped = true;
      this.history.durationMs = this.options.now();
      this.timers.forEach(clearTimeout); this.timers.clear();
      this.controller.abort();
      if (!this.history.frames.length) this.warn('No screen frames were captured for this turn.');
      if (!this.history.contexts.length) this.warn('No window/selection context was captured for this turn.');
      if (!this.history.cursor.length) this.warn('No cursor trajectory was captured for this turn.');
    }
    return this.history;
  }
  discard() {
    this.freeze();
    this.discarded = true;
    this.audioTimeline.discard();
    this.options.signal.removeEventListener('abort', this.abort);
    this.history.frames.length = 0;
    this.history.contexts.length = 0;
    this.history.cursor.length = 0;
    this.history.transcript.length = 0;
    this.lastContext = '';
    this.transcriptBytes = 0;
  }
}

// Only metadata leaves the runtime output. Image payloads stay in memory for the
// explicitly configured reasoning request and are never printed into scrollback.
export function attentionSummary(history: AttentionHistory) {
  return { ...history, frames: history.frames.map(({ image, ...frame }) => ({ ...frame,
    image: { mimeType: image.mimeType, width: image.width, height: image.height } })),
  contexts: [...history.contexts], cursor: [...history.cursor], transcript: [...history.transcript],
  warnings: [...history.warnings], audio: { ...history.audio } };
}
