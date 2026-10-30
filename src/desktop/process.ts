import { spawn } from 'node:child_process';
import { constants } from 'node:os';

export type CommandFailureReason = 'cancelled' | 'timeout' | 'input-limit' | 'output-limit'
  | 'input-unavailable' | 'spawn-failed' | 'exit-failed' | 'signal';

/** Transport diagnostics are finite metadata, never native output or arguments. */
export class CommandError extends Error {
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;

  constructor(readonly reason: CommandFailureReason,
    details: { exitCode?: number | null; signal?: string | null; spawnCode?: string } = {}) {
    const exitCode = Number.isInteger(details.exitCode) && details.exitCode! >= 0 && details.exitCode! <= 0xffff_ffff
      ? details.exitCode! : undefined;
    const signal = details.signal && Object.hasOwn(constants.signals, details.signal) ? details.signal as NodeJS.Signals : undefined;
    const spawnCode = details.spawnCode && Object.hasOwn(constants.errno, details.spawnCode) ? details.spawnCode : 'unknown';
    const messages: Record<CommandFailureReason, string> = {
      cancelled: 'Desktop helper was stopped.',
      timeout: 'Desktop helper timed out. Run opensaysme doctor for prerequisites.',
      'input-limit': 'Desktop helper input exceeded its limit.',
      'output-limit': 'Desktop helper exceeded its output limit. Run opensaysme doctor for prerequisites.',
      'input-unavailable': 'Desktop helper could not receive input. Run opensaysme doctor for prerequisites.',
      'spawn-failed': `Desktop helper could not start (${spawnCode}). Run opensaysme doctor for prerequisites.`,
      'exit-failed': `Desktop helper failed (${exitCode ?? 'signal'}). Run opensaysme doctor for prerequisites.`,
      signal: 'Desktop helper failed (signal). Run opensaysme doctor for prerequisites.',
    };
    super(messages[reason]);
    this.name = 'CommandError';
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

export interface CommandOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  input?: string;
}

const shutdown = new AbortController();
export const cancelDesktopCommands = () => shutdown.abort();

// Never invoke a shell or include captured stdout/stderr in an error. Native
// output can contain private desktop content; adapters interpret it explicitly.
export function runCommand(
  file: string, args: string[], options: CommandOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const signal = options.signal ? AbortSignal.any([options.signal, shutdown.signal]) : shutdown.signal;
    if (signal.aborted) return reject(new CommandError('cancelled'));
    if (options.input !== undefined && Buffer.byteLength(options.input) > 65_536) return reject(new CommandError('input-limit'));
    let child;
    try {
      child = spawn(file, args, {
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: options.env,
      });
    } catch { return reject(new CommandError('spawn-failed')); }
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let failure: CommandFailureReason | undefined;
    let finished = false;
    let forceKill: NodeJS.Timeout | undefined;
    const terminate = (reason: CommandFailureReason) => {
      if (failure || finished) return;
      failure = reason;
      child.kill('SIGTERM');
      // Some native tools handle SIGTERM and exit zero; failure remains set.
      forceKill = setTimeout(() => child.kill('SIGKILL'), 500);
    };
    const onAbort = () => terminate('cancelled');
    const deadline = setTimeout(() => terminate('timeout'), options.timeoutMs ?? 8_000);
    signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      finished = true;
      clearTimeout(deadline);
      clearTimeout(forceKill);
      signal.removeEventListener('abort', onAbort);
    };
    const count = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) terminate('output-limit');
    };
    child.stdout!.on('data', (chunk: Buffer) => {
      count(chunk);
      if (!failure) chunks.push(chunk);
    });
    child.stderr!.on('data', count);
    if (child.stdin) {
      child.stdin.on('error', () => terminate('input-unavailable'));
      child.stdin.end(options.input);
    }
    child.once('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(new CommandError('spawn-failed', { spawnCode: error.code }));
    });
    child.once('close', (code, signal) => {
      cleanup();
      if (failure || code !== 0 || signal) reject(new CommandError(failure ?? (signal ? 'signal' : 'exit-failed'), { exitCode: code, signal }));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
