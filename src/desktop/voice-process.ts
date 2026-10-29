import { spawn } from 'node:child_process';
import { nativeVoiceEventSchema, type NativeVoiceCommand, type NativeVoiceEvent, type VoiceHelperSpec } from './voice-types.js';

export interface VoiceInput {
  ready: Promise<void>;
  done: Promise<void>;
  send(command: NativeVoiceCommand): void;
  close(): Promise<void>;
}

export function startVoiceHelper(spec: VoiceHelperSpec, onEvent: (event: NativeVoiceEvent) => void): VoiceInput {
  const child = spawn(spec.file, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let closing = false;
  let exited = false;
  let failure: Error | undefined;
  let buffer = '';
  let stderrBytes = 0;
  let killTimer: NodeJS.Timeout | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // Errors may precede the caller attaching its lifecycle handlers.
  void ready.catch(() => {});
  void done.catch(() => {});
  const deadline = setTimeout(() => fail('Desktop voice helper did not become ready within 15 seconds.'), 15_000);

  function terminate() {
    child.kill('SIGTERM');
    killTimer ??= setTimeout(() => child.kill('SIGKILL'), 500);
  }
  function fail(message: string) {
    if (failure || exited) return;
    failure = new Error(message);
    rejectReady(failure);
    clearTimeout(deadline);
    terminate();
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (closing || failure) return;
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.length > 200_000) { fail('Desktop voice helper exceeded its message limit.'); return; }
      let value: unknown;
      try { value = JSON.parse(line); } catch { fail('Desktop voice helper returned invalid JSON.'); return; }
      const parsed = nativeVoiceEventSchema.safeParse(value);
      if (!parsed.success) { fail('Desktop voice helper returned an invalid event.'); return; }
      if (parsed.data.type === 'ready') { clearTimeout(deadline); resolveReady(); }
      try { onEvent(parsed.data); } catch { fail('Desktop voice event handling failed.'); return; }
    }
    if (buffer.length > 200_000) fail('Desktop voice helper exceeded its message limit.');
  });
  // Never echo native diagnostics; they can contain device names or context.
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 1024 * 1024) fail('Desktop voice helper exceeded its diagnostic limit.');
  });
  child.stdin.on('error', () => { if (!closing) fail('Desktop voice helper input closed unexpectedly.'); });
  child.on('error', () => fail('Could not start desktop voice helper. Run opensaysme doctor for prerequisites.'));
  child.on('close', () => {
    exited = true;
    clearTimeout(deadline);
    clearTimeout(killTimer);
    buffer = '';
    if (!closing && !failure) failure = new Error('Desktop voice helper exited unexpectedly. Run opensaysme doctor.');
    rejectReady(failure ?? new Error('Desktop voice helper stopped.'));
    if (failure) rejectDone(failure);
    else resolveDone();
  });
  function send(command: NativeVoiceCommand) {
    if (closing || exited || failure) throw new Error('Desktop voice helper is not running.');
    if (child.stdin.writableLength > 65_536) throw new Error('Desktop voice helper is not consuming commands.');
    child.stdin.write(`${JSON.stringify(command)}\n`);
  }
  return {
    ready, done, send,
    async close() {
      if (!closing && !exited) {
        closing = true;
        clearTimeout(deadline);
        child.stdin.end(`${JSON.stringify({ type: 'shutdown' })}\n`);
        killTimer ??= setTimeout(terminate, 500);
        // terminate must get a second deadline if the graceful one fires.
        const force = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 1200);
        try { await done.catch(() => {}); } finally { clearTimeout(force); }
      } else await done.catch(() => {});
    },
  };
}
