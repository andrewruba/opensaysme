import { z } from 'zod';

export const capabilityNames = [
  'activeWindow', 'focusWindow', 'selectedText', 'globalHotkey', 'microphone',
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

export const desktopTestResultSchema = z.object({
  capability: z.enum(['globalHotkey', 'microphone']),
  status: z.enum(['passed', 'not-observed', 'unavailable']),
  detail: z.string(),
  metrics: z.record(z.string(), z.number()).optional(),
});
export type DesktopTestResult = z.infer<typeof desktopTestResultSchema>;

export interface DesktopAdapter {
  probe(): Promise<DesktopReport>;
  inspect(includeSelection: boolean): Promise<DesktopSnapshot>;
  focus(targetId: string): Promise<void>;
  testHotkey(durationSeconds: number): Promise<DesktopTestResult>;
  testMicrophone(durationSeconds: number): Promise<DesktopTestResult>;
}
