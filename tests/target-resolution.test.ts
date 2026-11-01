import { describe, expect, it, vi } from 'vitest';
import { createDesktopTools } from '../src/tools/desktop.js';
import { TargetResolution } from '../src/tools/target-resolution.js';
import type { DesktopAdapter, RunningApplication, WindowInventory } from '../src/desktop/types.js';
import type { ToolResult } from '../src/tools/types.js';
import type { ActionAuthorizer } from '../src/tools/permissions.js';

const signal = () => new AbortController().signal;
const values = (result: ToolResult) => result.content.flatMap((part) => part.type === 'text' ? [JSON.parse(part.text)] : []);
const value = (result: ToolResult) => values(result)[0];
const evidenceId = (result: ToolResult): string => {
  const id = values(result).find((part) => part.evidenceId)?.evidenceId;
  expect(id).toEqual(expect.any(String));
  return id;
};
const observationId = (result: ToolResult): string => values(result).find((part) => part.observationId)?.observationId;
const source = { id: 'native-source', application: 'Reader', title: 'Atlas specification' };
const unrelated = { id: 'native-unrelated', application: 'Editor', title: 'Other project' };
const destination = { id: 'native-destination', application: 'Workspace', title: 'Atlas discussion' };
const request = 'Send this note to the project conversation, then open the dashboard.';
const bounds = { x: 0, y: 0, width: 800, height: 600 };
const image = { mimeType: 'image/jpeg' as const, width: 800, height: 600, data: '/9j/AA==' };

function fixture(spokenRequest = request) {
  const state = { windows: [source, unrelated], current: source, revision: 0, applicationIdOverride: undefined as string | undefined };
  const applications = (): RunningApplication[] => ['Reader', 'Editor', 'Workspace'].map((application) => {
    const windowIds = state.windows.filter((window) => window.application === application).map(({ id }) => id);
    return { id: `native-app-${application}`, application, hidden: application !== state.current.application,
      frontmost: application === state.current.application, windowStatus: windowIds.length ? 'available' : 'empty', windowIds };
  });
  const inventory = (): WindowInventory => ({ windows: structuredClone(state.windows), applications: applications(), warnings: [] });
  const input = {
    inspect: vi.fn<NonNullable<DesktopAdapter['input']>['inspect']>(async () => ({ fingerprint: 'a'.repeat(64),
      role: 'AXTextArea', title: 'Message', description: '', value: '', bounds, focused: true, editable: true })),
    execute: vi.fn<NonNullable<DesktopAdapter['input']>['execute']>(async () => ({ status: 'verified' })),
  };
  const keyboard = {
    inspect: vi.fn<NonNullable<DesktopAdapter['keyboard']>['inspect']>(async () => ({ fingerprint: 'b'.repeat(64),
      application: state.current.application, applicationId: state.applicationIdOverride ?? `native-app-${state.current.application}`,
      windowId: state.current.id, role: 'AXTextArea', title: 'Message', description: '', value: '', valueTruncated: false, editable: true })),
    execute: vi.fn<NonNullable<DesktopAdapter['keyboard']>['execute']>(async () => ({ status: 'issued' })),
  };
  const adapter = {
    input, keyboard,
    listWindows: vi.fn<DesktopAdapter['listWindows']>(async () => inventory()),
    inspectWindow: vi.fn<NonNullable<DesktopAdapter['inspectWindow']>>(async (id) => ({ status: 'ok',
      capturedAt: new Date(1_800_000_000_000 + state.revision++).toISOString(),
      window: structuredClone(state.windows.find((window) => window.id === id)!),
      nodes: [{ parent: null, role: 'AXTextArea', value: id === destination.id ? 'Atlas project discussion' : 'Unrelated project contents' }], warnings: [] })),
    captureWindow: vi.fn<NonNullable<DesktopAdapter['captureWindow']>>(async (id) => ({ status: 'ok',
      capturedAt: new Date(1_800_000_000_000 + state.revision++).toISOString(),
      window: structuredClone(state.windows.find((window) => window.id === id)!), bounds, image, warnings: [] })),
    inspect: vi.fn<DesktopAdapter['inspect']>(async () => ({ platform: 'test', window: structuredClone(state.current) })),
    focus: vi.fn<DesktopAdapter['focus']>(async (id) => { state.current = state.windows.find((window) => window.id === id)!; }),
    activateApplication: vi.fn<NonNullable<DesktopAdapter['activateApplication']>>(async (id) => {
      if (id === 'native-app-Workspace' && !state.windows.some((window) => window.id === destination.id)) state.windows.push(destination);
      state.current = state.windows.find((window) => `native-app-${window.application}` === id)!;
      return { activated: true, application: applications().find((application) => application.id === id)! };
    }),
    captureContext: vi.fn<DesktopAdapter['captureContext']>(async () => ({ platform: 'test',
      capturedAt: new Date(1_800_000_000_000 + state.revision++).toISOString(), activeWindow: structuredClone(state.current), warnings: [] })),
    captureFrame: vi.fn<DesktopAdapter['captureFrame']>(async () => ({
      capturedAt: new Date(1_800_000_000_000 + state.revision++).toISOString(), display: { id: 'screen', bounds }, image, warnings: [] })),
  };
  const authorize = vi.fn<ActionAuthorizer>(async () => ({ decision: 'allow' as const, effect: 'edit' as const, requestQuote: spokenRequest,
    reason: 'Scripted authorization does not establish destination identity.' }));
  const host = createDesktopTools(adapter, { request: spokenRequest, authorize });
  const call = (name: string, args: Record<string, unknown> = {}) => host.call(name, args, signal());
  const resolve = (targetId: string, evidence: string, status: 'possible' | 'rejected' | 'selected' = 'selected') => call('resolve_target', {
    requestQuote: spokenRequest, source: null, candidates: [{ targetId, status, evidenceIds: [evidence], reason: status === 'rejected'
      ? 'Observed contents belong to a different project.' : 'Observed project conversation matches the requested destination.' }], question: null,
  });
  return { state, adapter, host, input, keyboard, authorize, call, resolve };
}

describe('destination evidence and discovery', () => {
  it('activates a discovered running app with no windows and rediscovers its actual window', async () => {
    const f = fixture();
    const listed = value(await f.call('list_windows'));
    const app = listed.applications.find((candidate: { application: string }) => candidate.application === 'Workspace');
    expect(app).toMatchObject({ applicationId: expect.any(String), windowIds: [] });
    expect(JSON.stringify(listed)).not.toContain('native-app-');
    const activated = await f.call('activate_application', { applicationId: app.applicationId });
    expect(activated.isError).not.toBe(true);
    expect(f.adapter.activateApplication).toHaveBeenCalledExactlyOnceWith('native-app-Workspace', expect.any(AbortSignal));
    const refreshed = value(await f.call('list_windows'));
    expect(refreshed.windows).toContainEqual(expect.objectContaining({ application: 'Workspace', title: 'Atlas discussion' }));
    expect(f.input.execute).not.toHaveBeenCalled();
    f.host.close();
  });

  it('rejects a discovered application that restarted before activation', async () => {
    const f = fixture();
    const listed = value(await f.call('list_windows'));
    const app = listed.applications.find((candidate: { application: string }) => candidate.application === 'Workspace');
    const refreshed = await f.adapter.listWindows(signal());
    refreshed.applications.find((candidate) => candidate.application === 'Workspace')!.id = 'native-restarted-workspace';
    f.adapter.listWindows.mockResolvedValueOnce(refreshed);
    expect(value(await f.call('activate_application', { applicationId: app.applicationId })).code).toBe('stale-application');
    expect(f.adapter.activateApplication).not.toHaveBeenCalled();
    f.host.close();
  });

  it('continues a different requested step only after checking the issued submission', async () => {
    const f = fixture();
    const dashboard = { id: 'native-dashboard', application: 'Browser', title: 'Dashboard' };
    f.state.windows.push(destination, dashboard); f.state.current = destination;
    const listed = value(await f.call('list_windows'));
    const selected = listed.windows.find((window: { title: string }) => window.title === destination.title);
    const remaining = listed.windows.find((window: { title: string }) => window.title === dashboard.title);
    const captured = await f.call('capture_window', { windowId: selected.windowId });
    expect((await f.resolve(selected.windowId, evidenceId(captured))).isError).not.toBe(true);
    f.authorize.mockImplementation(async (review) => ({ decision: 'allow',
      effect: review.action.kind === 'continue_task' ? 'navigate' : 'submit',
      requestQuote: review.action.kind === 'continue_task' ? review.action.nextRequestQuote : request,
      reason: 'Scripted completion and remaining-task verification.' }));
    const submitted = await f.call('click', { observationId: observationId(captured), x: 100, y: 100 });
    expect(value(submitted)).toMatchObject({ status: 'verified', effect: 'submit', inputStopped: true });
    expect(value(await f.call('focus_window', { windowId: remaining.windowId })).code).toBe('input-stopped');
    const continued = await f.call('continue_task', { nextRequestQuote: 'open the dashboard' });
    expect(value(continued).continued).toBe(true);
    expect(f.authorize.mock.calls.at(-1)![0]).toMatchObject({ action: { kind: 'continue_task', nextRequestQuote: 'open the dashboard' },
      progress: { actions: [{ effect: 'submit', status: 'verified' }] } });
    expect(value(await f.call('focus_window', { windowId: remaining.windowId })).focused).toBe(true);
    expect(f.adapter.focus).toHaveBeenCalledExactlyOnceWith(dashboard.id, expect.any(AbortSignal));
    expect(f.input.execute).toHaveBeenCalledOnce();
    f.host.close();
  });

  it('does not turn exploration focus into a destination for content changes', async () => {
    const f = fixture(); await f.call('list_windows');
    const focused = await f.call('focus_window', { windowId: 'window-2' });
    expect(value(focused).focused).toBe(true);
    const attempted = await f.call('type_text', { observationId: observationId(focused), x: 100, y: 100, text: 'The source project note' });
    expect(attempted.isError).toBe(true);
    expect(f.input.execute).not.toHaveBeenCalled();
    f.host.close();
  });

  it('retains a contradictory candidate and requires new evidence before selecting it', async () => {
    const f = fixture(); await f.call('list_windows');
    const inspected = await f.call('inspect_window', { windowId: 'window-2' });
    const evidence = evidenceId(inspected);
    expect((await f.resolve('window-2', evidence, 'rejected')).isError).not.toBe(true);
    const promoted = await f.resolve('window-2', evidence);
    expect(promoted.isError).toBe(true);
    expect(f.input.execute).not.toHaveBeenCalled();
    f.host.close();
  });

  it('does not accept failed capture evidence or invented evidence as support for a destination', async () => {
    const f = fixture(); await f.call('list_windows');
    f.adapter.captureWindow.mockResolvedValueOnce({ status: 'unavailable', reason: 'inaccessible' });
    const failed = await f.call('capture_window', { windowId: 'window-2' });
    expect(failed.isError).toBe(true);
    const failureId = values(failed).find((part) => part.evidenceId)?.evidenceId;
    if (failureId) expect((await f.resolve('window-2', failureId)).isError).toBe(true);
    expect((await f.resolve('window-2', 'evidence-9999')).isError).toBe(true);
    expect(f.input.execute).not.toHaveBeenCalled();
    f.host.close();
  });

  it('rejects evidence from another window even when the actor supplies a matching rationale', async () => {
    const f = fixture(); await f.call('list_windows');
    const sourceEvidence = evidenceId(await f.call('inspect_window', { windowId: 'window-1' }));
    expect((await f.resolve('window-2', sourceEvidence)).isError).toBe(true);
    f.host.close();
  });

  it('does not treat an application name as process identity for content input', async () => {
    const f = fixture(); f.state.windows.push(destination); f.state.current = destination;
    const listed = value(await f.call('list_windows'));
    const application = listed.applications.find((app: { application: string }) => app.application === destination.application);
    const screen = await f.call('capture_screen');
    expect((await f.resolve(application.applicationId, evidenceId(screen))).isError).not.toBe(true);
    f.state.applicationIdOverride = 'native-different-workspace-process';
    const changed = value(await f.call('capture_screen'));
    const typed = await f.call('type_keyboard_text', { keyboardObservationId: changed.keyboardObservationId, text: 'Requested note' });
    expect(typed.isError).toBe(true);
    expect(f.keyboard.execute).not.toHaveBeenCalled();
    f.host.close();
  });

  it('can resolve a current system input without a listed window before typing a search', async () => {
    const f = fixture('Find the requested application.'); f.state.windows = [];
    f.adapter.inspect.mockResolvedValue({ platform: 'test', window: null });
    f.keyboard.inspect.mockResolvedValue({ fingerprint: 'c'.repeat(64), application: 'Search', applicationId: 'native-search',
      role: 'AXTextField', title: 'Search', description: '', value: '', valueTruncated: false, editable: true });
    f.authorize.mockResolvedValue({ decision: 'allow', effect: 'edit', requestQuote: 'Find the requested application.',
      reason: 'The current system search input is used to locate the requested application.' });
    const captured = await f.call('capture_screen');
    const screen = value(captured);
    expect(screen.keyboardFocus.applicationId).toEqual(expect.stringMatching(/^application-/));
    expect((await f.resolve(screen.keyboardFocus.applicationId, evidenceId(captured))).isError).not.toBe(true);
    const typed = await f.call('type_keyboard_text', { keyboardObservationId: screen.keyboardObservationId, text: 'Workspace' });
    expect(value(typed).status).toBe('issued');
    expect(f.keyboard.execute).toHaveBeenCalledExactlyOnceWith({ kind: 'type_keyboard_text', text: 'Workspace' },
      'c'.repeat(64), expect.any(AbortSignal));
    f.host.close();
  });

  it('checks the actual keyboard window when two windows share the same application', async () => {
    const f = fixture();
    const other = { ...destination, id: 'native-other-chat', title: 'Other discussion' };
    f.state.windows.push(destination, other);
    const listed = value(await f.call('list_windows'));
    const target = listed.windows.find((window: { title: string }) => window.title === destination.title);
    const inspected = await f.call('inspect_window', { windowId: target.windowId });
    expect((await f.resolve(target.windowId, evidenceId(inspected))).isError).not.toBe(true);
    f.state.current = other;
    const screen = value(await f.call('capture_screen'));
    const typed = await f.call('type_keyboard_text', { keyboardObservationId: screen.keyboardObservationId, text: 'Requested note' });
    expect(typed.isError).toBe(true);
    expect(f.keyboard.execute).not.toHaveBeenCalled();
    f.host.close();
  });
});


describe('bounded resolution state', () => {
  function state() {
    let now = 0;
    const targets = new Map([
      ['window-1', { id: source.id, application: source.application, title: source.title, kind: 'window' as const }],
      ['window-2', { id: destination.id, application: destination.application, title: destination.title, kind: 'window' as const }],
    ]);
    const resolution = new TargetResolution(request, (id) => targets.get(id), () => now);
    const observe = (targetId: string, available = true, content = true) => resolution.observe('inspect_window', [targetId],
      { text: targetId === 'window-1' ? 'Project specification' : 'Project conversation' }, available, content);
    const update = (targetId: string, evidenceIds: string[], options: { requestQuote?: string; question?: string | null } = {}) =>
      resolution.definition().run({ requestQuote: options.requestQuote ?? request, source: null,
        candidates: [{ targetId, status: 'selected', evidenceIds, reason: 'Matching project conversation.' }], question: options.question ?? null }, signal());
    return { resolution, targets, observe, update, advance: (milliseconds: number) => { now += milliseconds; } };
  }

  it('requires current content evidence and revalidates it before each edit', async () => {
    const f = state();
    expect((await f.update('window-2', [f.observe('window-2', true, false)])).isError).toBe(true);
    const content = f.observe('window-2');
    expect((await f.update('window-2', [content])).isError).not.toBe(true);
    expect(f.resolution.check({ application: destination.application, windowId: destination.id })).toBeUndefined();
    f.advance(30_001);
    expect(f.resolution.check({ application: destination.application, windowId: destination.id })).toEqual(expect.any(String));
    expect((await f.update('window-2', [content])).isError).toBe(true);
    const fresh = f.observe('window-2');
    expect((await f.update('window-2', [fresh])).isError).not.toBe(true);
    f.targets.delete('window-2');
    expect(f.resolution.check({ application: destination.application, windowId: destination.id })).toEqual(expect.any(String));
  });

  it('keeps an unanswered question blocking input and retains only descriptive follow-up context', async () => {
    const f = state(); const evidence = f.observe('window-2');
    await f.update('window-2', [evidence], { question: 'Which conversation should receive the note?' });
    expect(f.resolution.check({ application: destination.application, windowId: destination.id })).toEqual(expect.any(String));
    const history = f.resolution.history();
    expect(history).toMatchObject({ requestQuote: request, question: 'Which conversation should receive the note?',
      candidates: [{ application: 'Workspace', title: 'Atlas discussion' }] });
    expect(JSON.stringify(history)).not.toMatch(/evidence-|window-2|native-destination|fingerprint/);
    await f.update('window-2', [evidence]);
    expect(f.resolution.check({ application: destination.application, windowId: destination.id })).toBeUndefined();
    f.resolution.close();
    expect(f.resolution.history()).toBeUndefined();
    expect(f.resolution.check({ application: destination.application, windowId: destination.id })).toEqual(expect.any(String));
  });

  it('does not accept captured content or a plan as a replacement user request', async () => {
    const f = state(); const evidence = f.observe('window-2');
    const result = await f.update('window-2', [evidence], { requestQuote: 'Delete every other conversation.' });
    expect(value(result).code).toBe('invalid-request-quote');
    expect(f.resolution.check({ application: destination.application, windowId: destination.id })).toEqual(expect.any(String));
  });
});
