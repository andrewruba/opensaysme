import { z } from 'zod';
import type { DesktopInput, InputEvidence } from '../desktop/input-types.js';
import type { WindowFrameCapture } from '../desktop/types.js';
import type { AttentionHistory } from '../attention.js';
import type { ConversationTurn } from '../conversation.js';

export const permissionDecisionSchema = z.object({
  decision: z.enum(['allow', 'deny', 'clarify']),
  effect: z.enum(['point', 'navigate', 'edit', 'submit', 'unknown']),
  requestQuote: z.string().max(4096),
  reason: z.string().min(1).max(1024),
}).strict();
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;
export interface ActionReview {
  request: string;
  referenceContext: AttentionHistory['contexts'];
  conversation?: ConversationTurn[];
  action: DesktopInput;
  target: InputEvidence;
  frame: Extract<WindowFrameCapture, { status: 'ok' }>;
  point: { x: number; y: number };
  completed: Array<{ action: DesktopInput['kind']; effect: PermissionDecision['effect']; status: string }>;
}
export type ActionAuthorizer = (review: ActionReview, signal: AbortSignal) => Promise<PermissionDecision>;

/** Routine operations follow the actor's interpretation of the spoken request.
 * Clicks can commit regardless of their labels; Enter always gets a separate check. */
export function routineEffect(action: DesktopInput): 'point' | 'navigate' | 'edit' | undefined {
  switch (action.kind) {
    case 'move_pointer': return 'point';
    case 'scroll': return 'navigate';
    case 'type_text': return 'edit';
    case 'press_key': return action.key === 'Tab' ? 'navigate' : undefined;
    case 'click': return undefined;
  }
}

/** An independent decision is used once for the exact click or Enter reviewed.
 * The actor cannot supply its effect, supporting quote or approval. */
export function permits(request: string, action: DesktopInput, decision: PermissionDecision): boolean {
  if (decision.decision !== 'allow' || !decision.requestQuote.trim()
    || !request.includes(decision.requestQuote) || decision.effect === 'unknown') return false;
  switch (action.kind) {
    case 'press_key': return action.key === 'Enter' && decision.effect === 'submit';
    case 'click': return ['navigate', 'edit', 'submit'].includes(decision.effect);
    default: return false;
  }
}
