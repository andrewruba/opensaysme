import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configPath, configSchema, providerStatus, readConfig, writeConfig, type Config } from '../src/config.js';

const directories: string[] = [];
const config: Config = {
  version: 1,
  reasoning: { provider: 'anthropic', model: 'test-model', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  speech: { provider: 'openai', model: 'test-transcription', apiKeyEnv: 'OPENAI_API_KEY' },
};
async function path() {
  const directory = await mkdtemp(join(tmpdir(), 'opensaysme-config-'));
  directories.push(directory);
  return join(directory, 'config.json');
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('configuration', () => {
  it('stores only validated references and never overwrites existing configuration', async () => {
    const file = await path();
    expect(await readConfig(file)).toBeNull();
    await writeConfig(config, file);
    expect(await readConfig(file)).toEqual(config);
    await expect(writeConfig({ ...config, reasoning: { ...config.reasoning, model: 'replacement' } }, file)).rejects.toThrow('already exists');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(config);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('rejects secret fields and malformed key references', () => {
    expect(configSchema.safeParse({ ...config, apiKey: 'private-token' }).success).toBe(false);
    expect(configSchema.safeParse({ ...config, reasoning: { ...config.reasoning, apiKeyEnv: 'sk-private' } }).success).toBe(false);
  });

  it('reports invalid configuration without including its contents', async () => {
    const file = await path();
    await writeFile(file, '{"secret":"private-token"}');
    await expect(readConfig(file)).rejects.toThrow('Invalid configuration');
    await expect(readConfig(file)).rejects.not.toThrow('private-token');
  });

  it('reports only presence, not provider key values', () => {
    const report = providerStatus(config, { ANTHROPIC_API_KEY: 'private-token', OPENAI_API_KEY: ' ' });
    expect(report.reasoning?.keyPresent).toBe(true);
    expect(report.speech?.keyPresent).toBe(false);
    expect(JSON.stringify(report)).not.toContain('private-token');
  });

  it('uses platform configuration roots and supports an explicit override', () => {
    expect(configPath({ OPENSAYSME_CONFIG_DIR: '/test/config' }, 'linux')).toBe(join('/test/config', 'config.json'));
    expect(configPath({ APPDATA: 'profile' }, 'win32')).toBe(join('profile', 'opensaysme', 'config.json'));
    expect(configPath({ XDG_CONFIG_HOME: '/test/xdg' }, 'linux')).toBe(join('/test/xdg', 'opensaysme', 'config.json'));
  });
});
