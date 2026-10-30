import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { CommandError, runCommand } from '../process.js';
import { desktopInputSchema, inputEvidenceSchema, inputResultSchema, inputTargetSchema, type DesktopInputAdapter } from '../input-types.js';
import { desktopContextSchema, type DesktopContext, type VoiceHelperSpec } from '../voice-types.js';
import { screenFrameCaptureSchema, type ScreenFrameCapture } from '../visual-types.js';
import {
  desktopReportSchema,
  desktopSnapshotSchema,
  desktopTestResultSchema,
  windowInventorySchema,
  windowInspectionSchema,
  windowFrameCaptureSchema,
  type DesktopReport,
  type DesktopSnapshot,
  type DesktopTestResult,
  type WindowInventory,
  type WindowInspection,
  type WindowFrameCapture,
} from '../types.js';

const helperPath = fileURLToPath(new URL('../../../native/macos/bin/opensaysme-desktop', import.meta.url));
const targetIdSchema = z.string().regex(/^mac:[1-9]\d{0,9}:\d{1,16}:[a-f0-9]{64}$/)
  .refine((id) => Number(id.split(':')[1]) <= 2_147_483_647, 'Invalid macOS process ID');
const focusResultSchema = z.object({ ok: z.literal(true) }).strict();
const nativeErrors: Record<string, string> = {
  'permission-required': 'Enable Accessibility for the launching terminal/helper in System Settings > Privacy & Security > Accessibility, then retry.',
  'accessibility-unavailable': 'The macOS application does not expose the requested window or selected text through Accessibility.',
  'secure-field': 'Selected text is unavailable in secure text fields.',
  'selection-too-large': 'Selection exceeds 64 KiB. Select a smaller excerpt.',
  'invalid-target': 'Invalid or expired macOS window target. Run desktop inspect again.',
  'stale-or-ambiguous-target': 'Window target is stale or ambiguous. Run desktop inspect again; duplicate window titles may require a distinct title.',
  'focus-rejected': 'macOS or the application rejected the focus change.',
  'focus-unverified': 'Focus change was requested but could not be verified; macOS may have blocked activation.',
  'focus-changed': 'Desktop focus changed or the selection could not be tied to the inspected window. Retry with focus held steady.',
  'screen-permission-required': 'Enable Screen Recording for the launching terminal/helper in System Settings > Privacy & Security, then restart the terminal.',
  'screen-capture-unavailable': 'Screen capture requires macOS 14 or later and an active display under the pointer.',
  'screen-capture-failed': 'macOS could not capture a screen frame. Check Screen Recording permission and the active desktop session.',
  'window-capture-unsupported': 'Window screenshots require macOS 14 or later.',
  'window-capture-unavailable': 'The requested window is hidden, minimized, or unavailable for capture.',
  'window-capture-ambiguous': 'The requested window could not be uniquely matched to a capture source.',
  'window-capture-stale': 'The requested window changed during capture. Rediscover the target.',
  'window-capture-timeout': 'Window capture timed out.',
  'window-capture-failed': 'macOS could not capture the requested window.',
};

class MacOSHelperError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

async function requireHelper(): Promise<void> {
  try {
    await access(helperPath, constants.X_OK);
  } catch {
    throw new Error('The macOS desktop helper is not built. Run npm run build:native on macOS with Xcode Command Line Tools installed.');
  }
}

async function invoke(args: string[], timeoutMs = 10_000, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  await requireHelper();
  signal?.throwIfAborted();
  return runCommand(helperPath, args, { timeoutMs, signal });
}

function decode<T>(schema: z.ZodType<T>, output: string): T {
  let data: unknown;
  try {
    data = JSON.parse(output);
  } catch {
    // A malformed response can include selected text; never echo it into logs.
    throw new Error('The macOS desktop helper returned an invalid response.');
  }
  const failure = z.object({ error: z.string() }).strict().safeParse(data);
  if (failure.success) {
    const code = failure.data.error;
    throw new MacOSHelperError(Object.hasOwn(nativeErrors, code) ? code : 'unknown', Object.hasOwn(nativeErrors, code)
      ? nativeErrors[code]!
      : 'The macOS desktop helper failed with an unknown error.');
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error('The macOS desktop helper returned an invalid response.');
  return parsed.data;
}

export function parseMacOSSnapshot(output: string): DesktopSnapshot {
  const result = decode(desktopSnapshotSchema, output);
  if (result.platform !== 'darwin' || (result.window && !targetIdSchema.safeParse(result.window.id).success)) {
    throw new Error('The macOS desktop helper returned an invalid window target.');
  }
  return result;
}

export async function probeMacOS(): Promise<DesktopReport> {
  try {
    const result = decode(desktopReportSchema, await invoke(['--probe']));
    if (result.platform !== 'darwin') throw new Error('The macOS helper returned an invalid platform.');
    return result;
  } catch {
    const capability = {
      status: 'unavailable' as const,
      detail: 'The macOS helper could not be run or returned an invalid response. Run npm run build:native with Xcode Command Line Tools installed, then retry from your desktop terminal.',
    };
    return {
      platform: 'darwin', session: 'not assessed',
      capabilities: { activeWindow: capability, focusWindow: capability, selectedText: capability,
        globalHotkey: capability, microphone: capability, screenCapture: capability },
      notes: ['No capability was verified. Rebuild the helper for this Mac; prebuilt signed releases are not available yet.'],
    };
  }
}

export async function listMacOSWindows(signal?: AbortSignal): Promise<WindowInventory> {
  const inventory = decode(windowInventorySchema, await invoke(['--list-windows'], 4_000, signal));
  if (inventory.windows.some((window) => !targetIdSchema.safeParse(window.id).success)) {
    throw new Error('The macOS desktop helper returned an invalid window target.');
  }
  return inventory;
}

export async function inspectMacOSWindow(targetId: string, signal?: AbortSignal): Promise<WindowInspection> {
  if (!targetIdSchema.safeParse(targetId).success) throw new Error('Use a macOS window ID returned by window discovery.');
  try {
    const result = decode(windowInspectionSchema, await invoke(['--inspect-window', targetId], 4_000, signal));
    if (result.status === 'ok' && result.window.id !== targetId) {
      throw new Error('The macOS desktop helper returned mismatched window content.');
    }
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof MacOSHelperError) {
      if (error.code === 'permission-required') return { status: 'unavailable', reason: 'permission-required' };
      if (['invalid-target', 'stale-or-ambiguous-target'].includes(error.code)) return { status: 'unavailable', reason: 'stale-target' };
      if (error.code === 'accessibility-unavailable') return { status: 'unavailable', reason: 'inaccessible' };
    }
    throw error;
  }
}

export async function captureMacOSWindow(targetId: string, signal?: AbortSignal): Promise<WindowFrameCapture> {
  if (!targetIdSchema.safeParse(targetId).success) throw new Error('Use a macOS window ID returned by window discovery.');
  try {
    const result = decode(windowFrameCaptureSchema, await invoke(['--capture-window', targetId], 5_000, signal));
    if (result.status === 'ok' && result.window.id !== targetId) {
      throw new Error('The macOS desktop helper returned mismatched window pixels.');
    }
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof CommandError) {
      if (error.reason === 'signal') return { status: 'unavailable', reason: 'helper-crashed' };
      if (error.reason === 'timeout') return { status: 'unavailable', reason: 'timeout' };
    }
    const reasons: Record<string, Extract<WindowFrameCapture, { status: 'unavailable' }>['reason']> = {
      'permission-required': 'accessibility-permission-required', 'screen-permission-required': 'screen-permission-required',
      'invalid-target': 'stale-target', 'stale-or-ambiguous-target': 'stale-target', 'window-capture-stale': 'stale-target',
      'accessibility-unavailable': 'inaccessible', 'window-capture-unavailable': 'inaccessible',
      'window-capture-unsupported': 'unsupported', 'window-capture-ambiguous': 'ambiguous-target',
      'window-capture-timeout': 'timeout', 'window-capture-failed': 'capture-failed',
    };
    if (error instanceof MacOSHelperError && Object.hasOwn(reasons, error.code)) {
      return { status: 'unavailable', reason: reasons[error.code]! };
    }
    throw error;
  }
}

async function inputCommand(mode: 'inspect' | 'execute', target: unknown, action: unknown,
  fingerprint: string | null, signal: AbortSignal): Promise<string> {
  const parsed = inputTargetSchema.parse(target);
  if (!targetIdSchema.safeParse(parsed.windowId).success) throw new Error('Invalid macOS input target.');
  const input = JSON.stringify({ target: parsed, action: desktopInputSchema.parse(action), fingerprint });
  signal.throwIfAborted(); await requireHelper(); signal.throwIfAborted();
  // Text and captured context never appear in process arguments or a temporary file.
  return runCommand(helperPath, [`--${mode}-input`], { input, timeoutMs: 3_000, signal });
}

export const macOSInput: DesktopInputAdapter = {
  inspect: async (target, action, signal) => decode(inputEvidenceSchema, await inputCommand('inspect', target, action, null, signal)),
  execute: async (target, action, fingerprint, signal) => {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid macOS input evidence.');
    return decode(inputResultSchema, await inputCommand('execute', target, action, fingerprint, signal));
  },
};

export async function inspectMacOS(includeSelection: boolean, signal?: AbortSignal): Promise<DesktopSnapshot> {
  const result = parseMacOSSnapshot(await invoke([includeSelection ? '--inspect-selection' : '--inspect'], 10_000, signal));
  if (includeSelection && result.selectedText === undefined) {
    throw new Error('Selected text is unavailable from the current macOS control.');
  }
  return result;
}

export async function focusMacOS(targetId: string, signal?: AbortSignal): Promise<void> {
  if (!targetIdSchema.safeParse(targetId).success) {
    throw new Error('Use a macOS window ID returned by desktop inspect.');
  }
  decode(focusResultSchema, await invoke(['--focus', targetId], 10_000, signal));
}

async function test(capability: 'globalHotkey' | 'microphone', durationSeconds: number): Promise<DesktopTestResult> {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 30) {
    throw new Error('Test duration must be an integer from 1 to 30 seconds.');
  }
  const option = capability === 'globalHotkey' ? '--test-hotkey' : '--test-microphone';
  const result = decode(desktopTestResultSchema, await invoke([option, String(durationSeconds)], (durationSeconds + 10) * 1000));
  if (result.capability !== capability) throw new Error('The macOS helper returned an unexpected test result.');
  return result;
}

export function testMacOSHotkey(durationSeconds: number): Promise<DesktopTestResult> {
  return test('globalHotkey', durationSeconds);
}

export function testMacOSMicrophone(durationSeconds: number): Promise<DesktopTestResult> {
  return test('microphone', durationSeconds);
}

export async function macOSVoiceHelper(): Promise<VoiceHelperSpec> {
  await requireHelper();
  return { file: helperPath, args: ['--voice'] };
}

export async function captureMacOSContext(signal?: AbortSignal): Promise<DesktopContext> {
  const result = decode(desktopContextSchema, await invoke(['--context'], 4_000, signal));
  if (result.platform !== 'darwin' || [result.activeWindow, result.pointer?.window]
    .some((window) => window && !targetIdSchema.safeParse(window.id).success)) {
    throw new Error('The macOS desktop helper returned an invalid context target.');
  }
  return result;
}

export async function captureMacOSFrame(signal?: AbortSignal): Promise<ScreenFrameCapture> {
  const result = decode(screenFrameCaptureSchema, await invoke(['--frame'], 4_000, signal));
  if (!/^[1-9]\d{0,9}$/.test(result.display.id) || Number(result.display.id) > 0xffff_ffff) {
    throw new Error('The macOS desktop helper returned an invalid screen display.');
  }
  return result;
}
