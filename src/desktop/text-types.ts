import { z } from 'zod';

export const maxTextLength = 65_536;
export const textPreviewLength = 4096;
export const isWellFormedText = (text: string): boolean => !/[\ud800-\udfff]/u.test(text);
const boundedText = (limit: number) => z.string().max(limit)
  .refine((text) => text.length <= limit && isWellFormedText(text), 'Invalid or oversized UTF-16 text.');

/** Native capture is a suffix of one immutable AX value, not a complete document export. */
export const textCaptureSchema = z.object({
  capturedAt: z.string().datetime(), application: boundedText(256).refine((text) => text.length > 0),
  role: boundedText(128).refine((text) => text.length > 0),
  title: boundedText(1024), description: boundedText(1024), windowTitle: boundedText(1024),
  text: boundedText(maxTextLength),
  start: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  totalLength: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict().refine(({ start, text, totalLength }) => start + text.length === totalLength,
  'Captured text must be the declared suffix.');
export type TextCapture = z.infer<typeof textCaptureSchema>;

export function isTextBoundary(text: string, offset: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return false;
  const previous = text.charCodeAt(offset - 1), next = text.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}
