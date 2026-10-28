import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { runCommand } from '../process.js';
import {
  desktopReportSchema,
  desktopSnapshotSchema,
  desktopTestResultSchema,
  type DesktopReport,
  type DesktopSnapshot,
  type DesktopTestResult,
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
};

async function invoke(args: string[], timeoutMs = 10_000): Promise<string> {
  try {
    await access(helperPath, constants.X_OK);
  } catch {
    throw new Error('The macOS desktop helper is not built. Run npm run build:native on macOS with Xcode Command Line Tools installed.');
  }
  return runCommand(helperPath, args, { timeoutMs });
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
    throw new Error(Object.hasOwn(nativeErrors, code)
      ? nativeErrors[code]
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
        globalHotkey: capability, microphone: capability },
      notes: ['No capability was verified. Rebuild the helper for this Mac; prebuilt signed releases are not available yet.'],
    };
  }
}

export async function inspectMacOS(includeSelection: boolean): Promise<DesktopSnapshot> {
  const result = parseMacOSSnapshot(await invoke([includeSelection ? '--inspect-selection' : '--inspect']));
  if (includeSelection && result.selectedText === undefined) {
    throw new Error('Selected text is unavailable from the current macOS control.');
  }
  return result;
}

export async function focusMacOS(targetId: string): Promise<void> {
  if (!targetIdSchema.safeParse(targetId).success) {
    throw new Error('Use a macOS window ID returned by desktop inspect.');
  }
  decode(focusResultSchema, await invoke(['--focus', targetId]));
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
