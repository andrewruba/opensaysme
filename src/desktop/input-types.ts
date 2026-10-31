import { z } from 'zod';
import { frameBoundsSchema } from './visual-types.js';
import { maxTextLength, isWellFormedText } from './text-types.js';

const point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
// JSON Schema maxLength counts code points; the native protocol bounds UTF-16.
const inputText = z.string().max(maxTextLength)
  .refine((text) => text.length <= maxTextLength && isWellFormedText(text), 'Invalid or oversized UTF-16 text.');
// Pointer-targeted input and literal AX replacement; keyboard input has its own focused-target protocol.
export const desktopInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('move_pointer') }).strict(),
  z.object({ kind: z.literal('click') }).strict(),
  z.object({ kind: z.literal('scroll'), deltaY: z.number().int().min(-600).max(600).refine((n) => n !== 0) }).strict(),
  // Preserve literal indentation/line breaks; they never become Enter/Tab events.
  // Other C0 controls and DEL remain invalid. JS length is UTF-16, as in the helper.
  // eslint-disable-next-line no-control-regex
  z.object({ kind: z.literal('type_text'), text: inputText.regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/) }).strict(),
]);
export type DesktopInput = z.infer<typeof desktopInputSchema>;
export function textRequiresTextArea(text: string): boolean { return /[\t\n\r\u0085\u2028\u2029]/.test(text); }
export const inputTargetSchema = z.object({
  windowId: z.string().min(1).max(512), bounds: frameBoundsSchema, point,
}).strict();
export type InputTarget = z.infer<typeof inputTargetSchema>;
export const inputEvidenceSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  role: z.string().min(1).max(128), title: z.string().max(1024),
  description: z.string().max(1024), value: inputText,
  bounds: frameBoundsSchema, focused: z.boolean(), editable: z.boolean(),
}).strict();
export type InputEvidence = z.infer<typeof inputEvidenceSchema>;
export const inputFailureReasonSchema = z.enum([
  'input-unavailable', 'invalid-input', 'permission-required', 'secure-field',
  'stale-or-ambiguous-target', 'invalid-target', 'accessibility-unavailable',
  'stale-observation', 'focus-changed', 'user-intervention', 'unsupported-text-target',
  'event-creation-failed', 'cancelled', 'text-write-failed', 'text-read-unavailable', 'text-value-mismatch', 'pointer-unverified',
]);
export type InputFailureReason = z.infer<typeof inputFailureReasonSchema>;
export const inputResultSchema = z.object({
  status: z.enum(['issued', 'verified', 'not-issued', 'uncertain']),
  reason: inputFailureReasonSchema.optional(),
}).strict().refine(({ status, reason }) => reason === undefined || ['not-issued', 'uncertain'].includes(status),
  'Successful input cannot carry a failure reason.');
export type InputResult = z.infer<typeof inputResultSchema>;
export interface DesktopInputAdapter {
  inspect(target: InputTarget, action: DesktopInput, signal: AbortSignal): Promise<InputEvidence>;
  execute(target: InputTarget, action: DesktopInput, fingerprint: string, signal: AbortSignal): Promise<InputResult>;
}
