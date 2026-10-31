import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../src/tools/registry.js';
import { createDesktopTools } from '../src/tools/desktop.js';
import type { ToolDefinition, ToolResult } from '../src/tools/types.js';
import type { DesktopAdapter, WindowInventory } from '../src/desktop/types.js';
import type { ConversationTurn } from '../src/conversation.js';
import { DesktopError, desktopMessages } from '../src/desktop/errors.js';

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
  it('preserves trusted local failure metadata and rejects forged recovery codes', async () => {
    const host = new ToolRegistry([definition(async () => { throw new DesktopError('screen-permission-required'); })]);
    const result = await host.call('inspect_fixture', {}, signal());
    expect(result).toMatchObject({ isError: true, desktopIssue: 'screen-permission-required' });
    expect(value(result)).toEqual({ code: 'screen-permission-required', message: desktopMessages['screen-permission-required'] });
    host.close();
    const malformed = new ToolRegistry([definition(async () => ({ ...text({ ok: true }), desktopIssue: 'private arbitrary text' } as unknown as ToolResult))]);
    const rejected = await malformed.call('inspect_fixture', {}, signal());
    expect(rejected.desktopIssue).toBeUndefined(); expect(value(rejected).code).toBe('tool-failed');
    expect(JSON.stringify(rejected)).not.toContain('private arbitrary text'); malformed.close();
  });
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

it('exposes keyboard focus from screen capture even without discoverable windows', async () => {
  const f = desktopFixture(); f.state.inventory = [];
  const keyboard = {
    inspect: vi.fn(async () => ({ fingerprint: 'a'.repeat(64), application: 'Terminal', role: 'AXTextArea',
      title: '', description: '', value: '', valueTruncated: false, editable: false })),
    execute: vi.fn(async () => ({ status: 'issued' as const })),
  };
  const host = createDesktopTools({ ...f.adapter, keyboard }, { request: 'Open chess on Chrome.',
    authorize: async () => ({ decision: 'allow', effect: 'navigate', requestQuote: 'Open chess on Chrome.', reason: 'Open Spotlight.' }) });
  expect(value(await host.call('list_windows', {}, signal())).windows).toEqual([]);
  const capture = value(await host.call('capture_screen', {}, signal()));
  expect(capture.keyboardFocus.application).toBe('Terminal');
  const result = value(await host.call('press_key', { keyboardObservationId: capture.keyboardObservationId, key: 'Space', modifiers: ['Cmd'] }, signal()));
  expect(result).toMatchObject({ status: 'issued', effect: 'navigate', inputStopped: false });
  expect(keyboard.execute).toHaveBeenCalledWith({ kind: 'press_key', key: 'Space', modifiers: ['Cmd'] }, 'a'.repeat(64), expect.any(AbortSignal));
  const evidence = host.conversationEvidence!();
  expect(evidence.keyboardActions).toMatchObject([{ action: { kind: 'press_key', key: 'Space' }, status: 'issued' }]);
  expect(JSON.stringify(evidence)).not.toMatch(/keyboardObservationId|fingerprint/);
  host.close(); f.host.close();
});

const payloads = (result: ToolResult) => result.content.flatMap((part) => part.type === 'text' ? [JSON.parse(part.text)] : []);
const observation = (result: ToolResult) => payloads(result).find((part) => part.observationId || part.keyboardObservationId);
function actionableDesktop() {
  const f = desktopFixture();
  let committing = false;
  const request = 'Prepare the requested message and send it.';
  const input = {
    inspect: vi.fn<NonNullable<DesktopAdapter['input']>['inspect']>(async () => ({ fingerprint: 'a'.repeat(64),
      role: 'AXTextArea', title: 'Message', description: '', value: '', focused: true, editable: true,
      bounds: { x: -1200, y: -100, width: 800, height: 600 } })),
    execute: vi.fn<NonNullable<DesktopAdapter['input']>['execute']>(async () => ({ status: 'verified' })),
  };
  const authorize = vi.fn(async () => ({ decision: 'allow' as const, effect: committing ? 'submit' as const : 'edit' as const,
    requestQuote: request, reason: 'Scripted request-scoped decision.' }));
  const host = createDesktopTools({ ...f.adapter, input }, { request, authorize });
  return { ...f, host, input, authorize, commit: () => { committing = true; },
    close: () => { host.close(); f.host.close(); } };
}

describe('fresh observations bundled with actions', () => {
  it('runs focus, click, type and submit with fresh returned images and no separate capture requests', async () => {
    const f = actionableDesktop();
    await f.host.call('list_windows', {}, signal());
    const focused = await f.host.call('focus_window', { windowId: 'window-1' }, signal());
    expect(value(focused).focused).toBe(true);
    const first = observation(focused).observationId;
    const clicked = await f.host.call('click', { observationId: first, x: 100, y: 100 }, signal());
    expect(value(clicked)).toMatchObject({ status: 'verified', inputStopped: false });
    expect(observation(clicked).observationId).not.toBe(first);
    const typed = await f.host.call('type_text', { observationId: observation(clicked).observationId,
      x: 100, y: 100, text: 'Requested message' }, signal());
    expect(value(typed)).toMatchObject({ status: 'verified', inputStopped: false });
    expect(value(await f.host.call('click', { observationId: first, x: 100, y: 100 }, signal())).code).toBe('stale-observation');
    expect(f.input.execute).toHaveBeenCalledTimes(2);
    f.commit();
    const submitted = await f.host.call('click', { observationId: observation(typed).observationId, x: 100, y: 100 }, signal());
    expect(value(submitted)).toMatchObject({ status: 'verified', effect: 'submit', inputStopped: true });
    expect(observation(submitted)).toBeUndefined();
    for (const result of [focused, clicked, typed, submitted]) {
      expect(result.content.filter((part) => part.type === 'image')).toHaveLength(1);
      expect(payloads(result)).toContainEqual(expect.objectContaining({ postActionObservation: expect.objectContaining({ status: 'ok' }) }));
    }
    expect(f.adapter.captureWindow).toHaveBeenCalledTimes(4);
    expect(f.authorize).toHaveBeenCalledTimes(2);
    expect(value(await f.host.call('type_text', { observationId: observation(typed).observationId,
      x: 100, y: 100, text: 'Must not run' }, signal())).code).toBe('input-stopped');
    expect(f.input.execute).toHaveBeenCalledTimes(3);
    f.close();
  });

  it('returns each new keyboard focus for navigation, typing and Enter without intervening capture calls', async () => {
    const f = desktopFixture(); let revision = 0;
    const request = 'Write and send the requested message.';
    const keyboard = {
      inspect: vi.fn<NonNullable<DesktopAdapter['keyboard']>['inspect']>(async () => ({ fingerprint: String(revision).repeat(64),
        application: 'Workspace', role: 'AXTextArea', title: 'Message', description: '', value: revision > 1 ? 'Hello' : '',
        valueTruncated: false, editable: true })),
      execute: vi.fn<NonNullable<DesktopAdapter['keyboard']>['execute']>(async () => { revision++; return { status: 'issued' }; }),
    };
    const host = createDesktopTools({ ...f.adapter, keyboard }, { request,
      authorize: async () => ({ decision: 'allow', effect: 'submit', requestQuote: request, reason: 'Send requested message.' }) });
    const initial = await host.call('capture_screen', {}, signal());
    const navigated = await host.call('press_key', { keyboardObservationId: observation(initial).keyboardObservationId,
      key: 'Tab', modifiers: [] }, signal());
    const typed = await host.call('type_keyboard_text', { keyboardObservationId: observation(navigated).keyboardObservationId, text: 'Hello' }, signal());
    expect(observation(typed).keyboardFocus.value).toBe('Hello');
    expect(value(await host.call('type_keyboard_text', { keyboardObservationId: observation(initial).keyboardObservationId, text: 'stale' }, signal())).code).toBe('stale-observation');
    const sent = await host.call('press_key', { keyboardObservationId: observation(typed).keyboardObservationId, key: 'Enter', modifiers: [] }, signal());
    expect(value(sent)).toMatchObject({ status: 'issued', effect: 'submit', inputStopped: true });
    expect(observation(sent)).toBeUndefined();
    expect(payloads(sent)).toContainEqual(expect.objectContaining({ keyboardFocus: expect.objectContaining({ value: 'Hello' }) }));
    expect(f.adapter.captureFrame).toHaveBeenCalledTimes(4);
    expect(keyboard.execute).toHaveBeenCalledTimes(3);
    expect(value(await host.call('press_key', { keyboardObservationId: observation(typed).keyboardObservationId,
      key: 'Enter', modifiers: [] }, signal())).code).toBe('input-stopped');
    expect(keyboard.execute).toHaveBeenCalledTimes(3);
    host.close(); f.host.close();
  });

  it.each(['not-issued', 'uncertain'] as const)('observes a native %s result without retrying or reopening stopped input', async (status) => {
    const f = actionableDesktop(); await f.host.call('list_windows', {}, signal());
    const focused = await f.host.call('focus_window', { windowId: 'window-1' }, signal());
    f.input.execute.mockResolvedValue({ status, reason: 'stale-observation' });
    const result = await f.host.call('click', { observationId: observation(focused).observationId, x: 100, y: 100 }, signal());
    expect(value(result)).toMatchObject({ status, inputStopped: status === 'uncertain' });
    expect(f.input.execute).toHaveBeenCalledOnce();
    expect(result.content.some((part) => part.type === 'image')).toBe(true);
    if (status === 'not-issued') expect(observation(result).observationId).not.toBe(observation(focused).observationId);
    else expect(observation(result)).toBeUndefined();
    f.close();
  });

  it.each(['throw', 'unavailable', 'malformed'] as const)('preserves an issued action when its optional refresh is %s', async (failure) => {
    const f = actionableDesktop(); await f.host.call('list_windows', {}, signal());
    const focused = await f.host.call('focus_window', { windowId: 'window-1' }, signal());
    if (failure === 'throw') f.adapter.captureWindow.mockRejectedValue(new Error('private native details'));
    if (failure === 'unavailable') f.adapter.captureWindow.mockResolvedValue({ status: 'unavailable', reason: 'inaccessible' });
    if (failure === 'malformed') f.adapter.captureWindow.mockResolvedValue({ status: 'ok' } as never);
    const result = await f.host.call('type_text', { observationId: observation(focused).observationId, x: 100, y: 100, text: 'Requested message' }, signal());
    expect(value(result)).toMatchObject({ status: 'verified', inputStopped: false });
    expect(result.isError).toBe(false);
    expect(payloads(result)).toContainEqual(expect.objectContaining({ postActionObservation: expect.objectContaining({ status: 'unavailable' }) }));
    expect(JSON.stringify(result)).not.toContain('private native details');
    expect(observation(result)).toBeUndefined();
    expect(f.input.execute).toHaveBeenCalledOnce();
    f.close();
  });

  it('bounds optional refresh separately from focus and discards a late image', async () => {
    vi.useFakeTimers();
    const f = actionableDesktop(); await f.host.call('list_windows', {}, signal());
    const frame = await f.adapter.captureWindow(editor.id, signal());
    const late = deferred<typeof frame>(); let captureSignal: AbortSignal | undefined;
    f.adapter.focus.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 5_000)); f.state.current = editor; });
    f.adapter.captureWindow.mockImplementation(async (_id, active) => { captureSignal = active; return late.promise; });
    const pending = f.host.call('focus_window', { windowId: 'window-1' }, signal());
    await vi.advanceTimersByTimeAsync(7_000);
    const result = await pending;
    expect(value(result).focused).toBe(true);
    expect(payloads(result)).toContainEqual(expect.objectContaining({ postActionObservation: expect.objectContaining({ status: 'unavailable' }) }));
    expect(captureSignal?.aborted).toBe(true);
    late.resolve(frame); await Promise.resolve();
    expect(value(await f.host.call('click', { observationId: 'observation-1', x: 100, y: 100 }, signal())).code).toBe('stale-observation');
    expect(f.input.execute).not.toHaveBeenCalled();
    f.close();
  });

  it('cancels a post-action refresh without publishing late observations or retrying input', async () => {
    const f = actionableDesktop(); await f.host.call('list_windows', {}, signal());
    const focused = await f.host.call('focus_window', { windowId: 'window-1' }, signal());
    const frame = await f.adapter.captureWindow(editor.id, signal());
    const gate = deferred<typeof frame>(); const entered = deferred<void>();
    f.adapter.captureWindow.mockImplementation(async () => { entered.resolve(); return gate.promise; });
    const controller = new AbortController();
    const pending = f.host.call('type_text', { observationId: observation(focused).observationId, x: 100, y: 100, text: 'Requested message' }, controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise; controller.abort(); await cancelled;
    gate.resolve(frame); await Promise.resolve();
    expect(f.input.execute).toHaveBeenCalledOnce();
    expect(f.host.conversationEvidence!().actions[0]?.status).toBe('verified');
    expect(value(await f.host.call('click', { observationId: 'observation-2', x: 100, y: 100 }, signal())).code).toBe('stale-observation');
    f.close();
  });

  it('does not capture after point-only, invalid, or denied actions', async () => {
    const f = actionableDesktop(); await f.host.call('list_windows', {}, signal());
    const focused = await f.host.call('focus_window', { windowId: 'window-1' }, signal());
    const args = { observationId: observation(focused).observationId, x: 100, y: 100 };
    await f.host.call('click', { ...args, unexpected: true }, signal());
    await f.host.call('move_pointer', args, signal());
    expect(f.adapter.captureWindow).toHaveBeenCalledOnce();
    const fresh = await f.host.call('capture_window', { windowId: 'window-1' }, signal());
    f.authorize.mockResolvedValue({ decision: 'deny' as never, effect: 'edit', requestQuote: 'Prepare the requested message and send it.', reason: 'Wrong recipient.' });
    const denied = await f.host.call('click', { ...args, observationId: observation(fresh).observationId }, signal());
    expect(value(denied).code).toBe('outside-request');
    expect(f.adapter.captureWindow).toHaveBeenCalledTimes(2);
    expect(f.input.execute).toHaveBeenCalledOnce();
    f.close();
  });
});

describe('desktop tool primitives', () => {
  it('resolves feedback labels from discovered windows without extra desktop access', async () => {
    const { host, adapter, state } = desktopFixture();
    const args = { windowId: 'window-1' };
    expect(host.feedbackTarget!('focus_window', args)).toBeUndefined();
    await host.call('list_windows', {}, signal());
    const label = host.feedbackTarget!('focus_window', args);
    expect(label).toEqual({ application: editor.application, title: editor.title });
    label!.title = 'Changed outside the host';
    expect(host.feedbackTarget!('focus_window', args)?.title).toBe(editor.title);
    expect(host.feedbackTarget!('focus_window', { ...args, title: 'Model-supplied target' })).toBeUndefined();
    expect(host.feedbackTarget!('focus_window', { windowId: editor.id })).toBeUndefined();
    expect(host.feedbackTarget!('inspect_window', args)).toBeUndefined();
    expect(adapter.listWindows).toHaveBeenCalledOnce();
    expect(adapter.focus).not.toHaveBeenCalled(); expect(adapter.inspect).not.toHaveBeenCalled();
    state.inventory = [browser, { ...editor, title: 'A different project' }];
    await host.call('list_windows', {}, signal());
    expect(host.feedbackTarget!('focus_window', args)).toBeUndefined();
    host.close();
    expect(host.feedbackTarget!('focus_window', { windowId: 'window-2' })).toBeUndefined();
  });

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

  it('reports running apps with empty inventories without inventing window handles', async () => {
    const { host, adapter } = desktopFixture();
    adapter.listWindows.mockResolvedValueOnce({ windows: [], warnings: [], applicationsWithoutWindows: ['Chat App'] });
    expect(value(await host.call('list_windows', {}, signal()))).toEqual({
      windows: [], warnings: [], applicationsWithoutWindows: ['Chat App'],
    });
    expect(value(await host.call('focus_window', { windowId: 'window-1' }, signal())).code).toBe('unknown-window');
    expect(adapter.focus).not.toHaveBeenCalled();
    expect(host.conversationEvidence!()).toEqual({ windows: [], actions: [] });

    const window = { id: 'native-chat-43', application: 'Chat App', title: 'Project conversation' };
    adapter.listWindows.mockResolvedValueOnce({ windows: [window], warnings: [] });
    expect(value(await host.call('list_windows', {}, signal()))).toEqual({
      windows: [{ windowId: 'window-1', application: 'Chat App', title: window.title }], warnings: [],
    });
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
