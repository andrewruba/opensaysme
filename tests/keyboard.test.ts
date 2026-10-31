import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { keyboardActionSchema, type KeyboardAction, type KeyboardAdapter, type KeyboardEvidence } from '../src/desktop/keyboard-types.js';
import type { ScreenFrameCapture } from '../src/desktop/visual-types.js';
import type { DesktopInputAdapter } from '../src/desktop/input-types.js';
import type { WindowFrameCapture } from '../src/desktop/types.js';
import { DesktopError } from '../src/desktop/errors.js';
import { createKeyboardTools } from '../src/tools/keyboard.js';
import { createInputTools, type InputSession } from '../src/tools/input.js';
import { createDesktopTools } from '../src/tools/desktop.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { permitsKeyboard, type ActionAuthorizer, type PermissionDecision } from '../src/tools/permissions.js';
import type { ToolResult } from '../src/tools/types.js';

const signal = () => new AbortController().signal;
const frame: ScreenFrameCapture = {
  capturedAt: '2026-10-30T12:00:00Z', display: { id: 'display-1', bounds: { x: 0, y: 0, width: 1200, height: 800 } },
  image: { mimeType: 'image/jpeg', width: 1200, height: 800, data: '/9j/AA==' }, warnings: [],
};
const target = { fingerprint: 'a'.repeat(64), application: 'Browser', applicationId: 'mac-app:100:1', windowId: 'native-browser', role: 'AXTextField', title: 'Name',
  description: '', value: '', valueTruncated: false, editable: true };
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((close) => close()); vi.useRealTimers(); });
function value(result: ToolResult) {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('Expected tool text.');
  return JSON.parse(first.text);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(request = 'Fill this form. Leave it unsubmitted.', decision: Partial<PermissionDecision> = {}, guard = true,
  activationHotkey?: string) {
  const state = { target: structuredClone(target) };
  const adapter = {
    inspect: vi.fn<KeyboardAdapter['inspect']>(async () => structuredClone(state.target)),
    execute: vi.fn<KeyboardAdapter['execute']>(async (_action, fingerprint) => ({
      status: fingerprint === state.target.fingerprint ? 'issued' : 'not-issued',
    })),
  };
  const captureFrame = vi.fn(async () => structuredClone(frame));
  const authorize = vi.fn<ActionAuthorizer>(async (review) => ({ decision: 'allow', effect: review.action.kind === 'type_keyboard_text' ? 'edit' : 'navigate', requestQuote: request,
    reason: 'The requested navigation is supported by the current target.', ...decision }));
  const scope = { request, ...(guard ? { authorize } : {}), ...(activationHotkey ? { activationHotkey } : {}) };
  const session: InputSession = { stopped: false, revision: 0 };
  const keyboard = createKeyboardTools(adapter, captureFrame, scope, session);
  const host = new ToolRegistry([...keyboard.definitions, { name: 'capture_screen', effect: 'read', input: z.object({}),
    description: 'Capture a synthetic desktop and keyboard focus.', run: (_args, active) => keyboard.capture(active) }]);
  cleanups.push(() => { host.close(); keyboard.close(); });
  const capture = async () => value(await host.call('capture_screen', {}, signal()));
  const call = (observationId: string, action: KeyboardAction, active = signal()) => {
    const { kind, ...args } = action;
    return host.call(kind, { keyboardObservationId: observationId, ...args }, active);
  };
  return { state, adapter, captureFrame, authorize, scope, session, keyboard, host, capture, call };
}

function desktopFixture(decision: Partial<PermissionDecision> = {}) {
  const f = fixture(undefined, decision);
  const window = { id: 'native-browser', application: 'Browser', title: 'Form' };
  const bounds = { x: 0, y: 0, width: 1200, height: 800 };
  const windowFrame: Extract<WindowFrameCapture, { status: 'ok' }> = {
    status: 'ok', window, bounds, capturedAt: frame.capturedAt, image: frame.image, warnings: [],
  };
  const pointer = {
    inspect: vi.fn<DesktopInputAdapter['inspect']>(async () => ({ fingerprint: 'b'.repeat(64), role: 'AXTextField',
      title: 'Name', description: '', value: '', focused: true, editable: true, bounds })),
    execute: vi.fn<DesktopInputAdapter['execute']>(async () => ({ status: 'issued' })),
  };
  const host = createDesktopTools({ keyboard: f.adapter, input: pointer, captureFrame: f.captureFrame,
    listWindows: async () => ({ windows: [window], warnings: [], applications: [] }),
    captureWindow: async () => structuredClone(windowFrame),
    inspect: async () => ({ platform: 'darwin', window }), focus: async () => {},
    captureContext: async () => ({ platform: 'darwin', capturedAt: frame.capturedAt, activeWindow: window, warnings: [] }),
  }, f.scope);
  cleanups.push(() => host.close());
  return { host, pointer, keyboard: f.adapter, state: f.state, authorize: f.authorize,
    call: async (name: string, args = {}) => value(await host.call(name, args, signal())) };
}

describe('request-scoped keyboard input', () => {
  it('returns unresolved keyboard text locally before the guard and permits a resolved retry', async () => {
    const f = fixture();
    const checkTarget = vi.fn(async (): Promise<string | undefined> => 'Resolve the destination first.');
    const keyboard = createKeyboardTools(f.adapter, f.captureFrame, { ...f.scope, reviewTarget: () => true, checkTarget }, f.session);
    const host = new ToolRegistry(keyboard.definitions);
    const capture = value(await keyboard.capture(signal()));
    const args = { keyboardObservationId: capture.keyboardObservationId, text: 'Morgan' };
    expect(value(await host.call('type_keyboard_text', args, signal())).code).toBe('target-unresolved');
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.adapter.execute).not.toHaveBeenCalled();
    expect(f.session.stopped).toBe(false);
    checkTarget.mockResolvedValue(undefined);
    expect(value(await host.call('type_keyboard_text', args, signal()))).toMatchObject({ status: 'issued', permission: { mode: 'independent-check' } });
    expect(f.authorize).toHaveBeenCalledOnce();
    expect(f.adapter.execute).toHaveBeenCalledOnce();
    host.close(); keyboard.close();
  });

  it('allows inspection after missing evidence but independently checks subsequent routine input across modalities', async () => {
    const f = fixture('Find the requested conversation and prepare this question.', { decision: 'inspect', effect: 'unknown',
      reason: 'The focused document is unrelated to the requested conversation.' });
    const captured = await f.capture();
    expect(value(await f.call(captured.keyboardObservationId, { kind: 'press_key', key: 'R', modifiers: ['Ctrl'] })))
      .toMatchObject({ code: 'needs-evidence' });
    expect(f.session.stopped).toBe(false);
    expect(f.adapter.execute).not.toHaveBeenCalled();

    const pointer: DesktopInputAdapter = {
      inspect: vi.fn(async () => ({ fingerprint: 'b'.repeat(64), role: 'AXTextField', title: 'Question', description: '',
        value: '', bounds: frame.display.bounds, focused: true, editable: true })),
      execute: vi.fn(async () => ({ status: 'verified' as const })),
    };
    const inputs = createInputTools(pointer, f.scope, f.session);
    const host = new ToolRegistry(inputs.definitions);
    const windowFrame = { status: 'ok' as const, capturedAt: frame.capturedAt, image: frame.image, warnings: [],
      bounds: frame.display.bounds, window: { id: 'native-conversation', application: 'Agent', title: 'Requested project' } };
    f.authorize.mockResolvedValueOnce({ decision: 'allow', effect: 'edit', requestQuote: f.scope.request,
      reason: 'The newly inspected destination contains the requested project.' });
    expect(value(await host.call('type_text', { observationId: inputs.observe(windowFrame), x: 10, y: 10, text: 'Question' }, signal())))
      .toMatchObject({ status: 'verified', permission: { mode: 'independent-check' } });
    expect(f.authorize.mock.lastCall?.[0]).toMatchObject({ progress: { evidenceNeeded: {
      action: { kind: 'press_key', key: 'R' }, reason: 'The focused document is unrelated to the requested conversation.',
    } }, action: { kind: 'type_text', text: 'Question' } });
    expect(pointer.execute).toHaveBeenCalledOnce();
    expect(f.session.progress?.evidenceNeeded).toBeUndefined();
    host.close(); inputs.close();
  });

  it('keeps an unresolved attempt guarded when the next fresh capture supplies no useful evidence', async () => {
    const f = fixture('Prepare this question.', { decision: 'inspect', effect: 'unknown', reason: 'The destination is unresolved.' });
    let capture = await f.capture();
    await f.call(capture.keyboardObservationId, { kind: 'press_key', key: 'R', modifiers: ['Ctrl'] });
    capture = await f.capture();
    expect(value(await f.call(capture.keyboardObservationId, { kind: 'type_keyboard_text', text: 'Question' })))
      .toMatchObject({ code: 'needs-evidence' });
    expect(f.authorize).toHaveBeenCalledTimes(2);
    expect(f.authorize.mock.lastCall?.[0].progress?.evidenceNeeded?.reason).toBe('The destination is unresolved.');
    expect(f.adapter.execute).not.toHaveBeenCalled();
  });
  it('distinguishes a focused page from its composer and permits typing after focus is resolved', async () => {
    const f = desktopFixture();
    f.state.target = { ...target, role: 'AXWebArea', title: 'Conversation', editable: false };
    await f.call('list_windows');
    const window = await f.call('capture_window', { windowId: 'window-1' });
    await f.call('resolve_target', { requestQuote: 'Fill this form', source: null, question: null,
      candidates: [{ targetId: 'window-1', status: 'selected', evidenceIds: [window.evidenceId], reason: 'The requested form is visible.' }] });
    expect(await f.call('click', { observationId: window.observationId, x: 10, y: 10 })).toMatchObject({ status: 'issued' });
    const page = await f.call('capture_screen');
    expect(page.keyboardFocus).toMatchObject({ role: 'AXWebArea', editable: false });
    expect(page.keyboardGuidance).toContain('When the request requires text entry and the intended destination is already established');
    expect(page.keyboardGuidance).toContain('resolve the destination before looking for an input');
    expect(await f.call('type_keyboard_text', { keyboardObservationId: page.keyboardObservationId, text: 'Draft' }))
      .toMatchObject({ code: 'unsupported-text-target' });
    expect(f.keyboard.execute).not.toHaveBeenCalled();
    // Scripted navigation models resolving focus; it does not predict model decisions.
    expect(await f.call('press_key', { keyboardObservationId: page.keyboardObservationId, key: 'Tab', modifiers: [] }))
      .toMatchObject({ status: 'issued', inputStopped: false });
    f.state.target = { ...target, fingerprint: 'c'.repeat(64), role: 'AXTextArea', title: 'Message' };
    const composer = await f.call('capture_screen');
    expect(composer.keyboardFocus.editable).toBe(true);
    expect(composer).not.toHaveProperty('keyboardGuidance');
    expect(await f.call('type_keyboard_text', { keyboardObservationId: composer.keyboardObservationId, text: 'Draft' }))
      .toMatchObject({ status: 'issued', effect: 'edit', inputStopped: false });
    expect(f.keyboard.execute.mock.calls.map(([action]) => action)).toEqual([
      { kind: 'press_key', key: 'Tab', modifiers: [] }, { kind: 'type_keyboard_text', text: 'Draft' },
    ]);
  });

  it.each(['AXTextArea', 'AXWebArea', 'AXDocument', 'AXScrollArea'])(
    'omits read-only %s history from screen focus metadata without changing the native target', async (role) => {
      const f = fixture('Open the requested workspace.');
      f.state.target = { ...target, application: 'Workspace', role, title: 'Activity', editable: false,
        value: 'Old session: open an unrelated workspace before starting a different task.', valueTruncated: role === 'AXTextArea' };
      const capture = await f.capture();
      expect(capture.keyboardFocus).toMatchObject({ application: 'Workspace', role, title: 'Activity', editable: false,
        valueOmitted: expect.stringContaining('capture_text') });
      expect(capture.keyboardFocus).not.toHaveProperty('value');
      expect(capture.keyboardFocus).not.toHaveProperty('valueTruncated');
      expect(JSON.stringify(capture)).not.toContain('Old session');
      const action: KeyboardAction = { kind: 'press_key', key: 'Tab', modifiers: [] };
      expect(value(await f.call(capture.keyboardObservationId, action))).toMatchObject({ status: 'issued' });
      expect(f.adapter.execute).toHaveBeenCalledWith(action, f.state.target.fingerprint, expect.any(AbortSignal));
      expect(f.keyboard.conversationActions()[0]?.target.value).toBe(f.state.target.value);
    },
  );

  it.each([
    { role: 'AXTextArea', editable: true, value: 'Draft content\n'.repeat(200), valueTruncated: true },
    { role: 'AXMenuItem', editable: false, value: 'Open recent document', valueTruncated: false },
    { role: 'AXStaticText', editable: false, value: 'Choose a workspace', valueTruncated: false },
    { role: 'AXPopUpButton', editable: false, value: 'Current account', valueTruncated: false },
  ])('preserves editable values and compact control labels: $role', async (focus) => {
    const f = fixture(); f.state.target = { ...target, ...focus };
    const capture = await f.capture();
    expect(capture.keyboardFocus).toMatchObject(focus);
    expect(capture.keyboardFocus).not.toHaveProperty('valueOmitted');
  });

  it.each([
    { value: 'Long read-only document text. '.repeat(100), valueTruncated: false },
    { value: 'An incomplete control value', valueTruncated: true },
  ])('does not present long or incomplete read-only values as compact labels', async (content) => {
    const f = fixture(); f.state.target = { ...target, role: 'AXStaticText', editable: false, ...content };
    const capture = await f.capture();
    expect(capture.keyboardFocus).toHaveProperty('valueOmitted');
    expect(capture.keyboardFocus).not.toHaveProperty('value');
  });

  it.each(['not-issued', 'uncertain'] as const)('returns the native reason for %s keyboard input and preserves its stop boundary', async (status) => {
    const f = fixture();
    f.adapter.execute.mockResolvedValue({ status, reason: 'focus-changed' });
    const capture = await f.capture();
    expect(value(await f.call(capture.keyboardObservationId, { kind: 'type_keyboard_text', text: 'Draft' })))
      .toMatchObject({ status, code: 'focus-changed', inputStopped: status === 'uncertain' });
    expect(f.session.stopped).toBe(status === 'uncertain');
    if (status === 'uncertain') {
      const next = await f.capture();
      expect(next.keyboardObservationId).toBeUndefined();
      expect(value(await f.call(capture.keyboardObservationId, { kind: 'type_keyboard_text', text: 'Draft' })).code).toBe('input-stopped');
      expect(f.adapter.execute).toHaveBeenCalledOnce();
    }
  });

  it('executes a scripted app-and-site navigation using refreshed screen focus, without window coordinates', async () => {
    // This is a deterministic tool integration test, not a claim about model choices.
    const request = 'Open chess on Chrome.';
    const f = fixture(request);
    const steps: Array<{ application: string; title: string; editable: boolean; value: string; action: KeyboardAction }> = [
      { application: 'Terminal', title: 'Shell', editable: false, value: '', action: { kind: 'press_key', key: 'Space', modifiers: ['Cmd'] } },
      { application: 'Spotlight', title: 'Search', editable: true, value: '', action: { kind: 'type_keyboard_text', text: 'Google Chrome' } },
      { application: 'Spotlight', title: 'Search', editable: true, value: 'Google Chrome', action: { kind: 'press_key', key: 'Enter', modifiers: [] } },
      { application: 'Google Chrome', title: 'New Tab', editable: false, value: '', action: { kind: 'press_key', key: 'L', modifiers: ['Cmd'] } },
      { application: 'Google Chrome', title: 'Address and search bar', editable: true, value: '', action: { kind: 'type_keyboard_text', text: 'https://www.chess.com' } },
      { application: 'Google Chrome', title: 'Address and search bar', editable: true, value: 'https://www.chess.com', action: { kind: 'press_key', key: 'Enter', modifiers: [] } },
    ];
    const ids = new Set<string>();
    for (const [index, step] of steps.entries()) {
      const { action, ...focus } = step;
      f.state.target = { ...target, ...focus, fingerprint: String(index + 1).repeat(64) };
      const capture = await f.capture();
      expect(capture.keyboardFocus).toMatchObject(focus);
      expect(capture.keyboardObservationId).toMatch(/^keyboard-/);
      expect(ids.has(capture.keyboardObservationId)).toBe(false);
      ids.add(capture.keyboardObservationId);
      expect(value(await f.call(capture.keyboardObservationId, action))).toMatchObject({
        status: 'issued', effect: action.kind === 'type_keyboard_text' ? 'edit' : 'navigate', inputStopped: false,
      });
      expect(f.adapter.execute.mock.lastCall).toEqual([action, f.state.target.fingerprint, expect.any(AbortSignal)]);
    }
    expect(f.captureFrame).toHaveBeenCalledTimes(steps.length);
    expect(f.adapter.execute).toHaveBeenCalledTimes(steps.length);
    expect(f.authorize).toHaveBeenCalledTimes(4);
    for (const [review] of f.authorize.mock.calls) {
      expect(review.request).toBe(request);
      expect(review.action.kind).toBe('press_key');
      expect(review).not.toHaveProperty('point');
      expect(review.target).not.toHaveProperty('bounds');
      expect(review.frame).toEqual(frame);
    }
    expect(f.keyboard.conversationActions()).toHaveLength(steps.length);
    expect(f.keyboard.conversationActions().map(({ action }) => action)).toEqual(steps.map(({ action }) => action));
  });

  it.each([
    ['deny', []], ['clarify', []], ['deny', ['Cmd']], ['clarify', ['Cmd']],
  ] as const)('does not dispatch fill-only Enter after a %s decision with modifiers %j', async (decision, modifiers) => {
    const f = fixture(undefined, { decision, effect: 'submit', reason: 'Filling excludes submission.' });
    const capture = await f.capture();
    const result = value(await f.call(capture.keyboardObservationId, { kind: 'press_key', key: 'Enter', modifiers: [...modifiers] }));
    expect(result.code).toBe('outside-request');
    expect(f.authorize.mock.lastCall?.[0].request).toBe(f.scope.request);
    expect(f.adapter.execute).not.toHaveBeenCalled();
  });

  it.each(['deny', 'clarify'] as const)('stops keyboard and pointer input after a keyboard %s, including fresh captures', async (decision) => {
    const f = desktopFixture({ decision, effect: 'submit', reason: 'Filling excludes submission.' });
    await f.call('list_windows');
    const capture = await f.call('capture_screen');
    expect((await f.call('press_key', { keyboardObservationId: capture.keyboardObservationId, key: 'Enter', modifiers: [] })).code)
      .toBe('outside-request');
    const screen = await f.call('capture_screen');
    expect(screen.keyboardObservationId).toBeUndefined();
    expect((await f.call('type_keyboard_text', { keyboardObservationId: capture.keyboardObservationId, text: 'Morgan' })).code)
      .toBe('input-stopped');
    const window = await f.call('capture_window', { windowId: 'window-1' });
    expect(window.observationId).toBeUndefined();
    expect((await f.call('move_pointer', { observationId: 'observation-1', x: 10, y: 10 })).code).toBe('input-stopped');
    expect((await f.call('type_text', { observationId: 'observation-1', x: 10, y: 10, text: 'Morgan' })).code).toBe('input-stopped');
    expect(f.authorize).toHaveBeenCalledOnce();
    expect(f.keyboard.execute).not.toHaveBeenCalled();
    expect(f.pointer.inspect).not.toHaveBeenCalled(); expect(f.pointer.execute).not.toHaveBeenCalled();
  });

  it.each(['deny', 'clarify'] as const)('stops keyboard input after a pointer %s, including a fresh capture', async (decision) => {
    const f = desktopFixture({ decision, effect: 'submit', reason: 'Filling excludes submission.' });
    await f.call('list_windows');
    const window = await f.call('capture_window', { windowId: 'window-1' });
    expect((await f.call('click', { observationId: window.observationId, x: 10, y: 10 })).code).toBe('outside-request');
    const capture = await f.call('capture_screen');
    expect(capture.keyboardObservationId).toBeUndefined();
    expect((await f.call('type_keyboard_text', { keyboardObservationId: 'keyboard-1', text: 'Morgan' })).code)
      .toBe('input-stopped');
    expect((await f.call('press_key', { keyboardObservationId: 'keyboard-1', key: 'Tab', modifiers: [] })).code)
      .toBe('input-stopped');
    expect(f.authorize).toHaveBeenCalledOnce();
    expect(f.pointer.execute).not.toHaveBeenCalled(); expect(f.keyboard.execute).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, ['Shift', 'Ctrl']], ['Cmd+Space', ['Cmd']],
  ] as const)('reserves activation shortcut %s before inspecting or checking permission', async (shortcut, modifiers) => {
    const f = fixture('Open chess on Chrome.', {}, true, shortcut);
    const capture = await f.capture(); f.adapter.inspect.mockClear();
    expect(value(await f.call(capture.keyboardObservationId, { kind: 'press_key', key: 'Space', modifiers: [...modifiers] })).code)
      .toBe('reserved-shortcut');
    expect(f.adapter.inspect).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled();
    expect(f.adapter.execute).not.toHaveBeenCalled();
  });

  it('suppresses keyboard feedback after a pointer capture changes the shared observation revision', async () => {
    const f = desktopFixture(); await f.call('list_windows');
    const capture = await f.call('capture_screen');
    const args = { keyboardObservationId: capture.keyboardObservationId, key: 'Tab', modifiers: [] };
    expect(f.host.feedbackTarget!('press_key', args)).toEqual({ application: 'Browser', title: 'Name' });
    await f.call('capture_window', { windowId: 'window-1' });
    expect(f.host.feedbackTarget!('press_key', args)).toBeUndefined();
    expect(f.keyboard.execute).not.toHaveBeenCalled();
  });

  it('suppresses keyboard feedback after expiration or a stopped session', async () => {
    vi.useFakeTimers();
    const f = fixture(); const capture = await f.capture();
    expect(f.keyboard.feedbackTarget(capture.keyboardObservationId)).toEqual({ application: 'Browser', title: 'Name' });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(f.keyboard.feedbackTarget(capture.keyboardObservationId)).toBeUndefined();
    const fresh = await f.capture(); f.session.stopped = true;
    expect(f.keyboard.feedbackTarget(fresh.keyboardObservationId)).toBeUndefined();
  });

  it('stops both keyboard and mouse input after an explicitly authorized submission', async () => {
    const f = fixture('Fill this form and submit it.', { effect: 'submit' });
    const capture = await f.capture();
    expect(value(await f.call(capture.keyboardObservationId, { kind: 'press_key', key: 'Enter', modifiers: ['Cmd'] })))
      .toMatchObject({ status: 'issued', effect: 'submit', inputStopped: true });
    const next = await f.capture();
    expect(next.keyboardObservationId).toBeUndefined();
    expect(value(await f.call(capture.keyboardObservationId, { kind: 'type_keyboard_text', text: 'extra' })).code).toBe('input-stopped');
    const pointer = { inspect: vi.fn(), execute: vi.fn() };
    const inputs = createInputTools(pointer, f.scope, f.session);
    const pointerHost = new ToolRegistry(inputs.definitions);
    cleanups.push(() => { pointerHost.close(); inputs.close(); });
    expect(value(await pointerHost.call('click', { observationId: 'observation-1', x: 10, y: 10 }, signal())).code).toBe('input-stopped');
    expect(pointer.inspect).not.toHaveBeenCalled(); expect(pointer.execute).not.toHaveBeenCalled();
    expect(f.adapter.execute).toHaveBeenCalledOnce();
  });

  it.each<KeyboardAction>([
    { kind: 'press_key', key: 'Tab', modifiers: [] },
    { kind: 'type_keyboard_text', text: 'Morgan' },
    { kind: 'press_key', key: 'L', modifiers: ['Cmd'] },
  ])('consumes the observation after $kind and rejects reuse', async (action) => {
    const f = fixture(); const capture = await f.capture();
    expect(value(await f.call(capture.keyboardObservationId, action)).status).toBe('issued');
    expect(value(await f.call(capture.keyboardObservationId, action)).code).toBe('stale-observation');
    expect(f.adapter.execute).toHaveBeenCalledOnce();
  });

  it('rejects observations invalidated by another input tool or time', async () => {
    vi.useFakeTimers();
    const f = fixture(); const action: KeyboardAction = { kind: 'type_keyboard_text', text: 'Morgan' };
    const beforeOtherInput = await f.capture();
    f.session.revision++;
    expect(value(await f.call(beforeOtherInput.keyboardObservationId, action)).code).toBe('stale-observation');
    const beforeTimeout = await f.capture();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(value(await f.call(beforeTimeout.keyboardObservationId, action)).code).toBe('stale-observation');
    expect(f.adapter.execute).not.toHaveBeenCalled();
  });

  it('does not provide a keyboard handle when focus changes during screen capture', async () => {
    const f = fixture();
    f.captureFrame.mockImplementationOnce(async () => {
      f.state.target.fingerprint = 'b'.repeat(64); return structuredClone(frame);
    });
    const capture = await f.capture();
    expect(capture).not.toHaveProperty('keyboardObservationId');
    expect(capture.keyboardUnavailable).toContain('changed during capture');
    expect(capture.keyboardIssue).toBe('focus-changed');
    expect(value(await f.call('keyboard-1', { kind: 'press_key', key: 'L', modifiers: ['Cmd'] })).code).toBe('stale-observation');
    expect(f.adapter.execute).not.toHaveBeenCalled();
  });

  it('rejects changed focus before the permission call or native dispatch', async () => {
    const f = fixture(); const capture = await f.capture();
    f.state.target.fingerprint = 'b'.repeat(64);
    expect(value(await f.call(capture.keyboardObservationId, { kind: 'press_key', key: 'L', modifiers: ['Cmd'] })).code).toBe('stale-observation');
    expect(f.authorize).not.toHaveBeenCalled(); expect(f.adapter.execute).not.toHaveBeenCalled();
  });

  it('passes the reviewed fingerprint to native execution so a focus change during the guard is not issued', async () => {
    const f = fixture(); const capture = await f.capture();
    f.authorize.mockImplementationOnce(async () => {
      f.state.target.fingerprint = 'b'.repeat(64);
      return { decision: 'allow', effect: 'navigate', requestQuote: f.scope.request, reason: 'Navigation within scope.' };
    });
    expect(value(await f.call(capture.keyboardObservationId, { kind: 'press_key', key: 'L', modifiers: ['Cmd'] })))
      .toMatchObject({ status: 'not-issued', inputStopped: false });
    expect(f.adapter.execute.mock.lastCall?.[1]).toBe(target.fingerprint);
    expect(f.keyboard.conversationActions()[0]?.status).toBe('not-issued');
  });

  it('keeps screen evidence available when keyboard inspection is unavailable', async () => {
    const f = fixture(); f.adapter.inspect.mockRejectedValue(new DesktopError('permission-required'));
    const result = await f.host.call('capture_screen', {}, signal());
    expect(result.desktopIssue).toBe('permission-required');
    expect(result.isError).not.toBe(true);
    const capture = value(result);
    expect(capture).not.toHaveProperty('keyboardObservationId');
    expect(capture.keyboardUnavailable).toContain('Accessibility');
    expect(capture.keyboardIssue).toBe('permission-required');
    expect(capture.image).toMatchObject({ width: frame.image.width, height: frame.image.height });
    expect(f.captureFrame).toHaveBeenCalledOnce();
    expect(f.adapter.execute).not.toHaveBeenCalled();
  });

  it('surfaces a failure after capture without discarding usable pixels or leaking native error text', async () => {
    const f = fixture();
    f.adapter.inspect.mockResolvedValueOnce(structuredClone(target))
      .mockRejectedValueOnce(new DesktopError('accessibility-unavailable'));
    const result = await f.host.call('capture_screen', {}, signal());
    expect(result.desktopIssue).toBe('accessibility-unavailable');
    expect(result.content.some((part) => part.type === 'image')).toBe(true);
    expect(value(result)).not.toHaveProperty('keyboardObservationId');
    expect(value(result).keyboardIssue).toBe('accessibility-unavailable');
    expect(f.adapter.execute).not.toHaveBeenCalled();
  });

  it('does not type into a noneditable focus', async () => {
    const f = fixture(); f.state.target.editable = false;
    const capture = await f.capture();
    expect(value(await f.call(capture.keyboardObservationId, { kind: 'type_keyboard_text', text: 'Morgan' })).code).toBe('unsupported-text-target');
    expect(f.adapter.execute).not.toHaveBeenCalled();
  });

  it.each(['inspection', 'permission'] as const)('cancels during %s without dispatching late results', async (phase) => {
    const f = fixture(); const capture = await f.capture();
    const inspected = deferred<KeyboardEvidence>(), authorized = deferred<PermissionDecision>(), entered = deferred<void>();
    if (phase === 'inspection') f.adapter.inspect.mockImplementationOnce(() => { entered.resolve(); return inspected.promise; });
    else f.authorize.mockImplementationOnce(() => { entered.resolve(); return authorized.promise; });
    const controller = new AbortController();
    const pending = f.call(capture.keyboardObservationId, { kind: 'press_key', key: 'L', modifiers: ['Cmd'] }, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise; controller.abort(); await rejected;
    inspected.resolve(structuredClone(f.state.target));
    authorized.resolve({ decision: 'allow', effect: 'navigate', requestQuote: f.scope.request, reason: 'Late approval.' });
    await Promise.resolve(); await Promise.resolve();
    expect(f.adapter.execute).not.toHaveBeenCalled();
  });

  it('does not inspect or dispatch an already cancelled action', async () => {
    const f = fixture(); const capture = await f.capture(); f.adapter.inspect.mockClear();
    const controller = new AbortController(); controller.abort();
    await expect(f.call(capture.keyboardObservationId, { kind: 'press_key', key: 'Tab', modifiers: [] }, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(f.adapter.inspect).not.toHaveBeenCalled(); expect(f.adapter.execute).not.toHaveBeenCalled();
  });

  it.each(['throw', 'uncertain'] as const)('blocks retries after an uncertain native outcome (%s)', async (mode) => {
    const f = fixture(); const capture = await f.capture();
    if (mode === 'throw') f.adapter.execute.mockRejectedValueOnce(new DesktopError('helper-crashed'));
    else f.adapter.execute.mockResolvedValueOnce({ status: 'uncertain' });
    const result = await f.call(capture.keyboardObservationId, { kind: 'type_keyboard_text', text: 'Morgan' });
    expect(result.isError).toBe(true); expect(f.session.stopped).toBe(true);
    expect(f.keyboard.conversationActions()[0]?.status).toBe('uncertain');
    const next = await f.capture();
    expect(next.keyboardObservationId).toBeUndefined();
    expect(value(await f.call(capture.keyboardObservationId, { kind: 'type_keyboard_text', text: 'Morgan' })).code).toBe('input-stopped');
    expect(f.adapter.execute).toHaveBeenCalledOnce();
  });

  it('requires the original request and a guard for shortcuts, but routine text needs no guard', async () => {
    const empty = fixture(''); const emptyCapture = await empty.capture();
    expect(value(await empty.call(emptyCapture.keyboardObservationId, { kind: 'type_keyboard_text', text: 'Morgan' })).code).toBe('request-required');
    expect(empty.adapter.execute).not.toHaveBeenCalled();
    const noGuard = fixture(undefined, {}, false); const capture = await noGuard.capture();
    expect(value(await noGuard.call(capture.keyboardObservationId, { kind: 'press_key', key: 'Enter', modifiers: [] })).code).toBe('permission-unavailable');
    expect(noGuard.adapter.execute).not.toHaveBeenCalled();
    expect(value(await noGuard.call(capture.keyboardObservationId, { kind: 'type_keyboard_text', text: 'Morgan' })))
      .toMatchObject({ effect: 'edit', permission: { mode: 'actor-request' }, status: 'issued' });
  });

  it.each([
    ['Escape', { kind: 'press_key', key: 'Escape', modifiers: [] }],
    ['Ctrl+C', { kind: 'press_key', key: 'C', modifiers: ['Ctrl'] }],
    ['Cmd+V', { kind: 'press_key', key: 'V', modifiers: ['Cmd'] }],
    ['Ctrl+V', { kind: 'press_key', key: 'V', modifiers: ['Ctrl'] }],
    ['duplicate modifiers', { kind: 'press_key', key: 'L', modifiers: ['Cmd', 'Cmd'] }],
    ['newline', { kind: 'type_keyboard_text', text: 'first\nsecond' }],
    ['tab', { kind: 'type_keyboard_text', text: 'first\tsecond' }],
    ['carriage return', { kind: 'type_keyboard_text', text: 'first\rsecond' }],
    ['NUL', { kind: 'type_keyboard_text', text: 'first\u0000second' }],
    ['line separator', { kind: 'type_keyboard_text', text: 'first\u2028second' }],
    ['oversized UTF-16 text', { kind: 'type_keyboard_text', text: '😀'.repeat(2049) }],
  ] as const)('rejects %s before dispatch', async (_name, action) => {
    const f = fixture(); const capture = await f.capture();
    const { kind, ...args } = action;
    expect(keyboardActionSchema.safeParse(action).success).toBe(false);
    const result = value(await f.host.call(kind, { keyboardObservationId: capture.keyboardObservationId, ...args }, signal()));
    expect(result.code).toBe('invalid-arguments');
    expect(f.adapter.execute).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled();
  });

  it('requires an exact request quote and limits Enter navigation to an unmodified key', () => {
    const request = 'Open chess on Chrome.';
    const allowed: PermissionDecision = { decision: 'allow', effect: 'navigate', requestQuote: request, reason: 'Open the requested site.' };
    expect(permitsKeyboard(request, { kind: 'press_key', key: 'Enter', modifiers: [] }, allowed)).toBe(true);
    expect(permitsKeyboard(request, { kind: 'press_key', key: 'Enter', modifiers: ['Cmd'] }, allowed)).toBe(false);
    expect(permitsKeyboard(request, { kind: 'press_key', key: 'Enter', modifiers: [] }, { ...allowed, effect: 'edit' })).toBe(false);
    expect(permitsKeyboard(request, { kind: 'press_key', key: 'L', modifiers: ['Cmd'] }, { ...allowed, requestQuote: 'Submit' })).toBe(false);
    expect(permitsKeyboard(request, { kind: 'press_key', key: 'L', modifiers: ['Cmd'] }, { ...allowed, requestQuote: '' })).toBe(false);
  });
});
