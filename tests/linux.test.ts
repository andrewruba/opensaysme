import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../src/desktop/process.js';
import { captureLinuxContext, captureLinuxFrame, focusLinux, inspectLinux, linuxVoiceHelper, probeLinux, testLinuxHotkey, testLinuxMicrophone } from '../src/desktop/platforms/linux.js';

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
    if (file === 'python3' && args[1] === '--pointer') return '{"x":45,"y":70,"windowId":"67890"}';
    if (file === 'python3') return '{"capability":"globalHotkey","status":"not-observed","detail":"Shortcut was not observed."}';
    if (file === 'xsel') return 'selected text\n';
    throw new Error('Unexpected subprocess');
  });
});

describe('Linux voice startup and context', () => {
  it('requires X11 before probing prerequisites or starting a voice helper', async () => {
    vi.stubEnv('XDG_SESSION_TYPE', 'wayland');
    await expect(linuxVoiceHelper()).rejects.toThrow('Wayland');
    await expect(captureLinuxContext()).rejects.toThrow('Wayland');
    expect(run).not.toHaveBeenCalled();
  });

  it('checks prerequisites without opening a microphone or grabbing a hotkey', async () => {
    expect(await linuxVoiceHelper()).toEqual({ file: 'python3', args: [expect.stringContaining('native/linux/voice.py')] });
    expect(run.mock.calls.map(([file, args]) => [file, args.at(-1)])).toEqual([
      ['arecord', '--version'], ['python3', '--probe'],
    ]);
    run.mockRejectedValue(new Error('Missing executable'));
    await expect(linuxVoiceHelper()).rejects.toThrow('alsa-utils');
  });

  it('freezes distinct active and pointer window IDs and labels PRIMARY honestly', async () => {
    const signal = new AbortController().signal;
    const context = await captureLinuxContext(signal);
    expect(context.activeWindow?.id).toBe('12345');
    expect(context.pointer).toEqual({ x: 45, y: 70, window: { id: '67890', application: 'AgentTerminal', title: 'Example agent' } });
    expect(context.selectedText).toBe('selected text\n');
    expect(context.warnings).toEqual([expect.stringContaining('may belong to a different window')]);
    expect(Number.isNaN(Date.parse(context.capturedAt))).toBe(false);
    expect(run.mock.calls.every(([, , options]) => options?.signal === signal)).toBe(true);
    expect(run.mock.calls.some(([, args]) => args[0] === 'windowactivate')).toBe(false);
  });

  it('keeps partial context when one source is unavailable or malformed', async () => {
    const implementation = run.getMockImplementation()!;
    run.mockImplementation((file, args, options) => {
      if (args[1] === '--pointer') return Promise.resolve('{"x":2,"y":4,"windowId":"private malformed value"}');
      if (file === 'xsel') return Promise.reject(new Error('private selection'));
      return implementation(file, args, options);
    });
    const context = await captureLinuxContext();
    expect(context.activeWindow?.id).toBe('12345');
    expect(context.pointer).toBeUndefined();
    expect(context.selectedText).toBeUndefined();
    expect(context.warnings).toHaveLength(2);
    expect(JSON.stringify(context)).not.toContain('private');
  });

  it('discards oversized selection while preserving other context', async () => {
    const implementation = run.getMockImplementation()!;
    run.mockImplementation((file, args, options) => file === 'xsel'
      ? Promise.resolve('x'.repeat(65537)) : implementation(file, args, options));
    const context = await captureLinuxContext();
    expect(context.selectedText).toBeUndefined();
    expect(context.pointer?.window?.id).toBe('67890');
  });

  it('honors cancellation before starting any context subprocess', async () => {
    await expect(captureLinuxContext(AbortSignal.abort())).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
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
    expect(report.capabilities.screenCapture.status).toBe('unverified');
    expect(run.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ['arecord', ['--version']],
      ['xdotool', ['version']],
      ['xsel', ['--version']],
      ['python3', [expect.stringContaining('native/linux/hotkey.py'), '--probe']],
      ['python3', [expect.stringContaining('native/linux/frame.py'), '--probe']],
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

describe('Linux in-memory screen capture', () => {
  const frame = {
    capturedAt: '2026-10-28T10:00:00.000Z',
    display: { id: 'x11:root', bounds: { x: 0, y: 0, width: 3200, height: 1800 } },
    image: { mimeType: 'image/jpeg', width: 1600, height: 900, data: '/9j/2Q==' }, warnings: [],
  };
  it('keeps source desktop bounds distinct from resized image pixels and forwards cancellation', async () => {
    run.mockResolvedValue(JSON.stringify(frame));
    const signal = new AbortController().signal;
    expect(await captureLinuxFrame(signal)).toEqual(frame);
    expect(run).toHaveBeenCalledWith('python3', [expect.stringContaining('native/linux/frame.py')], { timeoutMs: 4000, signal });
  });
  it('rejects Wayland or pre-cancelled capture before launching a helper', async () => {
    await expect(captureLinuxFrame(AbortSignal.abort())).rejects.toThrow();
    vi.stubEnv('XDG_SESSION_TYPE', 'wayland');
    await expect(captureLinuxFrame()).rejects.toThrow('Wayland');
    expect(run).not.toHaveBeenCalled();
  });
  it.each([
    'private pixels', JSON.stringify({ error: 'screen-capture-unavailable' }),
    JSON.stringify({ ...frame, display: { ...frame.display, id: 'unknown' } }),
    JSON.stringify({ ...frame, image: { ...frame.image, width: 3200 } }),
    JSON.stringify({ ...frame, image: { ...frame.image, data: 'private screenshot content' } }),
  ])('reports malformed or missing capture without exposing image content', async (output) => {
    run.mockResolvedValue(output);
    await expect(captureLinuxFrame()).rejects.toThrow('Check Python Pillow');
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
