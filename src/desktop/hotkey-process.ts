import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { activationHotkeySchema } from '../hotkey.js';
import type { VoiceHelperSpec } from './voice-types.js';

export const hotkeyCaptureResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('captured'), shortcut: z.string().refine((value) => {
    const parsed = activationHotkeySchema.safeParse(value);
    return parsed.success && parsed.data === value;
  }) }),
  z.strictObject({ status: z.literal('cancelled') }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.enum([
    'accessibility-permission-required', 'capture-unavailable', 'timeout', 'focus-changed',
  ]) }),
]);
export type HotkeyCaptureResult = z.infer<typeof hotkeyCaptureResultSchema>;
const readySchema = z.strictObject({ status: z.literal('ready') });

/** Capture one chord; do not return it until the native event tap has exited. */
export function recordHotkey(spec: VoiceHelperSpec, signal: AbortSignal | undefined,
  onReady: () => void): Promise<HotkeyCaptureResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { resolve({ status: 'cancelled' }); return; }
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(spec.file, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch { reject(new Error('Could not start the shortcut recorder. Run npm run build:native.')); return; }
    let buffer = '', outputBytes = 0, diagnosticBytes = 0;
    let ready = false, closed = false, cancelled = false;
    let result: HotkeyCaptureResult | undefined;
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let exitTimer: NodeJS.Timeout | undefined;
    const readyTimer = setTimeout(() => fail('The shortcut recorder did not become ready.'), 5000);
    const deadline = setTimeout(() => fail('The shortcut recorder timed out.'), 35_000);

    function terminate() {
      if (closed || killTimer) return;
      child.stdin.end();
      child.kill('SIGTERM');
      killTimer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 500);
    }
    function fail(message: string) {
      if (closed || failure || cancelled) return;
      failure = new Error(message);
      clearTimeout(readyTimer);
      terminate();
    }
    const onAbort = () => {
      if (closed) return;
      cancelled = true;
      clearTimeout(readyTimer);
      terminate();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (closed || cancelled || failure) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 4096) { fail('The shortcut recorder exceeded its output limit.'); return; }
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let value: unknown;
        try { value = JSON.parse(line); }
        catch { fail('The shortcut recorder returned an invalid message.'); return; }
        if (result) { fail('The shortcut recorder returned an unexpected message.'); return; }
        if (readySchema.safeParse(value).success) {
          if (ready) { fail('The shortcut recorder returned an unexpected message.'); return; }
          ready = true; clearTimeout(readyTimer);
          try { onReady(); }
          catch { fail('The shortcut recorder could not show its prompt.'); return; }
          if (cancelled) return;
          continue;
        }
        const parsed = hotkeyCaptureResultSchema.safeParse(value);
        if (!parsed.success || (parsed.data.status === 'captured' && !ready)) {
          fail('The shortcut recorder returned an invalid result.'); return;
        }
        result = parsed.data;
        clearTimeout(readyTimer);
        exitTimer = setTimeout(() => fail('The shortcut recorder did not stop after capture.'), 500);
      }
    });
    // Diagnostics are bounded and discarded, never included in errors.
    child.stderr.on('data', (chunk: Buffer) => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes > 4096) fail('The shortcut recorder exceeded its diagnostic limit.');
    });
    child.stdin.on('error', () => fail('The shortcut recorder input closed unexpectedly.'));
    child.on('error', () => fail('Could not start the shortcut recorder. Run npm run build:native.'));
    child.on('close', (code, exitSignal) => {
      closed = true;
      clearTimeout(readyTimer); clearTimeout(deadline); clearTimeout(exitTimer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      if (cancelled || signal?.aborted) resolve({ status: 'cancelled' });
      else if (failure) reject(failure);
      else if (code !== 0 || exitSignal || buffer.length || !result) reject(new Error('The shortcut recorder exited without a valid result.'));
      else resolve(result);
      buffer = '';
    });
    // Keep stdin open while listening; EOF tells the native recorder to clean up.
    if (signal?.aborted) onAbort();
  });
}
