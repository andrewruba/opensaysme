import { z } from 'zod';

const windowSchema = z.object({
  id: z.string().min(1).max(512),
  application: z.string().max(1024),
  title: z.string().max(16_384).optional(),
}).strict();

export const desktopContextSchema = z.object({
  platform: z.string(),
  capturedAt: z.string().datetime(),
  activeWindow: windowSchema.nullable(),
  selectedText: z.string().max(65_536).optional(),
  pointer: z.object({ x: z.number().finite(), y: z.number().finite(), window: windowSchema.nullable() }).strict().optional(),
  warnings: z.array(z.string().max(1024)).max(16),
}).strict();
export type DesktopContext = z.infer<typeof desktopContextSchema>;

const turnId = z.string().min(1).max(64).regex(/^[a-zA-Z0-9-]+$/).refine((value) => !/[^a-zA-Z0-9-]/.test(value));
export const nativeVoiceEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }).strict(),
  z.object({ type: z.literal('toggle') }).strict(),
  z.object({ type: z.literal('cancel') }).strict(),
  z.object({ type: z.literal('pointer'), turnId, capturedAt: z.string().datetime(),
    x: z.number().finite(), y: z.number().finite(), displayId: z.string().min(1).max(128).nullable() }).strict(),
  z.object({ type: z.literal('audio-started'), turnId }).strict(),
  z.object({ type: z.literal('audio'), turnId, data: z.string().min(4).max(131_072).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict(),
  z.object({ type: z.literal('audio-stopped'), turnId }).strict(),
  z.object({ type: z.literal('error'), turnId: turnId.optional(), code: z.enum([
    'hotkey-unavailable', 'microphone-unavailable', 'capture-failed', 'invalid-command', 'internal-error',
  ]) }).strict(),
]);
export type NativeVoiceEvent = z.infer<typeof nativeVoiceEventSchema>;
export type NativeVoiceCommand =
  | { type: 'start' | 'stop' | 'cancel' | 'settled'; turnId: string }
  | { type: 'shutdown' };
export interface VoiceHelperSpec { file: string; args: string[] }
