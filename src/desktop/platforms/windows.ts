import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { runCommand } from '../process.js';
import { desktopTestResultSchema, type DesktopReport, type DesktopSnapshot, type DesktopTestResult } from '../types.js';

const helperPath = fileURLToPath(new URL('../../../native/windows/desktop.ps1', import.meta.url));
const windowId = z.string().refine((value) => {
  if (!/^win32:[1-9]\d{0,9}:[1-9]\d{0,18}$/.test(value)) return false;
  const [, processId, handle] = value.split(':');
  return BigInt(processId!) <= 4_294_967_295n && BigInt(handle!) <= 9_223_372_036_854_775_807n;
}, 'Invalid Windows window identifier');
const windowSchema = z.object({
  id: windowId,
  application: z.string().min(1).max(1024),
  title: z.string().max(16_384),
}).strict();
const probeSchema = z.object({
  version: z.literal(1),
  operation: z.literal('probe'),
  interactive: z.boolean(),
  automation: z.boolean(),
}).strict();
const snapshotSchema = z.object({
  version: z.literal(1),
  operation: z.literal('inspect'),
  window: windowSchema.nullable(),
  selectedText: z.string().max(16_384).optional(),
}).strict();
const focusSchema = z.object({
  version: z.literal(1),
  operation: z.literal('focus'),
  focused: z.literal(true),
}).strict();
const helperErrorMessages = {
  'native-failure': 'Windows desktop access failed. Check the interactive desktop session and PowerShell prerequisites.',
  'invalid-target': 'The target Windows window is no longer available.',
  'focus-denied': 'Windows refused foreground activation. Activate the tool deliberately and try again.',
  'selection-unavailable': 'The focused Windows control does not expose selected text through UI Automation.',
  'selection-too-large': 'The Windows selection exceeds 16,384 characters. Select a smaller passage.',
  'focus-changed': 'Desktop focus changed while reading selection; inspect again.',
} as const;
const helperErrorSchema = z.object({
  version: z.literal(1),
  operation: z.literal('error'),
  code: z.enum(['native-failure', 'invalid-target', 'focus-denied', 'selection-unavailable', 'selection-too-large', 'focus-changed']),
}).strict();

async function invoke(operation: 'probe' | 'inspect' | 'focus', args: string[] = []): Promise<string> {
  return runCommand('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', helperPath,
    '-Operation', operation, ...args,
  ], { timeoutMs: 10_000 });
}

function decode<T>(schema: z.ZodType<T>, output: string): T {
  // Do not include helper output in errors: it can contain selected text.
  let value: unknown;
  try {
    value = JSON.parse(output.replace(/^\uFEFF/, '').trim());
  } catch {
    throw new Error('The Windows desktop helper returned an invalid response.');
  }
  const helperError = helperErrorSchema.safeParse(value);
  if (helperError.success) throw new Error(helperErrorMessages[helperError.data.code]);
  const result = schema.safeParse(value);
  if (!result.success) throw new Error('The Windows desktop helper returned an invalid response.');
  return result.data;
}

export function parseWindowsSnapshot(output: string): DesktopSnapshot {
  const snapshot = decode(snapshotSchema, output);
  return {
    platform: 'win32',
    window: snapshot.window,
    ...(snapshot.selectedText === undefined ? {} : { selectedText: snapshot.selectedText }),
  };
}

export async function probeWindows(): Promise<DesktopReport> {
  let probe: z.infer<typeof probeSchema>;
  try {
    probe = decode(probeSchema, await invoke('probe'));
  } catch {
    const unavailable = {
      status: 'unavailable' as const,
      detail: 'Windows PowerShell could not run the desktop capability probe.',
    };
    return {
      platform: 'win32',
      session: 'desktop access could not be checked',
      capabilities: {
        activeWindow: unavailable, focusWindow: unavailable, selectedText: unavailable,
        globalHotkey: unavailable, microphone: unavailable,
      },
      notes: [
        'Use native Windows Node.js and Windows PowerShell 5.1 in an unlocked, logged-in desktop session.',
        'Confirm powershell.exe is available and native/windows helpers are present in the installation.',
        'Run Get-ExecutionPolicy -List in Windows PowerShell and check whether policy permits these local scripts. The tool does not change or bypass policy.',
        'See native/windows/README.md for compile and script checks; enterprise policy can also block Add-Type.',
      ],
    };
  }
  return {
    platform: 'win32',
    session: probe.interactive ? 'interactive Windows desktop' : 'no foreground desktop',
    capabilities: {
      activeWindow: {
        status: probe.interactive ? 'available' : 'unavailable',
        detail: probe.interactive ? 'Win32 foreground window detected.' : 'Run in an unlocked, logged-in Windows desktop session.',
      },
      focusWindow: {
        status: probe.interactive ? 'unverified' : 'unavailable',
        detail: 'Win32 focus adapter present; Windows foreground restrictions may deny activation. Test with desktop focus.',
      },
      selectedText: {
        status: probe.interactive && probe.automation ? 'unverified' : 'unavailable',
        detail: probe.automation
          ? 'UI Automation loaded. Selection requires a focused control exposing TextPattern; inspect with --selection to test.'
          : 'UI Automation could not be loaded.',
      },
      globalHotkey: {
        status: probe.interactive ? 'unverified' : 'unavailable',
        detail: probe.interactive
          ? 'RegisterHotKey adapter present. Run desktop test-hotkey to test Ctrl+Shift+Space.'
          : 'Global shortcuts need an unlocked, logged-in Windows desktop session.',
      },
      microphone: { status: 'unverified', detail: 'Default-device PCM adapter present. Run desktop test-microphone to test capture.' },
    },
    notes: [
      'Doctor does not change focus or read selected text.',
      'Elevated apps, secure desktops, and applications without accessibility support may be inaccessible.',
      'PowerShell execution policy is respected; this helper does not bypass it.',
    ],
  };
}

export async function inspectWindows(includeSelection: boolean): Promise<DesktopSnapshot> {
  const snapshot = parseWindowsSnapshot(await invoke('inspect', includeSelection ? ['-IncludeSelection'] : []));
  if (includeSelection && snapshot.selectedText === undefined) {
    throw new Error('Selected text is unavailable from the current Windows control.');
  }
  return snapshot;
}

export async function focusWindows(targetId: string): Promise<void> {
  const parsed = windowId.safeParse(targetId);
  if (!parsed.success) throw new Error('Use a Windows window ID returned by desktop inspect.');
  decode(focusSchema, await invoke('focus', ['-TargetId', parsed.data]));
}

async function testInput(capability: 'globalHotkey' | 'microphone', durationSeconds: number): Promise<DesktopTestResult> {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 30) {
    throw new Error('Desktop tests must run for 1 to 30 seconds.');
  }
  const output = await runCommand('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('../../../native/windows/input.ps1', import.meta.url)),
    '-Capability', capability, '-DurationSeconds', String(durationSeconds),
  ], { timeoutMs: durationSeconds * 1000 + 10_000 });
  const result = decode(desktopTestResultSchema, output);
  if (result.capability !== capability) throw new Error('The Windows desktop helper returned the wrong capability.');
  return result;
}

export async function testWindowsHotkey(durationSeconds: number): Promise<DesktopTestResult> {
  return testInput('globalHotkey', durationSeconds);
}

export async function testWindowsMicrophone(durationSeconds: number): Promise<DesktopTestResult> {
  return testInput('microphone', durationSeconds);
}
