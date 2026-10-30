import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../src/tools/registry.js';
import { createDesktopTools } from '../src/tools/desktop.js';
import type { ToolDefinition, ToolResult } from '../src/tools/types.js';
import type { DesktopAdapter, WindowInventory } from '../src/desktop/types.js';
import type { ConversationTurn } from '../src/conversation.js';

const signal = () => new AbortController().signal;
const text = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const value = (result: ToolResult) => {
  const part = result.content[0];
  if (part?.type !== 'text') throw new Error('Expected tool text');
  return JSON.parse(part.text);
};
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function definition(run: ToolDefinition['run'] = async () => text({ ok: true })): ToolDefinition {
  return { name: 'inspect_fixture', description: 'Inspect a fixture.', effect: 'read', input: z.object({}), run };
}
afterEach(() => vi.useRealTimers());

describe('local tool registry', () => {
  it('creates an isolated strict catalog without invoking tools', () => {
    const run = vi.fn();
    const host = new ToolRegistry([definition(run)]);
    expect(host.list()).toEqual([{ name: 'inspect_fixture', description: 'Inspect a fixture.', effect: 'read',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }]);
    const listed = host.list();
    listed[0]!.name = 'changed'; listed[0]!.inputSchema.additionalProperties = true;
    expect(host.list()[0]!.name).toBe('inspect_fixture');
    expect(host.list()[0]!.inputSchema.additionalProperties).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects duplicate, invalid, and optional tool definitions', () => {
    expect(() => new ToolRegistry([definition(), definition()])).toThrow('duplicate');
    expect(() => new ToolRegistry([{ ...definition(), name: 'run anything' }])).toThrow();
    expect(() => new ToolRegistry([{ ...definition(), input: z.object({ target: z.string().optional() }) }])).toThrow('required properties');
  });

  it('validates unknown, extra, and oversized arguments before execution', async () => {
    const run = vi.fn(async () => text({ ok: true }));
    const host = new ToolRegistry([definition(run)]);
    expect(value(await host.call('unknown', {}, signal())).code).toBe('unknown-tool');
    expect(value(await host.call('inspect_fixture', { private: 'secret' }, signal())).code).toBe('invalid-arguments');
    expect(value(await host.call('inspect_fixture', { huge: 'x'.repeat(65_537) }, signal())).code).toBe('invalid-arguments');
    expect(run).not.toHaveBeenCalled();
    expect(await host.call('inspect_fixture', {}, signal())).toEqual(text({ ok: true }));
  });

  it('sanitizes thrown errors and rejects unbounded or invalid outputs', async () => {
    const outputs: Array<() => Promise<ToolResult>> = [
      async () => { throw new Error('private API key or screenshot text'); },
      async () => ({ ...text('private data'), unexpected: 'credential' }),
      async () => text('x'.repeat(512 * 1024)),
      async () => ({ content: [{ type: 'image', mimeType: 'image/jpeg', data: 'a'.repeat(300) }] }),
      async () => ({ content: [{ type: 'text', text: '你'.repeat(200_000) }] }),
    ];
    for (const run of outputs) {
      const result = await new ToolRegistry([definition(run)]).call('inspect_fixture', {}, signal());
      expect(result.isError).toBe(true);
      expect(value(result).code).toBe('tool-failed');
      expect(JSON.stringify(result)).not.toMatch(/private API|screenshot text|credential/);
    }
  });

  it('keeps one call active and propagates cancellation without releasing late results', async () => {
    const gate = deferred<ToolResult>(); let received: AbortSignal | undefined;
    const run = vi.fn(async (_args, active: AbortSignal) => { received = active; return gate.promise; });
    const host = new ToolRegistry([definition(run)]);
    const controller = new AbortController();
    const pending = host.call('inspect_fixture', {}, controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    expect(value(await host.call('inspect_fixture', {}, signal())).code).toBe('busy');
    controller.abort(new Error('private reason'));
    await cancelled;
    expect(received?.aborted).toBe(true);
    gate.resolve(text({ tooLate: true }));
    await Promise.resolve();
    expect(run).toHaveBeenCalledOnce();
  });

  it('does not run already cancelled requests and bounds tools that ignore cancellation', async () => {
    vi.useFakeTimers();
    const run = vi.fn(() => new Promise<ToolResult>(() => {}));
    const host = new ToolRegistry([definition(run)], { timeoutMs: 20 });
    const controller = new AbortController(); controller.abort();
    await expect(host.call('inspect_fixture', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(run).not.toHaveBeenCalled();
    const pending = host.call('inspect_fixture', {}, signal());
    await vi.advanceTimersByTimeAsync(20);
    expect(value(await pending).code).toBe('timeout');
  });

  it('closes pending work and removes the catalog', async () => {
    const gate = deferred<ToolResult>();
    const host = new ToolRegistry([definition(() => gate.promise)]);
    const pending = host.call('inspect_fixture', {}, signal());
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    host.close(); await cancelled;
    expect(host.list()).toEqual([]);
    expect(value(await host.call('inspect_fixture', {}, signal())).code).toBe('closed');
    gate.resolve(text({ late: true }));
  });
});

const editor = { id: 'native-editor-42', application: 'Code', title: 'frontend — Visual Studio Code' };
const browser = { id: 'native-browser-17', application: 'Browser', title: 'Issue tracker' };
function desktopFixture() {
  const state = { current: browser, inventory: [editor, browser] };
  const adapter = {
    listWindows: vi.fn<DesktopAdapter['listWindows']>(async () => ({ windows: structuredClone(state.inventory), warnings: [] })),
    inspectWindow: vi.fn<NonNullable<DesktopAdapter['inspectWindow']>>(async (id) => ({
      status: 'ok', capturedAt: '2026-10-29T12:00:00.000Z', window: { ...state.inventory.find((window) => window.id === id)! },
      nodes: [{ parent: null, role: 'AXWindow', title: 'Project' }, { parent: 0, role: 'AXTextArea', value: 'frontend/src/App.tsx' }], warnings: [],
    })),
    captureWindow: vi.fn<NonNullable<DesktopAdapter['captureWindow']>>(async (id) => ({
      status: 'ok', capturedAt: '2026-10-29T12:00:01.000Z', window: { ...state.inventory.find((window) => window.id === id)! },
      bounds: { x: -1200, y: -100, width: 800, height: 600 },
      image: { mimeType: 'image/jpeg', width: 1600, height: 1200, data: '/9j/AA==' }, warnings: ['Protected content may be blank.'],
    })),
    inspect: vi.fn<DesktopAdapter['inspect']>(async () => ({ platform: 'test', window: { ...state.current } })),
    focus: vi.fn<DesktopAdapter['focus']>(async (id) => { state.current = state.inventory.find((window) => window.id === id)!; }),
    captureContext: vi.fn<DesktopAdapter['captureContext']>(async () => ({
      platform: 'test', capturedAt: '2026-10-29T12:00:00.000Z', activeWindow: browser, selectedText: 'selected evidence',
      pointer: { x: 12, y: 30, window: editor }, warnings: [],
    })),
    captureFrame: vi.fn<DesktopAdapter['captureFrame']>(async () => ({
      capturedAt: '2026-10-29T12:00:00.000Z', display: { id: 'screen-1', bounds: { x: 0, y: 0, width: 1000, height: 800 } },
      image: { mimeType: 'image/jpeg', width: 1000, height: 800, data: '/9j/AA==' }, warnings: ['Synthetic image'],
    })),
  };
  return { adapter, state, host: createDesktopTools(adapter) };
}

describe('desktop tool primitives', () => {
  it('maps fresh discoveries to prior native sources, rejecting same-title replacements as matches', async () => {
    const { adapter, state } = desktopFixture();
    const prior: ConversationTurn = { id: 'previous', completedAt: '2026-10-30T12:00:00Z', request: 'Switch to the frontend',
      response: 'Switched.', referenceContext: [], evidence: { windows: [{ window: editor, capturedAt: '2026-10-30T12:00:00Z', warnings: [] }], actions: [] } };
    const host = createDesktopTools(adapter, { request: 'Use that window', authorize: vi.fn(), conversation: [prior] });
    // A prior identity is evidence, not a directly executable target.
    expect((await host.call('focus_window', { windowId: editor.id }, signal())).isError).toBe(true);
    expect(value(await host.call('focus_window', { windowId: 'window-1' }, signal())).code).toBe('unknown-window');
    state.inventory = [browser, editor];
    const listed = value(await host.call('list_windows', {}, signal()));
    expect(listed.windows[1]).toMatchObject({ windowId: 'window-2', previousTurnIds: ['previous'] });
    expect(listed.windows[0]).not.toHaveProperty('previousTurnIds');
    state.inventory = [browser, { ...editor, id: 'replacement' }];
    expect(value(await host.call('list_windows', {}, signal())).windows[1]).not.toHaveProperty('previousTurnIds');
    host.close();
  });

  it('retains bounded text evidence with its original time and drops image data and handles', async () => {
    const { host } = desktopFixture();
    await host.call('list_windows', {}, signal());
    await host.call('inspect_window', { windowId: 'window-1' }, signal());
    await host.call('capture_window', { windowId: 'window-1' }, signal());
    const evidence = host.conversationEvidence!();
    expect(evidence).toMatchObject({ windows: [{ window: editor, capturedAt: '2026-10-29T12:00:00.000Z',
      nodes: [{ role: 'AXWindow' }, { value: 'frontend/src/App.tsx' }] }], actions: [] });
    expect(JSON.stringify(evidence)).not.toMatch(/windowId|observationId|mimeType|\/9j\//);
    evidence.windows[0]!.nodes![1]!.value = 'mutated';
    expect(host.conversationEvidence!().windows[0]!.nodes![1]!.value).toBe('frontend/src/App.tsx');
    host.close();
    expect(host.conversationEvidence!()).toEqual({ windows: [], actions: [] });
    expect(evidence.windows).toHaveLength(1);
  });

  it('discovers windows without manual names or exposing native IDs', async () => {
    const { host, adapter } = desktopFixture();
    expect(host.list().map((tool) => tool.name)).toEqual(['list_windows', 'inspect_desktop', 'capture_screen', 'focus_window', 'inspect_window', 'capture_window']);
    expect(adapter.listWindows).not.toHaveBeenCalled();
    const result = await host.call('list_windows', {}, signal());
    expect(value(result)).toEqual({ windows: [
      { windowId: 'window-1', application: 'Code', title: editor.title },
      { windowId: 'window-2', application: 'Browser', title: browser.title },
    ], warnings: [] });
    expect(JSON.stringify(result)).not.toContain('native-');
    expect(adapter.focus).not.toHaveBeenCalled();
  });

  it('rejects raw, undiscovered, and removed discovery handles before focusing', async () => {
    const { host, adapter, state } = desktopFixture();
    expect((await host.call('focus_window', { windowId: editor.id }, signal())).isError).toBe(true);
    expect(value(await host.call('focus_window', { windowId: 'window-1' }, signal())).code).toBe('unknown-window');
    await host.call('list_windows', {}, signal());
    state.inventory = [browser];
    await host.call('list_windows', {}, signal());
    expect(value(await host.call('focus_window', { windowId: 'window-1' }, signal())).code).toBe('unknown-window');
    expect(adapter.focus).not.toHaveBeenCalled();
  });

  it('retains references for unchanged windows across reordering and refreshes', async () => {
    const { host, state } = desktopFixture();
    await host.call('list_windows', {}, signal());
    state.inventory = [browser, editor];
    expect(value(await host.call('list_windows', {}, signal())).windows.map((window: { windowId: string }) => window.windowId))
      .toEqual(['window-2', 'window-1']);
    state.inventory = [browser, { ...editor, title: 'Different project' }];
    expect(value(await host.call('list_windows', {}, signal())).windows[1].windowId).toBe('window-3');
    expect(value(await host.call('focus_window', { windowId: 'window-1' }, signal())).code).toBe('unknown-window');
  });

  it('inspects the requested background window without focus or native ID disclosure', async () => {
    const { host, adapter } = desktopFixture();
    await host.call('list_windows', {}, signal());
    const result = await host.call('inspect_window', { windowId: 'window-1' }, signal());
    expect(value(result)).toMatchObject({ source: 'accessibility', capturedAt: '2026-10-29T12:00:00.000Z',
      window: { windowId: 'window-1', title: editor.title }, nodes: [{ role: 'AXWindow' }, { value: 'frontend/src/App.tsx' }] });
    expect(adapter.inspectWindow).toHaveBeenCalledWith(editor.id, expect.any(AbortSignal));
    expect(adapter.listWindows).toHaveBeenCalledOnce();
    expect(adapter.focus).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('native-');
  });

  it('omits inspection from the catalog when the platform has no implementation', () => {
    const { adapter } = desktopFixture();
    const host = createDesktopTools({ ...adapter, inspectWindow: undefined });
    expect(host.list().some((tool) => tool.name === 'inspect_window')).toBe(false);
  });

  it('returns window pixels with source, time, and scaled/negative desktop coordinates without focusing', async () => {
    const { host, adapter } = desktopFixture();
    await host.call('list_windows', {}, signal());
    const result = await host.call('capture_window', { windowId: 'window-1' }, signal());
    expect(value(result)).toEqual({ source: 'window-screenshot', capturedAt: '2026-10-29T12:00:01.000Z',
      window: { windowId: 'window-1', application: 'Code', title: editor.title },
      bounds: { x: -1200, y: -100, width: 800, height: 600 }, coordinateSpace: 'global-desktop-logical-points',
      image: { mimeType: 'image/jpeg', width: 1600, height: 1200 }, warnings: ['Protected content may be blank.'] });
    expect(result.content[1]).toEqual({ type: 'image', mimeType: 'image/jpeg', data: '/9j/AA==' });
    expect(JSON.stringify(result)).not.toContain('native-');
    expect(adapter.captureWindow).toHaveBeenCalledWith(editor.id, expect.any(AbortSignal));
    expect(adapter.focus).not.toHaveBeenCalled();
    expect(adapter.captureFrame).not.toHaveBeenCalled();
  });

  it('does not advertise window capture on platforms without an implementation', async () => {
    const { adapter } = desktopFixture();
    const host = createDesktopTools({ ...adapter, captureWindow: undefined });
    expect(host.list().some((tool) => tool.name === 'capture_window')).toBe(false);
    expect(value(await host.call('capture_window', { windowId: 'window-1' }, signal())).code).toBe('unknown-tool');
  });

  it('requires a discovered window before requesting pixels', async () => {
    const { host, adapter } = desktopFixture();
    for (const windowId of [editor.id, 'window-1']) expect((await host.call('capture_window', { windowId }, signal())).isError).toBe(true);
    expect(adapter.captureWindow).not.toHaveBeenCalled();
  });

  it.each(['accessibility-permission-required', 'screen-permission-required', 'unsupported', 'stale-target',
    'ambiguous-target', 'inaccessible', 'timeout', 'capture-failed', 'helper-crashed'] as const)('reports %s without substituting a foreground screenshot', async (reason) => {
    const { host, adapter } = desktopFixture();
    await host.call('list_windows', {}, signal());
    adapter.captureWindow.mockResolvedValue({ status: 'unavailable', reason });
    const result = await host.call('capture_window', { windowId: 'window-1' }, signal());
    expect(result.isError).toBe(true);
    expect(value(result).code).toBe(reason === 'stale-target' ? 'stale-window' : reason);
    if (reason === 'helper-crashed') expect(value(result).message).not.toContain('permission');
    expect(result.content.every((part) => part.type === 'text')).toBe(true);
    if (reason === 'stale-target') expect(value(await host.call('focus_window', { windowId: 'window-1' }, signal())).code).toBe('unknown-window');
    expect(adapter.focus).not.toHaveBeenCalled();
    expect(adapter.captureFrame).not.toHaveBeenCalled();
  });

  it('discards pixels and the discovery reference when capture returns another source', async () => {
    const { host, adapter } = desktopFixture();
    await host.call('list_windows', {}, signal());
    const other = await adapter.captureWindow(browser.id);
    adapter.captureWindow.mockResolvedValue(other);
    const result = await host.call('capture_window', { windowId: 'window-1' }, signal());
    expect(value(result).code).toBe('stale-window');
    expect(result.content.some((part) => part.type === 'image')).toBe(false);
    expect(value(await host.call('focus_window', { windowId: 'window-1' }, signal())).code).toBe('unknown-window');
  });

  it('discards a late image after cancellation', async () => {
    const { host, adapter } = desktopFixture();
    await host.call('list_windows', {}, signal());
    const frame = await adapter.captureWindow(editor.id);
    const gate = deferred<typeof frame>();
    adapter.captureWindow.mockReturnValueOnce(gate.promise);
    const controller = new AbortController();
    const pending = host.call('capture_window', { windowId: 'window-1' }, controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve(); controller.abort(); await cancelled;
    gate.resolve(frame); await Promise.resolve();
    expect(adapter.focus).not.toHaveBeenCalled();
    expect(adapter.captureFrame).not.toHaveBeenCalled();
  });

  it('rejects undiscovered inspection targets before native access', async () => {
    const { host, adapter } = desktopFixture();
    for (const windowId of [editor.id, 'window-1']) {
      expect((await host.call('inspect_window', { windowId }, signal())).isError).toBe(true);
    }
    expect(adapter.inspectWindow).not.toHaveBeenCalled();
  });

  it.each(['permission-required', 'inaccessible', 'stale-target'] as const)('preserves actionable %s inspection failures', async (reason) => {
    const { host, adapter } = desktopFixture();
    await host.call('list_windows', {}, signal());
    adapter.inspectWindow.mockResolvedValue({ status: 'unavailable', reason });
    const result = await host.call('inspect_window', { windowId: 'window-1' }, signal());
    expect(value(result).code).toBe(reason === 'inaccessible' ? 'content-unavailable' : reason === 'stale-target' ? 'stale-window' : reason);
    if (reason === 'stale-target') expect(value(await host.call('focus_window', { windowId: 'window-1' }, signal())).code).toBe('unknown-window');
    expect(adapter.focus).not.toHaveBeenCalled();
  });

  it('discards content when the returned source changed during inspection', async () => {
    const { host, adapter, state } = desktopFixture();
    await host.call('list_windows', {}, signal());
    state.inventory[0] = { ...editor, title: 'Changed project' };
    const result = await host.call('inspect_window', { windowId: 'window-1' }, signal());
    expect(value(result).code).toBe('stale-window');
    expect(JSON.stringify(result)).not.toContain('frontend/src/App.tsx');
    expect(value(await host.call('focus_window', { windowId: 'window-1' }, signal())).code).toBe('unknown-window');
    expect(adapter.focus).not.toHaveBeenCalled();
  });

  it('does not release content returned after cancellation', async () => {
    const { host, adapter } = desktopFixture();
    await host.call('list_windows', {}, signal());
    const gate = deferred<Awaited<ReturnType<NonNullable<DesktopAdapter['inspectWindow']>>>>();
    adapter.inspectWindow.mockReturnValueOnce(gate.promise);
    const controller = new AbortController();
    const pending = host.call('inspect_window', { windowId: 'window-1' }, controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve(); controller.abort(); await cancelled;
    gate.resolve({ status: 'ok', capturedAt: '2026-10-29T12:00:00Z', window: editor, nodes: [], warnings: [] });
    await Promise.resolve();
    expect(adapter.focus).not.toHaveBeenCalled();
  });

  it('rechecks a discovered window and reports success only after verified focus', async () => {
    const { host, adapter } = desktopFixture();
    await host.call('list_windows', {}, signal());
    const result = await host.call('focus_window', { windowId: 'window-1' }, signal());
    expect(value(result)).toEqual({ focused: true, window: { windowId: 'window-1', application: 'Code', title: editor.title } });
    expect(adapter.listWindows).toHaveBeenCalledTimes(2);
    expect(adapter.focus).toHaveBeenCalledWith(editor.id, expect.any(AbortSignal));
    expect(adapter.inspect).toHaveBeenCalledWith(false, expect.any(AbortSignal));
  });

  it.each(['closed', 'reused', 'retitled'])('rejects a %s window before issuing focus', async (change) => {
    const { host, adapter, state } = desktopFixture();
    await host.call('list_windows', {}, signal());
    state.inventory = change === 'closed' ? [browser] : [change === 'reused'
      ? { ...editor, application: 'Another app' } : { ...editor, title: 'backend — Visual Studio Code' }, browser];
    expect(value(await host.call('focus_window', { windowId: 'window-1' }, signal())).code).toBe('stale-window');
    expect(value(await host.call('focus_window', { windowId: 'window-1' }, signal())).code).toBe('unknown-window');
    expect(adapter.focus).not.toHaveBeenCalled();
  });

  it('does not claim focus when native verification returns another window', async () => {
    const { host, adapter } = desktopFixture();
    await host.call('list_windows', {}, signal());
    adapter.focus.mockResolvedValue();
    expect(value(await host.call('focus_window', { windowId: 'window-1' }, signal())).code).toBe('focus-unverified');
  });

  it('does not focus when cancelled while refreshing evidence', async () => {
    const { host, adapter } = desktopFixture();
    await host.call('list_windows', {}, signal());
    const gate = deferred<WindowInventory>();
    adapter.listWindows.mockReturnValueOnce(gate.promise);
    const controller = new AbortController();
    const pending = host.call('focus_window', { windowId: 'window-1' }, controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve(); controller.abort(); await cancelled;
    gate.resolve({ windows: [editor, browser], warnings: [] });
    await Promise.resolve(); await Promise.resolve();
    expect(adapter.focus).not.toHaveBeenCalled();
  });

  it('prevents closed sessions from publishing late discovery or focusing', async () => {
    const { host, adapter } = desktopFixture();
    const gate = deferred<WindowInventory>(); adapter.listWindows.mockReturnValueOnce(gate.promise);
    const pending = host.call('list_windows', {}, signal());
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve(); host.close(); await cancelled;
    gate.resolve({ windows: [editor, browser], warnings: [] });
    await Promise.resolve(); await Promise.resolve();
    expect(host.list()).toEqual([]);
    expect(value(await host.call('focus_window', { windowId: 'window-1' }, signal())).code).toBe('closed');
    expect(adapter.focus).not.toHaveBeenCalled();
  });

  it('returns current selection and pointer evidence without native IDs or focus changes', async () => {
    const { host, adapter } = desktopFixture();
    await host.call('list_windows', {}, signal());
    const result = await host.call('inspect_desktop', {}, signal());
    expect(value(result)).toMatchObject({ activeWindow: { windowId: 'window-2', application: 'Browser' },
      pointer: { x: 12, y: 30, window: { windowId: 'window-1' } }, selectedText: 'selected evidence' });
    expect(JSON.stringify(result)).not.toContain('native-');
    expect(adapter.focus).not.toHaveBeenCalled();
  });

  it('returns bounded full-screen JPEG bytes alongside capture metadata', async () => {
    const { host, adapter } = desktopFixture();
    const result = await host.call('capture_screen', {}, signal());
    expect(value(result)).toMatchObject({ display: { id: 'screen-1' }, image: { width: 1000, height: 800 }, warnings: ['Synthetic image'] });
    expect(result.content[1]).toEqual({ type: 'image', mimeType: 'image/jpeg', data: '/9j/AA==' });
    expect(adapter.focus).not.toHaveBeenCalled();
  });

  it('rejects ambiguous or invalid inventories instead of inventing target identities', async () => {
    const { host, adapter } = desktopFixture();
    adapter.listWindows.mockResolvedValue({ windows: [editor, editor], warnings: [] });
    expect((await host.call('list_windows', {}, signal())).isError).toBe(true);
    expect(value(await host.call('focus_window', { windowId: 'window-1' }, signal())).code).toBe('unknown-window');
    expect(adapter.focus).not.toHaveBeenCalled();
  });
});
