import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/desktop/process.js';

describe('native command lifecycle', () => {
  it('preserves whitespace and treats arguments literally', async () => {
    const value = '  selected text\n$(echo not-a-command)\n';
    const output = await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', value]);
    expect(output).toBe(value);
  });

  it('does not leak stdout or stderr on nonzero exit', async () => {
    const command = runCommand(process.execPath, ['-e', 'process.stdout.write("private-selection");process.stderr.write("private-key");process.exitCode=7']);
    await expect(command).rejects.toThrow('failed (7)');
    await expect(command).rejects.not.toThrow('private');
  });

  it('rejects a deadline even when the child exits zero after termination', async () => {
    await expect(runCommand(process.execPath, ['-e', 'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)'], { timeoutMs: 300 })).rejects.toThrow('timed out');
  });

  it('kills a child that ignores termination', async () => {
    const start = Date.now();
    await expect(runCommand(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { timeoutMs: 300 })).rejects.toThrow('timed out');
    expect(Date.now() - start).toBeLessThan(4000);
  });

  it('stops a running child on cancellation', async () => {
    const controller = new AbortController();
    const command = runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
    controller.abort();
    await expect(command).rejects.toThrow('stopped');
  });

  it('rejects already-cancelled work without spawning', async () => {
    await expect(runCommand('does-not-exist', [], { signal: AbortSignal.abort() })).rejects.toThrow('stopped');
  });

  it('bounds helper output', async () => {
    await expect(runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(2*1024*1024))'])).rejects.toThrow('output limit');
  });
});
