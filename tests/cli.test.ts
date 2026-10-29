import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { writeConfig } from '../src/config.js';

const execute = promisify(execFile);
const args = ['--import', 'tsx', 'src/cli.ts'];
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function configured(model = 'gpt-live-transcribe') {
  const directory = await mkdtemp(join(tmpdir(), 'opensaysme-cli-'));
  directories.push(directory);
  await writeConfig({ version: 1, speech: { provider: 'openai', model, apiKeyEnv: 'OPENSAYSME_TEST_MISSING_KEY' } }, join(directory, 'config.json'));
  return { ...process.env, OPENSAYSME_CONFIG_DIR: directory, OPENSAYSME_TEST_MISSING_KEY: '' };
}

it('shows CLI commands without reading desktop context', async () => {
  const { stdout } = await execute(process.execPath, [...args, '--help']);
  expect(stdout).toContain('setup');
  expect(stdout).toContain('doctor');
  expect(stdout).toContain('desktop');
});

it('rejects invalid test durations before native execution', async () => {
  await expect(execute(process.execPath, [...args, 'desktop', 'test-microphone', '--seconds', '0'])).rejects.toMatchObject({ code: 1 });
});

it('does not hang in non-interactive setup', async () => {
  await expect(execute(process.execPath, [...args, 'setup'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('interactive terminal') });
});

it('requires setup for voice mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opensaysme-cli-'));
  directories.push(directory);
  await expect(execute(process.execPath, args, { env: { ...process.env, OPENSAYSME_CONFIG_DIR: directory } })).rejects.toMatchObject({ stderr: expect.stringContaining('setup first') });
});

it('requires the speech key before opening desktop hooks or a connection', async () => {
  await expect(execute(process.execPath, args, { env: await configured() })).rejects.toMatchObject({ code: 1,
    stderr: expect.stringContaining('Set OPENSAYSME_TEST_MISSING_KEY') });
});

it('rejects unsupported streaming model configuration before native access', async () => {
  const env = await configured('file-model'); env.OPENSAYSME_TEST_MISSING_KEY = 'fixture-key';
  await expect(execute(process.execPath, args, { env })).rejects.toMatchObject({ code: 1,
    stderr: expect.stringContaining('Set speech.model') });
});
