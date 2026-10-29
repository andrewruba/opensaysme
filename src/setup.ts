import { cancel, intro, isCancel, note, outro, text } from '@clack/prompts';
import { configPath, readConfig, writeConfig } from './config.js';
import { streamingModel } from './speech/openai.js';

function answer<T>(value: T): Exclude<T, symbol> {
  if (isCancel(value)) {
    cancel('Setup cancelled. No configuration was written.');
    throw new Error('Setup cancelled.');
  }
  return value as Exclude<T, symbol>;
}

export async function setup(signal?: AbortSignal): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Setup needs an interactive terminal. See docs/development.md for the configuration format.');
  }
  if (await readConfig()) throw new Error(`Configuration already exists at ${configPath()}; edit it directly.`);
  intro('OpenSaysMe setup');
  note(`Voice uses OpenAI ${streamingModel}. When you activate recording,\n`
    + 'microphone audio streams directly to OpenAI using your key. Provider charges apply.\n'
    + 'Desktop context stays local. Transcripts and context appear in the terminal.\n'
    + 'Setup stores an environment-variable name, never your key, and makes no API request.', 'Voice mode');
  const apiKeyEnv = answer(await text({
    signal,
    message: 'Environment variable containing your OpenAI API key',
    initialValue: 'OPENAI_API_KEY',
    validate: (value) => value && /^[A-Z_][A-Z0-9_]{0,127}$/.test(value) ? undefined : 'Enter an uppercase environment-variable name, not a key value.',
  }));
  if (signal?.aborted) throw new Error('Setup cancelled. No configuration was written.');
  await writeConfig({
    version: 1,
    speech: { provider: 'openai', model: streamingModel, apiKeyEnv },
  });
  outro(`Saved ${configPath()}. Set ${apiKeyEnv} in your environment, then run opensaysme.`);
}
