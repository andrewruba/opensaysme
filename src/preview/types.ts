import { z } from 'zod';
import type { AttentionHistory } from '../attention.js';

const identifier = z.string().min(1).max(512);
const region = z.strictObject({
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1),
});

export const actionPreviewSchema = z.strictObject({
  action: z.enum(['focus_window', 'return_to_previous', 'insert_text', 'clarify', 'unsupported']),
  summary: z.string().min(1).max(2000),
  references: z.array(z.strictObject({
    role: z.enum(['source', 'target', 'context']),
    description: z.string().min(1).max(1000),
    frameId: identifier.nullable(),
    contextId: identifier.nullable(),
    windowId: identifier.nullable(),
    region: region.nullable(),
  })).max(8),
  text: z.string().max(16_384).nullable(),
  clarification: z.string().min(1).max(1000).nullable(),
});
export type ActionPreview = z.infer<typeof actionPreviewSchema>;
export interface PreviewInput {
  transcript: string;
  history: AttentionHistory;
  signal: AbortSignal;
}
export type PreviewFactory = (input: PreviewInput) => Promise<ActionPreview>;

/** Validate references against the evidence sent in this request, never model IDs alone. */
export function validatePreview(value: unknown, history: AttentionHistory): ActionPreview {
  const preview = actionPreviewSchema.parse(value);
  const frames = new Set(history.frames.map((frame) => frame.id));
  const contexts = new Map(history.contexts.map((sample) => [sample.id, sample.context]));
  const windowIds = (context: AttentionHistory['contexts'][number]['context']) =>
    [context.activeWindow?.id, context.pointer?.window?.id].filter((id): id is string => Boolean(id));
  const windows = new Set(history.contexts.flatMap((sample) => windowIds(sample.context)));
  for (const reference of preview.references) {
    if (!reference.frameId && !reference.contextId && !reference.windowId) throw new Error('Missing reference evidence.');
    if (reference.frameId && !frames.has(reference.frameId)) throw new Error('Unknown frame reference.');
    if (reference.contextId && !contexts.has(reference.contextId)) throw new Error('Unknown context reference.');
    if (reference.windowId && !windows.has(reference.windowId)) throw new Error('Unknown window reference.');
    if (reference.contextId && reference.windowId && !windowIds(contexts.get(reference.contextId)!).includes(reference.windowId)) {
      throw new Error('Window does not belong to the referenced context.');
    }
    if (reference.region && (!reference.frameId || reference.region.x + reference.region.width > 1
      || reference.region.y + reference.region.height > 1)) throw new Error('Invalid region reference.');
  }
  const targets = preview.references.filter((reference) => reference.role === 'target');
  if (['focus_window', 'return_to_previous', 'insert_text'].includes(preview.action)
    && (targets.length !== 1 || !targets[0]?.windowId)) throw new Error('Action needs one observed target window.');
  if (preview.action === 'return_to_previous') {
    const focusOrder = history.contexts.map((sample) => sample.context.activeWindow?.id)
      .filter((id): id is string => Boolean(id))
      .filter((id, index, all) => id !== all[index - 1]);
    if (focusOrder.length < 2 || targets[0]?.windowId !== focusOrder.at(-2)) throw new Error('Previous window is not established.');
  }
  if (preview.action === 'insert_text' ? !preview.text?.trim() : preview.text !== null) throw new Error('Invalid action text.');
  if (preview.action === 'clarify' ? !preview.clarification?.trim() : preview.clarification !== null) {
    throw new Error('Invalid clarification.');
  }
  return preview;
}
