import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setup } from '../src/setup.js';
import { setupPermissions } from '../src/setup-permissions.js';
import { DesktopError } from '../src/desktop/errors.js';
import type { PermissionAccess, PermissionReport } from '../src/desktop/permissions.js';

const mocks = vi.hoisted(() => ({ select: vi.fn(), text: vi.fn(), confirm: vi.fn(), note: vi.fn(),
  intro: vi.fn(), outro: vi.fn(), cancel: vi.fn(), isCancel: vi.fn(), read: vi.fn(), write: vi.fn(), adapter: vi.fn() }));
vi.mock('@clack/prompts', () => ({ select: mocks.select, text: mocks.text, confirm: mocks.confirm,
  note: mocks.note, intro: mocks.intro, outro: mocks.outro, cancel: mocks.cancel, isCancel: mocks.isCancel }));
vi.mock('../src/config.js', () => ({ readConfig: mocks.read, writeConfig: mocks.write, configPath: () => '/fixture/config.json' }));
vi.mock('../src/desktop/index.js', () => ({ desktopAdapter: mocks.adapter }));
const terminalDescriptors = [process.stdin, process.stdout].map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
beforeEach(() => {
  vi.resetAllMocks(); mocks.isCancel.mockImplementation((value) => typeof value === 'symbol');
  mocks.select.mockResolvedValue('done'); mocks.confirm.mockResolvedValue(true);
  mocks.read.mockResolvedValue(null); mocks.write.mockResolvedValue(undefined);
  for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
});
afterEach(() => {
  [process.stdin, process.stdout].forEach((stream, index) => {
    const descriptor = terminalDescriptors[index];
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else Reflect.deleteProperty(stream, 'isTTY');
  });
});
const report: PermissionReport = {
  helperPath: '/fixture/opensaysme-desktop', bundleIdentifier: 'dev.opensaysme.desktop', desktopAvailable: true,
  launcher: { name: 'Terminal', bundleIdentifier: 'com.apple.Terminal', path: '/System/Applications/Utilities/Terminal.app' },
  permissions: { microphone: 'granted', accessibility: 'granted', screenCapture: 'granted' },
};
function fixture() {
  const access = { inspect: vi.fn<PermissionAccess['inspect']>(async () => structuredClone(report)),
    verify: vi.fn<PermissionAccess['verify']>(async (permission) => ({ permission, outcome: 'verified' })) };
  mocks.adapter.mockResolvedValue({ permissions: access });
  return access;
}
const displayed = () => JSON.stringify(mocks.note.mock.calls);

it('shows separate grants and observed identity without prompting or capturing when checks are skipped', async () => {
  const access = fixture(); await setupPermissions(access);
  expect(access.inspect).toHaveBeenCalledOnce(); expect(access.verify).not.toHaveBeenCalled();
  expect(displayed()).toContain('not verified in this setup session');
  expect(displayed()).toContain('com.apple.Terminal'); expect(displayed()).toContain('/fixture/opensaysme-desktop');
  expect(displayed()).toContain('does not determine which entry macOS uses');
  expect(mocks.write).not.toHaveBeenCalled();
});

it('runs only the explicitly selected local check and makes recheck read-only', async () => {
  const access = fixture(); const signal = new AbortController().signal;
  mocks.select.mockResolvedValueOnce('screenCapture').mockResolvedValueOnce('recheck').mockResolvedValueOnce('done');
  await setupPermissions(access, signal);
  expect(access.verify).toHaveBeenCalledExactlyOnceWith('screenCapture', signal);
  expect(access.inspect).toHaveBeenCalledTimes(3);
  expect(displayed()).toContain('one screen image'); expect(displayed()).toContain('local check passed');
});

it('separates granted status from verification, and clears a success after access is revoked', async () => {
  const access = fixture();
  access.inspect.mockResolvedValueOnce(structuredClone(report)).mockResolvedValueOnce({ ...report,
    permissions: { ...report.permissions, microphone: 'denied' } });
  mocks.select.mockResolvedValueOnce('microphone').mockResolvedValueOnce('done');
  await setupPermissions(access);
  const lastStatus = mocks.note.mock.calls.filter(([, title]) => title === 'Current access').at(-1)![0];
  expect(lastStatus).toContain('Microphone: denied — not verified'); expect(lastStatus).not.toContain('local check passed');
});

it('explains denied access and does not mislabel a helper crash as a permission denial', async () => {
  const access = fixture();
  access.verify.mockResolvedValueOnce({ permission: 'microphone', outcome: 'permission-required' })
    .mockRejectedValueOnce(new DesktopError('helper-crashed'));
  mocks.select.mockResolvedValueOnce('microphone').mockResolvedValueOnce('screenCapture').mockResolvedValueOnce('done');
  await setupPermissions(access);
  expect(displayed()).toContain('fully quit and reopen');
  expect(displayed()).toContain('crashed'); expect(displayed()).not.toContain('local check passed');
});

it('sanitizes unknown and malformed helper failures without preserving a success', async () => {
  const access = fixture();
  access.verify.mockRejectedValueOnce(new Error('PRIVATE_DEVICE_VALUE')).mockResolvedValueOnce({ permission: 'microphone', outcome: 'verified' });
  mocks.select.mockResolvedValueOnce('microphone').mockResolvedValueOnce('screenCapture').mockResolvedValueOnce('done');
  await setupPermissions(access);
  expect(displayed()).not.toContain('PRIVATE_DEVICE_VALUE'); expect(displayed()).not.toContain('local check passed');
  expect(displayed()).toContain('valid result');
});

it('handles missing helper and cancellation before any active permission operation', async () => {
  const access = fixture(); access.inspect.mockRejectedValueOnce(new DesktopError('helper-unavailable'));
  await setupPermissions(access); expect(access.verify).not.toHaveBeenCalled(); expect(displayed()).toContain('build:native');
  const controller = new AbortController(); controller.abort();
  await expect(setupPermissions(access, controller.signal)).rejects.toThrow();
  expect(access.inspect).toHaveBeenCalledOnce();
});

it('propagates cancellation to the active check and does not continue to another permission', async () => {
  const access = fixture(); const controller = new AbortController();
  access.verify.mockImplementationOnce(async (_permission, signal) => {
    expect(signal).toBe(controller.signal); controller.abort(); throw new Error('cancelled');
  });
  mocks.select.mockResolvedValueOnce('microphone');
  await expect(setupPermissions(access, controller.signal)).rejects.toThrow();
  expect(access.inspect).toHaveBeenCalledOnce(); expect(access.verify).toHaveBeenCalledOnce();
});

it('retains existing provider settings during recovery without asking for credentials', async () => {
  const access = fixture(); mocks.read.mockResolvedValue({ version: 1 });
  await setup();
  expect(access.inspect).toHaveBeenCalledOnce(); expect(mocks.text).not.toHaveBeenCalled();
  expect(mocks.confirm).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
});

it('saves new provider settings before optional checks and keeps them after cancellation', async () => {
  const access = fixture();
  mocks.text.mockResolvedValueOnce('SPEECH_KEY').mockResolvedValueOnce('REASONING_KEY').mockResolvedValueOnce('model');
  mocks.select.mockResolvedValueOnce(Symbol('cancel'));
  await expect(setup()).rejects.toThrow('saved provider configuration is unchanged');
  expect(mocks.write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    speech: expect.objectContaining({ apiKeyEnv: 'SPEECH_KEY' }), reasoning: expect.objectContaining({ apiKeyEnv: 'REASONING_KEY' }),
  }), '/fixture/config.json', false);
  expect(access.verify).not.toHaveBeenCalled();
  expect(mocks.write.mock.invocationCallOrder[0]).toBeLessThan(access.inspect.mock.invocationCallOrder[0]!);
});

it('changes saved providers only when replace is requested', async () => {
  fixture(); mocks.read.mockResolvedValue({ version: 1 });
  mocks.text.mockResolvedValueOnce('SPEECH_KEY').mockResolvedValueOnce('REASONING_KEY').mockResolvedValueOnce('model');
  await setup(undefined, true);
  expect(mocks.write).toHaveBeenCalledWith(expect.any(Object), '/fixture/config.json', true);
});

it('can replace an invalid configuration without reading or trusting it', async () => {
  fixture(); mocks.read.mockRejectedValue(new Error('Invalid configuration'));
  mocks.text.mockResolvedValueOnce('SPEECH_KEY').mockResolvedValueOnce('REASONING_KEY').mockResolvedValueOnce('model');
  await setup(undefined, true);
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.write).toHaveBeenCalledWith(expect.any(Object), '/fixture/config.json', true);
});
