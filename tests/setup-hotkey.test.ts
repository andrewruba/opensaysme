import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setupHotkey } from '../src/setup-hotkey.js';
import type { Config } from '../src/config.js';

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), note: vi.fn(), intro: vi.fn(), outro: vi.fn(),
  cancel: vi.fn(), isCancel: vi.fn(), read: vi.fn(), write: vi.fn(), adapter: vi.fn(), record: vi.fn(),
  raw: vi.fn(), resume: vi.fn(), pause: vi.fn() }));
vi.mock('@clack/prompts', () => ({ confirm: mocks.confirm, note: mocks.note, intro: mocks.intro,
  outro: mocks.outro, cancel: mocks.cancel, isCancel: mocks.isCancel }));
vi.mock('../src/config.js', () => ({ readConfig: mocks.read, writeConfig: mocks.write, configPath: () => '/fixture/config.json' }));
vi.mock('../src/desktop/index.js', () => ({ desktopAdapter: mocks.adapter }));

const config: Config = { version: 1, shareVisualContext: true, activationHotkey: 'Ctrl+Alt+Space',
  speech: { provider: 'openai', model: 'gpt-live-transcribe', apiKeyEnv: 'SPEECH_KEY' },
  reasoning: { provider: 'openai', model: 'gpt-6-astra', apiKeyEnv: 'REASONING_KEY' } };
const originals = [
  ...['isTTY', 'isRaw', 'readableFlowing', 'setRawMode', 'resume', 'pause'].map((key) => [process.stdin, key] as const),
  [process.stdout, 'isTTY'] as const,
].map(([stream, key]) => ({ stream, key, descriptor: Object.getOwnPropertyDescriptor(stream, key) }));
const dataListeners = process.stdin.listenerCount('data');
beforeEach(() => {
  vi.resetAllMocks();
  mocks.isCancel.mockImplementation((value) => typeof value === 'symbol');
  mocks.read.mockResolvedValue(config); mocks.write.mockResolvedValue(undefined);
  mocks.confirm.mockResolvedValue(true);
  mocks.adapter.mockResolvedValue({ recordHotkey: mocks.record });
  mocks.record.mockImplementation(async (_signal, ready) => { ready(); return { status: 'captured', shortcut: 'Cmd+Shift+Space' }; });
  for (const [key, value] of Object.entries({ isTTY: true, isRaw: false, readableFlowing: null,
    setRawMode: mocks.raw, resume: mocks.resume, pause: mocks.pause })) {
    Object.defineProperty(process.stdin, key, { configurable: true, value });
  }
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
});
afterEach(() => {
  expect(process.stdin.listenerCount('data')).toBe(dataListeners);
  for (const { stream, key, descriptor } of originals) {
    if (descriptor) Object.defineProperty(stream, key, descriptor);
    else Reflect.deleteProperty(stream, key);
  }
});

it('records physical keys, restores the terminal, confirms the result and saves only the shortcut', async () => {
  mocks.confirm.mockImplementation(async ({ message }) => {
    expect(message).toContain('Cmd+Shift+Space');
    expect(mocks.raw.mock.calls).toEqual([[true], [false]]);
    expect(process.stdin.listenerCount('data')).toBe(dataListeners);
    return true;
  });
  await setupHotkey();
  expect(JSON.stringify(mocks.note.mock.calls)).toContain('Current: Ctrl+Alt+Space');
  expect(mocks.note).toHaveBeenCalledWith('Press your shortcut now, then release all keys.', 'Ready');
  expect(mocks.write).toHaveBeenCalledExactlyOnceWith({ ...config, activationHotkey: 'Cmd+Shift+Space' }, '/fixture/config.json', true);
  expect(config.activationHotkey).toBe('Ctrl+Alt+Space');
  expect(mocks.pause).toHaveBeenCalledOnce();
  expect(mocks.outro).toHaveBeenCalledWith(expect.stringContaining('Restart voice mode'));
});

it('shows the default when no shortcut is saved', async () => {
  const withoutHotkey = { ...config }; delete withoutHotkey.activationHotkey;
  mocks.read.mockResolvedValue(withoutHotkey);
  await setupHotkey();
  expect(JSON.stringify(mocks.note.mock.calls)).toContain('Current: Ctrl+Shift+Space');
});

it.each([false, Symbol('cancel')])('leaves the setting unchanged when confirmation is declined or cancelled', async (answer) => {
  mocks.confirm.mockResolvedValue(answer);
  await expect(setupHotkey()).rejects.toThrow('cancelled');
  expect(mocks.write).not.toHaveBeenCalled();
});

it.each([
  [{ status: 'cancelled' }, 'cancelled'],
  [{ status: 'unavailable', reason: 'accessibility-permission-required' }, 'Allow Accessibility'],
  [{ status: 'unavailable', reason: 'focus-changed' }, 'terminal is not focused'],
  [{ status: 'unavailable', reason: 'timeout' }, '30 seconds'],
  [{ status: 'captured', shortcut: 'Ctrl+C' }, 'invalid shortcut'],
])('never confirms or saves a failed recording (%j)', async (result, message) => {
  mocks.record.mockResolvedValue(result);
  await expect(setupHotkey()).rejects.toThrow(message as string);
  expect(mocks.confirm).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
  expect(mocks.raw.mock.calls).toEqual([[true], [false]]);
});

it.each([3, 27])('cancels on terminal fallback input %i while discarding captured bytes', async (byte) => {
  mocks.record.mockImplementation(async (signal: AbortSignal) => {
    process.stdin.emit('data', Buffer.from([byte]));
    expect(signal.aborted).toBe(true);
    return { status: 'cancelled' };
  });
  await expect(setupHotkey()).rejects.toThrow('cancelled');
  expect(mocks.confirm).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
});

it('does not save a late result after abort, or expose the abort reason', async () => {
  const controller = new AbortController();
  mocks.record.mockImplementation(async () => { controller.abort('private-abort-reason'); return { status: 'captured', shortcut: 'Cmd+Space' }; });
  await expect(setupHotkey(controller.signal)).rejects.toThrow('cancelled');
  expect(mocks.confirm).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
  expect(JSON.stringify(mocks.cancel.mock.calls)).not.toContain('private-abort-reason');
});

it('restores a previously raw and flowing terminal after helper failure', async () => {
  Object.defineProperty(process.stdin, 'isRaw', { configurable: true, value: true });
  Object.defineProperty(process.stdin, 'readableFlowing', { configurable: true, value: true });
  mocks.record.mockRejectedValue(new Error('Recorder failed.'));
  await expect(setupHotkey()).rejects.toThrow('Recorder failed');
  expect(mocks.raw.mock.calls).toEqual([[true], [true]]);
  expect(mocks.pause).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
});

it('requires existing setup before listening', async () => {
  mocks.read.mockResolvedValue(null);
  await expect(setupHotkey()).rejects.toThrow('Run osm setup');
  expect(mocks.record).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
});

it.each([process.stdin, process.stdout])('does not listen without an interactive terminal', async (stream) => {
  Object.defineProperty(stream, 'isTTY', { configurable: true, value: false });
  await expect(setupHotkey()).rejects.toThrow('osm hotkey --show');
  expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
});
