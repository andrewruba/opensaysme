import { z } from 'zod';

export const frameBoundsSchema = z.object({
  x: z.number().finite(), y: z.number().finite(),
  width: z.number().positive().max(65_536), height: z.number().positive().max(65_536),
}).strict();
export const frameImageSchema = z.object({
  mimeType: z.literal('image/jpeg'),
  width: z.number().int().positive().max(1600), height: z.number().int().positive().max(1600),
  data: z.string().min(4).max(1_400_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();

export const screenFrameCaptureSchema = z.object({
  capturedAt: z.string().datetime(),
  display: z.object({
    id: z.string().min(1).max(128),
    bounds: frameBoundsSchema,
  }).strict(),
  image: frameImageSchema,
  warnings: z.array(z.string().max(1024)).max(16),
}).strict();
export type ScreenFrameCapture = z.infer<typeof screenFrameCaptureSchema>;
