import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareStartup } from '../src/startup.js';

const mocks = vi.hoisted(() => ({ read: vi.fn(), setup: vi.fn() }));
vi.mock('../src/config.js', () => ({ readConfig: mocks.read }));
vi.mock('../src/setup.js', () => ({ setup: mocks.setup }));
const descriptors = [process.stdin, process.stdout].map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
beforeEach(() => {
  vi.resetAllMocks();
  for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
});
afterEach(() => {
  [process.stdin, process.stdout].forEach((stream, index) => {
    const descriptor = descriptors[index];
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else Reflect.deleteProperty(stream, 'isTTY');
  });
});

it('starts with existing settings without prompting again', async () => {
  const config = { version: 1 };
  mocks.read.mockResolvedValue(config);
  expect(await prepareStartup()).toBe(config);
  expect(mocks.setup).not.toHaveBeenCalled();
});

it('runs setup on first interactive launch and uses the saved configuration', async () => {
  const config = { version: 1 };
  mocks.read.mockResolvedValueOnce(null).mockResolvedValueOnce(config);
  expect(await prepareStartup()).toBe(config);
  expect(mocks.setup).toHaveBeenCalledExactlyOnceWith(undefined);
});

it('does not start or read back configuration after setup cancellation', async () => {
  const controller = new AbortController();
  mocks.read.mockResolvedValue(null);
  mocks.setup.mockImplementation(async () => { controller.abort(); });
  await expect(prepareStartup(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(mocks.read).toHaveBeenCalledTimes(1);
});

it('never hangs on a setup prompt in a noninteractive launch', async () => {
  mocks.read.mockResolvedValue(null);
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  await expect(prepareStartup()).rejects.toThrow('interactive terminal');
  expect(mocks.setup).not.toHaveBeenCalled();
});

it('does not replace invalid existing configuration', async () => {
  mocks.read.mockRejectedValue(new Error('Invalid configuration'));
  await expect(prepareStartup()).rejects.toThrow('Invalid configuration');
  expect(mocks.setup).not.toHaveBeenCalled();
});
