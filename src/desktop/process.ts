import { spawn } from 'node:child_process';

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
    if (signal.aborted) return reject(new Error('Desktop helper was stopped.'));
    if (options.input !== undefined && Buffer.byteLength(options.input) > 65_536) return reject(new Error('Desktop helper input exceeded its limit.'));
    const child = spawn(file, args, {
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: options.env,
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let failure: string | undefined;
    let finished = false;
    let forceKill: NodeJS.Timeout | undefined;
    const terminate = (reason: string) => {
      if (failure || finished) return;
      failure = reason;
      child.kill('SIGTERM');
      // Some native tools handle SIGTERM and exit zero; failure remains set.
      forceKill = setTimeout(() => child.kill('SIGKILL'), 500);
    };
    const onAbort = () => terminate('was stopped');
    const deadline = setTimeout(() => terminate('timed out'), options.timeoutMs ?? 8_000);
    signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      finished = true;
      clearTimeout(deadline);
      clearTimeout(forceKill);
      signal.removeEventListener('abort', onAbort);
    };
    const count = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) terminate('exceeded its output limit');
    };
    child.stdout!.on('data', (chunk: Buffer) => {
      count(chunk);
      if (!failure) chunks.push(chunk);
    });
    child.stderr!.on('data', count);
    if (child.stdin) {
      child.stdin.on('error', () => terminate('could not receive input'));
      child.stdin.end(options.input);
    }
    child.once('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(new Error(`Desktop helper could not start (${error.code ?? 'unknown'}). Run opensaysme doctor for prerequisites.`));
    });
    child.once('close', (code) => {
      cleanup();
      if (failure || code !== 0) reject(new Error(`Desktop helper ${failure ?? `failed (${code ?? 'signal'})`}. Run opensaysme doctor for prerequisites.`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
