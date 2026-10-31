import { afterEach, expect, it, vi } from 'vitest';
import { createFeedback } from '../src/feedback.js';
import type { VoiceOutput } from '../src/runtime.js';
import { desktopMessages } from '../src/desktop/errors.js';

afterEach(() => vi.useRealTimers());
function fixture(activationHotkey?: string) {
  vi.useFakeTimers();
  const sink = { send: vi.fn(), close: vi.fn(async () => {}) };
  const feedback = createFeedback(sink, activationHotkey);
  const state = (state: 'starting' | 'listening' | 'processing' | 'inspecting' | 'acting' | 'interpreting', turnId = 'one') => feedback.handle({ type: 'state', state, turnId });
  const response = (text: string, turnId = 'one', toolResults?: Extract<VoiceOutput, { type: 'result' }>['toolResults']) =>
    feedback.handle({ type: 'result', turnId, response: text, toolResults } as VoiceOutput);
  return { sink, feedback, state, response, last: () => sink.send.mock.lastCall?.[0] };
}

it('shows the configured activation shortcut for recording and follow-ups while keeping Escape', async () => {
  const f = fixture('Cmd+Space'); f.state('starting'); f.state('listening');
  expect(f.last().detail).toBe('Cmd+Space to finish · Escape to cancel');
  f.response('Ready.');
  expect(f.last().detail).toBe('Cmd+Space to reply');
  await f.feedback.close();
});

it('shows status and actual target, then keeps the answer visible when the runtime returns to ready', async () => {
  const f = fixture(); f.state('starting'); f.state('listening');
  expect(f.last()).toMatchObject({ type: 'show', title: 'Listening…', persistent: false });
  f.state('acting');
  f.feedback.handle({ type: 'activity', turnId: 'one', name: 'type_text', target: { application: 'Editor', title: 'Agent — project A' } });
  expect(f.last()).toMatchObject({ title: 'Preparing input…', message: 'Editor — Agent — project A' });
  f.state('interpreting'); expect(f.last().message).toBe('');
  f.response('Which project should receive this error?');
  f.feedback.handle({ type: 'state', state: 'ready' });
  expect(f.last()).toMatchObject({ message: 'Which project should receive this error?', detail: expect.stringContaining('to reply'), persistent: true });
  const calls = f.sink.send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(f.sink.send).toHaveBeenCalledTimes(calls);
  expect(vi.getTimerCount()).toBe(0);
  await f.feedback.close();
});

it('preserves a long multiline answer and keeps it visible until dismissed', async () => {
  const f = fixture('Cmd+Shift+Space'); f.state('starting');
  const answer = `Here is the explanation:\n\n${'A detailed line with a Unicode example 🌱.\n'.repeat(300)}\nNext steps:\n1. Review the result.\n2. Ask a follow-up.`;
  f.response(answer);
  expect(f.last()).toMatchObject({ type: 'show', title: 'Response', message: answer, detail: 'Cmd+Shift+Space to reply', persistent: true });
  f.feedback.handle({ type: 'dismiss-feedback' });
  expect(f.last()).toEqual({ type: 'hide' });
  f.response('Late result');
  f.feedback.handle({ type: 'state', state: 'ready' });
  await vi.runAllTimersAsync();
  expect(f.last()).toEqual({ type: 'hide' });
  await f.feedback.close();
});

it('never replaces a missing target with a previous target or response', async () => {
  const f = fixture(); f.state('starting');
  f.feedback.handle({ type: 'activity', turnId: 'one', name: 'click', target: { application: 'Browser', title: 'Form' } });
  f.feedback.handle({ type: 'activity', turnId: 'one', name: 'click' });
  expect(f.last().message).toBe('Resolving target…');
  await f.feedback.close();
});

it('hides on cancellation, ignores late results and stale-turn events, and clears a persistent response on follow-up', async () => {
  const f = fixture(); f.state('starting'); f.response('Prepared.');
  await vi.advanceTimersByTimeAsync(59_000);
  f.state('starting', 'two'); f.state('listening', 'two');
  expect(f.sink.send.mock.calls.slice(-3).map(([command]) => command.type)).toEqual(['hide', 'show', 'show']);
  f.response('Old response', 'one'); f.state('acting', 'one');
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.last()).toMatchObject({ title: 'Listening…' });
  f.feedback.handle({ type: 'cancelled', turnId: 'two' });
  f.response('Late response', 'two');
  expect(f.last()).toEqual({ type: 'hide' });
  await f.feedback.close();
});

it('keeps a failure visible across cancellation cleanup, and idle Escape dismisses it', async () => {
  const f = fixture(); f.state('starting');
  f.feedback.handle({ type: 'state', state: 'cancelling', turnId: 'one' });
  f.feedback.handle({ type: 'error', turnId: 'one', message: 'The microphone is unavailable.' });
  f.feedback.handle({ type: 'state', state: 'ready' });
  expect(f.last()).toMatchObject({ message: 'The microphone is unavailable.', persistent: false });
  f.feedback.handle({ type: 'dismiss-feedback' });
  expect(f.last()).toEqual({ type: 'hide' });
  await f.feedback.close();
});

it.each(['warning', 'error'] as const)('still expires transient %s feedback', async (type) => {
  const f = fixture(); f.state('starting');
  f.feedback.handle({ type, turnId: 'one', message: 'Desktop access is unavailable.' });
  expect(f.last()).toMatchObject({ message: 'Desktop access is unavailable.', persistent: false });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.last()).toEqual({ type: 'hide' });
  await f.feedback.close();
});

it('shows actionable warnings once, without carrying old diagnostics into progress or the answer', async () => {
  const f = fixture(); f.state('starting');
  f.feedback.handle({ type: 'warning', turnId: 'one', desktopIssue: 'helper-crashed', message: desktopMessages['helper-crashed'] });
  expect(f.last()).toMatchObject({ title: 'Needs attention', message: desktopMessages['helper-crashed'], expression: 'concerned' });
  f.state('interpreting');
  expect(f.last()).toMatchObject({ title: 'Thinking…', detail: 'Escape to cancel', expression: 'thinking' });
  f.response('I could not inspect that window.');
  expect(f.last()).toMatchObject({ title: 'Response', persistent: true, detail: 'Ctrl+Shift+Space to reply' });
  const calls = f.sink.send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.sink.send).toHaveBeenCalledTimes(calls);
  f.state('starting', 'two'); f.response('Ready.', 'two');
  expect(f.last().detail).not.toContain('crashed'); await f.feedback.close();
});

it.each(['focus-changed', 'window-capture-unavailable', 'window-capture-stale'] as const)('keeps recoverable %s diagnostics out of the overlay', async (desktopIssue) => {
  const f = fixture(); f.state('starting'); f.state('interpreting');
  const calls = f.sink.send.mock.calls.length;
  f.feedback.handle({ type: 'warning', turnId: 'one', desktopIssue, message: desktopMessages[desktopIssue] });
  expect(f.sink.send).toHaveBeenCalledTimes(calls);
  f.state('acting'); f.state('interpreting'); f.response('The requested window is now focused.');
  expect(f.last()).toMatchObject({ title: 'Response', expression: 'happy',
    message: 'The requested window is now focused.', detail: 'Ctrl+Shift+Space to reply' });
  expect(JSON.stringify(f.sink.send.mock.calls)).not.toContain('Earlier');
  await f.feedback.close();
});

it('uses actual runtime phases for expressions and keeps old-turn events from changing the face', async () => {
  const f = fixture(); f.state('starting');
  expect(f.last().expression).toBe('neutral');
  for (const [state, expression] of [['listening', 'listening'], ['processing', 'thinking'], ['interpreting', 'thinking'],
    ['inspecting', 'focused'], ['acting', 'focused']] as const) {
    f.state(state); expect(f.last().expression).toBe(expression);
  }
  f.feedback.handle({ type: 'activity', turnId: 'one', name: 'activate_application', target: { application: 'Workspace' } });
  expect(f.last()).toMatchObject({ title: 'Switching app…', expression: 'focused' });
  f.state('starting', 'two'); f.state('listening', 'two');
  f.feedback.handle({ type: 'warning', turnId: 'one', desktopIssue: 'permission-required', message: 'Old warning' });
  expect(f.last().expression).toBe('listening');
  f.feedback.handle({ type: 'error', turnId: 'two', message: 'Microphone unavailable.' });
  expect(f.last()).toMatchObject({ expression: 'concerned', title: 'Couldn’t complete the request' });
  await f.feedback.close();
});

it.each(['uncertain', 'failed', 'not-issued'] as const)('does not celebrate %s input merely because a later read succeeded', async (outcome) => {
  const f = fixture(); f.state('starting');
  f.response('Here is what happened.', 'one', [
    { name: 'click', effect: 'input', outcome }, { name: 'capture_screen', effect: 'read', outcome: 'ok' },
  ]);
  expect(f.last()).toMatchObject({ title: 'Response', expression: 'concerned' });
  await f.feedback.close();
});

it('allows the finishing smile after a rejected input was retried successfully', async () => {
  const f = fixture(); f.state('starting');
  f.response('Finished.', 'one', [
    { name: 'click', effect: 'input', outcome: 'not-issued' },
    { name: 'click', effect: 'input', outcome: 'issued' },
    { name: 'capture_screen', effect: 'read', outcome: 'ok' },
  ]);
  expect(f.last()).toMatchObject({ expression: 'happy', persistent: true });
  await f.feedback.close();
});

it('bounds Unicode display text, ignores diagnostic/transcript payloads, and makes shutdown idempotent', async () => {
  const f = fixture(); f.state('starting');
  f.feedback.handle({ type: 'partial', turnId: 'one', text: 'private transcript' });
  f.feedback.handle({ type: 'debug', directory: '/private/path' });
  expect(JSON.stringify(f.sink.send.mock.calls)).not.toMatch(/private transcript|private\/path/);
  f.feedback.handle({ type: 'activity', turnId: 'one', name: 'click', target: { application: 'Editor', title: 'Cut \ud83c' } });
  expect(f.last().message).toBe('Editor — Cut �');
  f.response('🌱'.repeat(20_000));
  expect(f.last().message.length).toBeLessThanOrEqual(32_768);
  expect(f.last().message).toBe(`${'🌱'.repeat(16_383)}…`);
  expect(f.last().message.isWellFormed()).toBe(true);
  await Promise.all([f.feedback.close(), f.feedback.close()]);
  const calls = f.sink.send.mock.calls.length;
  f.state('starting', 'two'); await vi.runAllTimersAsync();
  expect(f.sink.send).toHaveBeenCalledTimes(calls);
  expect(f.sink.close).toHaveBeenCalledOnce();
});
