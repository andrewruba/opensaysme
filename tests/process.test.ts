import { describe, expect, it } from 'vitest';
import { CommandError, runCommand } from '../src/desktop/process.js';

describe('native command lifecycle', () => {
  it('sends private text over stdin without arguments or shell interpretation', async () => {
    const input = 'private text\n$(not-a-command)';
    expect(await runCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input })).toBe(input);
    await expect(runCommand(process.execPath, ['-e', ''], { input: 'x'.repeat(65_537) })).rejects.toThrow('input exceeded');
    await expect(runCommand('/nonexistent/opensaysme-helper', [], { input })).rejects.toThrow('could not start');
  });
  it('preserves whitespace and treats arguments literally', async () => {
    const value = '  selected text\n$(echo not-a-command)\n';
    const output = await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', value]);
    expect(output).toBe(value);
  });

  it('opts into bounded larger stdin for literal text without changing the default cap', async () => {
    const input = JSON.stringify({ text: '日本語\n'.repeat(16_384) });
    expect(Buffer.byteLength(input)).toBeGreaterThan(65_536);
    expect(await runCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input, maxInputBytes: 1024 * 1024 })).toBe(input);
    for (const maxInputBytes of [0, -1, 1.5, Number.NaN, 1024 * 1024 + 1]) {
      await expect(runCommand('must-not-spawn', [], { input: '', maxInputBytes })).rejects.toMatchObject({ reason: 'input-limit' });
    }
    await expect(runCommand('must-not-spawn', [], { input: 'x'.repeat(1024 * 1024 + 1), maxInputBytes: 1024 * 1024 }))
      .rejects.toMatchObject({ reason: 'input-limit' });
  });

  it('does not leak stdout or stderr on nonzero exit', async () => {
    const command = runCommand(process.execPath, ['-e', 'process.stdout.write("private-selection");process.stderr.write("private-key");process.exitCode=7']);
    await expect(command).rejects.toThrow('failed (7)');
    await expect(command).rejects.not.toThrow('private');
    await expect(command).rejects.toMatchObject({ name: 'CommandError', reason: 'exit-failed', exitCode: 7, signal: undefined });
    await expect(command).rejects.toBeInstanceOf(CommandError);
  });

  it.skipIf(process.platform === 'win32')('reports a native abort without exposing captured output or process arguments', async () => {
    const command = runCommand(process.execPath, ['-e',
      'process.stdout.write("private-selection");process.stderr.write("private-key");process.kill(process.pid,"SIGABRT")', 'private-argument']);
    await expect(command).rejects.toMatchObject({ reason: 'signal', exitCode: undefined, signal: 'SIGABRT' });
    const error: unknown = await command.catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CommandError);
    expect(String(error)).not.toContain('private');
    expect(JSON.stringify(error)).not.toContain('private');
    expect((error as CommandError).stack).not.toContain('private');
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('stdout'); expect(error).not.toHaveProperty('stderr');
  });

  it('sanitizes unavailable transport details and spawn failures', async () => {
    const error = new CommandError('signal', { signal: 'private-signal', exitCode: Number.NaN, spawnCode: 'private-code' });
    expect(error.signal).toBeUndefined(); expect(error.exitCode).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('private');
    expect(new CommandError('spawn-failed', { spawnCode: 'private-code' }).message).not.toContain('private');
    await expect(runCommand('/nonexistent/private-helper', [])).rejects.toMatchObject({ reason: 'spawn-failed' });
    await expect(runCommand('private-helper\0', [])).rejects.toThrow('Desktop helper could not start (unknown)');
  });

  it('rejects a deadline even when the child exits zero after termination', async () => {
    const command = runCommand(process.execPath, ['-e', 'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)'], { timeoutMs: 300 });
    await expect(command).rejects.toThrow('timed out');
    await expect(command).rejects.toMatchObject({ reason: 'timeout' });
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
    await expect(command).rejects.toMatchObject({ reason: 'cancelled' });
  });

  it('rejects already-cancelled work without spawning', async () => {
    await expect(runCommand('does-not-exist', [], { signal: AbortSignal.abort() })).rejects.toThrow('stopped');
  });

  it('bounds helper output', async () => {
    const command = runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(2*1024*1024))']);
    await expect(command).rejects.toThrow('output limit');
    await expect(command).rejects.toMatchObject({ reason: 'output-limit' });
  });
});
