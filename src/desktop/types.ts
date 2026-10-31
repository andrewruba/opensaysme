import { z } from 'zod';
import type { DesktopContext, VoiceHelperSpec } from './voice-types.js';
import { frameBoundsSchema, frameImageSchema, type ScreenFrameCapture } from './visual-types.js';
import type { DesktopInputAdapter } from './input-types.js';

export const capabilityNames = [
  'activeWindow', 'focusWindow', 'selectedText', 'globalHotkey', 'microphone', 'screenCapture',
] as const;

export const capabilitySchema = z.object({
  status: z.enum(['available', 'permission-required', 'unavailable', 'unverified']),
  detail: z.string(),
});
export type Capability = z.infer<typeof capabilitySchema>;

export const desktopReportSchema = z.object({
  platform: z.string(),
  session: z.string(),
  capabilities: z.object({
    activeWindow: capabilitySchema,
    focusWindow: capabilitySchema,
    selectedText: capabilitySchema,
    globalHotkey: capabilitySchema,
    microphone: capabilitySchema,
    screenCapture: capabilitySchema,
  }),
  notes: z.array(z.string()),
});
export type DesktopReport = z.infer<typeof desktopReportSchema>;

export const desktopSnapshotSchema = z.object({
  platform: z.string(),
  window: z.object({
    id: z.string().min(1),
    application: z.string(),
    title: z.string().optional(),
  }).nullable(),
  selectedText: z.string().optional(),
});
export type DesktopSnapshot = z.infer<typeof desktopSnapshotSchema>;

export const windowInventorySchema = z.object({
  windows: z.array(z.object({
    id: z.string().min(1).max(512), application: z.string().min(1).max(1024),
    title: z.string().max(16_384).optional(),
  }).strict()).max(128),
  warnings: z.array(z.string().max(1024)).max(16),
}).strict().refine((inventory) => new Set(inventory.windows.map(({ id }) => id)).size === inventory.windows.length,
  'Window IDs must be unique');
export type WindowInventory = z.infer<typeof windowInventorySchema>;

const contentText = z.string().max(2048);
export const windowInspectionSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'), capturedAt: z.string().datetime(),
    window: windowInventorySchema.shape.windows.element,
    nodes: z.array(z.object({
      parent: z.number().int().min(0).max(127).nullable(), role: z.string().min(1).max(128),
      title: contentText.optional(), description: contentText.optional(), value: contentText.optional(),
    }).strict()).max(128),
    warnings: z.array(z.string().max(1024)).max(16),
  }).strict().refine(({ nodes }) => nodes.every((node, index) => node.parent === null || node.parent < index)
    && nodes.reduce((total, node) => total + node.role.length + (node.title?.length ?? 0)
      + (node.description?.length ?? 0) + (node.value?.length ?? 0), 0) <= 16_384,
  'Invalid or oversized accessibility content'),
  z.object({ status: z.literal('unavailable'), reason: z.enum(['permission-required', 'stale-target', 'inaccessible']) }).strict(),
]);
export type WindowInspection = z.infer<typeof windowInspectionSchema>;

export const windowFrameCaptureSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'), capturedAt: z.string().datetime(),
    window: windowInventorySchema.shape.windows.element,
    bounds: frameBoundsSchema, image: frameImageSchema,
    warnings: z.array(z.string().max(1024)).max(16),
  }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.enum([
    'accessibility-permission-required', 'screen-permission-required', 'unsupported',
    'stale-target', 'ambiguous-target', 'inaccessible', 'timeout', 'capture-failed', 'helper-crashed',
  ]) }).strict(),
]);
export type WindowFrameCapture = z.infer<typeof windowFrameCaptureSchema>;

export interface DesktopAdapter {
  input?: DesktopInputAdapter;
  probe(): Promise<DesktopReport>;
  listWindows(signal?: AbortSignal): Promise<WindowInventory>;
  // Omitted when the platform has no implementation; do not advertise a phantom tool.
  inspectWindow?(targetId: string, signal?: AbortSignal): Promise<WindowInspection>;
  captureWindow?(targetId: string, signal?: AbortSignal): Promise<WindowFrameCapture>;
  inspect(includeSelection: boolean, signal?: AbortSignal): Promise<DesktopSnapshot>;
  focus(targetId: string, signal?: AbortSignal): Promise<void>;
  voiceHelper(activationHotkey?: string): Promise<VoiceHelperSpec>;
  feedbackHelper?(): Promise<VoiceHelperSpec>;
  captureContext(signal?: AbortSignal): Promise<DesktopContext>;
  captureFrame(signal?: AbortSignal): Promise<ScreenFrameCapture>;
}
