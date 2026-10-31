import { chmod, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearWorkContext, openWorkContext, workContextLifetimeMs, workContextPath, workContextSchema, type WorkContextStore } from '../src/work-context.js';

vi.mock('node:fs/promises', async (original) => {
  const module = await original<typeof import('node:fs/promises')>();
  return { ...module, rename: vi.fn(module.rename) };
});
const directories: string[] = [];
const stores: WorkContextStore[] = [];
const now = Date.parse('2026-10-31T12:00:00Z');
const reference = (application = 'Editor', title = 'Project', at = now) => ({ application, title, observedAt: new Date(at).toISOString() });
async function path() {
  const directory = await mkdtemp(join(tmpdir(), 'opensaysme-work-context-'));
  directories.push(directory);
  return join(directory, 'private', 'work-context.json');
}
async function memory(options: Parameters<typeof openWorkContext>[0] = {}) {
  const store = await openWorkContext({ now: () => now, ...options }); stores.push(store); return store;
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.mocked(rename).mockClear();
});

describe('historical work references', () => {
  it('retains only observed labels and time, with immutable outputs and no authority or content', async () => {
    const file = await path();
    const store = await memory({ path: file });
    const observed = { application: 'Editor', title: 'Project', id: 'native-window', selectedText: 'private selection',
      value: 'private input', request: 'submit everything', image: 'private screenshot', permission: 'allow' };
    store.observe(observed);
    observed.title = 'mutated original';
    const result = store.recent();
    expect(result).toEqual([reference()]);
    result[0]!.title = 'mutated copy'; result.pop();
    expect(store.recent()).toEqual([reference()]);
    await store.close();
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved).toEqual({ version: 1, references: [reference()] });
    expect(JSON.stringify(saved)).not.toMatch(/private|native-window|submit|permission|image|selectedText/);
  });

  it('supports memory-only collection without writing a default file', async () => {
    const store = await memory();
    store.observe({ application: 'Terminal' });
    expect(store.recent()).toEqual([{ application: 'Terminal', observedAt: new Date(now).toISOString() }]);
    await store.close();
    expect(rename).not.toHaveBeenCalled();
  });

  it('deduplicates app/title pairs, keeps newest first and limits the catalog to twelve entries', async () => {
    let time = now;
    const store = await memory({ now: () => time });
    for (let index = 0; index < 15; index++) { time++; store.observe({ application: 'Editor', title: `Project ${index}` }); }
    expect(store.recent()).toHaveLength(12);
    expect(store.recent().map(({ title }) => title)).toEqual(Array.from({ length: 12 }, (_, index) => `Project ${14 - index}`));
    time++; store.observe({ application: 'Editor', title: 'Project 5' });
    expect(store.recent()).toHaveLength(12);
    expect(store.recent()[0]).toEqual(reference('Editor', 'Project 5', time));
    time++; store.observe({ application: 'Other editor', title: 'Project 5' });
    expect(store.recent().filter(({ title }) => title === 'Project 5')).toHaveLength(2);
  });

  it('coalesces unchanged foreground labels for one minute, while recording window switches immediately', async () => {
    let time = now;
    const store = await memory({ now: () => time });
    store.observe({ application: 'Editor', title: 'Project' });
    for (let index = 1; index < 20; index++) {
      time = now + index * 3000;
      store.observe({ application: 'Editor', title: 'Project' });
    }
    expect(store.recent()).toEqual([reference()]);
    time = now + 60_000; store.observe({ application: 'Editor', title: 'Project' });
    expect(store.recent()).toEqual([reference('Editor', 'Project', time)]);
    time++; store.observe({ application: 'Terminal' });
    time++; store.observe({ application: 'Editor', title: 'Project' });
    expect(store.recent()[0]).toEqual(reference('Editor', 'Project', time));
  });

  it('bounds labels at UTF-16 boundaries without splitting emoji or retaining malformed labels', async () => {
    const store = await memory();
    store.observe({ application: 'a'.repeat(255) + '👋', title: 'b'.repeat(511) + '👋' });
    expect(store.recent()).toEqual([reference('a'.repeat(255), 'b'.repeat(511))]);
    store.observe({ application: '👋'.repeat(128), title: '👋'.repeat(256) });
    expect(store.recent()[0]).toEqual(reference('👋'.repeat(128), '👋'.repeat(256)));
    for (const window of [null, { application: ' ' }, { application: '\ud800' },
      { application: 'Editor', title: '\udc00' }, { application: ' '.repeat(256) + 'Editor' }]) store.observe(window);
    expect(store.recent()).toHaveLength(2);
  });

  it('expires observations after eight hours and drops timestamps made future by a clock change', async () => {
    let time = now;
    const store = await memory({ now: () => time });
    store.observe({ application: 'Editor', title: 'Earlier' });
    time += 60_000; store.observe({ application: 'Terminal' });
    time = now + workContextLifetimeMs;
    expect(store.recent()).toEqual([{ application: 'Terminal', observedAt: new Date(now + 60_000).toISOString() }]);
    time += 60_000; expect(store.recent()).toEqual([]);
    store.observe({ application: 'Clock test' }); time--;
    expect(store.recent()).toEqual([]);
  });

  it('validates the provider-visible catalog without accepting hidden content or target handles', () => {
    expect(workContextSchema.safeParse([reference()]).success).toBe(true);
    for (const extra of [{ request: 'private request' }, { id: 'native-id' }, { permission: 'allow' }, { value: 'private text' }]) {
      expect(workContextSchema.safeParse([{ ...reference(), ...extra }]).success).toBe(false);
    }
    expect(workContextSchema.safeParse([reference(), reference()]).success).toBe(false);
    expect(workContextSchema.safeParse(Array.from({ length: 13 }, (_, i) => reference('Editor', `Project ${i}`))).success).toBe(false);
    expect(workContextSchema.safeParse([reference('👋'.repeat(129))]).success).toBe(false);
    expect(workContextSchema.safeParse([{ ...reference(), observedAt: 'not a timestamp' }]).success).toBe(false);
  });
});

describe('optional work-reference persistence', () => {
  it('leaves a missing cache untouched when only viewing context', async () => {
    const file = await path(); const onWarning = vi.fn();
    const store = await memory({ path: file, onWarning });
    expect(store.recent()).toEqual([]); await store.close();
    expect(onWarning).not.toHaveBeenCalled(); expect(rename).not.toHaveBeenCalled();
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores across restarts with private permissions, excluding expired records', async () => {
    const file = await path();
    const first = await memory({ path: file });
    first.observe({ application: 'Editor', title: 'Project' }); await first.close();
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(join(file, '..'))).mode & 0o777).toBe(0o700);
    }
    const second = await memory({ path: file, now: () => now + 1000 });
    expect(second.recent()).toEqual([reference()]); await second.close();
    const expired = await memory({ path: file, now: () => now + workContextLifetimeMs });
    expect(expired.recent()).toEqual([]); await expired.close();
    expect(JSON.parse(await readFile(file, 'utf8')).references).toEqual([]);
  });

  it('atomically replaces old files with mode 0600 and leaves no temporary files', async () => {
    const file = await path();
    const store = await memory({ path: file });
    store.observe({ application: 'Initial' }); await store.close();
    await writeFile(file, JSON.stringify({ version: 1, references: [] }), { mode: 0o644 });
    await chmod(file, 0o644);
    const updated = await memory({ path: file });
    updated.observe({ application: 'Replacement' }); await updated.close();
    expect(JSON.parse(await readFile(file, 'utf8')).references).toEqual([{ application: 'Replacement', observedAt: new Date(now).toISOString() }]);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(file, '..'))).toEqual(['work-context.json']);
  });

  it('coalesces pending writes in order and close waits for the latest observation', async () => {
    const file = await path();
    const store = await memory({ path: file });
    let release!: () => void;
    let began!: () => void;
    const ready = new Promise<void>((done) => { began = done; });
    const gate = new Promise<void>((done) => { release = done; });
    const original = vi.mocked(rename).getMockImplementation()!;
    vi.mocked(rename).mockImplementationOnce(async (...args) => { began(); await gate; return original(...args); });
    store.observe({ application: 'Editor', title: 'First' }); await ready;
    for (let index = 0; index < 100; index++) store.observe({ application: 'Editor', title: `Later ${index}` });
    let closed = false;
    const closing = store.close().then(() => { closed = true; });
    store.observe({ application: 'Must not appear after close' });
    await Promise.resolve(); expect(closed).toBe(false); expect(store.recent()).toEqual([]);
    release(); await closing;
    expect(rename).toHaveBeenCalledTimes(2);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.references).toHaveLength(12); expect(saved.references[0]).toEqual(reference('Editor', 'Later 99'));
    expect(JSON.stringify(saved)).not.toContain('Must not appear');
    await store.close();
  });

  it('rejects corrupt, oversized, future-dated and content-bearing files with a safe warning', async () => {
    const file = await path();
    const initial = await memory({ path: file }); initial.observe({ application: 'Initial' }); await initial.close();
    for (const content of [
      '{"private":"secret', ' '.repeat(65_537), Buffer.from([0x22, 0xff, 0x22]),
      JSON.stringify({ version: 1, references: [reference('Editor', 'Future', now + 1)] }),
      JSON.stringify({ version: 1, references: [{ ...reference(), value: 'private content' }] }),
      JSON.stringify({ version: 1, references: [reference(), reference()] }),
      JSON.stringify({ version: 99, references: [] }),
    ]) {
      await writeFile(file, content);
      const onWarning = vi.fn(); const store = await memory({ path: file, onWarning });
      expect(store.recent()).toEqual([]); expect(onWarning).toHaveBeenCalledOnce();
      expect(onWarning.mock.calls[0]?.[0]).not.toMatch(/secret|private|Editor|Future|\.json/);
      store.observe({ application: 'New observation' }); await store.close();
      expect(JSON.parse(await readFile(file, 'utf8')).references).toEqual([{ application: 'New observation', observedAt: new Date(now).toISOString() }]);
    }
  });

  it('warns once on storage failure, retains current-session context and never throws raw errors', async () => {
    const file = await path();
    const initial = await memory({ path: file }); initial.observe({ application: 'Initial' }); await initial.close();
    const onWarning = vi.fn<(message: string) => void>(() => { throw new Error('feedback cannot break collection'); });
    const store = await memory({ path: join(file, 'unwritable-private-path'), onWarning });
    store.observe({ application: 'Editor', title: 'Project' });
    expect(store.recent()).toEqual([reference()]);
    await store.close();
    expect(onWarning).toHaveBeenCalledOnce();
    expect(onWarning.mock.calls[0]?.[0]).not.toContain('unwritable-private-path');
  });

  it('clears only the saved cache and respects the configured directory', async () => {
    expect(workContextPath({ OPENSAYSME_CONFIG_DIR: '/custom/config' })).toBe('/custom/config/work-context.json');
    expect(workContextPath({})).toBe(join(homedir(), 'Library', 'Application Support', 'opensaysme', 'work-context.json'));
    const file = await path(); const store = await memory({ path: file });
    store.observe({ application: 'Editor' }); await store.close();
    const settings = join(file, '..', 'config.json'); await writeFile(settings, 'settings');
    await clearWorkContext(file); await clearWorkContext(file);
    expect(await readdir(join(file, '..'))).toEqual(['config.json']);
    expect(await readFile(settings, 'utf8')).toBe('settings');
    await expect(clearWorkContext(join(file, '..'))).rejects.toThrow('Could not clear saved work context.');
  });
});
