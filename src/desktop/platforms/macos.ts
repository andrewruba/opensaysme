import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { activationHotkeySchema, defaultActivationHotkey } from '../../hotkey.js';
import { recordHotkey, type HotkeyCaptureResult } from '../hotkey-process.js';

import { runCommand } from '../process.js';
import { DesktopError, desktopCommandError, desktopIssue, desktopMessages, desktopIssueSchema } from '../errors.js';
import { desktopInputSchema, inputEvidenceSchema, inputResultSchema, inputTargetSchema, type DesktopInputAdapter } from '../input-types.js';
import { desktopContextSchema, type DesktopContext, type VoiceHelperSpec } from '../voice-types.js';
import { screenFrameCaptureSchema, type ScreenFrameCapture } from '../visual-types.js';
import {
  desktopReportSchema,
  desktopSnapshotSchema,
  windowInventorySchema,
  windowInspectionSchema,
  windowFrameCaptureSchema,
  type DesktopReport,
  type DesktopSnapshot,
  type WindowInventory,
  type WindowInspection,
  type WindowFrameCapture,
} from '../types.js';

const helperPath = fileURLToPath(new URL('../../../native/macos/bin/opensaysme-desktop', import.meta.url));
const targetIdSchema = z.string().regex(/^mac:[1-9]\d{0,9}:\d{1,16}:[a-f0-9]{64}$/)
  .refine((id) => Number(id.split(':')[1]) <= 2_147_483_647, 'Invalid macOS process ID');
const focusResultSchema = z.object({ ok: z.literal(true) }).strict();
async function requireHelper(): Promise<void> {
  try {
    await access(helperPath, constants.X_OK);
  } catch {
    throw new DesktopError('helper-missing');
  }
}

async function invoke(args: string[], timeoutMs = 10_000, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  await requireHelper();
  signal?.throwIfAborted();
  try { return await runCommand(helperPath, args, { timeoutMs, signal }); }
  catch (error) { signal?.throwIfAborted(); throw desktopCommandError(error); }
}

function decode<T>(schema: z.ZodType<T>, output: string): T {
  let data: unknown;
  try {
    data = JSON.parse(output);
  } catch {
    // A malformed response can include selected text; never echo it into logs.
    throw new DesktopError('helper-invalid-response');
  }
  const failure = z.object({ error: z.string() }).strict().safeParse(data);
  if (failure.success) {
    const code = failure.data.error;
    const parsedCode = desktopIssueSchema.safeParse(code);
    throw new DesktopError(parsedCode.success ? parsedCode.data : 'helper-failed');
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new DesktopError('helper-invalid-response');
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
  } catch (error) {
    const capability = {
      status: 'unavailable' as const,
      detail: desktopMessages[desktopIssue(error) ?? 'helper-failed'],
    };
    return {
      platform: 'darwin', session: 'not assessed',
      capabilities: { activeWindow: capability, focusWindow: capability, selectedText: capability,
        globalHotkey: capability, microphone: capability, screenCapture: capability },
      notes: ['No capability was verified. Doctor requested no permissions and captured no data.'],
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
    if (error instanceof DesktopError) {
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
    if (error instanceof DesktopError) {
      if (error.code === 'helper-crashed') return { status: 'unavailable', reason: 'helper-crashed' };
      if (error.code === 'timeout') return { status: 'unavailable', reason: 'timeout' };
    }
    const reasons: Record<string, Extract<WindowFrameCapture, { status: 'unavailable' }>['reason']> = {
      'permission-required': 'accessibility-permission-required', 'screen-permission-required': 'screen-permission-required',
      'invalid-target': 'stale-target', 'stale-or-ambiguous-target': 'stale-target', 'window-capture-stale': 'stale-target',
      'accessibility-unavailable': 'inaccessible', 'window-capture-unavailable': 'inaccessible',
      'window-capture-unsupported': 'unsupported', 'window-capture-ambiguous': 'ambiguous-target',
      'window-capture-timeout': 'timeout', 'window-capture-failed': 'capture-failed',
    };
    if (error instanceof DesktopError && Object.hasOwn(reasons, error.code)) {
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
  try { return await runCommand(helperPath, [`--${mode}-input`], { input, timeoutMs: 3_000, signal }); }
  catch (error) { signal.throwIfAborted(); throw desktopCommandError(error); }
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

export async function macOSVoiceHelper(activationHotkey = defaultActivationHotkey): Promise<VoiceHelperSpec> {
  const shortcut = activationHotkeySchema.parse(activationHotkey);
  await requireHelper();
  return { file: helperPath, args: ['--voice', shortcut] };
}

export async function recordMacOSHotkey(signal?: AbortSignal, onReady = () => {}): Promise<HotkeyCaptureResult> {
  signal?.throwIfAborted();
  await requireHelper();
  return recordHotkey({ file: helperPath, args: ['--record-hotkey'] }, signal, onReady);
}

export async function macOSFeedbackHelper(): Promise<VoiceHelperSpec> {
  await requireHelper();
  return { file: helperPath, args: ['--feedback'] };
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
