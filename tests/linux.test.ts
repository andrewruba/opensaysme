import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../src/desktop/process.js';
import { focusLinux, inspectLinux, probeLinux, testLinuxHotkey, testLinuxMicrophone } from '../src/desktop/platforms/linux.js';

vi.mock('../src/desktop/process.js', () => ({ runCommand: vi.fn() }));
const run = vi.mocked(runCommand);

beforeEach(() => {
  vi.stubEnv('XDG_SESSION_TYPE', 'x11');
  vi.stubEnv('WAYLAND_DISPLAY', '');
  vi.stubEnv('DISPLAY', ':0');
  run.mockReset();
  run.mockImplementation(async (file, args) => {
    if (args[0] === 'version' || args[0] === '--version') return 'installed';
    if (args[0] === 'getactivewindow') return '12345\n';
    if (args[0] === 'getwindowclassname') return 'AgentTerminal\n';
    if (args[0] === 'getwindowname') return 'Example agent\n';
    if (args[0] === 'windowactivate') return '';
    if (file === 'python3' && args[1] === '--probe') return '{"available":true}';
    if (file === 'python3') return '{"capability":"globalHotkey","status":"not-observed","detail":"Shortcut was not observed."}';
    if (file === 'xsel') return 'selected text\n';
    throw new Error('Unexpected subprocess');
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('Linux capability detection', () => {
  it('does not mistake XWayland DISPLAY for full desktop access', async () => {
    vi.stubEnv('XDG_SESSION_TYPE', 'wayland');
    const report = await probeLinux();
    expect(report.session).toBe('wayland');
    expect(report.capabilities.activeWindow.status).toBe('unavailable');
    expect(run.mock.calls.map(([file]) => file)).toEqual(['arecord']);
    run.mockClear();
    await expect(inspectLinux(false)).rejects.toThrow('Wayland');
    await expect(focusLinux('12345')).rejects.toThrow('Wayland');
    expect(run).not.toHaveBeenCalled();
  });

  it('also detects Wayland through WAYLAND_DISPLAY', async () => {
    vi.stubEnv('XDG_SESSION_TYPE', '');
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0');
    expect((await probeLinux()).session).toBe('wayland');
    expect(run.mock.calls.map(([file]) => file)).toEqual(['arecord']);
  });

  it('reports headless sessions without launching desktop helpers', async () => {
    vi.stubEnv('DISPLAY', '');
    expect((await probeLinux()).session).toBe('headless');
    await expect(inspectLinux(false)).rejects.toThrow('logged-in desktop session');
    expect(run.mock.calls.map(([file]) => file)).toEqual(['arecord']);
  });

  it('checks active access without reading context, recording, or changing focus', async () => {
    const report = await probeLinux();
    expect(report.capabilities.activeWindow.status).toBe('available');
    expect(report.capabilities.focusWindow.status).toBe('unverified');
    expect(report.capabilities.selectedText.status).toBe('unverified');
    expect(report.capabilities.globalHotkey.status).toBe('unverified');
    expect(report.capabilities.microphone.status).toBe('unverified');
    expect(run.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ['arecord', ['--version']],
      ['xdotool', ['version']],
      ['xsel', ['--version']],
      ['python3', [expect.stringContaining('native/linux/hotkey.py'), '--probe']],
      ['xdotool', ['getactivewindow']],
    ]);
  });

  it('reports missing prerequisites without pretending access is available', async () => {
    run.mockRejectedValue(new Error('ENOENT'));
    const report = await probeLinux();
    expect(report.capabilities.activeWindow.status).toBe('unavailable');
    expect(report.capabilities.selectedText.status).toBe('unavailable');
    expect(report.capabilities.focusWindow.status).toBe('unavailable');
  });

  it('does not report malformed helper output as active-window success', async () => {
    run.mockImplementation(async (_file, args) => args[0] === 'getactivewindow' ? '123\n456' : 'version');
    expect((await probeLinux()).capabilities.activeWindow.status).toBe('unavailable');
  });
});

describe('Linux explicit microphone and activation tests', () => {
  it('discards bounded microphone capture without writing an audio file', async () => {
    run.mockResolvedValue('');
    const result = await testLinuxMicrophone(2);
    expect(result.status).toBe('passed');
    expect(run).toHaveBeenCalledWith('arecord', [
      '--quiet', '--nonblock', '--device', 'default', '--duration', '2',
      '--file-type', 'raw', '--format', 'S16_LE', '--rate', '16000', '--channels', '1', '/dev/null',
    ], { timeoutMs: 5000 });
  });

  it.each([0, -1, 31, 1.5, Number.NaN])('rejects unsafe capture duration %s', async (duration) => {
    await expect(testLinuxMicrophone(duration)).rejects.toThrow('integer from 1 to 30');
    expect(run).not.toHaveBeenCalled();
  });

  it('reports microphone timeout or denial as unavailable', async () => {
    run.mockRejectedValue(new Error('Denied'));
    expect((await testLinuxMicrophone(1)).status).toBe('unavailable');
  });

  it('does not falsely pass an unobserved global shortcut', async () => {
    expect((await testLinuxHotkey(2)).status).toBe('not-observed');
    expect(run).toHaveBeenCalledWith('python3', [expect.stringContaining('native/linux/hotkey.py'), '--seconds', '2'], { timeoutMs: 5000 });
  });

  it('rejects malformed or mismatched hotkey responses without echoing native output', async () => {
    run.mockResolvedValue('{"capability":"microphone","status":"passed","detail":"private data"}');
    const result = await testLinuxHotkey(2);
    expect(result.status).toBe('unavailable');
    expect(result.detail).not.toContain('private data');
  });

  it('never starts the X11 hotkey helper on Wayland', async () => {
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0');
    expect((await testLinuxHotkey(2)).status).toBe('unavailable');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('Linux explicit inspection', () => {
  it('reads metadata without touching selection by default', async () => {
    expect(await inspectLinux(false)).toEqual({
      platform: 'linux',
      window: { id: '12345', application: 'AgentTerminal', title: 'Example agent' },
    });
    expect(run.mock.calls.every(([file]) => file === 'xdotool')).toBe(true);
  });

  it('reads PRIMARY only when requested and preserves selection whitespace', async () => {
    expect((await inspectLinux(true)).selectedText).toBe('selected text\n');
    expect(run).toHaveBeenCalledWith('xsel', ['--primary', '--output', '--selectionTimeout', '2000'], { timeoutMs: 3000 });
  });

  it('represents no active window explicitly', async () => {
    run.mockResolvedValue('0\n');
    expect(await inspectLinux(false)).toEqual({ platform: 'linux', window: null });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('supports stable xdotool packages using xprop for application classes', async () => {
    run.mockImplementation(async (file, args) => {
      if (args[0] === 'getactivewindow') return '12345';
      if (args[0] === 'getwindowname') return 'Example agent';
      if (file === 'xprop') return 'WM_CLASS(STRING) = "agent-terminal", "AgentTerminal"\n';
      throw new Error('Unknown xdotool command');
    });
    expect((await inspectLinux(false)).window?.application).toBe('AgentTerminal');
    expect(run).toHaveBeenCalledWith('xprop', ['-id', '12345', 'WM_CLASS'], { timeoutMs: 3000 });
  });

  it('rejects oversized captured text instead of silently truncating it', async () => {
    run.mockImplementation(async (file, args) => {
      if (file === 'xsel') return 'x'.repeat(65537);
      if (args[0] === 'getactivewindow') return '0';
      throw new Error('Unexpected subprocess');
    });
    await expect(inspectLinux(true)).rejects.toThrow('maximum 64 KiB');
  });
});

describe('Linux focus', () => {
  it.each(['0', '-1', '0x123', '123;echo unsafe', '--help', '4294967296', '12\n34'])('rejects invalid target %s before starting a process', async (target) => {
    await expect(focusLinux(target)).rejects.toThrow('positive decimal X11 window ID');
    expect(run).not.toHaveBeenCalled();
  });

  it('uses bounded activation and verifies the active window', async () => {
    await expect(focusLinux('12345')).resolves.toBeUndefined();
    expect(run.mock.calls).toEqual([
      ['xdotool', ['windowactivate', '--sync', '12345'], { timeoutMs: 5000 }],
      ['xdotool', ['getactivewindow'], { timeoutMs: 3000 }],
    ]);
  });

  it('reports a rejected focus request even if the helper exits successfully', async () => {
    await expect(focusLinux('54321')).rejects.toThrow('Could not activate');
  });

  it('propagates bounded helper failure without reporting focus success', async () => {
    run.mockRejectedValue(new Error('Timed out'));
    await expect(focusLinux('12345')).rejects.toThrow('Could not activate');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
