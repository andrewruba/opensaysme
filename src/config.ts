import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const environmentName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/).max(128);
const modelName = z.string().trim().min(1).max(256)
  .refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127));
export const configSchema = z.strictObject({
  version: z.literal(1),
  reasoning: z.strictObject({
    provider: z.enum(['openai', 'anthropic']),
    model: modelName,
    apiKeyEnv: environmentName,
  }).optional(),
  speech: z.strictObject({
    provider: z.literal('openai'),
    model: modelName,
    apiKeyEnv: environmentName,
  }),
});
export type Config = z.infer<typeof configSchema>;

export function configPath(env = process.env, platform = process.platform): string {
  if (env.OPENSAYSME_CONFIG_DIR) return join(env.OPENSAYSME_CONFIG_DIR, 'config.json');
  const base = platform === 'win32'
    ? env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    : platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'opensaysme', 'config.json');
}

export async function readConfig(path = configPath()): Promise<Config | null> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Cannot read configuration at ${path}.`, { cause: error });
  }
  try {
    return configSchema.parse(JSON.parse(content));
  } catch {
    throw new Error(`Invalid configuration at ${path}. Use the documented schema; store key references, not keys.`);
  }
}

export async function writeConfig(config: Config, path = configPath()): Promise<void> {
  const validated = configSchema.parse(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Configuration already exists at ${path}; edit it directly to change settings.`, { cause: error });
    }
    throw new Error(`Cannot save configuration at ${path}.`, { cause: error });
  }
}

export function providerStatus(config: Config, env = process.env) {
  return Object.fromEntries((['reasoning', 'speech'] as const).flatMap((role) => {
    const provider = config[role];
    return provider ? [[role, { provider: provider.provider, model: provider.model,
      apiKeyEnv: provider.apiKeyEnv, keyPresent: Boolean(env[provider.apiKeyEnv]?.trim()) }]] : [];
  }));
}
