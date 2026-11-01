/* global AbortController */
import { spawn } from 'node:child_process';
import { setTimeout, clearTimeout } from 'node:timers';

// npm and shell scripts can leave a compiler behind when only their parent is
// cancelled. Keep the entire build process group stopped before staging cleanup.
const cancellation = new AbortController();
for (const name of ['SIGINT', 'SIGTERM']) {
  process.once(name, () => {
    process.exitCode = name === 'SIGINT' ? 130 : 143;
    cancellation.abort();
  });
}

export async function run(command, args, { cwd, env = process.env, capture = false, timeout = 180_000 } = {}) {
  cancellation.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, env, detached: grouped,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let output = '', errors = '', failure, stopping;
    const signal = (name) => {
      if (!child.pid) return false;
      try {
        if (grouped) process.kill(-child.pid, name);
        else if (!child.kill(name)) return false;
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
      }
    };
    const pause = () => new Promise((done) => setTimeout(done, 25));
    const terminate = async () => {
      if (!signal('SIGTERM')) return;
      const deadline = Date.now() + 2_000;
      while (signal(0)) {
        if (Date.now() >= deadline) {
          signal('SIGKILL');
          for (let attempt = 0; attempt < 20 && signal(0); attempt++) await pause();
          return;
        }
        await pause();
      }
    };
    const stop = (reason) => {
      failure ??= reason;
      stopping ??= terminate();
      // Observe a possible kill failure even before the direct child exits.
      void stopping.catch((error) => { failure ??= error; });
    };
    const abort = () => stop(new Error('Packaging cancelled.'));
    cancellation.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new Error(`${command} timed out.`)), timeout);
    child.stdout?.on('data', (data) => { output += data; });
    child.stderr?.on('data', (data) => { errors += data; });
    child.once('error', (error) => { failure = error; });
    child.once('close', async (code) => {
      clearTimeout(timer);
      cancellation.signal.removeEventListener('abort', abort);
      try { await stopping; } catch (error) { failure ??= error; }
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${command} exited with ${code}. ${errors.trim()}`));
      else resolve(output);
    });
  });
}
