import { execFile, spawn } from 'node:child_process';
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

it('requires setup for the foreground scaffold', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opensaysme-cli-'));
  directories.push(directory);
  await expect(execute(process.execPath, args, { env: { ...process.env, OPENSAYSME_CONFIG_DIR: directory } })).rejects.toMatchObject({ stderr: expect.stringContaining('setup first') });
});

it.skipIf(process.platform === 'win32')('exits cleanly when the foreground scaffold is interrupted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opensaysme-cli-'));
  directories.push(directory);
  await writeConfig({ version: 1,
    reasoning: { provider: 'openai', model: 'test', apiKeyEnv: 'TEST_KEY' },
    speech: { provider: 'openai', model: 'test', apiKeyEnv: 'TEST_KEY' },
  }, join(directory, 'config.json'));
  const child = spawn(process.execPath, args, { env: { ...process.env, OPENSAYSME_CONFIG_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let interrupted = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
  try {
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (!interrupted && output.includes('Use opensaysme doctor')) {
          interrupted = true;
          child.kill('SIGINT');
        }
      });
    });
    expect(exit).toBe(0);
    expect(output).toContain('Stopped.');
  } finally {
    clearTimeout(timer);
    child.kill();
  }
});
