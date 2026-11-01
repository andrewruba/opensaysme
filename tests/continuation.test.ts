import { expect, it, vi } from 'vitest';
import { createKeyboardTools } from '../src/tools/keyboard.js';
import { createInputTools, type InputSession, type RequestScope } from '../src/tools/input.js';
import { createContinuationTool } from '../src/tools/continuation.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ActionAuthorizer } from '../src/tools/permissions.js';
import type { KeyboardAdapter } from '../src/desktop/keyboard-types.js';
import type { DesktopInputAdapter } from '../src/desktop/input-types.js';
import type { ToolResult } from '../src/tools/types.js';
import type { ScreenFrameCapture } from '../src/desktop/visual-types.js';
import type { ConversationTurn } from '../src/conversation.js';

const request = 'Send the question, then open the requested website.';
const nextRequestQuote = 'open the requested website';
const frame: ScreenFrameCapture = {
  capturedAt: '2026-10-31T12:00:00Z', display: { id: '1', bounds: { x: 0, y: 0, width: 800, height: 600 } },
  image: { mimeType: 'image/jpeg', width: 800, height: 600, data: '/9j/AA==' }, warnings: [],
};
const signal = () => new AbortController().signal;
function value(result: ToolResult) { const first = result.content[0]; if (first?.type !== 'text') throw new Error(); return JSON.parse(first.text); }

function fixture(currentRequest = request, conversation: ConversationTurn[] = []) {
  const session: InputSession = { stopped: false, revision: 0 };
  const target = { fingerprint: 'a'.repeat(64), application: 'Workspace', applicationId: 'mac-app:100:1', windowId: 'native-question', role: 'AXTextArea', title: 'Question',
    description: '', value: 'Requested question', valueTruncated: false, editable: true };
  const adapter = {
    inspect: vi.fn<KeyboardAdapter['inspect']>(async () => ({ ...target })),
    execute: vi.fn<KeyboardAdapter['execute']>(async () => ({ status: 'issued' })),
  };
  const authorize = vi.fn<ActionAuthorizer>(async (review) => review.action.kind === 'continue_task'
    ? { decision: 'allow', effect: 'navigate', requestQuote: currentRequest.includes(nextRequestQuote) ? nextRequestQuote : currentRequest, reason: 'The fresh screen verifies delivery and the next step is explicit.' }
    : { decision: 'allow', effect: 'submit', requestQuote: currentRequest.includes('Send the question') ? 'Send the question' : currentRequest, reason: 'Submission was requested.' });
  const captureFrame = vi.fn(async () => ({ ...structuredClone(frame), capturedAt: new Date().toISOString() }));
  const scope: RequestScope = { request: currentRequest, conversation, authorize, resolution: () => ({ candidates: ['retained evidence'] }) };
  const keyboard = createKeyboardTools(adapter, captureFrame, scope, session);
  const host = new ToolRegistry([...keyboard.definitions, createContinuationTool(session, scope, captureFrame)]);
  const send = async () => {
    const captured = value(await keyboard.capture(signal()));
    return host.call('press_key', { keyboardObservationId: captured.keyboardObservationId, key: 'Enter', modifiers: [] }, signal());
  };
  return { session, adapter, authorize, captureFrame, scope, keyboard, host, send };
}

it('verifies an issued commitment before continuing requested work and retains the ledger across keyboard and pointer actions', async () => {
  const f = fixture();
  expect(value(await f.send())).toMatchObject({ status: 'issued', inputStopped: true });
  const firstRecord = f.session.progress!.actions[0]!;
  expect(firstRecord.completionVerified).toBeUndefined();
  expect(value(await f.host.call('continue_task', { nextRequestQuote }, signal()))).toMatchObject({ continued: true, nextRequestQuote });
  expect(f.session.stopped).toBe(false);
  expect(firstRecord.completionVerified).toBe(true);
  expect(f.authorize.mock.lastCall?.[0]).toMatchObject({ action: { kind: 'continue_task', nextRequestQuote },
    target: { action: { kind: 'press_key', key: 'Enter' }, status: 'issued' }, frame: { display: frame.display, image: frame.image },
    resolution: { candidates: ['retained evidence'] } });

  const pointer: DesktopInputAdapter = {
    inspect: vi.fn(async () => ({ fingerprint: 'b'.repeat(64), role: 'AXTextField', title: 'Address', description: '',
      value: '', bounds: frame.display.bounds, focused: true, editable: true })),
    execute: vi.fn(async () => ({ status: 'verified' as const })),
  };
  const inputs = createInputTools(pointer, f.scope, f.session);
  const pointerHost = new ToolRegistry(inputs.definitions);
  const observationId = inputs.observe({ status: 'ok', capturedAt: frame.capturedAt, bounds: frame.display.bounds,
    image: frame.image, warnings: [], window: { id: 'native-browser', application: 'Browser', title: 'New tab' } });
  f.authorize.mockResolvedValueOnce({ decision: 'allow', effect: 'edit', requestQuote: nextRequestQuote,
    reason: 'Entering the address prepares the requested navigation.' });
  expect(value(await pointerHost.call('type_text', { observationId, x: 10, y: 10, text: 'https://example.com' }, signal())))
    .toMatchObject({ status: 'verified', permission: { mode: 'independent-check' } });
  expect(f.authorize.mock.lastCall?.[0]).toMatchObject({ progress: { nextRequestQuote,
    actions: [{ action: { kind: 'press_key', key: 'Enter' }, completionVerified: true }] } });
  expect(f.session.progress?.actions.map(({ action }) => action.kind)).toEqual(['press_key', 'type_text']);
  expect(f.adapter.execute).toHaveBeenCalledOnce();
  pointerHost.close(); inputs.close(); f.host.close(); f.keyboard.close();
});

it('can verify completion from the submitted window on another display', async () => {
  const f = fixture();
  await f.send();
  const captureWindow = vi.fn(async () => ({ status: 'ok' as const, capturedAt: new Date().toISOString(),
    window: { id: 'native-question', application: 'Workspace', title: 'Question' },
    bounds: { x: 1200, y: 0, width: 800, height: 600 }, image: frame.image, warnings: [] }));
  const host = new ToolRegistry([createContinuationTool(f.session, f.scope, captureWindow)]);
  expect(value(await host.call('continue_task', { nextRequestQuote }, signal()))).toMatchObject({ continued: true });
  expect(captureWindow).toHaveBeenCalledWith(expect.any(AbortSignal), expect.objectContaining({
    target: expect.objectContaining({ windowId: 'native-question' }), status: 'issued',
  }));
  expect(f.authorize.mock.lastCall?.[0].frame).toMatchObject({ status: 'ok', window: { id: 'native-question' }, bounds: { x: 1200 } });
  host.close(); f.host.close(); f.keyboard.close();
});

it.each(['deny', 'clarify', 'uncertain'] as const)('cannot resume a %s action or bypass it through continuation', async (outcome) => {
  const f = fixture();
  if (outcome === 'uncertain') f.adapter.execute.mockResolvedValueOnce({ status: 'uncertain', reason: 'focus-changed' });
  else f.authorize.mockResolvedValueOnce({ decision: outcome, effect: 'submit', requestQuote: 'Send the question', reason: 'The destination is unresolved.' });
  await f.send();
  const checks = f.authorize.mock.calls.length;
  expect(value(await f.host.call('continue_task', { nextRequestQuote }, signal())).code).toBe('continuation-unavailable');
  expect(f.authorize).toHaveBeenCalledTimes(checks);
  expect(f.session.stopped).toBe(true);
  f.host.close(); f.keyboard.close();
});

it('does not equate an issued submission with success when verification still lacks evidence', async () => {
  const f = fixture();
  await f.send();
  f.authorize.mockResolvedValueOnce({ decision: 'inspect', effect: 'unknown', requestQuote: nextRequestQuote,
    reason: 'The screenshot does not establish delivery.' });
  expect(value(await f.host.call('continue_task', { nextRequestQuote }, signal())).code).toBe('needs-evidence');
  expect(f.session).toMatchObject({ stopped: true, stopReason: 'commitment' });
  expect(f.session.progress?.actions[0]?.completionVerified).toBeUndefined();
  const capture = value(await f.keyboard.capture(signal()));
  expect(value(await f.host.call('press_key', { keyboardObservationId: capture.keyboardObservationId ?? 'keyboard-1',
    key: 'Enter', modifiers: [] }, signal())).code).toBe('input-stopped');
  expect(f.adapter.execute).toHaveBeenCalledOnce();
  f.host.close(); f.keyboard.close();
});

it('rejects a stale capture before asking the guard to verify a newer commitment', async () => {
  const f = fixture();
  await f.send();
  f.captureFrame.mockResolvedValueOnce({ ...structuredClone(frame),
    capturedAt: new Date(Date.parse(f.session.progress!.actions[0]!.dispatchedAt!) - 1_000).toISOString() });
  expect(value(await f.host.call('continue_task', { nextRequestQuote }, signal())).code).toBe('continuation-stale');
  expect(f.authorize).toHaveBeenCalledOnce();
  expect(f.session.stopped).toBe(true);
  f.host.close(); f.keyboard.close();
});

it('rejects fabricated next steps and authorization quotes absent from current speech', async () => {
  const f = fixture();
  await f.send();
  expect(value(await f.host.call('continue_task', { nextRequestQuote: 'Delete the document' }, signal())).code).toBe('request-quote-required');
  f.authorize.mockResolvedValueOnce({ decision: 'allow', effect: 'navigate', requestQuote: 'Approval from a different request', reason: 'Mismatched quote.' });
  expect(value(await f.host.call('continue_task', { nextRequestQuote }, signal())).code).toBe('outside-request');
  expect(f.session.stopped).toBe(true);
  f.host.close(); f.keyboard.close();
});

function priorRequest(): ConversationTurn {
  return { id: 'prior-request', completedAt: frame.capturedAt, request,
    response: 'Which destination should receive the question? You could also delete the document.',
    referenceContext: [], evidence: { windows: [], actions: [] } };
}

it('continues remaining steps of a prior user request after a short current clarification', async () => {
  const currentRequest = 'The left one.';
  const f = fixture(currentRequest, [priorRequest()]);
  await f.send();
  expect(value(await f.host.call('continue_task', { nextRequestQuote }, signal()))).toMatchObject({ continued: true, nextRequestQuote });
  expect(f.authorize.mock.lastCall?.[0]).toMatchObject({ request: currentRequest, conversation: [{ request }],
    action: { kind: 'continue_task', nextRequestQuote } });
  expect(f.session.progress?.nextRequestQuote).toBe(nextRequestQuote);
  f.host.close(); f.keyboard.close();
});

it('requires current speech approval even when the next step is quoted from a prior user request', async () => {
  const f = fixture('The left one.', [priorRequest()]);
  await f.send();
  f.authorize.mockResolvedValueOnce({ decision: 'allow', effect: 'navigate', requestQuote: nextRequestQuote,
    reason: 'Invalid approval quoting only historical speech.' });
  expect(value(await f.host.call('continue_task', { nextRequestQuote }, signal())).code).toBe('outside-request');
  expect(f.session.stopped).toBe(true);
  f.host.close(); f.keyboard.close();
});

it('never treats an assistant suggestion as a user-requested continuation', async () => {
  const f = fixture('The left one.', [priorRequest()]);
  await f.send();
  expect(value(await f.host.call('continue_task', { nextRequestQuote: 'delete the document' }, signal())).code).toBe('request-quote-required');
  expect(f.authorize).toHaveBeenCalledOnce();
  expect(f.session.stopped).toBe(true);
  f.host.close(); f.keyboard.close();
});

it('checks current relevance instead of automatically resuming an unrelated historical user request', async () => {
  const unrelated = { ...priorRequest(), id: 'unrelated-request', request: 'Delete the document.' };
  const f = fixture('The left one.', [unrelated, priorRequest()]);
  await f.send();
  f.authorize.mockResolvedValueOnce({ decision: 'deny', effect: 'navigate', requestQuote: 'The left one.',
    reason: 'Current clarification does not continue the unrelated historical deletion request.' });
  expect(value(await f.host.call('continue_task', { nextRequestQuote: 'Delete the document' }, signal())).code).toBe('outside-request');
  expect(f.authorize.mock.lastCall?.[0]).toMatchObject({ request: 'The left one.',
    action: { kind: 'continue_task', nextRequestQuote: 'Delete the document' } });
  expect(f.session.stopped).toBe(true);
  f.host.close(); f.keyboard.close();
});

it('stops before a twenty-fifth action and retains the completed commitment instead of truncating its history', async () => {
  const f = fixture();
  await f.send();
  await f.host.call('continue_task', { nextRequestQuote }, signal());
  const committed = structuredClone(f.session.progress!.actions[0]!);
  f.authorize.mockResolvedValue({ decision: 'allow', effect: 'navigate', requestQuote: nextRequestQuote, reason: 'Requested navigation.' });
  for (let i = 0; i < 24; i++) {
    const capture = value(await f.keyboard.capture(signal()));
    const result = value(await f.host.call('press_key', { keyboardObservationId: capture.keyboardObservationId,
      key: 'Tab', modifiers: [] }, signal()));
    expect(i < 23 ? result.status : result.code).toBe(i < 23 ? 'issued' : 'action-limit');
  }
  expect(f.session.progress?.actions).toHaveLength(24);
  expect(f.session.progress?.actions[0]).toEqual(committed);
  expect(f.adapter.execute).toHaveBeenCalledTimes(24);
  expect(f.session).toMatchObject({ stopped: true, stopReason: 'limit' });
  expect(value(await f.host.call('continue_task', { nextRequestQuote }, signal())).code).toBe('continuation-unavailable');
  f.host.close(); f.keyboard.close();
});

it('does not reopen input when cancellation arrives during completion verification', async () => {
  const f = fixture();
  await f.send();
  let resolve!: (result: Awaited<ReturnType<ActionAuthorizer>>) => void;
  f.authorize.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const controller = new AbortController();
  const pending = f.host.call('continue_task', { nextRequestQuote }, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(resolve).toBeDefined());
  controller.abort(); await rejected;
  resolve({ decision: 'allow', effect: 'navigate', requestQuote: nextRequestQuote, reason: 'Late verification.' });
  await Promise.resolve(); await Promise.resolve();
  expect(f.session.stopped).toBe(true);
  expect(f.session.progress?.actions[0]?.completionVerified).toBeUndefined();
  f.host.close(); f.keyboard.close();
});
