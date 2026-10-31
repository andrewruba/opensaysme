import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configPath, configSchema, providerStatus, readConfig, writeConfig, type Config } from '../src/config.js';

const directories: string[] = [];
const config: Config = {
  version: 1,
  shareVisualContext: true,
  reasoning: { provider: 'openai', model: 'test-model', apiKeyEnv: 'REASONING_API_KEY' },
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
    await expect(writeConfig({ ...config, reasoning: { ...config.reasoning!, model: 'replacement' } }, file)).rejects.toThrow('already exists');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(config);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('rejects secret fields and malformed key references', () => {
    expect(configSchema.safeParse({ ...config, apiKey: 'private-token' }).success).toBe(false);
    expect(configSchema.safeParse({ ...config, reasoning: { ...config.reasoning, apiKeyEnv: 'sk-private' } }).success).toBe(false);
  });

  it('normalizes a saved activation shortcut and rejects shortcuts that would interfere with fixed controls', async () => {
    const file = await path();
    await writeConfig({ ...config, activationHotkey: ' cmd + shift + space ' }, file);
    expect((await readConfig(file))?.activationHotkey).toBe('Cmd+Shift+Space');
    for (const activationHotkey of ['Escape', 'Cmd+Escape', 'Ctrl+C', 'Cmd+Ctrl+Shift+C', 'Space', 'Shift+A', 'Cmd+Cmd+A', 'Cmd+A+B', 'Cmd+F13', 'Cmd+\nA']) {
      expect(configSchema.safeParse({ ...config, activationHotkey }).success, activationHotkey).toBe(false);
    }
  });

  it('requires explicit visual sharing and a configured supported reasoning provider', () => {
    expect(configSchema.safeParse({ ...config, shareVisualContext: false }).success).toBe(false);
    expect(configSchema.safeParse({ ...config, shareVisualContext: undefined }).success).toBe(false);
    expect(configSchema.safeParse({ ...config, reasoning: undefined }).success).toBe(false);
    expect(configSchema.safeParse({ ...config, reasoning: { ...config.reasoning, provider: 'anthropic' } }).success).toBe(false);
  });

  it('replaces configuration only when explicitly requested', async () => {
    const file = await path(); await writeConfig(config, file);
    const replacement = { ...config, reasoning: { ...config.reasoning, model: 'replacement' } };
    await writeConfig(replacement, file, true);
    expect(await readConfig(file)).toEqual(replacement);
  });

  it('reports invalid configuration without including its contents', async () => {
    const file = await path();
    await writeFile(file, '{"secret":"private-token"}');
    await expect(readConfig(file)).rejects.toThrow('Invalid configuration');
    await expect(readConfig(file)).rejects.not.toThrow('private-token');
  });

  it('reports only presence, not provider key values', () => {
    const report = providerStatus(config, { REASONING_API_KEY: 'private-token', OPENAI_API_KEY: ' ' });
    expect(report.reasoning?.keyPresent).toBe(true);
    expect(report.speech?.keyPresent).toBe(false);
    expect(JSON.stringify(report)).not.toContain('private-token');
  });

  it('uses the macOS configuration root and supports an explicit override', () => {
    expect(configPath({ OPENSAYSME_CONFIG_DIR: '/test/config' })).toBe(join('/test/config', 'config.json'));
    expect(configPath({})).toBe(join(homedir(), 'Library', 'Application Support', 'opensaysme', 'config.json'));
  });
});
