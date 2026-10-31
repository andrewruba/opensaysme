import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setup } from '../src/setup.js';

const mocks = vi.hoisted(() => ({ text: vi.fn(), confirm: vi.fn(), note: vi.fn(),
  intro: vi.fn(), outro: vi.fn(), cancel: vi.fn(), isCancel: vi.fn(), read: vi.fn(), write: vi.fn(), adapter: vi.fn() }));
vi.mock('@clack/prompts', () => ({ text: mocks.text, confirm: mocks.confirm,
  note: mocks.note, intro: mocks.intro, outro: mocks.outro, cancel: mocks.cancel, isCancel: mocks.isCancel }));
vi.mock('../src/config.js', () => ({ readConfig: mocks.read, writeConfig: mocks.write, configPath: () => '/fixture/config.json' }));
vi.mock('../src/desktop/index.js', () => ({ desktopAdapter: mocks.adapter }));
const terminalDescriptors = [process.stdin, process.stdout].map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
beforeEach(() => {
  vi.resetAllMocks(); mocks.isCancel.mockImplementation((value) => typeof value === 'symbol');
  mocks.confirm.mockResolvedValue(true); mocks.read.mockResolvedValue(null); mocks.write.mockResolvedValue(undefined);
  mocks.text.mockResolvedValueOnce('SPEECH_KEY').mockResolvedValueOnce('REASONING_KEY').mockResolvedValueOnce('model');
  for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
});
afterEach(() => {
  [process.stdin, process.stdout].forEach((stream, index) => {
    const descriptor = terminalDescriptors[index];
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else Reflect.deleteProperty(stream, 'isTTY');
  });
});

it('saves independent environment references after sharing consent and only explains desktop access', async () => {
  await setup();
  expect(mocks.write).toHaveBeenCalledExactlyOnceWith({
    version: 1, shareVisualContext: true, activationHotkey: 'Ctrl+Shift+Space',
    speech: { provider: 'openai', model: 'gpt-live-transcribe', apiKeyEnv: 'SPEECH_KEY' },
    reasoning: { provider: 'openai', model: 'model', apiKeyEnv: 'REASONING_KEY' },
  }, '/fixture/config.json', false);
  expect(mocks.confirm.mock.invocationCallOrder[0]).toBeLessThan(mocks.write.mock.invocationCallOrder[0]!);
  expect(mocks.adapter).not.toHaveBeenCalled();
  const displayed = JSON.stringify(mocks.note.mock.calls);
  expect(displayed).toContain('Microphone, Accessibility, and Screen Recording');
  expect(displayed).toContain('opensaysme doctor');
  expect(displayed).toContain('osm hotkey');
});

it('retains saved settings without asking for keys or inspecting the desktop', async () => {
  mocks.read.mockResolvedValue({ version: 1 });
  await setup();
  expect(mocks.text).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.adapter).not.toHaveBeenCalled();
  expect(mocks.outro).toHaveBeenCalledWith(expect.stringContaining('retained'));
});

it('can replace invalid configuration without reading or trusting it', async () => {
  mocks.read.mockRejectedValue(new Error('Invalid configuration'));
  await setup(undefined, true);
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.write).toHaveBeenCalledWith(expect.any(Object), '/fixture/config.json', true);
});

it('writes nothing when sharing is declined or a prompt is cancelled', async () => {
  mocks.confirm.mockResolvedValueOnce(false);
  await expect(setup()).rejects.toThrow('Visual sharing was not enabled');
  expect(mocks.write).not.toHaveBeenCalled();
  mocks.text.mockReset().mockResolvedValueOnce(Symbol('cancel'));
  await expect(setup()).rejects.toThrow('Setup cancelled');
  expect(mocks.write).not.toHaveBeenCalled();
});

it('stops a cancelled setup before persistence without exposing an arbitrary reason', async () => {
  const controller = new AbortController();
  mocks.confirm.mockImplementationOnce(async () => { controller.abort('private-abort-reason'); return true; });
  await expect(setup(controller.signal)).rejects.toThrow('Setup cancelled');
  expect(mocks.write).not.toHaveBeenCalled();
  await expect(setup(controller.signal)).rejects.not.toThrow('private-abort-reason');
});

it('requires an interactive terminal without saving or probing devices', async () => {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  await expect(setup()).rejects.toThrow('interactive terminal');
  expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.adapter).not.toHaveBeenCalled();
  expect(mocks.write).not.toHaveBeenCalled();
});
