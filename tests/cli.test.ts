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
async function configured(model = 'gpt-live-transcribe', activationHotkey?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'opensaysme-cli-'));
  directories.push(directory);
  await writeConfig({ version: 1, shareVisualContext: true, ...(activationHotkey ? { activationHotkey } : {}), reasoning: { provider: 'openai', model: 'gpt-5.4-mini', apiKeyEnv: 'OPENSAYSME_TEST_MISSING_REASONING_KEY' }, speech: { provider: 'openai', model, apiKeyEnv: 'OPENSAYSME_TEST_MISSING_KEY' } }, join(directory, 'config.json'));
  return { ...process.env, OPENSAYSME_CONFIG_DIR: directory, OPENSAYSME_TEST_MISSING_KEY: '' };
}

it('shows a runnable quick start without configuration, keys or desktop access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opensaysme-cli-help-'));
  directories.push(directory);
  const env = { ...process.env, OPENSAYSME_CONFIG_DIR: directory, OPENAI_API_KEY: '' };
  const { stdout, stderr } = await execute(process.execPath, [...args, '--help'], { env });
  expect(stdout).toContain('setup');
  expect(stdout).toContain('uninstall');
  expect(stdout).toContain('doctor');
  expect(stdout).toContain('desktop');
  expect(stdout).toContain('tools');
  expect(stdout).toContain('hotkey');
  expect(stdout).toContain('--debug [directory]');
  expect(stdout).not.toContain('--hotkey');
  expect(stdout).toContain('npm run install:cli');
  expect(stdout).toContain('osm and opensaysme');
  expect(stdout).toContain('osm setup');
  expect(stdout).toContain("export OPENAI_API_KEY='your-key'");
  expect(stdout).toContain('System Settings > Privacy & Security');
  expect(stdout).toContain('osm hotkey --show');
  expect(stdout).toContain('osm hotkey --help');
  expect(stdout).not.toContain('osm hotkey "');
  expect(stdout).toContain('Escape cancels');
  expect(stderr).toBe('');
  expect(await readdir(directory)).toEqual([]);
});

it('shows shortcut help without configuration, keys or desktop access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opensaysme-cli-help-'));
  directories.push(directory);
  const env = { ...process.env, OPENSAYSME_CONFIG_DIR: directory, OPENAI_API_KEY: '' };
  const help = await execute(process.execPath, [...args, 'hotkey', '--help'], { env });
  expect(help.stdout).toContain('Escape and Ctrl+C are reserved');
  expect(help.stdout).toContain('press and release');
  expect(help.stdout).toContain('Ctrl+Shift+Space');
  expect(help.stdout).not.toContain('[shortcut]');
  expect(help.stdout).not.toContain('--hotkey');
  expect(help.stdout).not.toContain('Save directly');
  expect(help.stderr).toBe('');
  expect(await readdir(directory)).toEqual([]);
});

it('shows uninstall help without configuration, keys or desktop access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opensaysme-cli-help-'));
  directories.push(directory);
  const env = { ...process.env, OPENSAYSME_CONFIG_DIR: directory, OPENAI_API_KEY: '' };
  const uninstallHelp = await execute(process.execPath, [...args, 'uninstall', '--help'], { env });
  expect(uninstallHelp.stdout).toContain('Remove the installed osm and opensaysme commands');
  expect(uninstallHelp.stdout).toContain('Keeps your repository folder, saved settings and debug captures.');
  expect(uninstallHelp.stderr).toBe('');
  expect(await readdir(directory)).toEqual([]);
});

it.each([
  [undefined, 'Ctrl+Shift+Space'],
  ['Cmd+Shift+Space', 'Cmd+Shift+Space'],
] as const)('uses the saved shortcut or default at startup and with --show (%s)', async (saved, expected) => {
  const env = await configured('gpt-live-transcribe', saved);
  const file = join(env.OPENSAYSME_CONFIG_DIR, 'config.json');
  const before = await readFile(file, 'utf8');
  try {
    await execute(process.execPath, args, { env });
    throw new Error('Expected the missing-key failure before native startup.');
  } catch (error) {
    expect(error).toMatchObject({ code: 1, stderr: expect.stringContaining('Set OPENSAYSME_TEST_MISSING_KEY') });
    const stderr = (error as { stderr: string }).stderr;
    expect(stderr).toContain(`${expected} starts/stops; Escape cancels; Ctrl+C quits`);
    expect(stderr).toContain(file);
    expect(stderr).toContain('Models: reasoning gpt-5.4-mini; speech gpt-live-transcribe');
    expect(stderr).toContain('osm hotkey (interactive)');
    expect(stderr).toContain('Wait for ready');
    expect(stderr).toContain('point, click, scroll, type and use keyboard shortcuts within your request');
  }
  expect((await execute(process.execPath, [...args, 'hotkey', '--show'], { env })).stdout).toContain(expected);
  expect(await readFile(file, 'utf8')).toBe(before);
});

it('shows the default without creating configuration or requiring desktop access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opensaysme-cli-show-hotkey-'));
  directories.push(directory);
  const { stdout, stderr } = await execute(process.execPath, [...args, 'hotkey', '--show'], {
    env: { ...process.env, OPENSAYSME_CONFIG_DIR: directory },
  });
  expect(stdout).toContain('Ctrl+Shift+Space');
  expect(stderr).toBe('');
  expect(await readdir(directory)).toEqual([]);
});

it.each([
  [['--hotkey', 'Ctrl+Alt+Space'], 'unknown option'],
  [['hotkey', 'Cmd+Shift+Space'], 'too many arguments'],
  [['hotkey', '--show', 'Cmd+Shift+Space'], 'too many arguments'],
] as const)('rejects unsupported shortcut arguments before changing configuration (%j)', async (command, message) => {
  const env = await configured('gpt-live-transcribe', 'Cmd+Space');
  const file = join(env.OPENSAYSME_CONFIG_DIR, 'config.json');
  const before = await readFile(file, 'utf8');
  await expect(execute(process.execPath, [...args, ...command], { env })).rejects.toMatchObject({
    code: 1, stderr: expect.stringContaining(message),
  });
  expect(await readFile(file, 'utf8')).toBe(before);
});

it('never hangs or changes settings when the interactive hotkey command has no terminal', async () => {
  const env = await configured();
  const file = join(env.OPENSAYSME_CONFIG_DIR, 'config.json');
  const before = await readFile(file, 'utf8');
  await expect(execute(process.execPath, [...args, 'hotkey'], { env })).rejects.toMatchObject({ code: 1,
    stderr: expect.stringContaining('interactive terminal') });
  expect(await readFile(file, 'utf8')).toBe(before);
});

it('lists tool schemas without configuration, keys, or a graphical session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opensaysme-cli-tools-'));
  directories.push(directory);
  const { stdout, stderr } = await execute(process.execPath, [...args, 'tools'], { env: {
    ...process.env, OPENSAYSME_CONFIG_DIR: directory, DISPLAY: '', WAYLAND_DISPLAY: '', OPENAI_API_KEY: '',
  } });
  expect(JSON.parse(stdout).map((tool: { name: string }) => tool.name)).toEqual([
    'list_windows', 'inspect_desktop', 'capture_screen', 'focus_window',
    ...(process.platform === 'darwin' ? ['inspect_window', 'capture_window', 'move_pointer', 'click', 'scroll', 'type_text', 'press_key', 'type_keyboard_text',
      'capture_text', 'read_text', 'transfer_text'] : []),
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
    stderr: expect.stringMatching(/Quick start[\s\S]*osm setup first/),
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
