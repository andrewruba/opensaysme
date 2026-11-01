import type { DesktopInput } from '../desktop/input-types.js';
import type { KeyboardAction } from '../desktop/keyboard-types.js';
import type { ExecutionRecord, PermissionDecision, RequestProgress } from './permissions.js';

/** One ledger for both input paths. A fresh observation never clears a stop. */
export interface InputSession {
  stopped: boolean;
  revision: number;
  stopReason?: 'denied' | 'uncertain' | 'commitment' | 'limit';
  progress?: RequestProgress;
}

export const requestProgress = (session: InputSession): RequestProgress => session.progress ??= { actions: [] };
export const completedActions = (session: InputSession) => requestProgress(session).actions
  .map(({ action, effect, status }) => ({ action: action.kind, effect, status }));
export const requiresReview = (session: InputSession) => Boolean(requestProgress(session).evidenceNeeded
  || requestProgress(session).nextRequestQuote);

export function rejectAction(session: InputSession, request: string, decision: PermissionDecision,
  action: DesktopInput | KeyboardAction, target: unknown): 'needs-evidence' | 'outside-request' {
  if (decision.decision === 'inspect' && decision.requestQuote.trim() && request.includes(decision.requestQuote)) {
    requestProgress(session).evidenceNeeded = structuredClone({ action, reason: decision.reason, target });
    return 'needs-evidence';
  }
  session.stopped = true;
  session.stopReason = 'denied';
  return 'outside-request';
}

export function beginAction(session: InputSession, record: ExecutionRecord): ExecutionRecord | undefined {
  const progress = requestProgress(session);
  record.dispatchedAt = new Date().toISOString();
  // Keep every commitment. Stop before execution rather than dropping history
  // needed to distinguish unfinished work from a duplicate action.
  if (progress.actions.length >= 24 || Buffer.byteLength(JSON.stringify({ ...progress, actions: [...progress.actions, record] })) > 512 * 1024) {
    session.stopped = true;
    session.stopReason = 'limit';
    return undefined;
  }
  session.stopped = true;
  session.stopReason = 'uncertain';
  delete progress.evidenceNeeded;
  progress.actions.push(record);
  return record;
}

export function finishAction(session: InputSession, record: ExecutionRecord, status: ExecutionRecord['status']): void {
  record.status = status;
  session.stopReason = status === 'uncertain' ? 'uncertain'
    : status !== 'not-issued' && record.effect === 'submit' ? 'commitment' : undefined;
  session.stopped = session.stopReason !== undefined;
}

export function closeInputSession(session: InputSession): void {
  session.stopped = true;
  session.revision++;
  delete session.stopReason;
  delete session.progress;
}
