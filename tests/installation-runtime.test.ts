import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startInstallationRuntime, withInstallationMaintenance } from '../src/installation-runtime.js';

vi.setConfig({ testTimeout: 15_000 });
const roots: string[] = [];
const close: Array<() => Promise<void>> = [];
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'opensaysme-runtime-test-')));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(close.splice(0).map((done) => done()));
  for (const root of roots.splice(0)) {
    const identity = createHash('sha256').update(root).digest('hex').slice(0, 24);
    for (const suffix of ['sock', 'gate', 'runtime']) {
      await rm(`/private/tmp/opensaysme-${process.getuid?.()}/${identity}.${suffix}`, { force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== 'darwin')('installation runtime coordination', () => {
  it('waits for voice cleanup, then excludes new runtime and maintenance operations until finished', async () => {
    const root = await fixture();
    const stopped = deferred(), entered = deferred(), finish = deferred();
    const runtime = await startInstallationRuntime(root, () => stopped.resolve());
    close.push(runtime.close);
    let operated = false;
    const maintenance = withInstallationMaintenance(root, undefined, async () => {
      operated = true; entered.resolve();
      await finish.promise;
      return 'updated';
    });
    await stopped.promise;
    expect(operated).toBe(false);
    await expect(startInstallationRuntime(root, () => {})).rejects.toThrow('updating or uninstalling');
    await runtime.close();
    await entered.promise;
    await expect(startInstallationRuntime(root, () => {})).rejects.toThrow('updating or uninstalling');
    await expect(withInstallationMaintenance(root, undefined, async () => {})).rejects.toThrow('updating or uninstalling');
    finish.resolve();
    expect(await maintenance).toBe('updated');
    const restarted = await startInstallationRuntime(root, () => {});
    await restarted.close();
  });

  it('identifies symlink aliases as the same installation and leaves other installations running', async () => {
    const first = await fixture(), second = await fixture();
    const alias = join(second, 'alias');
    await symlink(first, alias);
    const stopFirst = vi.fn(), stopSecond = vi.fn();
    const runtime = await startInstallationRuntime(first, stopFirst);
    const other = await startInstallationRuntime(second, stopSecond);
    close.push(runtime.close, other.close);
    await expect(startInstallationRuntime(alias, () => {})).rejects.toThrow('already running');
    await runtime.close();
    await withInstallationMaintenance(alias, undefined, async () => {});
    expect(stopFirst).not.toHaveBeenCalled();
    expect(stopSecond).not.toHaveBeenCalled();
  });

  it('releases locks on cancellation and failure without running a cancelled operation', async () => {
    const root = await fixture();
    const stopped = deferred();
    const runtime = await startInstallationRuntime(root, () => stopped.resolve());
    close.push(runtime.close);
    const controller = new AbortController(), operation = vi.fn();
    const maintenance = withInstallationMaintenance(root, controller.signal, operation);
    const rejected = expect(maintenance).rejects.toThrow('cancelled');
    await stopped.promise;
    controller.abort();
    await rejected;
    expect(operation).not.toHaveBeenCalled();
    await runtime.close();
    await expect(withInstallationMaintenance(root, undefined, async () => { throw new Error('fixture failure'); })).rejects.toThrow('fixture failure');
    expect(await withInstallationMaintenance(root, undefined, async () => 'retry')).toBe('retry');
    const cancelled = new AbortController(); cancelled.abort();
    await expect(startInstallationRuntime(root, () => {}, cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const fresh = await startInstallationRuntime(root, () => {});
    await fresh.close();
  });

  it('recovers a stale socket after its owning fixture process crashes', async () => {
    const root = await fixture();
    const source = `import { startInstallationRuntime } from ${JSON.stringify(new URL('../src/installation-runtime.ts', import.meta.url).href)};
await startInstallationRuntime(${JSON.stringify(root)}, () => {});
process.stdout.write('ready\\n');`;
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Fixture did not start')), 10_000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}`)); });
      });
      const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.kill('SIGKILL');
      await exited;
      const recovered = await startInstallationRuntime(root, () => {});
      await recovered.close();
      expect(await withInstallationMaintenance(root, undefined, async () => 'removed')).toBe('removed');
    } finally { child.kill('SIGKILL'); }
  });

  it('fails closed for an unrecognized file at the control socket path', async () => {
    const root = await fixture();
    const identity = createHash('sha256').update(root).digest('hex').slice(0, 24);
    // Creating and closing first prepares the private registry and its lock files.
    const runtime = await startInstallationRuntime(root, () => {});
    await runtime.close();
    const socket = `/private/tmp/opensaysme-${process.getuid!()}/${identity}.sock`;
    await mkdir(socket);
    await expect(startInstallationRuntime(root, () => {})).rejects.toThrow('Unrecognized');
    const operation = vi.fn();
    await expect(withInstallationMaintenance(root, undefined, operation)).rejects.toThrow('Unrecognized');
    expect(operation).not.toHaveBeenCalled();
    await rm(socket, { recursive: true });
  });
});
