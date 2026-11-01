import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { VoiceHelperSpec } from './voice-types.js';

const bounded = (limit: number) => z.string().max(limit).refine((value) => value.length <= limit);
export const feedbackExpressionSchema = z.enum(['neutral', 'listening', 'thinking', 'focused', 'happy', 'concerned']);
export type FeedbackExpression = z.infer<typeof feedbackExpressionSchema>;
export const feedbackCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('show'), title: bounded(160).min(1), message: bounded(32_768), detail: bounded(512),
    persistent: z.boolean(), expression: feedbackExpressionSchema }).strict(),
  z.object({ type: z.literal('hide') }).strict(),
  z.object({ type: z.literal('shutdown') }).strict(),
]);
export type FeedbackCommand = z.infer<typeof feedbackCommandSchema>;
export interface FeedbackSink { send(command: FeedbackCommand): void; close(): Promise<void> }
export const feedbackUnavailable = 'On-screen feedback is unavailable. Voice continues in the terminal; rebuild the macOS helper if needed.';

/** Optional UI: one pending update, bounded pipes, and no private native output. */
export function startFeedbackHelper(spec: VoiceHelperSpec, onUnavailable: () => void): FeedbackSink {
  const child = spawn(spec.file, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let ready = false, closing = false, exited = false, failed = false;
  let pending: FeedbackCommand | undefined;
  let buffer = '', stderrBytes = 0;
  let terminateTimer: NodeJS.Timeout | undefined, killTimer: NodeJS.Timeout | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const deadline = setTimeout(fail, 3000);
  function terminate() {
    if (exited) return;
    child.kill('SIGTERM');
    killTimer ??= setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 500);
  }
  function fail() {
    if (failed || closing || exited) return;
    failed = true; pending = undefined; buffer = '';
    clearTimeout(deadline); terminate();
    onUnavailable();
  }
  function flush() {
    if (!ready || closing || exited || failed || !pending || child.stdin.writableNeedDrain) return;
    const command = pending; pending = undefined;
    try { child.stdin.write(`${JSON.stringify(command)}\n`); } catch { fail(); }
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (closing || failed) return;
    buffer += chunk;
    if (buffer.length > 4096) { fail(); return; }
    const end = buffer.indexOf('\n');
    if (end < 0) return;
    let value: unknown;
    try { value = JSON.parse(buffer.slice(0, end)); } catch { fail(); return; }
    if (ready || !z.object({ type: z.literal('ready') }).strict().safeParse(value).success
      || buffer.slice(end + 1).length > 0) { fail(); return; }
    buffer = ''; ready = true; clearTimeout(deadline); flush();
  });
  child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 65_536) fail(); });
  child.stdin.on('drain', flush);
  child.stdin.on('error', fail);
  child.on('error', fail);
  child.on('close', () => {
    if (!closing && !failed) fail();
    exited = true; pending = undefined; buffer = '';
    clearTimeout(deadline); clearTimeout(terminateTimer); clearTimeout(killTimer); resolveDone();
  });
  return {
    send(command) {
      if (closing || exited || failed) return;
      const parsed = feedbackCommandSchema.safeParse(command);
      if (!parsed.success || parsed.data.type === 'shutdown') { fail(); return; }
      pending = parsed.data; flush();
    },
    async close() {
      if (!closing && !exited) {
        closing = true; pending = undefined; clearTimeout(deadline);
        try { child.stdin.end('{"type":"shutdown"}\n'); } catch { terminate(); }
        terminateTimer = setTimeout(terminate, 200);
      }
      await done;
    },
  };
}
