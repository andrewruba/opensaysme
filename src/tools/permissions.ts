import { z } from 'zod';
import type { DesktopInput, InputEvidence } from '../desktop/input-types.js';
import type { WindowFrameCapture } from '../desktop/types.js';
import type { KeyboardAction, KeyboardEvidence } from '../desktop/keyboard-types.js';
import type { ScreenFrameCapture } from '../desktop/visual-types.js';
import type { AttentionHistory } from '../attention.js';
import type { ConversationTurn } from '../conversation.js';

export const permissionDecisionSchema = z.object({
  decision: z.enum(['allow', 'deny', 'clarify', 'inspect']),
  effect: z.enum(['point', 'navigate', 'edit', 'submit', 'unknown']),
  requestQuote: z.string().max(4096),
  reason: z.string().min(1).max(1024),
}).strict();
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;
export interface ExecutionRecord {
  action: DesktopInput | KeyboardAction;
  effect: PermissionDecision['effect'];
  status: 'issued' | 'verified' | 'not-issued' | 'uncertain';
  capturedAt: string;
  dispatchedAt?: string;
  target: unknown;
  requestQuote?: string;
  completionVerified?: boolean;
}
export interface RequestProgress {
  actions: ExecutionRecord[];
  evidenceNeeded?: { action: DesktopInput | KeyboardAction; reason: string; target: unknown };
  nextRequestQuote?: string;
}
interface ReviewContext {
  request: string;
  referenceContext: AttentionHistory['contexts'];
  conversation?: ConversationTurn[];
  resolution?: unknown;
  progress?: RequestProgress;
  completed: Array<{ action: string; effect: PermissionDecision['effect']; status: string }>;
}
export interface ActionReview extends ReviewContext {
  action: DesktopInput;
  target: InputEvidence;
  frame: Extract<WindowFrameCapture, { status: 'ok' }>;
  point: { x: number; y: number };
}
export interface KeyboardReview extends ReviewContext {
  action: KeyboardAction;
  target: KeyboardEvidence;
  frame: ScreenFrameCapture;
}
export interface ContinuationReview extends ReviewContext {
  action: { kind: 'continue_task'; nextRequestQuote: string };
  target: ExecutionRecord;
  frame: ScreenFrameCapture | Extract<WindowFrameCapture, { status: 'ok' }>;
}
export type ActionAuthorizer = (review: ActionReview | KeyboardReview | ContinuationReview, signal: AbortSignal) => Promise<PermissionDecision>;

/** Routine operations follow the actor's interpretation of the spoken request.
 * Clicks can commit regardless of their labels. */
export function routineEffect(action: DesktopInput): 'point' | 'navigate' | 'edit' | undefined {
  switch (action.kind) {
    case 'move_pointer': return 'point';
    case 'scroll': return 'navigate';
    case 'type_text': return 'edit';
    case 'click': return undefined;
  }
}

/** An independent decision is used once for the exact click reviewed.
 * The actor cannot supply its effect, supporting quote or approval. */
export function permits(request: string, action: DesktopInput, decision: PermissionDecision): boolean {
  if (decision.decision !== 'allow' || !decision.requestQuote.trim()
    || !request.includes(decision.requestQuote) || decision.effect === 'unknown') return false;
  switch (action.kind) {
    case 'click': return ['navigate', 'edit', 'submit'].includes(decision.effect);
    default: return decision.effect === routineEffect(action);
  }
}

export function permitsKeyboard(request: string, action: KeyboardAction, decision: PermissionDecision): boolean {
  if (decision.decision !== 'allow' || !decision.requestQuote.trim() || !request.includes(decision.requestQuote)
    || !['navigate', 'edit', 'submit'].includes(decision.effect)) return false;
  if (action.kind === 'type_keyboard_text') return decision.effect === 'edit';
  // Enter can open a requested app/site, or commit an action. It is never a
  // substitute for literal line breaks while preparing an unsent draft.
  return action.kind !== 'press_key' || action.key !== 'Enter' || decision.effect === 'submit'
    || (action.modifiers.length === 0 && decision.effect === 'navigate');
}
