import { afterEach, expect, it, vi } from 'vitest';
import { createFeedback } from '../src/feedback.js';
import type { VoiceOutput } from '../src/runtime.js';
import { desktopMessages } from '../src/desktop/errors.js';

afterEach(() => vi.useRealTimers());
function fixture(activationHotkey?: string) {
  vi.useFakeTimers();
  const sink = { send: vi.fn(), close: vi.fn(async () => {}) };
  const feedback = createFeedback(sink, activationHotkey);
  const state = (state: 'starting' | 'listening' | 'acting' | 'interpreting', turnId = 'one') => feedback.handle({ type: 'state', state, turnId });
  const response = (text: string, turnId = 'one') => feedback.handle({ type: 'result', turnId, response: text } as VoiceOutput);
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

it('keeps local recovery evidence visible after actor output and clears it for a fresh turn', async () => {
  const f = fixture(); f.state('starting');
  f.feedback.handle({ type: 'warning', turnId: 'one', desktopIssue: 'helper-crashed', message: desktopMessages['helper-crashed'] });
  f.state('interpreting');
  expect(f.last().detail).toBe(`Earlier warning: ${desktopMessages['helper-crashed']}`);
  f.response('I could not inspect that window.');
  expect(f.last()).toMatchObject({ title: 'Response · Earlier desktop warning', persistent: true,
    detail: `Ctrl+Shift+Space to reply · Earlier warning: ${desktopMessages['helper-crashed']}` });
  const calls = f.sink.send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.sink.send).toHaveBeenCalledTimes(calls);
  f.state('starting', 'two'); f.response('Ready.', 'two');
  expect(f.last().detail).not.toContain('crashed'); await f.feedback.close();
});

it('does not present an earlier transient failure as proof of current access failure', async () => {
  const f = fixture(); f.state('starting');
  f.feedback.handle({ type: 'warning', turnId: 'one', desktopIssue: 'focus-changed', message: desktopMessages['focus-changed'] });
  f.state('acting'); f.state('interpreting'); f.response('The requested window is now focused.');
  expect(f.last()).toMatchObject({ title: 'Response · Earlier desktop warning',
    message: 'The requested window is now focused.', detail: expect.stringContaining('Earlier warning:') });
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
