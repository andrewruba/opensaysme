import { z } from 'zod';

export const permissionNameSchema = z.enum(['microphone', 'accessibility', 'screenCapture']);
export type PermissionName = z.infer<typeof permissionNameSchema>;
const label = z.string().min(1).max(1024);
export const permissionReportSchema = z.object({
  helperPath: z.string().min(1).max(4096), bundleIdentifier: label,
  launcher: z.object({ name: label, bundleIdentifier: label.nullable(), path: z.string().min(1).max(4096).nullable() }).strict().nullable(),
  desktopAvailable: z.boolean(),
  permissions: z.object({
    microphone: z.enum(['granted', 'not-determined', 'denied', 'restricted', 'unavailable']),
    accessibility: z.enum(['granted', 'not-granted']),
    screenCapture: z.enum(['granted', 'not-granted', 'unsupported']),
  }).strict(),
}).strict();
export type PermissionReport = z.infer<typeof permissionReportSchema>;
export const permissionVerificationSchema = z.object({
  permission: permissionNameSchema,
  outcome: z.enum(['verified', 'permission-required', 'restricted', 'not-determined', 'unsupported',
    'no-device', 'no-window', 'capture-failed', 'cancelled', 'timeout']),
}).strict();
export type PermissionVerification = z.infer<typeof permissionVerificationSchema>;
export interface PermissionAccess {
  inspect(signal?: AbortSignal): Promise<PermissionReport>;
  verify(permission: PermissionName, signal?: AbortSignal): Promise<PermissionVerification>;
}
