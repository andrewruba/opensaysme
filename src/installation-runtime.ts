import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { join } from 'node:path';

interface RuntimePaths { socket: string; gate: string; runtime: string }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const busy = () => new Error('OpenSaysMe is already starting, updating or uninstalling. Wait for it to finish and retry.');

async function paths(root: string): Promise<RuntimePaths> {
  if (process.platform !== 'darwin' || !process.getuid) throw new Error('Installation management requires macOS.');
  const uid = process.getuid();
  // A fixed, short path works across shells and custom configuration directories,
  // and stays below macOS's Unix socket path limit. It contains no captured data.
  const directory = `/private/tmp/opensaysme-${uid}`;
  await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) {
    throw new Error('OpenSaysMe runtime directory is not private to this user.');
  }
  const identity = createHash('sha256').update(await realpath(root)).digest('hex').slice(0, 24);
  return { socket: join(directory, `${identity}.sock`), gate: join(directory, `${identity}.gate`),
    runtime: join(directory, `${identity}.runtime`) };
}

/** lockf locks the inherited open-file description; our descriptor retains the
 * BSD lock after lockf exits. The kernel releases it if this process crashes. */
async function tryLock(path: string, signal?: AbortSignal): Promise<FileHandle | undefined> {
  signal?.throwIfAborted();
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0 || info.nlink !== 1) {
      throw new Error('OpenSaysMe installation lock is not a private regular file.');
    }
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn('/usr/bin/lockf', ['-s', '-t', '0', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', file.fd], signal, timeout: 2_000,
      });
      let failure: Error | undefined;
      child.once('error', (error) => { failure = error; });
      child.once('close', (code) => failure ? reject(failure) : resolve(code));
    });
    signal?.throwIfAborted();
    if (code === 0) return file;
    if (code !== 75) throw new Error('Could not acquire the OpenSaysMe installation lock.');
  } catch (error) {
    await file.close();
    throw error;
  }
  await file.close();
  return undefined;
}

async function removeStaleSocket(path: string): Promise<void> {
  // Both locks are held here. No live runtime can own or replace this socket.
  try {
    const info = await lstat(path);
    if (!info.isSocket() || info.uid !== process.getuid!()) throw new Error('Unrecognized OpenSaysMe control socket.');
    await unlink(path);
  } catch (error) { if (!missing(error)) throw error; }
}

export async function startInstallationRuntime(
  installationRoot: string, stop: () => void, signal?: AbortSignal,
): Promise<{ close(): Promise<void> }> {
  signal?.throwIfAborted();
  const location = await paths(installationRoot);
  const gate = await tryLock(location.gate, signal);
  if (!gate) throw busy();
  let runtime: FileHandle | undefined;
  try {
    runtime = await tryLock(location.runtime, signal);
    if (!runtime) throw new Error('OpenSaysMe is already running from this installation.');
    await removeStaleSocket(location.socket);
    const sockets = new Set<Socket>();
    let closing: Promise<void> | undefined, requested = false;
    const requestStop = () => {
      if (requested) return;
      requested = true;
      try { stop(); } catch { for (const socket of sockets) socket.destroy(); }
    };
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => socket.destroy());
      socket.once('close', () => sockets.delete(socket));
      socket.setTimeout(2_000, () => socket.destroy());
      let request = '';
      socket.on('data', (data: Buffer) => {
        request += data.toString('utf8');
        if (request === 'stop\n') {
          socket.setTimeout(0);
          requestStop();
        } else if (request.length >= 5 || !'stop\n'.startsWith(request)) socket.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(location.socket, () => { server.removeListener('error', reject); resolve(); });
    });
    // Runtime errors must not crash voice mode or signal an unrelated process.
    server.on('error', requestStop);
    const held = runtime;
    const close = () => closing ??= (async () => {
      signal?.removeEventListener('abort', requestStop);
      // The caller invokes close only AFTER microphone/helper cleanup. An ACK
      // therefore means cleanup finished, not merely that cancellation began.
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        for (const socket of sockets) socket.end('stopped\n', () => socket.destroy());
      }).finally(() => held.close());
    })();
    runtime = undefined; // close() now owns this descriptor.
    signal?.addEventListener('abort', requestStop, { once: true });
    if (signal?.aborted) requestStop();
    return { close };
  } finally {
    await runtime?.close();
    await gate.close();
  }
}

async function requestShutdown(path: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    let response = '', settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(new Error('Installation operation cancelled.'));
    const timer = setTimeout(() => finish(new Error('OpenSaysMe did not stop. Quit the running instance and retry.')), 15_000);
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('connect', () => socket.write('stop\n'));
    socket.on('data', (data: Buffer) => {
      response += data.toString('utf8');
      if (response === 'stopped\n') finish();
      else if (response.length >= 8 || !'stopped\n'.startsWith(response)) finish(new Error('Invalid OpenSaysMe shutdown response.'));
    });
    socket.once('error', () => finish(new Error('Could not contact the running OpenSaysMe instance. Quit it and retry.')));
    socket.once('close', () => { if (!settled) finish(new Error('OpenSaysMe closed without confirming shutdown.')); });
  });
}

export async function withInstallationMaintenance<T>(
  installationRoot: string, signal: AbortSignal | undefined, operation: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const location = await paths(installationRoot);
  const gate = await tryLock(location.gate, signal);
  if (!gate) throw busy();
  let runtime: FileHandle | undefined;
  try {
    runtime = await tryLock(location.runtime, signal);
    if (!runtime) {
      await requestShutdown(location.socket, signal);
      // ACK delivery can precede the runtime's close callback by one event turn.
      const deadline = Date.now() + 3_000;
      while (!(runtime = await tryLock(location.runtime, signal))) {
        if (Date.now() >= deadline) throw new Error('OpenSaysMe is still stopping. Retry shortly.');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await removeStaleSocket(location.socket);
    signal?.throwIfAborted();
    return await operation();
  } finally {
    await runtime?.close();
    await gate.close();
  }
}
