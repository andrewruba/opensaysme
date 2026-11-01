import { z } from 'zod';
import type { InputResult } from './input-types.js';

export const keyboardKeys = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ...'0123456789',
  'Space', 'Tab', 'Enter', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
] as const;
const modifiers = z.array(z.enum(['Cmd', 'Ctrl', 'Alt', 'Shift'])).max(4)
  .refine((values) => new Set(values).size === values.length, 'Duplicate modifiers.');
export const keyboardActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('press_key'), key: z.enum(keyboardKeys), modifiers }).strict().refine(
    ({ key, modifiers }) => !(key === 'C' && modifiers.includes('Ctrl'))
      && !(key === 'V' && (modifiers.includes('Cmd') || modifiers.includes('Ctrl'))),
    'Cancellation shortcuts and pasting uninspected clipboard contents are not supported.'),
  z.object({ kind: z.literal('type_keyboard_text'),
    // Keyboard text never generates control keys or implicit submission.
    // eslint-disable-next-line no-control-regex
    text: z.string().min(1).max(4096).regex(/^[^\u0000-\u001f\u007f\u0085\u2028\u2029]+$/)
      .refine((value) => value.length <= 4096, 'Text exceeds 4096 UTF-16 code units.'),
  }).strict(),
]);
export type KeyboardAction = z.infer<typeof keyboardActionSchema>;
export const keyboardEvidenceSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), application: z.string().min(1).max(1024),
  applicationId: z.string().min(1).max(512), windowId: z.string().min(1).max(512).optional(),
  role: z.string().min(1).max(128), title: z.string().max(1024), description: z.string().max(1024),
  value: z.string().max(4096), valueTruncated: z.boolean(), editable: z.boolean(),
}).strict();
export type KeyboardEvidence = z.infer<typeof keyboardEvidenceSchema>;
export interface KeyboardAdapter {
  inspect(signal: AbortSignal): Promise<KeyboardEvidence>;
  execute(action: KeyboardAction, fingerprint: string, signal: AbortSignal): Promise<InputResult>;
}
