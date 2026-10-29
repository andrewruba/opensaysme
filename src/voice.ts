import { emitKeypressEvents } from 'node:readline';
import type { Config } from './config.js';
import { desktopAdapter } from './desktop/index.js';
import { startVoiceHelper } from './desktop/voice-process.js';
import { openAITranscription, streamingModel } from './speech/openai.js';
import { VoiceRuntime, type VoiceOutput } from './runtime.js';

export async function runVoice(config: Config, signal: AbortSignal, emit: (output: VoiceOutput) => void): Promise<void> {
  const apiKey = process.env[config.speech.apiKeyEnv];
  if (!apiKey?.trim()) throw new Error(`Set ${config.speech.apiKeyEnv} in your environment before starting voice mode.`);
  if (config.speech.model !== streamingModel) throw new Error(`Set speech.model to "${streamingModel}" for live transcription.`);
  if (signal.aborted) return;
  const adapter = await desktopAdapter();
  const spec = await adapter.voiceHelper();
  if (signal.aborted) return;
  const input = startVoiceHelper(spec, (event) => runtime.handle(event));
  const runtime = new VoiceRuntime({ input, transcribe: openAITranscription, captureContext: adapter.captureContext,
    apiKey, model: config.speech.model, emit });
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const onAbort = () => { runtime.close(); resolveStopped(); };
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
    await input.close();
  }
}
