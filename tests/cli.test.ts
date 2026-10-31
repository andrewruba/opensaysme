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

it('shows a runnable quick start and shortcut help without configuration, keys or desktop access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opensaysme-cli-help-'));
  directories.push(directory);
  const env = { ...process.env, OPENSAYSME_CONFIG_DIR: directory, OPENAI_API_KEY: '' };
  const { stdout, stderr } = await execute(process.execPath, [...args, '--help'], { env });
  expect(stdout).toContain('setup');
  expect(stdout).toContain('doctor');
  expect(stdout).toContain('desktop');
  expect(stdout).toContain('tools');
  expect(stdout).toContain('hotkey');
  expect(stdout).toContain('--debug [directory]');
  expect(stdout).toContain('--hotkey <shortcut>');
  expect(stdout).toContain('npm run build:native');
  expect(stdout).toContain('node dist/cli.js setup');
  expect(stdout).toContain("export OPENAI_API_KEY='your-key'");
  expect(stdout).toContain('System Settings > Privacy & Security');
  expect(stdout).toContain('node dist/cli.js hotkey "Cmd+Shift+Space"');
  expect(stdout).toContain('Escape cancels');
  expect(stderr).toBe('');
  const help = await execute(process.execPath, [...args, 'hotkey', '--help'], { env });
  expect(help.stdout).toContain('Escape and Ctrl+C are reserved');
  expect(help.stdout).toContain('For one run without saving');
  expect(await readdir(directory)).toEqual([]);
});

it('overrides the saved shortcut for one launch without writing configuration', async () => {
  const env = await configured();
  await execute(process.execPath, [...args, 'hotkey', 'Cmd+Shift+Space'], { env });
  const file = join(env.OPENSAYSME_CONFIG_DIR, 'config.json');
  const before = await readFile(file, 'utf8');
  try {
    await execute(process.execPath, [...args, '--hotkey', 'ctrl+alt+space'], { env });
    throw new Error('Expected the missing-key failure before native startup.');
  } catch (error) {
    expect(error).toMatchObject({ code: 1, stderr: expect.stringContaining('Set OPENSAYSME_TEST_MISSING_KEY') });
    const stderr = (error as { stderr: string }).stderr;
    expect(stderr).toContain('Ctrl+Alt+Space starts/stops; Escape cancels; Ctrl+C quits');
    expect(stderr).toContain('saved shortcut is unchanged');
    expect(stderr).toContain(file);
    expect(stderr).toContain('Models: reasoning gpt-5.4-mini; speech gpt-live-transcribe');
    expect(stderr).toContain('node dist/cli.js hotkey "Cmd+Shift+Space"');
    expect(stderr).toContain('Wait for ready');
  }
  expect(await readFile(file, 'utf8')).toBe(before);
  expect((await execute(process.execPath, [...args, 'hotkey'], { env })).stdout).toContain('Cmd+Shift+Space');
});

it('rejects a reserved activation override before configuration or native startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opensaysme-cli-invalid-hotkey-'));
  directories.push(directory);
  await expect(execute(process.execPath, [...args, '--hotkey', 'Escape'], {
    env: { ...process.env, OPENSAYSME_CONFIG_DIR: directory },
  })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Escape and Ctrl+C are reserved') });
  expect(await readdir(directory)).toEqual([]);
});

it('saves and displays an activation shortcut without changing providers or requiring desktop access', async () => {
  const env = await configured();
  const file = join(env.OPENSAYSME_CONFIG_DIR, 'config.json');
  const before = JSON.parse(await readFile(file, 'utf8'));
  expect((await execute(process.execPath, [...args, 'hotkey'], { env })).stdout).toContain('Ctrl+Shift+Space');
  const { stdout } = await execute(process.execPath, [...args, 'hotkey', 'cmd+shift+space'], { env });
  expect(stdout).toContain('Restart voice mode');
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ...before, activationHotkey: 'Cmd+Shift+Space' });
  expect((await execute(process.execPath, [...args, 'hotkey'], { env })).stdout).toContain('Cmd+Shift+Space');
  const saved = await readFile(file, 'utf8');
  await expect(execute(process.execPath, [...args, 'hotkey', 'Ctrl+C'], { env })).rejects.toMatchObject({ code: 1,
    stderr: expect.stringContaining('reserved') });
  expect(await readFile(file, 'utf8')).toBe(saved);
  await expect(execute(process.execPath, args, { env })).rejects.toMatchObject({
    stderr: expect.stringContaining('Cmd+Shift+Space starts/stops; Escape cancels; Ctrl+C quits'),
  });
});

it('lists tool schemas without configuration, keys, or a graphical session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opensaysme-cli-tools-'));
  directories.push(directory);
  const { stdout, stderr } = await execute(process.execPath, [...args, 'tools'], { env: {
    ...process.env, OPENSAYSME_CONFIG_DIR: directory, DISPLAY: '', WAYLAND_DISPLAY: '', OPENAI_API_KEY: '',
  } });
  expect(JSON.parse(stdout).map((tool: { name: string }) => tool.name)).toEqual([
    'list_windows', 'inspect_desktop', 'capture_screen', 'focus_window',
    ...(process.platform === 'darwin' ? ['inspect_window', 'capture_window', 'move_pointer', 'click', 'scroll', 'type_text', 'press_key'] : []),
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
  for (const command of [['--help'], ['setup'], ['desktop', 'inspect', '--delay', '0']]) {
    const result = await execute(process.execPath, [...args, '--debug', 'images', ...command], { env, cwd }).catch((error: { stdout: string; stderr: string }) => error);
    expect(result.stderr).not.toContain('Debug enabled');
    expect(await readdir(cwd)).toEqual(['config.json']);
  }
});

it('rejects invalid inspection delays before native execution', async () => {
  await expect(execute(process.execPath, [...args, 'desktop', 'inspect', '--delay', '0'])).rejects.toMatchObject({ code: 1 });
});

it('does not hang in non-interactive setup', async () => {
  await expect(execute(process.execPath, [...args, 'setup'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('interactive terminal') });
});

it('requires setup for voice mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opensaysme-cli-'));
  directories.push(directory);
  await expect(execute(process.execPath, args, { env: { ...process.env, OPENSAYSME_CONFIG_DIR: directory } })).rejects.toMatchObject({
    stderr: expect.stringMatching(/Quick start[\s\S]*node dist\/cli.js setup first/),
  });
  expect(await readdir(directory)).toEqual([]);
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
