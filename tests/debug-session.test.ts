import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDebugSession } from '../src/debug-session.js';
import type { DebugTurnInput, PreparedReasoningRequest } from '../src/diagnostics.js';

const io = vi.hoisted(() => ({ beforeWrite: undefined as undefined | ((path: string) => Promise<void>),
  afterWrite: undefined as undefined | ((path: string) => void), beforeMkdtemp: undefined as undefined | (() => Promise<void>) }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    await io.beforeWrite?.(String(args[0])); await fs.writeFile(...args); io.afterWrite?.(String(args[0]));
  }, mkdtemp: async (...args: Parameters<typeof fs.mkdtemp>) => {
    await io.beforeMkdtemp?.(); return fs.mkdtemp(...args);
  } };
});
const directories: string[] = [];
afterEach(async () => {
  io.beforeWrite = undefined; io.afterWrite = undefined; io.beforeMkdtemp = undefined; vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function root() {
  const directory = await mkdtemp(join(tmpdir(), 'opensaysme-debug-session-test-'));
  directories.push(directory); return directory;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const clean = Buffer.from([255, 216, 255, 1, 2, 3, 255, 217]);
const trail = Buffer.from([255, 216, 255, 4, 5, 6, 255, 217]);
const key = 'fixture-secret-value';
function input(): DebugTurnInput {
  return { transcript: `Look at ${key}`, history: { frames: [{ id: 'f1', atMs: 500, receivedAtMs: 510,
    capturedAt: '2026-10-28T12:00:00.500Z', display: { id: 'screen', bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
    image: { mimeType: 'image/jpeg', width: 1600, height: 900, data: clean.toString('base64') }, warnings: [] }],
  contexts: [{ id: 'c1', atMs: 100, receivedAtMs: 120, context: { platform: 'test', capturedAt: '2026-10-28T12:00:00.100Z',
    activeWindow: { id: 'window', application: 'Editor', title: `Window ${key}` }, selectedText: `Selected ${key}`, warnings: [] } }],
  cursor: [{ atMs: 400, receivedAtMs: 410, x: -1440, y: 432, displayId: 'screen' }],
  transcript: [{ id: 'p1', text: `Phrase ${key}`, startSample: 0, endSample: 24000, startMs: 200, endMs: 1200,
    receivedAtMs: 1400, boundary: 'pause', timing: 'device' }], warnings: [], durationMs: 1500,
  audio: { sampleRate: 24000, samples: 0, durationMs: 0, firstCapturedAtMs: null, lastCapturedAtMs: null,
    firstReceivedAtMs: null, maxDeliveryLagMs: null, timing: 'unavailable' } },
  visual: { frames: [{ context: { frameId: 'f1', atMs: 500, startMs: 0, endMs: 1250, phraseIds: ['p1'], contextIds: ['c1'],
    trails: [{ points: [{ x: 0.25, y: 0.4, atMs: 400 }, { x: 0.3, y: 0.5, atMs: 600 }] }],
    pointer: { x: 0.25, y: 0.4, atMs: 400 }, warnings: [] },
  image: { mimeType: 'image/jpeg', width: 1600, height: 900, data: trail.toString('base64') } }], warnings: [] } };
}
function request() {
  return { model: 'test-model', instructions: `Instruction ${key}`, store: false as const, max_output_tokens: 2500,
    input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ transcript: `Say ${key}`,
      nested: JSON.stringify({ selectedText: `Selected ${key}`, authorization: 'omit authorization', rawAudio: 'omit PCM' }),
      headers: { Authorization: 'omit headers' }, env: { PRIVATE: 'omit environment' }, apiKey: 'omit key',
      audio: { sampleRate: 24000, samples: 4, data: 'omit audio chunk', unknown: 'omit unknown audio' },
      image: { data: `data:image/jpeg;base64,${clean.toString('base64')}` } }) },
    { type: 'input_image', image_url: 'images/f1-clean.jpg', detail: 'high' },
    { type: 'input_image', image_url: 'images/f1-trail.jpg', detail: 'high' }] }] } satisfies PreparedReasoningRequest;
}

it('saves each tool exchange and replay request with image files and no opaque reasoning or credentials', async () => {
  const debug = await createDebugSession(await root(), { secrets: [key] });
  const event = { callId: 'call/with/path', name: 'capture_screen', arguments: { label: key, authorization: 'omit auth' },
    effect: 'read' as const, phase: 'started' as const };
  debug.request('turn', request(), 1);
  debug.tool!('turn', event);
  debug.tool!('turn', { ...event, phase: 'completed', durationMs: 15,
    result: { content: [{ type: 'text', text: 'Current desktop.' }, { type: 'image', mimeType: 'image/jpeg', data: clean.toString('base64') }] } });
  const replay: PreparedReasoningRequest = { ...request(), input: [
    { type: 'reasoning', id: 'r1', encrypted_content: 'opaque reasoning that must not be saved', summary: [] },
    { type: 'function_call_output', call_id: event.callId, output: [
      { type: 'input_text', text: key },
      { type: 'input_image', image_url: `data:image/jpeg;base64,${clean.toString('base64')}`, detail: 'high' },
    ] },
  ], tools: [{ type: 'function', name: 'capture_screen', description: 'Capture current display.', strict: true,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
  tool_choice: 'auto', parallel_tool_calls: false, include: ['reasoning.encrypted_content'] };
  debug.request('turn', replay, 2); await debug.close();
  const dir = debug.turnDirectory('turn');
  const tool = JSON.parse(await readFile(join(dir, 'tool-1-completed.json'), 'utf8'));
  expect(tool).toMatchObject({ callId: event.callId, arguments: { label: '[REDACTED]' }, durationMs: 15,
    result: { content: [{ type: 'text' }, { type: 'image', file: 'images/tool-1-completed-image-1.jpg' }] } });
  expect(await readFile(join(dir, 'images/tool-1-completed-image-1.jpg'))).toEqual(clean);
  const saved = await readFile(join(dir, 'request-2.json'), 'utf8');
  expect(saved).not.toMatch(/opaque reasoning|fixture-secret-value|omit auth/);
  expect(JSON.parse(saved)).toMatchObject({ tools: replay.tools, input: [
    { type: 'reasoning', id: 'r1' }, { type: 'function_call_output', output: [
      { text: '[REDACTED]' }, { image_url: 'images/request-2-image-1.jpg' },
    ] },
  ] });
  expect(await readFile(join(dir, 'images/request-2-image-1.jpg'))).toEqual(clean);
  expect(await readdir(dir)).toEqual(expect.arrayContaining(['request.json', 'request-2.json', 'tool-1-started.json', 'tool-1-completed.json']));
});

it('exports exact images, full input/request/result, and a timestamped redacted event log', async () => {
  const debug = await createDebugSession(await root(), { secrets: [key] });
  const captured = input(); Object.assign(captured.history.audio, { pcm: 'omit audio' });
  Object.assign(captured, { apiKey: key, unknown: 'omit input extra' });
  const prepared = request(); Object.assign(prepared, { headers: { Authorization: 'omit top-level headers' } });
  debug.event({ component: 'runtime', event: 'state.changed', turnId: 'turn-1', data: {
    state: 'listening', message: `Message ${key}`, apiKey: key, authorization: 'omit event auth', pcm: 'omit event PCM', unknown: 'omit event extra',
  } });
  debug.input('turn-1', captured); debug.request('turn-1', prepared);
  debug.result('turn-1', { status: 'completed', response: `Answer ${key}`, latency: { reasoningMs: 42 } });
  await debug.close();
  const directory = debug.turnDirectory('turn-1');
  expect(await readFile(join(directory, 'images/f1-clean.jpg'))).toEqual(clean);
  expect(await readFile(join(directory, 'images/f1-trail.jpg'))).toEqual(trail);
  const contextText = await readFile(join(directory, 'context.json'), 'utf8');
  const requestText = await readFile(join(directory, 'request.json'), 'utf8');
  const resultText = await readFile(join(directory, 'result.json'), 'utf8');
  const events = await readFile(join(debug.directory, 'session.jsonl'), 'utf8');
  expect(contextText + requestText + resultText + events).not.toContain(key);
  expect(contextText + requestText + resultText + events).not.toContain('omit ');
  expect(contextText + requestText).not.toContain(clean.toString('base64'));
  expect(JSON.parse(contextText)).toMatchObject({ transcript: 'Look at [REDACTED]', attention: {
    contexts: [{ context: { selectedText: 'Selected [REDACTED]' } }], transcript: [{ text: 'Phrase [REDACTED]', startMs: 200 }],
    cursor: [{ x: -1440 }], frames: [{ image: { file: 'images/f1-clean.jpg' } }],
  }, visualContext: { frames: [{ trailFile: 'images/f1-trail.jpg' }] } });
  const savedRequest = JSON.parse(requestText);
  expect(savedRequest.input[0].content[1].image_url).toBe('images/f1-clean.jpg');
  const nested = JSON.parse(JSON.parse(savedRequest.input[0].content[0].text).nested);
  expect(nested).toEqual({ selectedText: 'Selected [REDACTED]' });
  expect(JSON.parse(savedRequest.input[0].content[0].text).audio).toEqual({ sampleRate: 24000, samples: 4 });
  expect(JSON.parse(resultText)).toEqual({ status: 'completed', response: 'Answer [REDACTED]', latency: { reasoningMs: 42 } });
  expect(JSON.parse(events.trim())).toMatchObject({ at: expect.stringMatching(/^\d{4}-/), elapsedMs: expect.any(Number),
    turnId: 'turn-1', component: 'runtime', event: 'state.changed', data: { state: 'listening', message: 'Message [REDACTED]' } });
});

it('snapshots before turn disposal and saves captures even without annotated copies', async () => {
  const debug = await createDebugSession(await root());
  const captured = input(); captured.visual = undefined;
  debug.input('turn', captured); captured.history.frames.length = 0; captured.history.contexts.length = 0;
  debug.result('turn', { status: 'cancelled' }); await debug.close();
  const directory = debug.turnDirectory('turn');
  expect(await readdir(join(directory, 'images'))).toEqual(['f1-clean.jpg']);
  expect(JSON.parse(await readFile(join(directory, 'context.json'), 'utf8')).attention.contexts).toHaveLength(1);
  expect(JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')).status).toBe('cancelled');
});

it('redacts configured secrets in JSON property names inside captured text, requests, and responses', async () => {
  const debug = await createDebugSession(await root(), { secrets: [key] });
  const text = JSON.stringify({ outer: JSON.stringify({ [`prefix-${key}-suffix`]: 'visible value' }) });
  const captured = input(); captured.history.contexts[0]!.context.selectedText = text;
  const prepared = request(); prepared.input[0]!.content[0] = { type: 'input_text', text };
  debug.input('turn', captured); debug.request('turn', prepared);
  debug.result('turn', { status: 'completed', response: text }); await debug.close();
  const directory = debug.turnDirectory('turn');
  const saved = await Promise.all(['context.json', 'request.json', 'result.json'].map(async (file) => {
    const contents = await readFile(join(directory, file), 'utf8');
    expect(contents).not.toContain(key);
    return JSON.parse(contents);
  }));
  for (const value of [saved[0].attention.contexts[0].context.selectedText, saved[1].input[0].content[0].text, saved[2].response]) {
    expect(JSON.parse(JSON.parse(value).outer)).toEqual({ 'prefix-[REDACTED]-suffix': 'visible value' });
  }
});

it('keeps failed and interrupted turn records, and skips duplicates without overwriting', async () => {
  const onWarning = vi.fn(), directory = await root();
  const first = await createDebugSession(directory, { onWarning }), second = await createDebugSession(directory);
  expect(first.directory).not.toBe(second.directory);
  first.input('turn', input()); first.input('turn', input());
  first.result('turn', { status: 'failed', error: { component: 'reasoning', code: 'http-error', message: 'Provider rejected request.' } });
  first.result('turn', { status: 'completed', response: 'must not overwrite' });
  second.result('turn', { status: 'interrupted' });
  await Promise.all([first.close(), second.close()]);
  expect(JSON.parse(await readFile(join(first.turnDirectory('turn'), 'result.json'), 'utf8')).status).toBe('failed');
  expect(JSON.parse(await readFile(join(second.turnDirectory('turn'), 'result.json'), 'utf8')).status).toBe('interrupted');
  expect(await readFile(join(first.turnDirectory('turn'), 'images/f1-clean.jpg'))).toEqual(clean);
  expect(onWarning).toHaveBeenCalledOnce();
});

it('rejects unsafe paths, oversized input, and nonlocal request images without throwing into voice', async () => {
  const onWarning = vi.fn(), debug = await createDebugSession(await root(), { onWarning });
  expect(() => debug.input('../escape', input())).not.toThrow();
  const bad = input(); bad.history.frames[0]!.id = '../escape'; debug.input('bad-frame', bad);
  const oversized = input(); oversized.transcript = 'x'.repeat(65_537); debug.input('oversized', oversized);
  const external = request(); external.input[0]!.content[1] = { type: 'input_image', image_url: 'https://example.com/private.jpg', detail: 'high' };
  debug.request('external', external);
  await debug.close();
  expect(await readdir(join(debug.directory, 'turns'))).toEqual([]);
  expect(onWarning).toHaveBeenCalledOnce();
});

it('creates private directories and files on systems supporting POSIX modes', async () => {
  const debug = await createDebugSession(await root()); debug.input('turn', input()); await debug.close();
  if (process.platform !== 'win32') {
    for (const directory of [debug.directory, join(debug.directory, 'turns'), debug.turnDirectory('turn'), join(debug.turnDirectory('turn'), 'images')]) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    for (const path of [join(debug.directory, 'session.jsonl'), join(debug.turnDirectory('turn'), 'context.json'), join(debug.turnDirectory('turn'), 'images/f1-clean.jpg')]) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  }
});

it('keeps completed records after a disk failure and removes incomplete temporary files', async () => {
  const onWarning = vi.fn(), debug = await createDebugSession(await root(), { onWarning });
  io.beforeWrite = async (path) => { if (path.includes('request.json')) throw new Error(`private failure ${key}`); };
  debug.input('turn', input()); debug.request('turn', request()); debug.result('turn', { status: 'failed' });
  await debug.close();
  expect((await readdir(debug.turnDirectory('turn'))).sort()).toEqual(['context.json', 'images']);
  expect(onWarning).toHaveBeenCalledOnce();
  expect(onWarning.mock.calls[0]![0]).not.toContain('private failure');
});

it('bounds the event log and warns only once when limits or callback failures occur', async () => {
  const warning = vi.fn(() => { throw new Error('caller warning failure'); });
  const debug = await createDebugSession(await root(), { onWarning: warning });
  for (let i = 0; i < 10_100; i++) debug.event({ component: 'runtime', event: 'state', data: { count: i } });
  await debug.close();
  expect(warning).toHaveBeenCalledOnce();
  expect((await stat(join(debug.directory, 'session.jsonl'))).size).toBeLessThanOrEqual(8 * 1024 * 1024);
});

it('drains an event queued between the worker exit and its finally continuation', async () => {
  const debug = await createDebugSession(await root());
  let scheduled = false;
  io.afterWrite = (path) => {
    if (path.endsWith('session.jsonl') && !scheduled) {
      scheduled = true;
      queueMicrotask(() => queueMicrotask(() => debug.event({ component: 'runtime', event: 'second' })));
    }
  };
  debug.event({ component: 'runtime', event: 'first' });
  await vi.waitFor(async () => {
    const lines = (await readFile(join(debug.directory, 'session.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.event)).toEqual(['first', 'second']);
  });
  await debug.close();
});

it('never replaces a file already present at its destination', async () => {
  const onWarning = vi.fn(), debug = await createDebugSession(await root(), { onWarning });
  await mkdir(debug.turnDirectory('turn'));
  await writeFile(join(debug.turnDirectory('turn'), 'result.json'), 'existing');
  debug.result('turn', { status: 'completed' }); await debug.close();
  expect(await readFile(join(debug.turnDirectory('turn'), 'result.json'), 'utf8')).toBe('existing');
  expect(await readdir(debug.turnDirectory('turn'))).toEqual(['result.json']);
  expect(onWarning).toHaveBeenCalledOnce();
});

it('bounds pending image writes without blocking callers', async () => {
  const onWarning = vi.fn(), debug = await createDebugSession(await root(), { onWarning });
  const blocked = deferred(), entered = deferred();
  io.beforeWrite = () => { entered.resolve(); return blocked.promise; };
  const captured = input(); const bytes = Buffer.alloc(450_000, 1); bytes[0] = 255; bytes[1] = 216; bytes[2] = 255;
  const frame = captured.history.frames[0]!, view = captured.visual!.frames[0]!;
  captured.history.frames = Array.from({ length: 12 }, (_, i) => ({ ...frame, id: `f${i}`, image: { ...frame.image, data: bytes.toString('base64') } }));
  captured.visual!.frames = captured.history.frames.map((frame) => ({ context: { ...view.context, frameId: frame.id }, image: frame.image }));
  debug.input('one', captured); await entered.promise;
  for (const id of ['two', 'three', 'four', 'five']) debug.input(id, captured);
  expect(onWarning).toHaveBeenCalledOnce();
  blocked.resolve(); await debug.close();
  expect(await readdir(join(debug.directory, 'turns'))).toEqual(['one']);
});

it('stops waiting after two seconds on close, rejects new records, and cleans up late writes', async () => {
  const onWarning = vi.fn(), debug = await createDebugSession(await root(), { onWarning });
  const blocked = deferred(), entered = deferred();
  io.beforeWrite = () => { entered.resolve(); return blocked.promise; };
  debug.result('turn', { status: 'completed' }); await entered.promise;
  vi.useFakeTimers(); const close = debug.close();
  await vi.advanceTimersByTimeAsync(2000); await close;
  expect(onWarning).toHaveBeenCalledOnce();
  debug.result('late', { status: 'completed' });
  vi.useRealTimers(); blocked.resolve();
  await vi.waitFor(async () => expect(await readdir(debug.turnDirectory('turn'))).toEqual([]));
  expect(await readdir(join(debug.directory, 'turns'))).toEqual(['turn']);
});

it('bounds initialization and removes a directory created after the timeout', async () => {
  const directory = await root(), blocked = deferred(), entered = deferred();
  io.beforeMkdtemp = () => { entered.resolve(); return blocked.promise; };
  vi.useFakeTimers();
  const pending = expect(createDebugSession(directory)).rejects.toThrow('Could not create debug session');
  await entered.promise; await vi.advanceTimersByTimeAsync(2000); await pending;
  vi.useRealTimers(); blocked.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await readdir(directory)).toEqual([]);
});
