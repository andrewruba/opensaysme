import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Only the in-process timeout test uses this clock. Subprocess fixtures keep
// their real timers, so readiness never races the simulated packaging deadline.
vi.mock('node:timers', () => ({
  setTimeout: (callback: () => void, milliseconds: number) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
}));
const realPause = pause;

const fixtures: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];
const processExists = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};
afterEach(async () => {
  vi.useRealTimers();
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  for (const root of fixtures.splice(0)) {
    try {
      const pid = Number(await readFile(join(root, 'parent.pid'), 'utf8'));
      if (Number.isInteger(pid) && pid > 1) process.kill(-pid, 'SIGKILL');
    } catch { /* Already stopped. */ }
    await rm(root, { recursive: true, force: true });
  }
});

async function fixtureFiles(startupDelay = 0) {
  const root = await mkdtemp(join(tmpdir(), 'opensaysme-package-process-'));
  fixtures.push(root);
  await writeFile(join(root, 'grandchild.mjs'), `import { writeFileSync } from 'node:fs';
await new Promise((resolve) => setTimeout(resolve, ${startupDelay}));
process.on('SIGTERM', () => {});
writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);`);
  await writeFile(join(root, 'parent.mjs'), `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], String(process.pid));
spawn(process.execPath, [process.argv[3], process.argv[4]], { stdio: 'ignore' });
setInterval(() => {}, 1000);`);
  return { root, args: [join(root, 'parent.mjs'), join(root, 'parent.pid'), join(root, 'grandchild.mjs'), join(root, 'grandchild.pid')] };
}

async function waitForGrandchild(root: string): Promise<number> {
  let pid = 0;
  for (let attempt = 0; attempt < 500; attempt++) {
    try { pid = Number(await readFile(join(root, 'grandchild.pid'), 'utf8')); if (pid > 1) break; } catch { /* Starting. */ }
    await realPause(20);
  }
  expect(pid).toBeGreaterThan(1);
  return pid;
}

async function fixture(timeout: number) {
  const { root, args } = await fixtureFiles();
  const runner = pathToFileURL(join(process.cwd(), 'scripts/package-process.mjs')).href;
  await writeFile(join(root, 'runner.mjs'), `import { run } from ${JSON.stringify(runner)};
try {
  await run(process.execPath, ${JSON.stringify(args)}, {capture:true,timeout:${timeout}});
  throw new Error('Unexpected success');
} catch (error) { process.stdout.write(error.message); }`);
  const child = spawn(process.execPath, [join(root, 'runner.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  const done = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
  const pid = await waitForGrandchild(root);
  return { child, done, pid };
}

describe.skipIf(!['darwin', 'linux'].includes(process.platform))('package subprocess cleanup', () => {
  it('kills a compiler grandchild that ignores TERM before reporting a timeout', async () => {
    // Reproduce slow CI startup beyond the deadline without killing the fixture
    // before the descendant-cleanup behavior can be exercised.
    const { root, args } = await fixtureFiles(1_000);
    const modulePath = pathToFileURL(join(process.cwd(), 'scripts/package-process.mjs')).href;
    const { run } = await import(modulePath);
    vi.useFakeTimers();
    let reported = false;
    const result = run(process.execPath, args, { capture: true, timeout: 600 })
      .then(() => 'Unexpected success', (error: Error) => error.message)
      .then((message: string) => { reported = true; return message; });
    const pid = await waitForGrandchild(root);
    expect(processExists(pid)).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    const parent = Number(await readFile(join(root, 'parent.pid'), 'utf8'));
    for (let attempt = 0; attempt < 100 && processExists(parent); attempt++) await realPause(20);
    expect(processExists(parent)).toBe(false);
    expect(processExists(pid)).toBe(true);
    expect(reported).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    // SIGKILL and orphan reaping belong to the real OS, not Vitest's clock.
    for (let attempt = 0; attempt < 100 && processExists(pid); attempt++) await realPause(20);
    expect(processExists(pid)).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBe(`${process.execPath} timed out.`);
    expect(processExists(pid)).toBe(false);
  }, 15_000);

  it('drains the entire child group before finishing cancelled packaging', async () => {
    const { child, done, pid } = await fixture(30_000);
    child.kill('SIGTERM');
    expect(await done).toEqual({ code: 143, output: 'Packaging cancelled.' });
    expect(processExists(pid)).toBe(false);
  }, 15_000);
});
