import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { DesktopContext, NativeVoiceEvent } from './desktop/voice-types.js';
import type { ScreenFrameCapture } from './desktop/visual-types.js';
import { AttentionCollector, attentionSummary } from './attention.js';
import type { ReasoningFactory } from './reasoning/types.js';
import { prepareVisualContext, discardVisualContext, visualContextSummary, type PreparedVisualContext } from './visual-input.js';
import type { VoiceInput } from './desktop/voice-process.js';
import type { TranscriptionFactory, TranscriptionSession } from './speech/types.js';

export type VoiceState = 'ready' | 'starting' | 'listening' | 'processing' | 'interpreting' | 'cancelling';
export interface LatencyMeasurements {
  activationToListeningMs?: number;
  activationToFirstAudioMs?: number;
  activationToProviderReadyMs?: number;
  activationToFirstTranscriptMs?: number;
  activationToFirstPhraseMs?: number;
  maxPhraseFinalizationMs?: number;
  maxAudioDeliveryLagMs?: number;
  stopToFinalTranscriptMs?: number;
  stopToResultMs?: number;
  contextCaptureMs?: number;
  visualPreparationMs?: number;
  reasoningMs?: number;
  stopToResponseMs?: number;
  recordingMs?: number;
  totalMs?: number;
}
export type VoiceOutput =
  | { type: 'state'; state: VoiceState; turnId?: string }
  | { type: 'partial'; turnId: string; text: string }
  | { type: 'transcript'; turnId: string; text: string }
  | { type: 'cancelled'; turnId: string }
  | { type: 'error'; turnId?: string; message: string }
  | { type: 'result'; turnId: string; transcript: string; attention: ReturnType<typeof attentionSummary>;
    visualContext: ReturnType<typeof visualContextSummary>; response: string; latency: LatencyMeasurements };
interface Turn {
  id: string; activated: number; stopped?: number; abort: AbortController;
  attention?: AttentionCollector; session?: TranscriptionSession;
  visual?: PreparedVisualContext;
  metrics: LatencyMeasurements; partial: string; timers: Set<NodeJS.Timeout>;
  startupTimer?: NodeJS.Timeout; stopTimer?: NodeJS.Timeout; captureTimer?: NodeJS.Timeout;
}
export interface VoiceRuntimeOptions {
  input: VoiceInput;
  transcribe: TranscriptionFactory;
  captureContext: (signal: AbortSignal) => Promise<DesktopContext>;
  captureFrame: (signal: AbortSignal) => Promise<ScreenFrameCapture>;
  reason: ReasoningFactory;
  apiKey: string; model: string;
  emit: (output: VoiceOutput) => void;
  now?: () => number;
  deadlines?: { startup?: number; stop?: number; cancel?: number; context?: number; capture?: number; reasoning?: number };
}
const nativeErrors = {
  'hotkey-unavailable': 'The global shortcut is unavailable. Check for conflicting bindings and run opensaysme doctor.',
  'microphone-unavailable': 'The microphone is unavailable. Check the device and microphone permission.',
  'capture-failed': 'Microphone capture failed. Check the recording device and try again.',
  'invalid-command': 'The native voice helper rejected a command. Rebuild the helper.',
  'internal-error': 'The native voice helper failed. Run opensaysme doctor.',
};

export class VoiceRuntime {
  private turn?: Turn;
  private state: VoiceState = 'ready';
  private closed = false;
  private readonly now: () => number;
  private rejectFatal!: (error: Error) => void;
  readonly fatal: Promise<never>;
  constructor(private readonly options: VoiceRuntimeOptions) {
    this.now = options.now ?? (() => performance.now());
    this.fatal = new Promise((_, reject) => { this.rejectFatal = reject; });
    void this.fatal.catch(() => {});
  }
  private publishState(state: VoiceState) {
    this.state = state;
    this.options.emit({ type: 'state', state, ...(this.turn ? { turnId: this.turn.id } : {}) });
  }
  private timer(turn: Turn, duration: number, action: () => void): NodeJS.Timeout {
    const timer = setTimeout(() => {
      turn.timers.delete(timer);
      if (this.turn === turn && !this.closed) action();
    }, duration);
    turn.timers.add(timer);
    return timer;
  }
  private clearTimer(turn: Turn, timer?: NodeJS.Timeout) {
    clearTimeout(timer);
    if (timer) turn.timers.delete(timer);
  }
  private elapsed(since: number) { return Math.max(0, Math.round(this.now() - since)); }
  private die(message: string) { this.close(); this.rejectFatal(new Error(message)); }

  handle(event: NativeVoiceEvent): void {
    if (this.closed) return;
    if (event.type === 'ready') { this.publishState('ready'); return; }
    if (event.type === 'toggle') { this.toggle(); return; }
    if (event.type === 'cancel') { this.cancel(); return; }
    const turn = this.turn;
    if (event.type === 'error' && !event.turnId) { this.die(nativeErrors[event.code]); return; }
    if (!turn || !('turnId' in event) || event.turnId !== turn.id) return;
    switch (event.type) {
      case 'pointer':
        turn.attention?.pointer(event);
        break;
      case 'audio-started':
        if (this.state === 'cancelling') return;
        turn.metrics.activationToListeningMs ??= this.elapsed(turn.activated);
        this.clearTimer(turn, turn.startupTimer);
        if (this.state === 'starting') this.publishState('listening');
        break;
      case 'audio': {
        if (this.state === 'cancelling') return;
        turn.metrics.activationToFirstAudioMs ??= this.elapsed(turn.activated);
        const pcm = Buffer.from(event.data, 'base64');
        try {
          turn.attention?.audio(event, pcm.length);
          turn.session?.append(pcm);
        } catch { this.cancel('Audio capture timing or streaming failed. Rebuild the native helper and try again.'); }
        finally { pcm.fill(0); }
        break;
      }
      case 'audio-stopped':
        this.clearTimer(turn, turn.stopTimer);
        if (this.state === 'cancelling') { this.reset(turn); return; }
        if (this.state !== 'processing') { this.cancel('Microphone stopped unexpectedly.'); return; }
        this.clearTimer(turn, turn.startupTimer);
        try { turn.session?.commit(); } catch { this.cancel('Could not finalize the speech turn.'); }
        break;
      case 'error': this.cancel(nativeErrors[event.code]); break;
    }
  }

  toggle(): void {
    if (this.closed) return;
    if (!this.turn) { this.start(); return; }
    if (this.state !== 'starting' && this.state !== 'listening') return;
    const turn = this.turn;
    turn.stopped = this.now();
    turn.metrics.recordingMs = this.elapsed(turn.activated);
    turn.attention?.freeze();
    this.clearTimer(turn, turn.captureTimer);
    this.publishState('processing');
    turn.stopTimer = this.timer(turn, this.options.deadlines?.stop ?? 5_000,
      () => this.cancel('The microphone did not stop within five seconds.'));
    try { this.options.input.send({ type: 'stop', turnId: turn.id }); }
    catch { this.die('Desktop voice helper could not stop recording.'); }
  }

  private start() {
    const turn: Turn = { id: randomUUID(), activated: this.now(), abort: new AbortController(), metrics: {}, partial: '', timers: new Set() };
    this.turn = turn;
    this.publishState('starting');
    turn.startupTimer = this.timer(turn, this.options.deadlines?.startup ?? 10_000,
      () => this.cancel('Microphone did not become ready. Check permissions, then tap to retry.'));
    turn.captureTimer = this.timer(turn, this.options.deadlines?.capture ?? 120_000,
      () => { this.options.emit({ type: 'error', turnId: turn.id, message: 'Two-minute recording limit reached; finishing this turn.' }); this.toggle(); });
    try {
      // Begin all three together; desktop access never gates listening.
      this.options.input.send({ type: 'start', turnId: turn.id });
      turn.attention = new AttentionCollector({
        captureContext: this.options.captureContext, captureFrame: this.options.captureFrame,
        now: () => this.elapsed(turn.activated), epochStart: Date.now() - this.elapsed(turn.activated),
        signal: turn.abort.signal, captureTimeoutMs: this.options.deadlines?.context,
      });
      turn.session = this.options.transcribe({
        apiKey: this.options.apiKey, model: this.options.model, signal: turn.abort.signal,
        onPartial: (text) => {
          if (this.turn !== turn || turn.abort.signal.aborted || text === turn.partial) return;
          if (text) turn.metrics.activationToFirstTranscriptMs ??= this.elapsed(turn.activated);
          turn.partial = text;
          if (Buffer.byteLength(text) > 65_536) { this.cancel('Transcript exceeded the turn limit.'); return; }
          this.options.emit({ type: 'partial', turnId: turn.id, text: turn.partial });
        },
        onPhrase: (phrase) => {
          if (this.turn !== turn || turn.abort.signal.aborted) return;
          try {
            const timed = turn.attention?.phrase(phrase);
            turn.metrics.activationToFirstPhraseMs ??= this.elapsed(turn.activated);
            if (timed?.endMs != null) turn.metrics.maxPhraseFinalizationMs = Math.max(turn.metrics.maxPhraseFinalizationMs ?? 0,
              Math.max(0, Math.round(timed.receivedAtMs - timed.endMs)));
          } catch { this.cancel('Transcript timing did not match captured audio. Try another voice turn.'); }
        },
      });
      void turn.session.ready.then(() => {
        if (this.turn === turn && !turn.abort.signal.aborted) turn.metrics.activationToProviderReadyMs = this.elapsed(turn.activated);
      }).catch(() => {}); // finished handles the same failure once.
      void turn.session.finished.then((text) => this.finish(turn, text)).catch((error: unknown) => {
        if (this.turn === turn && !turn.abort.signal.aborted) this.cancel(error instanceof Error ? error.message : 'Transcription failed.');
      });
    } catch (error) { this.cancel(error instanceof Error ? error.message : 'Could not start voice recording.'); }
  }

  private async finish(turn: Turn, transcript: string) {
    if (this.turn !== turn || turn.abort.signal.aborted || this.closed) return;
    if (turn.stopped === undefined) { this.cancel('Speech provider finalized before recording stopped.'); return; }
    turn.metrics.stopToFinalTranscriptMs = this.elapsed(turn.stopped);
    // Final speech remains visible while the bounded reasoning request runs.
    this.options.emit({ type: 'transcript', turnId: turn.id, text: transcript });
    const history = turn.attention!.freeze();
    turn.metrics.contextCaptureMs = history.contexts[0]?.receivedAtMs;
    turn.metrics.maxAudioDeliveryLagMs = history.audio.maxDeliveryLagMs ?? undefined;
    this.publishState('interpreting');
    const started = this.now();
    const deadline = this.timer(turn, this.options.deadlines?.reasoning ?? 30_000,
      () => this.cancel('Reasoning timed out. Try a shorter request.'));
    const visual = await prepareVisualContext(history, turn.abort.signal);
    if (this.turn !== turn || turn.abort.signal.aborted || this.closed) { discardVisualContext(visual); return; }
    turn.visual = visual;
    turn.metrics.visualPreparationMs = this.elapsed(started);
    const reasoningStarted = this.now();
    const response = await this.options.reason({ transcript, history, visual, signal: turn.abort.signal });
    this.clearTimer(turn, deadline);
    turn.metrics.reasoningMs = this.elapsed(reasoningStarted);
    turn.metrics.stopToResponseMs = this.elapsed(turn.stopped);
    if (this.turn !== turn || turn.abort.signal.aborted || this.closed) return;
    turn.metrics.totalMs = this.elapsed(turn.activated);
    turn.metrics.stopToResultMs = this.elapsed(turn.stopped);
    this.options.emit({ type: 'result', turnId: turn.id, transcript, attention: attentionSummary(history),
      visualContext: visualContextSummary(visual), response, latency: { ...turn.metrics } });
    this.reset(turn);
  }

  cancel(message?: string): void {
    const turn = this.turn;
    if (!turn || this.state === 'cancelling' || this.closed) return;
    this.publishState('cancelling');
    for (const timer of turn.timers) clearTimeout(timer);
    turn.timers.clear();
    turn.attention?.discard();
    if (turn.visual) discardVisualContext(turn.visual);
    turn.abort.abort();
    turn.session?.close();
    turn.partial = '';
    this.options.emit(message ? { type: 'error', turnId: turn.id, message } : { type: 'cancelled', turnId: turn.id });
    turn.stopTimer = this.timer(turn, this.options.deadlines?.cancel ?? 2_000,
      () => this.die('Native recording cleanup could not be confirmed. Voice runtime stopped.'));
    try { this.options.input.send({ type: 'cancel', turnId: turn.id }); }
    catch { this.die('Could not cancel native recording. Voice runtime stopped.'); }
  }

  private reset(turn: Turn) {
    if (this.turn !== turn) return;
    for (const timer of turn.timers) clearTimeout(timer);
    turn.attention?.discard();
    if (turn.visual) discardVisualContext(turn.visual);
    turn.abort.abort();
    turn.session?.close();
    turn.partial = '';
    try { this.options.input.send({ type: 'settled', turnId: turn.id }); }
    catch { this.die('Desktop voice helper could not reset for another turn.'); return; }
    this.turn = undefined;
    this.publishState('ready');
  }
  close(): void {
    this.closed = true;
    const turn = this.turn;
    if (!turn) return;
    for (const timer of turn.timers) clearTimeout(timer);
    turn.attention?.discard();
    if (turn.visual) discardVisualContext(turn.visual);
    turn.abort.abort();
    turn.session?.close();
    turn.partial = '';
    this.turn = undefined;
  }
}
