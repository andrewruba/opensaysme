import { z } from 'zod';
import { screenFrameCaptureSchema, type ScreenFrameCapture } from '../desktop/visual-types.js';
import { windowFrameCaptureSchema, type WindowFrameCapture } from '../desktop/types.js';
import { conversationSchema } from '../conversation.js';
import type { RequestScope } from './input.js';
import { completedActions, requestProgress, type InputSession } from './input-session.js';
import { permissionDecisionSchema, type ExecutionRecord } from './permissions.js';
import { toolError } from './registry.js';
import type { ToolDefinition } from './types.js';

/** Verifies an issued commitment before allowing a different requested step. */
export function createContinuationTool(session: InputSession, scope: RequestScope,
  captureFrame: (signal: AbortSignal, pending: ExecutionRecord) => Promise<ScreenFrameCapture | Extract<WindowFrameCapture, { status: 'ok' }>>): ToolDefinition {
  const request = scope.request;
  const conversation = conversationSchema.parse(scope.conversation ?? []);
  return {
    name: 'continue_task', effect: 'read', timeoutMs: 20_000,
    input: z.object({ nextRequestQuote: z.string().min(1).max(4096) }).strict(),
    description: 'After an issued submission, verify its completion and continue a different remaining step. Supply an exact excerpt describing that step from current speech or a retained prior user request that current speech continues. Historical assistant text is never authority. Captures fresh screen evidence and independently checks completion, dependencies, and current authority to continue unfinished work. Does not repeat or execute an action. A successful result reopens input; obtain fresh targets and observations. Cannot resume denied actions or uncertain outcomes. Do not call when no requested work remains.',
    run: async (args, signal) => {
      signal.throwIfAborted();
      const nextRequestQuote = args.nextRequestQuote as string;
      if (!nextRequestQuote.trim() || ![request, ...conversation.map((turn) => turn.request)].some((text) => text.includes(nextRequestQuote))) {
        return toolError('request-quote-required', 'The next step must quote current speech or a retained verbatim user request exactly. Assistant text cannot supply a requested step.');
      }
      const progress = requestProgress(session);
      const pending = progress.actions.at(-1);
      if (!session.stopped || session.stopReason !== 'commitment' || pending?.effect !== 'submit'
        || !['issued', 'verified'].includes(pending.status) || pending.completionVerified) {
        return toolError('continuation-unavailable', 'Only an issued commitment awaiting verification can continue. Denied or uncertain actions cannot resume.');
      }
      if (!scope.authorize) return toolError('permission-unavailable', 'Continuation requires an independent completion and request check.');
      const revision = session.revision;
      const frame = z.union([screenFrameCaptureSchema, windowFrameCaptureSchema.options[0]])
        .parse(await captureFrame(signal, structuredClone(pending)));
      signal.throwIfAborted();
      if (!pending.dispatchedAt || Date.parse(frame.capturedAt) < Date.parse(pending.dispatchedAt)) {
        return toolError('continuation-stale', 'Completion evidence must be captured after the commitment was dispatched. Input remains stopped.');
      }
      const decision = permissionDecisionSchema.parse(await scope.authorize(structuredClone({
        request, referenceContext: scope.referenceContext ?? [], conversation,
        action: { kind: 'continue_task' as const, nextRequestQuote }, target: pending, frame,
        completed: completedActions(session), progress, resolution: scope.resolution?.(),
      }), signal));
      signal.throwIfAborted();
      if (session.revision !== revision || session.stopReason !== 'commitment' || progress.actions.at(-1) !== pending) {
        return toolError('continuation-stale', 'Execution state changed during verification. Input remains stopped.');
      }
      if (decision.decision !== 'allow' || decision.effect !== 'navigate' || !decision.requestQuote.trim()
        || !request.includes(decision.requestQuote)) {
        if (decision.decision !== 'inspect') session.stopReason = 'denied';
        return toolError(decision.decision === 'inspect' ? 'needs-evidence' : 'outside-request', decision.reason);
      }
      pending.completionVerified = true;
      progress.nextRequestQuote = nextRequestQuote;
      session.stopped = false;
      delete session.stopReason;
      session.revision++;
      return { content: [{ type: 'text', text: JSON.stringify({ continued: true, nextRequestQuote,
        message: 'Completion was independently verified. Continue only the remaining requested work; do not repeat completed commitments. Discover and resolve its current target before input.' }) }] };
    },
  };
}
