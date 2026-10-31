import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { startFeedbackHelper } from '../src/desktop/feedback-process.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
function fixture() {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  const written: string[] = [];
  child.stdin.on('data', (chunk: Buffer) => written.push(chunk.toString()));
  child.kill.mockImplementation(() => { child.emit('close'); return true; });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const warning = vi.fn();
  const sink = startFeedbackHelper({ file: '/fixture/helper', args: ['--feedback'] }, warning);
  return { child, written, warning, sink, ready: () => child.stdout.write('{"type":"ready"}\n') };
}
const show = { type: 'show' as const, title: 'OpenSaysMe', message: 'Which agent?', detail: 'Reply with the hotkey' };

it('sends only the newest pending display over stdin, without putting private text in arguments', async () => {
  const f = fixture();
  f.sink.send({ ...show, message: 'old' }); f.sink.send(show);
  expect(f.written).toEqual([]); f.ready();
  expect(f.written.map((line) => JSON.parse(line))).toEqual([show]);
  expect(spawn).toHaveBeenCalledWith('/fixture/helper', ['--feedback'], expect.any(Object));
  f.sink.send({ type: 'hide' });
  expect(JSON.parse(f.written.at(-1)!)).toEqual({ type: 'hide' });
  const closing = f.sink.close(); await vi.advanceTimersByTimeAsync(200); await closing;
  expect(f.warning).not.toHaveBeenCalled();
});

it.each(['private native response\n', '{"type":"ready","private":"value"}\n', 'x'.repeat(4097)])('disables malformed native output without exposing it', async (output) => {
  const f = fixture(); f.child.stdout.write(output);
  expect(f.warning).toHaveBeenCalledExactlyOnceWith();
  f.sink.send(show); expect(f.written).toEqual([]);
  await f.sink.close();
});

it('bounds startup and rejects oversized commands without writing them', async () => {
  const f = fixture(); await vi.advanceTimersByTimeAsync(3000);
  expect(f.warning).toHaveBeenCalledOnce(); await f.sink.close();
  const g = fixture(); g.ready(); g.sink.send({ ...show, message: '🌱'.repeat(2049) });
  expect(g.warning).toHaveBeenCalledOnce(); expect(g.written).toEqual([]); await g.sink.close();
});

it('reports unexpected exit only once and cleans up helpers ignoring graceful shutdown', async () => {
  const f = fixture(); f.ready(); f.child.emit('close');
  expect(f.warning).toHaveBeenCalledOnce(); await f.sink.close();
  const g = fixture(); g.ready();
  g.child.kill.mockImplementation((signal) => { if (signal === 'SIGKILL') g.child.emit('close'); return true; });
  const closing = g.sink.close(); await vi.advanceTimersByTimeAsync(700); await closing;
  expect(g.child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  expect(g.warning).not.toHaveBeenCalled();
});
