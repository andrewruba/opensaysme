import { z } from 'zod';
import { frameBoundsSchema } from './visual-types.js';

const point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
// No arbitrary shortcuts, shell text, clipboard use, held buttons, or key sequences.
export const desktopInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('move_pointer') }).strict(),
  z.object({ kind: z.literal('click') }).strict(),
  z.object({ kind: z.literal('scroll'), deltaY: z.number().int().min(-600).max(600).refine((n) => n !== 0) }).strict(),
  // Explicitly exclude key/control characters; literal text never becomes Enter/Tab.
  // eslint-disable-next-line no-control-regex
  z.object({ kind: z.literal('type_text'), text: z.string().max(4096).regex(/^[^\u0000-\u001f\u007f\u2028\u2029]*$/) }).strict(),
  z.object({ kind: z.literal('press_key'), key: z.enum(['Tab', 'Enter']) }).strict(),
]);
export type DesktopInput = z.infer<typeof desktopInputSchema>;
export const inputTargetSchema = z.object({
  windowId: z.string().min(1).max(512), bounds: frameBoundsSchema, point,
}).strict();
export type InputTarget = z.infer<typeof inputTargetSchema>;
export const inputEvidenceSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  role: z.string().min(1).max(128), title: z.string().max(1024),
  description: z.string().max(1024), value: z.string().max(4096),
  bounds: frameBoundsSchema, focused: z.boolean(), editable: z.boolean(),
}).strict();
export type InputEvidence = z.infer<typeof inputEvidenceSchema>;
export const inputResultSchema = z.object({
  status: z.enum(['issued', 'verified', 'not-issued', 'uncertain']),
}).strict();
export type InputResult = z.infer<typeof inputResultSchema>;
export interface DesktopInputAdapter {
  inspect(target: InputTarget, action: DesktopInput, signal: AbortSignal): Promise<InputEvidence>;
  execute(target: InputTarget, action: DesktopInput, fingerprint: string, signal: AbortSignal): Promise<InputResult>;
}
