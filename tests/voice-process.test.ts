import { afterEach, expect, it } from 'vitest';
import { startVoiceHelper, type VoiceInput } from '../src/desktop/voice-process.js';
import type { NativeVoiceEvent } from '../src/desktop/voice-types.js';

const inputs: VoiceInput[] = [];
afterEach(async () => { await Promise.all(inputs.splice(0).map((input) => input.close())); });
function launch(source: string, events: NativeVoiceEvent[] = []) {
  const input = startVoiceHelper({ file: process.execPath, args: ['-e', source] }, (event) => events.push(event));
  inputs.push(input); return input;
}
function until(check: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { clearInterval(poll); reject(new Error('Fixture timed out')); }, 2000);
    const poll = setInterval(() => { if (check()) { clearTimeout(deadline); clearInterval(poll); resolve(); } }, 10);
  });
}

it('exchanges incremental native frames and gracefully shuts down', async () => {
  const events: NativeVoiceEvent[] = [];
  const input = launch(`
    const emit = x => process.stdout.write(JSON.stringify(x)+'\\n');
    emit({type:'ready'});
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const c=JSON.parse(line);
      if(c.type==='start'){emit({type:'audio-started',turnId:c.turnId});emit({type:'audio',turnId:c.turnId,data:'AAA=',capturedAt:new Date().toISOString(),startSample:0,timing:'estimated'});}
      if(c.type==='stop'||c.type==='cancel')emit({type:'audio-stopped',turnId:c.turnId});
      if(c.type==='shutdown')process.exit(0);
    });
  `, events);
  await input.ready; input.send({ type: 'start', turnId: 'one' });
  await until(() => events.some((event) => event.type === 'audio'));
  input.send({ type: 'stop', turnId: 'one' });
  await until(() => events.some((event) => event.type === 'audio-stopped'));
  await input.close(); await expect(input.done).resolves.toBeUndefined();
  expect(events.map((event) => event.type)).toEqual(['ready', 'audio-started', 'audio', 'audio-stopped']);
});

it('rejects malformed messages without echoing private native output', async () => {
  const input = launch(`process.stdout.write('private-selection\\n');setInterval(()=>{},1000);`);
  await expect(input.ready).rejects.toThrow('invalid JSON');
  await expect(input.done).rejects.not.toThrow('private-selection');
});

it('reports unexpected native exit and missing executables', async () => {
  const exited = launch(`process.stdout.write('{"type":"ready"}\\n');`);
  await exited.ready; await expect(exited.done).rejects.toThrow('exited unexpectedly');
  const missing = startVoiceHelper({ file: 'opensaysme-nonexistent-fixture', args: [] }, () => {});
  inputs.push(missing);
  await expect(missing.ready).rejects.toThrow('Could not start');
  await expect(missing.done).rejects.toThrow('Could not start');
});

it('forces cleanup of a helper that ignores shutdown and termination', async () => {
  const input = launch(`process.on('SIGTERM',()=>{});process.stdout.write('{"type":"ready"}\\n');process.stdin.resume();setInterval(()=>{},1000);`);
  await input.ready; const started = Date.now(); await input.close();
  expect(Date.now() - started).toBeLessThan(3000);
});

it('bounds an unterminated native message', async () => {
  const input = launch(`process.stdout.write('x'.repeat(300000));setInterval(()=>{},1000);`);
  await expect(input.ready).rejects.toThrow('message limit');
});
