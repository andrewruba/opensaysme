import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { runCommand } from '../process.js';
import { desktopTestResultSchema, type Capability, type DesktopReport, type DesktopSnapshot, type DesktopTestResult } from '../types.js';
import { desktopContextSchema, type DesktopContext, type VoiceHelperSpec } from '../voice-types.js';

const hotkeyHelperPath = fileURLToPath(new URL('../../../native/linux/hotkey.py', import.meta.url));
const voiceHelperPath = fileURLToPath(new URL('../../../native/linux/voice.py', import.meta.url));

type Session = 'x11' | 'wayland' | 'headless';

function session(): Session {
  // XWayland exposes DISPLAY too; it cannot represent the whole Wayland desktop.
  if (process.env.XDG_SESSION_TYPE?.toLowerCase() === 'wayland' || process.env.WAYLAND_DISPLAY) {
    return 'wayland';
  }
  return process.env.DISPLAY ? 'x11' : 'headless';
}

function requireX11(): void {
  const current = session();
  if (current === 'wayland') {
    throw new Error('Native Wayland desktop access is not implemented. Use an X11 desktop session for this prototype.');
  }
  if (current === 'headless') {
    throw new Error('No X11 display detected. Run OpenSaysMe inside your logged-in desktop session.');
  }
}

function windowId(value: string): string {
  const normalized = value.trim();
  if (!/^[1-9]\d{0,9}$/.test(normalized) || Number(normalized) > 0xffffffff) {
    throw new Error('Expected a positive decimal X11 window ID.');
  }
  return normalized;
}

async function activeWindowId(signal?: AbortSignal): Promise<string | null> {
  const output = await runCommand('xdotool', ['getactivewindow'], { timeoutMs: 3000, ...(signal ? { signal } : {}) });
  return output.trim() === '0' ? null : windowId(output);
}

function checkedText(text: string, description: string, limit: number): string {
  if (text.includes('\0') || Buffer.byteLength(text, 'utf8') > limit) {
    throw new Error(`${description} was invalid or exceeded ${limit} bytes.`);
  }
  return text;
}

async function windowApplication(id: string, signal?: AbortSignal): Promise<string> {
  const options = { timeoutMs: 3000, ...(signal ? { signal } : {}) };
  try {
    return await runCommand('xdotool', ['getwindowclassname', id], options);
  } catch {
    // Stable distributions can ship xdotool versions predating getwindowclassname.
    const output = await runCommand('xprop', ['-id', id, 'WM_CLASS'], options);
    const match = /^WM_CLASS\(STRING\) = "(?:\\.|[^"\\])*", ("(?:\\.|[^"\\])*")\s*$/.exec(output);
    if (!match?.[1]) throw new Error('The X11 window has no valid WM_CLASS property.');
    return z.string().parse(JSON.parse(match[1]));
  }
}

async function isInstalled(file: string, args: string[]): Promise<boolean> {
  try {
    await runCommand(file, args, { timeoutMs: 3000 });
    return true;
  } catch {
    return false;
  }
}

export async function probeLinux(): Promise<DesktopReport> {
  const current = session();
  const unavailable = (detail: string): Capability => ({ status: 'unavailable', detail });
  const desktopDetail = current === 'wayland'
    ? 'Native Wayland access is not implemented; XWayland tools cannot cover the whole desktop. An X11 session is required by this prototype.'
    : 'No DISPLAY detected. Run inside a logged-in X11 desktop session.';
  const report: DesktopReport = {
    platform: 'linux',
    session: current,
    capabilities: {
      activeWindow: unavailable(desktopDetail),
      focusWindow: unavailable(desktopDetail),
      selectedText: unavailable(desktopDetail),
      globalHotkey: unavailable(current === 'wayland'
        ? 'A Wayland GlobalShortcuts portal adapter is not implemented; no keyboard hook is installed.'
        : 'No X11 desktop session is available for global shortcut registration.'),
      microphone: unavailable('Install arecord (alsa-utils) to enable an explicit microphone test. No recording was attempted.'),
    },
    notes: [],
  };
  if (await isInstalled('arecord', ['--version'])) {
    report.capabilities.microphone = {
      status: 'unverified',
      detail: 'arecord is installed. Run the explicit microphone test to verify the ALSA default input; doctor does not record audio.',
    };
  }
  if (current !== 'x11') return report;

  const [hasXdotool, hasXsel, hasHotkeyHelper] = await Promise.all([
    isInstalled('xdotool', ['version']),
    isInstalled('xsel', ['--version']),
    runCommand('python3', [hotkeyHelperPath, '--probe'], { timeoutMs: 3000 })
      .then((output) => z.object({ available: z.boolean() }).strict().parse(JSON.parse(output)).available)
      .catch(() => false),
  ]);
  report.capabilities.globalHotkey = hasHotkeyHelper
    ? { status: 'unverified', detail: 'Python 3 and libX11 are available. Run desktop test-hotkey to register Ctrl+Shift+Space temporarily; doctor does not register it.' }
    : unavailable('Install Python 3 and libX11 to enable an explicit X11 Ctrl+Shift+Space test.');
  if (hasXdotool) {
    try {
      const id = await activeWindowId();
      report.capabilities.activeWindow = id
        ? { status: 'available', detail: 'Read an active X11 window ID using xdotool.' }
        : { status: 'unverified', detail: 'X11 responded, but no window is currently active. Focus a window and retry.' };
      report.capabilities.focusWindow = {
        status: 'unverified',
        detail: 'xdotool is installed. Use the explicit focus command to verify window-manager activation; doctor does not change focus.',
      };
    } catch {
      const detail = 'xdotool could not read a valid active window. Check DISPLAY, X11 authorization, and EWMH window-manager support.';
      report.capabilities.activeWindow = unavailable(detail);
      report.capabilities.focusWindow = unavailable(detail);
    }
  } else {
    const detail = 'Install xdotool with your distribution package manager, then run doctor in your X11 session.';
    report.capabilities.activeWindow = unavailable(detail);
    report.capabilities.focusWindow = unavailable(detail);
  }
  report.capabilities.selectedText = hasXsel
    ? {
        status: 'unverified',
        detail: 'xsel is installed. Explicit selection inspection reads X11 PRIMARY, which may belong to another window; doctor does not read it.',
      }
    : unavailable('Install xsel with your distribution package manager to enable explicit X11 PRIMARY selection inspection.');
  report.notes.push('xdotool and xsel are external prerequisites; no binaries are bundled or installed automatically.');
  report.notes.push('Older xdotool versions use xprop (x11-utils) to read application classes. X11 shortcut tests require Python 3 and libX11.');
  report.notes.push('Selection inspection reads the last X11 PRIMARY selection, not a guaranteed selection in the active window.');
  return report;
}

export async function inspectLinux(includeSelection: boolean): Promise<DesktopSnapshot> {
  requireX11();
  const snapshot: DesktopSnapshot = { platform: 'linux', window: null };
  let id: string | null;
  try {
    id = await activeWindowId();
    if (id) {
      const [application, title] = await Promise.all([
        windowApplication(id),
        runCommand('xdotool', ['getwindowname', id], { timeoutMs: 3000 }),
      ]);
      const applicationName = checkedText(application.trim(), 'Window application', 8192);
      if (!applicationName) throw new Error('The active window has no application class.');
      snapshot.window = {
        id,
        application: applicationName,
        title: checkedText(title.replace(/\r?\n$/, ''), 'Window title', 8192),
      };
    }
  } catch (cause) {
    throw new Error('Could not inspect the X11 active window. Check doctor and install xprop (x11-utils) if your xdotool lacks getwindowclassname.', { cause });
  }
  if (includeSelection) {
    try {
      const selection = await runCommand('xsel', ['--primary', '--output', '--selectionTimeout', '2000'], { timeoutMs: 3000 });
      snapshot.selectedText = checkedText(selection, 'Selected text', 65536);
    } catch (cause) {
      throw new Error('Could not read X11 PRIMARY text. Check that xsel is installed and a text selection is available (maximum 64 KiB).', { cause });
    }
  }
  return snapshot;
}

export async function focusLinux(targetId: string): Promise<void> {
  const id = windowId(targetId);
  requireX11();
  try {
    await runCommand('xdotool', ['windowactivate', '--sync', id], { timeoutMs: 5000 });
    if (await activeWindowId() !== id) throw new Error('The requested window did not become active.');
  } catch (cause) {
    throw new Error('Could not activate the requested X11 window. It may have closed or the window manager may have rejected focus.', { cause });
  }
}

export async function testLinuxMicrophone(durationSeconds: number): Promise<DesktopTestResult> {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 30) {
    throw new Error('Microphone test duration must be an integer from 1 to 30 seconds.');
  }
  try {
    await runCommand('arecord', [
      '--quiet', '--nonblock', '--device', 'default', '--duration', String(durationSeconds),
      '--file-type', 'raw', '--format', 'S16_LE', '--rate', '16000', '--channels', '1', '/dev/null',
    ], { timeoutMs: (durationSeconds + 3) * 1000 });
    return {
      capability: 'microphone',
      status: 'passed',
      detail: 'ALSA default-input capture completed; audio was discarded into /dev/null. This verifies capture access, not audible speech or signal quality.',
      metrics: { durationSeconds },
    };
  } catch {
    return {
      capability: 'microphone',
      status: 'unavailable',
      detail: 'Microphone test failed. Install arecord (alsa-utils), check the ALSA default input and permissions, and close applications using the device exclusively.',
    };
  }
}

export async function testLinuxHotkey(durationSeconds: number): Promise<DesktopTestResult> {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 30) {
    throw new Error('Hotkey test duration must be an integer from 1 to 30 seconds.');
  }
  if (session() !== 'x11') {
    return {
      capability: 'globalHotkey',
      status: 'unavailable',
      detail: session() === 'wayland'
        ? 'A Wayland GlobalShortcuts portal adapter is not implemented. No keyboard hook was installed.'
        : 'No X11 desktop session is available. No keyboard hook was installed.',
    };
  }
  try {
    const output = await runCommand('python3', [hotkeyHelperPath, '--seconds', String(durationSeconds)], {
      timeoutMs: (durationSeconds + 3) * 1000,
    });
    const result = desktopTestResultSchema.parse(JSON.parse(output));
    if (result.capability !== 'globalHotkey') throw new Error('Unexpected capability');
    return result;
  } catch {
    return {
      capability: 'globalHotkey', status: 'unavailable',
      detail: 'The X11 shortcut helper failed. Check Python 3, libX11, DISPLAY authorization, and whether another application owns Ctrl+Shift+Space.',
    };
  }
}

export async function linuxVoiceHelper(): Promise<VoiceHelperSpec> {
  requireX11();
  const [recorder, hotkeys] = await Promise.all([
    isInstalled('arecord', ['--version']),
    runCommand('python3', [hotkeyHelperPath, '--probe'], { timeoutMs: 3000 })
      .then((output) => z.object({ available: z.literal(true) }).strict().parse(JSON.parse(output)))
      .then(() => true).catch(() => false),
  ]);
  if (!recorder || !hotkeys) {
    throw new Error('Linux voice requires arecord (alsa-utils), Python 3, and libX11 in a logged-in X11 session.');
  }
  return { file: 'python3', args: [voiceHelperPath] };
}

const pointerSnapshotSchema = z.object({
  x: z.number().int(), y: z.number().int(),
  windowId: z.string().regex(/^[1-9]\d{0,9}$/).nullable(),
}).strict();

export async function captureLinuxContext(signal?: AbortSignal): Promise<DesktopContext> {
  requireX11();
  signal?.throwIfAborted();
  const capturedAt = new Date().toISOString();
  const options = { timeoutMs: 3000, ...(signal ? { signal } : {}) };
  const context: DesktopContext = { platform: 'linux', capturedAt, activeWindow: null, warnings: [] };
  const metadata = async (id: string): Promise<NonNullable<DesktopContext['activeWindow']>> => {
    const [application, title] = await Promise.all([
      windowApplication(id, signal),
      runCommand('xdotool', ['getwindowname', id], options),
    ]);
    const name = checkedText(application.trim(), 'Window application', 1024);
    if (!name) throw new Error('Missing application class');
    return { id, application: name, title: checkedText(title.replace(/\r?\n$/, ''), 'Window title', 8192) };
  };
  // IDs and coordinates are captured once, before metadata lookup. Neither voice
  // nor a later pointer movement changes which windows this turn refers to.
  const [active, pointer, selection] = await Promise.allSettled([
    activeWindowId(signal).then((id) => id ? metadata(id) : null),
    runCommand('python3', [voiceHelperPath, '--pointer'], options).then(async (output) => {
      const point = pointerSnapshotSchema.parse(JSON.parse(output));
      const window = point.windowId ? await metadata(windowId(point.windowId)).catch(() => null) : null;
      if (point.windowId && !window) context.warnings.push('The window under the pointer could not be identified.');
      return { x: point.x, y: point.y, window };
    }),
    runCommand('xsel', ['--primary', '--output', '--selectionTimeout', '1000'], options)
      .then((text) => checkedText(text, 'Selected text', 65536)),
  ]);
  signal?.throwIfAborted();
  if (active.status === 'fulfilled') context.activeWindow = active.value;
  else context.warnings.push('Active-window context is unavailable; check xdotool and xprop.');
  if (pointer.status === 'fulfilled') context.pointer = pointer.value;
  else context.warnings.push('Pointer context is unavailable or changed during capture.');
  if (selection.status === 'fulfilled') {
    context.selectedText = selection.value;
    context.warnings.push('Selected text comes from X11 PRIMARY and may belong to a different window.');
  } else context.warnings.push('X11 PRIMARY selected text is unavailable.');
  return desktopContextSchema.parse(context);
}
