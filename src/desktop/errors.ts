import { z } from 'zod';
import { CommandError } from './process.js';

// Only these local messages may cross a native/transport failure boundary. Never
// derive recovery advice from arbitrary stderr, captured text or model output.
export const desktopMessages = {
  'permission-required': 'Enable Accessibility for the launching terminal/helper in System Settings > Privacy & Security > Accessibility, then restart that app and retry.',
  'screen-permission-required': 'Enable Screen Recording for the launching terminal/helper, then fully quit and reopen that app. Run opensaysme doctor to check access status.',
  'microphone-permission-required': 'Enable Microphone for the launching terminal/helper in System Settings > Privacy & Security, then restart that app and retry.',
  'microphone-unavailable': 'The microphone device is unavailable. Check the selected input device, then retry the voice turn.',
  'helper-missing': 'The macOS desktop helper is missing or not executable. Run npm run build:native, then opensaysme setup.',
  'helper-unavailable': 'The desktop helper could not start. Rebuild with npm run build:native and run opensaysme setup from your desktop terminal.',
  'helper-crashed': 'The desktop helper crashed. Rebuild with npm run build:native and run opensaysme setup. This is not evidence of denied permission.',
  'helper-invalid-response': 'The macOS desktop helper returned an invalid response.',
  'helper-failed': 'The macOS desktop helper failed with an unknown error.',
  timeout: 'Desktop access timed out. Check that the application responds, then retry with fresh context.',
  unsupported: 'This operation requires macOS 14 or later. Permission changes cannot enable an unsupported operation.',
  'unsupported-text-target': 'This control does not support literal text replacement. Use a supported accessible input; permission changes cannot make this control writable.',
  'input-unavailable': 'The input target could not be verified. Inspect its focus, visibility and current contents again. No input was issued.',
  'invalid-input': 'The native helper rejected the input protocol. Rebuild with npm run build:native before retrying.',
  'accessibility-unavailable': 'The application does not expose the requested window or control through Accessibility. Permission may be granted; try a supported target.',
  'secure-field': 'Selected text is unavailable in secure text fields.',
  'selection-too-large': 'Selection exceeds 64 KiB. Select a smaller excerpt.',
  'invalid-target': 'Invalid or expired macOS window target. Inspect current windows again.',
  'stale-or-ambiguous-target': 'Window target is stale or ambiguous. Inspect current windows again before acting.',
  'focus-rejected': 'macOS or the application rejected the focus change. Inspect the current target before retrying.',
  'focus-unverified': 'Focus was requested but could not be verified. Inspect the desktop before retrying.',
  'focus-changed': 'Desktop focus changed during inspection. Inspect again with focus held steady.',
  'screen-capture-unavailable': 'Screen capture requires macOS 14 or later and an active display under the pointer.',
  'screen-capture-timeout': 'Screen capture timed out. Check that the desktop responds and retry. This does not establish permission denial.',
  'screen-capture-failed': 'macOS could not capture a screen frame. Run opensaysme doctor for access status; a capture failure does not establish permission denial.',
  'window-capture-unsupported': 'Window screenshots require macOS 14 or later.',
  'window-capture-unavailable': 'The requested window is hidden, minimized, or unavailable for capture. Inspect current windows again.',
  'window-capture-ambiguous': 'The requested window could not be uniquely matched to a capture source. Inspect current windows again.',
  'window-capture-stale': 'The requested window changed during capture. Inspect current windows again.',
  'window-capture-timeout': 'Window capture timed out. Check that the application responds and inspect the window again.',
  'window-capture-failed': 'macOS could not capture the requested window. Run opensaysme doctor for access status; permission denial has not been established.',
} as const;
export type DesktopIssue = keyof typeof desktopMessages;
export const desktopIssueSchema = z.enum(Object.keys(desktopMessages) as [DesktopIssue, ...DesktopIssue[]]);
export class DesktopError extends Error {
  constructor(readonly code: DesktopIssue) { super(desktopMessages[code]); this.name = 'DesktopError'; }
}
export function desktopIssue(error: unknown): DesktopIssue | undefined {
  return error instanceof DesktopError ? error.code : undefined;
}
export function desktopCommandError(error: unknown): unknown {
  if (!(error instanceof CommandError) || error.reason === 'cancelled') return error;
  return new DesktopError(error.reason === 'timeout' ? 'timeout'
    : error.reason === 'signal' ? 'helper-crashed'
      : error.reason === 'spawn-failed' ? 'helper-unavailable'
        : ['output-limit', 'input-limit'].includes(error.reason) ? 'helper-invalid-response' : 'helper-failed');
}
