import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { writeConfig } from '../src/config.js';

const execute = promisify(execFile);
const args = ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/cli.ts', import.meta.url))];
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function configured(model = 'gpt-live-transcribe') {
  const directory = await mkdtemp(join(tmpdir(), 'opensaysme-cli-'));
  directories.push(directory);
  await writeConfig({ version: 1, shareVisualContext: true, reasoning: { provider: 'openai', model: 'gpt-5.4-mini', apiKeyEnv: 'OPENSAYSME_TEST_MISSING_REASONING_KEY' }, speech: { provider: 'openai', model, apiKeyEnv: 'OPENSAYSME_TEST_MISSING_KEY' } }, join(directory, 'config.json'));
  return { ...process.env, OPENSAYSME_CONFIG_DIR: directory, OPENSAYSME_TEST_MISSING_KEY: '' };
}

it('shows CLI commands without reading desktop context', async () => {
  const { stdout } = await execute(process.execPath, [...args, '--help']);
  expect(stdout).toContain('setup');
  expect(stdout).toContain('doctor');
  expect(stdout).toContain('desktop');
  expect(stdout).toContain('tools');
  expect(stdout).toContain('--debug [directory]');
});

it('lists tool schemas without configuration, keys, or a graphical session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opensaysme-cli-tools-'));
  directories.push(directory);
  const { stdout, stderr } = await execute(process.execPath, [...args, 'tools'], { env: {
    ...process.env, OPENSAYSME_CONFIG_DIR: directory, DISPLAY: '', WAYLAND_DISPLAY: '', OPENAI_API_KEY: '',
  } });
  expect(JSON.parse(stdout).map((tool: { name: string }) => tool.name)).toEqual([
    'list_windows', 'inspect_desktop', 'capture_screen', 'focus_window',
    ...(process.platform === 'darwin' ? ['inspect_window'] : []),
  ]);
  expect(stderr).toBe('');
  expect(await readdir(directory)).toEqual([]);
});

it('rejects an empty debug directory before native access', async () => {
  await expect(execute(process.execPath, [...args, '--debug', ''])).rejects.toMatchObject({ code: 1,
    stderr: expect.stringContaining('nonempty debug directory') });
});

it('rejects the superseded image-only flag', async () => {
  await expect(execute(process.execPath, [...args, '--debug-images'])).rejects.toMatchObject({ code: 1,
    stderr: expect.stringContaining("unknown option '--debug-images'") });
});

it('logs startup configuration failures only when debugging is explicitly enabled', async () => {
  for (const [flags, folder] of [
    [[], null], [['--debug'], '.opensaysme-debug'], [['--debug', 'chosen-images'], 'chosen-images'],
  ] as const) {
    const env = { ...await configured(), OPENSAYSME_TEST_MISSING_REASONING_KEY: 'fixture-provider-secret' };
    const cwd = await realpath(env.OPENSAYSME_CONFIG_DIR);
    try {
      await execute(process.execPath, [...args, ...flags], { env, cwd });
      throw new Error('Expected the missing-key failure.');
    } catch (error) {
      expect(error).toMatchObject({ code: 1, stderr: expect.stringContaining('Set OPENSAYSME_TEST_MISSING_KEY') });
      const stderr = (error as { stderr: string }).stderr;
      if (folder) expect(stderr).toContain(`Debug enabled: ${JSON.stringify(join(cwd, folder)).slice(1, -1)}`);
      else expect(stderr).not.toContain('Debug enabled');
    }
    if (!folder) {
      expect(await readdir(cwd)).toEqual(['config.json']);
      continue;
    }
    expect((await readdir(cwd)).sort()).toEqual([folder, 'config.json'].sort());
    const sessions = await readdir(join(cwd, folder));
    expect(sessions).toHaveLength(1);
    const session = join(cwd, folder, sessions[0]!);
    expect((await readdir(session)).sort()).toEqual(['session.jsonl', 'turns']);
    expect(await readdir(join(session, 'turns'))).toEqual([]);
    const text = await readFile(join(session, 'session.jsonl'), 'utf8');
    const events = text.trim().split('\n').map((line) => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({ component: 'session', event: 'configuration',
      data: expect.objectContaining({ speechKeyPresent: false, reasoningKeyPresent: true }) }));
    expect(events).toContainEqual(expect.objectContaining({ component: 'session', event: 'failed' }));
    expect(text).not.toContain('fixture-provider-secret');
  }
});

it('does not enable debug persistence for help, setup, or desktop probes', async () => {
  const env = await configured();
  const cwd = await realpath(env.OPENSAYSME_CONFIG_DIR);
  for (const command of [['--help'], ['setup'], ['desktop', 'test-microphone', '--seconds', '0']]) {
    const result = await execute(process.execPath, [...args, '--debug', 'images', ...command], { env, cwd }).catch((error: { stdout: string; stderr: string }) => error);
    expect(result.stderr).not.toContain('Debug enabled');
    expect(await readdir(cwd)).toEqual(['config.json']);
  }
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

it('requires the independent reasoning key before desktop access', async () => {
  const env = { ...await configured(), OPENSAYSME_TEST_MISSING_KEY: 'fixture-key', OPENSAYSME_TEST_MISSING_REASONING_KEY: '' };
  await expect(execute(process.execPath, args, { env })).rejects.toMatchObject({ code: 1,
    stderr: expect.stringContaining('Set OPENSAYSME_TEST_MISSING_REASONING_KEY') });
});
