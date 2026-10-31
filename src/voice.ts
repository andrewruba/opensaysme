import { emitKeypressEvents } from 'node:readline';
import type { Config } from './config.js';
import { desktopAdapter } from './desktop/index.js';
import { cancelDesktopCommands } from './desktop/process.js';
import { startVoiceHelper } from './desktop/voice-process.js';
import { openAITranscription, streamingModel } from './speech/openai.js';
import { VoiceRuntime, type VoiceOutput } from './runtime.js';
import { openAIReasoning } from './reasoning/openai.js';
import { createDebugSession } from './debug-session.js';
import type { DebugSession } from './diagnostics.js';
import { capabilityNames } from './desktop/types.js';
import { createDesktopTools } from './tools/desktop.js';
import { openAIActionAuthorizer } from './reasoning/action-authorization.js';
import { createFeedback } from './feedback.js';
import { defaultActivationHotkey } from './hotkey.js';
import { feedbackUnavailable, startFeedbackHelper, type FeedbackCommand, type FeedbackSink } from './desktop/feedback-process.js';

export async function runVoice(config: Config, signal: AbortSignal, emit: (output: VoiceOutput) => void,
  options: { debugDirectory?: string } = {}): Promise<void> {
  const apiKey = process.env[config.speech.apiKeyEnv];
  const reasoningKey = process.env[config.reasoning.apiKeyEnv];
  const activationHotkey = config.activationHotkey ?? defaultActivationHotkey;
  let debug: DebugSession | undefined;
  let feedback: ReturnType<typeof createFeedback> | undefined;
  let feedbackClosed = false;
  const publish = (event: VoiceOutput) => { feedback?.handle(event); emit(event); };
  if (options.debugDirectory !== undefined && !signal.aborted) {
    try {
      debug = await createDebugSession(options.debugDirectory, {
        secrets: [apiKey, reasoningKey].filter((key): key is string => Boolean(key?.trim())),
        onWarning: (message) => emit({ type: 'warning', message }),
      });
      debug.event({ component: 'session', event: 'started', data: { platform: process.platform } });
      emit({ type: 'debug', directory: debug.directory });
    } catch { emit({ type: 'warning', message: 'Could not start debug logging. Check the directory and disk space; voice mode continues.' }); }
  }
  try {
    debug?.event({ component: 'session', event: 'configuration', data: {
      platform: process.platform, speechModel: config.speech.model, reasoningModel: config.reasoning.model,
      speechKeyPresent: Boolean(apiKey?.trim()), reasoningKeyPresent: Boolean(reasoningKey?.trim()),
    } });
    if (!apiKey?.trim()) throw new Error(`Set ${config.speech.apiKeyEnv} in your environment before starting voice mode.`);
    if (config.speech.model !== streamingModel) throw new Error(`Set speech.model to "${streamingModel}" for live transcription.`);
    if (!config.shareVisualContext) throw new Error('Run opensaysme setup --replace to enable visual context sharing.');
    if (!reasoningKey?.trim()) throw new Error(`Set ${config.reasoning.apiKeyEnv} in your environment before starting reasoning.`);
    if (signal.aborted) return;
    const reason = openAIReasoning({ apiKey: reasoningKey, model: config.reasoning.model });
    const authorize = openAIActionAuthorizer({ apiKey: reasoningKey, model: config.reasoning.model });
    const adapter = await desktopAdapter();
    if (adapter.feedbackHelper) {
      let sink: FeedbackSink | undefined;
      let pending: FeedbackCommand | undefined;
      feedback = createFeedback({
        send(command) { if (sink) sink.send(command); else pending = command; },
        async close() { pending = undefined; await sink?.close(); },
      }, activationHotkey);
      // Resolve/start optional UI alongside voice startup; it never delays listening.
      void Promise.resolve().then(() => adapter.feedbackHelper!()).then((feedbackSpec) => {
        if (signal.aborted || feedbackClosed) return;
        sink = startFeedbackHelper(feedbackSpec, () => emit({ type: 'warning', message: feedbackUnavailable }));
        if (pending) { sink.send(pending); pending = undefined; }
      }).catch(() => { if (!feedbackClosed) emit({ type: 'warning', message: feedbackUnavailable }); });
    }
    if (debug) {
      // Read-only checks run alongside startup; neither permission requests nor captures.
      debug.event({ component: 'desktop', event: 'capabilities-check-started' });
      void adapter.probe().then((report) => {
        debug?.event({ component: 'desktop', event: 'detected', data: { platform: report.platform, session: report.session } });
        for (const capability of capabilityNames) debug?.event({ component: 'desktop', event: 'capability', data: {
          capability, status: report.capabilities[capability].status,
        } });
      }).catch(() => debug?.event({ component: 'desktop', event: 'capabilities-check-failed' }));
    }
    debug?.event({ component: 'desktop', event: 'helper-starting' });
    const spec = await adapter.voiceHelper(activationHotkey);
    if (signal.aborted) return;
    const input = startVoiceHelper(spec, (event) => runtime.handle(event));
    const runtime = new VoiceRuntime({ input, transcribe: openAITranscription, captureContext: adapter.captureContext,
      captureFrame: adapter.captureFrame, reason, createTools: (request, referenceContext, conversation) => createDesktopTools(adapter, { request, referenceContext, conversation, authorize }),
      deadlines: { reasoning: adapter.input ? 95_000 : 50_000 },
      debug, apiKey, model: config.speech.model, emit: publish });
    let resolveStopped!: () => void;
    const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
    const onAbort = () => { debug?.event({ component: 'session', event: 'stop-requested' });
      feedbackClosed = true; void feedback?.close(); runtime.close(); resolveStopped(); };
    signal.addEventListener('abort', onAbort, { once: true });
    const wasRaw = process.stdin.isRaw;
    const wasFlowing = process.stdin.readableFlowing;
    const keypress = (_text: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      if (key.name === 'escape') runtime.cancel();
      if (key.ctrl && key.name === 'c') onAbort();
    };
    try {
      if (process.stdin.isTTY) {
        emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
        process.stdin.on('keypress', keypress);
        process.stdin.resume();
      }
      if (signal.aborted) onAbort();
      await Promise.race([input.ready, stopped, runtime.fatal]);
      await Promise.race([input.done, stopped, runtime.fatal]);
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (process.stdin.isTTY) {
        process.stdin.off('keypress', keypress);
        process.stdin.setRawMode(Boolean(wasRaw));
        if (wasFlowing !== true) process.stdin.pause();
      }
      runtime.close();
      debug?.event({ component: 'desktop', event: 'helper-cleanup-started' });
      await input.close();
      debug?.event({ component: 'desktop', event: 'helper-closed' });
    }
  } catch (error) {
    // Provider/native errors may contain private input; detailed safe event codes
    // are recorded at their source instead of serializing arbitrary exceptions.
    debug?.event({ component: 'session', event: 'failed', data: { code: 'voice-start-or-run-failed' } });
    throw error;
  } finally {
    feedbackClosed = true;
    await feedback?.close();
    if (debug) {
      cancelDesktopCommands();
      debug.event({ component: 'session', event: 'stopped' });
      await debug.close();
    }
  }
}
