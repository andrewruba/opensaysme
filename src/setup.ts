import { cancel, intro, isCancel, note, outro, select, text } from '@clack/prompts';
import { configPath, readConfig, writeConfig, type Config } from './config.js';

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
  note('This scaffold saves provider preferences and environment-variable names only.\n'
    + 'Model calls, voice activation, and OS credential storage are not connected yet.\n'
    + 'Future requests will go directly to your chosen providers. Nothing is uploaded now.', 'Current scope');
  const provider = answer(await select({
    signal,
    message: 'Reasoning provider',
    options: [{ value: 'openai', label: 'OpenAI' }, { value: 'anthropic', label: 'Anthropic' }],
  })) as Config['reasoning']['provider'];
  const model = answer(await text({
    signal,
    message: 'Reasoning model identifier',
    validate: (value) => value?.trim() ? undefined : 'Enter a model identifier from your provider.',
  }));
  const speechModel = answer(await text({
    signal,
    message: 'OpenAI transcription model identifier (configured separately)',
    validate: (value) => value?.trim() ? undefined : 'Enter your transcription model identifier.',
  }));
  const reasoningKey = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  if (signal?.aborted) throw new Error('Setup cancelled. No configuration was written.');
  await writeConfig({
    version: 1,
    reasoning: { provider, model, apiKeyEnv: reasoningKey },
    speech: { provider: 'openai', model: speechModel, apiKeyEnv: 'OPENAI_API_KEY' },
  });
  outro(`Saved ${configPath()}. Set ${[...new Set([reasoningKey, 'OPENAI_API_KEY'])].join(' and ')} in your environment, then run opensaysme doctor.`);
}
