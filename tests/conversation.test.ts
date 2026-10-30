import { afterEach, expect, it, vi } from 'vitest';
import { conversationLifetimeMs, conversationSchema, RecentConversation, type ConversationTurn } from '../src/conversation.js';

const memories: RecentConversation[] = [];
afterEach(() => { memories.splice(0).forEach((memory) => memory.clear()); vi.useRealTimers(); });
function memory() { const result = new RecentConversation(() => Date.now()); memories.push(result); return result; }
function turn(id = 'one'): ConversationTurn {
  return { id, completedAt: new Date().toISOString(), request: 'Fill this form; leave it unsubmitted.',
    response: 'Filled the form.', referenceContext: [], evidence: { windows: [], actions: [] } };
}

it('retains complete user constraints and independent snapshots for at most three turns', () => {
  const recent = memory();
  for (const id of ['one', 'two', 'three', 'four']) expect(recent.remember(turn(id))).toBe(true);
  expect(recent.recent().map(({ id }) => id)).toEqual(['two', 'three', 'four']);
  const snapshot = recent.recent();
  snapshot[0]!.request = 'Submit everything';
  snapshot.pop();
  expect(recent.recent()).toHaveLength(3);
  expect(recent.recent()[0]!.request).toBe('Fill this form; leave it unsubmitted.');
});

it('expires each turn after two minutes, including while idle, without extending older entries', async () => {
  vi.useFakeTimers(); const recent = memory();
  recent.remember(turn('first'));
  await vi.advanceTimersByTimeAsync(60_000);
  recent.remember(turn('second'));
  await vi.advanceTimersByTimeAsync(conversationLifetimeMs - 60_000);
  expect(recent.recent().map(({ id }) => id)).toEqual(['second']);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(recent.recent()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds encoded bytes without truncating a request or keeping the wrong older target', () => {
  const recent = memory();
  const large = { ...turn(), request: 'a'.repeat(40_000) + '; do not submit.' };
  recent.remember(large); recent.remember({ ...large, id: 'new' });
  expect(recent.recent()).toEqual([{ ...large, id: 'new' }]);
  expect(recent.remember({ ...turn(), request: '界'.repeat(25_000) })).toBe(false);
  expect(recent.recent()).toEqual([]);
});

it('rejects images, approval tokens and old action handles instead of retaining arbitrary tool output', () => {
  for (const extra of [{ image: { data: 'private pixels' } }, { observationId: 'observation-1' }, { permission: 'allow' }]) {
    expect(conversationSchema.safeParse([{ ...turn(), evidence: { windows: [], actions: [], ...extra } }]).success).toBe(false);
  }
  const recent = memory(); recent.remember(turn());
  expect(recent.remember({ ...turn(), evidence: { windows: [], actions: [], image: 'unexpected' } } as ConversationTurn)).toBe(false);
  expect(recent.recent()).toEqual([]);
});

it('releases retained data and timers on explicit clear', () => {
  vi.useFakeTimers(); const recent = memory(); recent.remember(turn());
  recent.clear();
  expect(recent.recent()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
