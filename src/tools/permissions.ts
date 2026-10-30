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

/** The actor cannot supply an effect or approval. Interpretations are checked here,
 * then used once for the exact action and native evidence reviewed by the guard. */
export function permits(request: string, action: DesktopInput, decision: PermissionDecision): boolean {
  if (decision.decision !== 'allow' || !decision.requestQuote.trim()
    || !request.includes(decision.requestQuote) || decision.effect === 'unknown') return false;
  switch (action.kind) {
    case 'move_pointer': return decision.effect === 'point';
    case 'scroll': return decision.effect === 'navigate';
    case 'type_text': return decision.effect === 'edit' || decision.effect === 'submit';
    case 'press_key': return action.key === 'Enter' ? decision.effect === 'submit'
      : ['navigate', 'edit', 'submit'].includes(decision.effect);
    case 'click': return ['navigate', 'edit', 'submit'].includes(decision.effect);
  }
}
