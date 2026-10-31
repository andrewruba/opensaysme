import { expect, it, vi } from 'vitest';
import { recordHotkey } from '../src/desktop/hotkey-process.js';

const emit = `const emit = value => process.stdout.write(JSON.stringify(value)+'\\n');`;
function launch(source: string, signal?: AbortSignal, onReady: () => void = vi.fn()) {
  return recordHotkey({ file: process.execPath, args: ['-e', `${emit}\n${source}`] }, signal, onReady);
}

it('announces readiness, keeps stdin open, and waits for native cleanup before returning a captured chord', async () => {
  const ready = vi.fn();
  const started = Date.now();
  const result = await launch(`
    process.stdin.resume();
    process.stdin.once('end', () => process.exit(42));
    emit({status:'ready'});
    emit({status:'captured',shortcut:'Cmd+Shift+Space'});
    setTimeout(() => process.exit(0), 100);
  `, undefined, ready);
  expect(result).toEqual({ status: 'captured', shortcut: 'Cmd+Shift+Space' });
  expect(ready).toHaveBeenCalledOnce();
  expect(Date.now() - started).toBeGreaterThanOrEqual(90);
});

it.each([
  { status: 'cancelled' },
  { status: 'unavailable', reason: 'accessibility-permission-required' },
  { status: 'unavailable', reason: 'focus-changed' },
])('accepts a bounded native refusal before readiness: %j', async (result) => {
  const ready = vi.fn();
  await expect(launch(`emit(${JSON.stringify(result)});`, undefined, ready)).resolves.toEqual(result);
  expect(ready).not.toHaveBeenCalled();
});

it.each([
  `process.stdout.write('private-input\\n');`,
  `emit({status:'captured',shortcut:'Cmd+Space'});`,
  `emit({status:'ready'});emit({status:'ready'});`,
  `emit({status:'ready'});emit({status:'captured',shortcut:'Ctrl+C'});`,
  `emit({status:'ready'});emit({status:'captured',shortcut:'cmd+space'});`,
  `emit({status:'unavailable',reason:'private-input'});`,
  `emit({status:'ready',private:'private-input'});`,
  `emit({status:'ready'});emit({status:'cancelled'});emit({status:'cancelled'});`,
])('rejects malformed, out-of-order or duplicated messages without leaking data', async (source) => {
  try {
    await launch(`${source}setInterval(()=>{},1000);`);
    throw new Error('Expected invalid protocol rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/invalid|unexpected/);
    expect((error as Error).message).not.toContain('private-input');
  }
});

it('discards a captured result when cancellation arrives before the helper exits', async () => {
  const controller = new AbortController();
  await expect(launch(`
    process.stdin.resume();
    process.on('SIGTERM',()=>{});
    emit({status:'ready'});
    emit({status:'captured',shortcut:'Cmd+Space'});
    setInterval(()=>{},1000);
  `, controller.signal, () => controller.abort('private-reason'))).resolves.toEqual({ status: 'cancelled' });
});

it('does not start an already cancelled request or expose an arbitrary abort reason', async () => {
  const controller = new AbortController(); controller.abort('private-reason');
  const ready = vi.fn();
  await expect(recordHotkey({ file: 'missing-shortcut-helper', args: [] }, controller.signal, ready))
    .resolves.toEqual({ status: 'cancelled' });
  expect(ready).not.toHaveBeenCalled();
});

it('forces cleanup when a helper reports a result but stays alive', async () => {
  await expect(launch(`
    process.stdin.resume();process.on('SIGTERM',()=>{});
    emit({status:'ready'});emit({status:'captured',shortcut:'Cmd+Space'});
    setInterval(()=>{},1000);
  `)).rejects.toThrow('did not stop');
});

it.each(['stdout', 'stderr'])('bounds %s without exposing its contents', async (stream) => {
  await expect(launch(`process.${stream}.write('private-input'.repeat(1000));setInterval(()=>{},1000);`))
    .rejects.toThrow(/exceeded its (output|diagnostic) limit/);
});

it('rejects truncated results, unexpected exit and missing executables', async () => {
  await expect(launch(`emit({status:'ready'});process.stdout.write('{"status":');`)).rejects.toThrow('without a valid result');
  await expect(launch(`emit({status:'ready'});process.exit(1);`)).rejects.toThrow('without a valid result');
  await expect(recordHotkey({ file: 'opensaysme-missing-hotkey-fixture', args: [] }, undefined, vi.fn())).rejects.toThrow('Could not start');
});
