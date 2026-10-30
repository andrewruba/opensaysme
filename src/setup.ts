import { cancel, confirm, intro, isCancel, note, outro, text } from '@clack/prompts';
import { configPath, readConfig, writeConfig } from './config.js';
import { streamingModel } from './speech/openai.js';
import { defaultReasoningModel } from './reasoning/openai.js';

function answer<T>(value: T): Exclude<T, symbol> {
  if (isCancel(value)) {
    cancel('Setup cancelled. No configuration was written.');
    throw new Error('Setup cancelled.');
  }
  return value as Exclude<T, symbol>;
}

export async function setup(signal?: AbortSignal, replace = false): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Setup needs an interactive terminal. See docs/development.md for the configuration format.');
  }
  if (!replace && await readConfig()) throw new Error(`Configuration already exists at ${configPath()}; use setup --replace to reconfigure.`);
  intro('OpenSaysMe setup');
  note(`Voice uses OpenAI ${streamingModel}. When you activate recording,\n`
    + 'microphone audio streams directly to OpenAI using your key. Provider charges apply.\n'
    + 'While recording, screen frames, window/selection context, and cursor paths are captured.\n'
    + 'After stopping, selected frames, attention history, and the transcript go to your\n'
    + 'reasoning provider for a response. Screen content can include private data.\n'
    + 'The agent can inspect more desktop context and switch windows for your request.\n'
    + 'On macOS, this includes accessibility text and screenshots of requested background windows.\n'
    + 'Tool results may also go to your provider. Capture stays in memory by default.\n'
    + 'Setup stores an environment-variable name, never your key, and makes no API request.', 'Voice mode');
  const apiKeyEnv = answer(await text({
    signal,
    message: 'Environment variable containing your OpenAI speech API key',
    initialValue: 'OPENAI_API_KEY',
    validate: (value) => value && /^[A-Z_][A-Z0-9_]{0,127}$/.test(value) ? undefined : 'Enter an uppercase environment-variable name, not a key value.',
  }));
  const reasoningKeyEnv = answer(await text({ signal,
    message: 'Environment variable containing your OpenAI reasoning API key', initialValue: apiKeyEnv,
    validate: (value) => value && /^[A-Z_][A-Z0-9_]{0,127}$/.test(value) ? undefined : 'Enter an uppercase environment-variable name, not a key value.',
  }));
  const model = answer(await text({ signal, message: 'Reasoning model with image input and function calling', initialValue: defaultReasoningModel,
    validate: (value) => value?.trim() ? undefined : 'Enter a compatible model identifier.',
  }));
  if (!answer(await confirm({ signal, message: 'Enable sharing captured screen/context with your reasoning provider after each turn?', initialValue: false }))) {
    throw new Error('Visual sharing was not enabled. No configuration was written.');
  }
  if (signal?.aborted) throw new Error('Setup cancelled. No configuration was written.');
  await writeConfig({
    version: 1,
    speech: { provider: 'openai', model: streamingModel, apiKeyEnv },
    reasoning: { provider: 'openai', model, apiKeyEnv: reasoningKeyEnv },
    shareVisualContext: true,
  }, configPath(), replace);
  outro(`Saved ${configPath()}. Set ${[...new Set([apiKeyEnv, reasoningKeyEnv])].join(' and ')} in your environment, then run opensaysme.`);
}
