import { z } from 'zod';
import { desktopInputSchema, inputEvidenceSchema, inputResultSchema, textRequiresTextArea, type DesktopInput, type DesktopInputAdapter } from '../desktop/input-types.js';
import type { WindowFrameCapture } from '../desktop/types.js';
import { permissionDecisionSchema, permits, routineEffect, type ActionAuthorizer, type ActionReview } from './permissions.js';
import { desktopToolError, toolError } from './registry.js';
import { desktopIssue, desktopMessages } from '../desktop/errors.js';
import type { ToolDefinition, ToolResult } from './types.js';
import { conversationSchema, type ConversationTurn, type ConversationEvidence } from '../conversation.js';
import type { WorkReference } from '../work-context.js';
import { beginAction, closeInputSession, completedActions, finishAction, rejectAction, requestProgress, requiresReview, type InputSession } from './input-session.js';
export type { InputSession } from './input-session.js';

type Frame = Extract<WindowFrameCapture, { status: 'ok' }>;
export interface RequestScope {
  activationHotkey?: string;
  request: string; authorize?: ActionAuthorizer; referenceContext?: ActionReview['referenceContext'];
  conversation?: ConversationTurn[];
  workContext?: WorkReference[];
  resolution?: () => unknown;
  checkTarget?: (target: { application: string; applicationId?: string; windowId?: string }, effect: 'edit' | 'submit', signal: AbortSignal) => Promise<string | undefined>;
  reviewTarget?: () => boolean;
  targetReviewed?: () => void;
}
const position = { observationId: z.string().regex(/^observation-[1-9]\d{0,15}$/),
  x: z.number().finite().min(0).max(1600), y: z.number().finite().min(0).max(1600) };
const descriptions = {
  move_pointer: 'Move the pointer to indicate a target without clicking.',
  click: 'Issue one left click on a visible, accessible target. A click may edit or submit.',
  scroll: 'Scroll vertically at the target; positive deltaY scrolls content down, negative up, in logical pixels (at most 600).',
  type_text: 'Replace the entire value of the focused writable Accessibility input with model-provided literal text (at most 4096 UTF-16 code units). When transfer_text is offered, use it for larger captured source text to preserve it exactly without rewriting it. Tabs and line breaks require AXTextArea; ordinary single-line text also supports AXTextField. Preserves exact text, including indentation and line endings, without keyboard events or clipboard use. This is not append. Empty text clears the field. Some applications autosave; entering text does not authorize sending. Unsupported targets fail without a typing or paste fallback.',
};

export function createInputTools(adapter: DesktopInputAdapter, scope?: RequestScope,
  session: InputSession = { stopped: false, revision: 0 }) {
  // Copy the original finalized request; neither tool arguments nor captured content can replace it.
  const request = scope?.request ?? '';
  const authorize = scope?.authorize;
  const referenceContext = structuredClone(scope?.referenceContext ?? []);
  const conversation = conversationSchema.parse(scope?.conversation ?? []);
  const actions: ConversationEvidence['actions'] = [];
  let observation: { id: string; frame: Frame; at: number; revision: number } | undefined;
  let next = 0;
  let closed = false;
  const invalidate = () => { observation = undefined; session.revision++; };
  const definitions: ToolDefinition[] = desktopInputSchema.options.map((schema) => {
    const kind = schema.shape.kind.value;
    const parameters = Object.fromEntries(Object.entries(schema.shape).filter(([name]) => name !== 'kind'));
    // Model-authored text stays small; transfer_text invokes this same checked
    // runner with a larger host-retained literal, never model-rewritten content.
    if ('text' in schema.shape) parameters.text = schema.shape.text.max(4096)
      .refine((text) => text.length <= 4096, 'Text exceeds 4096 UTF-16 code units.');
    return { name: kind, effect: 'input', timeoutMs: 20_000, input: z.object({ ...position, ...parameters }).strict(),
      description: `${descriptions[kind]} Requires a recent capture_window observationId and x/y in that image's pixels, not screen coordinates. Target window must already be focused and unobscured. You must stay within the original request; clicks receive a separate permission check. Other input uses your request interpretation with native target checks. Tools cannot grant permission. Every issued action invalidates old observations. Except for move_pointer, the desktop host attempts to include a fresh same-window image and observationId in the result; use it directly, or capture again if unavailable. After submission, use continue_task only when another requested step remains. Uncertain outcomes and denied actions stay stopped. A needs-evidence result permits inspection and a fresh independently checked attempt. macOS only.`,
      run: async (args, signal): Promise<ToolResult> => {
        if (closed || session.stopped) return toolError('input-stopped', 'Input is stopped. An issued commitment may use continue_task to verify completion before another requested step. Denied or uncertain actions cannot resume.');
        if (!request.trim() || request.length > 65_536) return toolError('request-required', 'Input requires the original user request.');
        const seen = observation;
        if (!seen || seen.id !== args.observationId || seen.revision !== session.revision || performance.now() - seen.at > 30_000) {
          return toolError('stale-observation', 'Capture the intended window again before acting. Previous images are not current action targets.');
        }
        const x = args.x as number, y = args.y as number;
        if (x >= seen.frame.image.width || y >= seen.frame.image.height) return toolError('outside-image', 'The point is outside this window image.');
        const payload = Object.fromEntries(Object.entries(args).filter(([name]) => !['observationId', 'x', 'y'].includes(name)));
        const action: DesktopInput = desktopInputSchema.parse({ kind, ...payload });
        const { bounds } = seen.frame;
        const point = { x: bounds.x + x * bounds.width / seen.frame.image.width,
          y: bounds.y + y * bounds.height / seen.frame.image.height };
        const target = { windowId: seen.frame.window.id, bounds, point };
        let evidence;
        try { evidence = inputEvidenceSchema.parse(await adapter.inspect(target, action, signal)); }
        catch (error) {
          signal.throwIfAborted(); invalidate();
          const issue = desktopIssue(error);
          if (issue) return desktopToolError(issue);
          return toolError('input-target-unavailable', 'Input target could not be verified or does not support this action. Check focus, occlusion, Accessibility access and fresh window content. '
            + (action.kind === 'type_text' && textRequiresTextArea(action.text) ? 'Tabs and multiline text require a writable AXTextArea; do not substitute keystrokes or paste. ' : '')
            + 'No input was issued.');
        }
        signal.throwIfAborted();
        if (action.kind === 'type_text' && (!evidence.editable
          || !['AXTextField', 'AXTextArea'].includes(evidence.role)
          || (textRequiresTextArea(action.text) && evidence.role !== 'AXTextArea'))) {
          invalidate();
          return desktopToolError('unsupported-text-target');
        }
        if (action.kind === 'type_text' && !evidence.focused) {
          invalidate();
          return toolError('input-not-focused', 'The editable input must already have keyboard focus. Focus the intended field, capture it again, then enter text. No input was issued.');
        }
        let effect: 'point' | 'navigate' | 'edit' | 'submit' | undefined = routineEffect(action);
        if (effect === 'edit') {
          const targetProblem = await scope?.checkTarget?.({ application: seen.frame.window.application, windowId: seen.frame.window.id }, effect, signal);
          signal.throwIfAborted();
          if (targetProblem) return toolError('target-unresolved', targetProblem);
        }
        let permission: { mode: 'actor-request' | 'independent-check'; requestQuote?: string; reason: string } = {
          mode: 'actor-request', reason: 'Actor-scoped routine input; no separate permission check.',
        };
        if (effect === undefined || requiresReview(session) || (effect === 'edit' && scope?.reviewTarget?.())) {
          if (!authorize) return toolError('permission-unavailable', 'Clicks require an independent request check. No input was issued.');
          const decision = permissionDecisionSchema.parse(await authorize(structuredClone({ request, referenceContext, conversation, action, target: evidence,
            frame: seen.frame, point, completed: completedActions(session), progress: requestProgress(session), resolution: scope?.resolution?.() }), signal));
          signal.throwIfAborted();
          if (!permits(request, action, decision)) {
            invalidate();
            const code = rejectAction(session, request, decision, action, { window: seen.frame.window, control: evidence });
            return toolError(code, `Input was not issued: ${decision.reason} ${code === 'needs-evidence'
              ? 'Inspect useful evidence before another attempt. All subsequent input requires an independent check.'
              : 'Input stopped; do not route around this decision.'}`);
          }
          effect = decision.effect as 'navigate' | 'edit' | 'submit';
          permission = { mode: 'independent-check', requestQuote: decision.requestQuote, reason: decision.reason };
        }
        if (action.kind === 'click' && (effect === 'edit' || effect === 'submit')) {
          const targetProblem = await scope?.checkTarget?.({ application: seen.frame.window.application, windowId: seen.frame.window.id }, effect, signal);
          signal.throwIfAborted();
          if (targetProblem) return toolError('target-unresolved', targetProblem);
        }
        signal.throwIfAborted();
        if (closed || session.stopped || observation !== seen || seen.revision !== session.revision || performance.now() - seen.at > 30_000) return toolError('stale-observation', 'The observation expired while checking the target or request. Inspect again.');
        // Consume evidence and block retries BEFORE touching the OS, including timeouts/cancellation.
        invalidate();
        const { fingerprint, ...control } = evidence;
        const recorded: ConversationEvidence['actions'][number] = structuredClone({
          window: seen.frame.window, capturedAt: seen.frame.capturedAt, action, target: control,
          point, effect, status: 'uncertain',
        });
        // Record uncertainty before dispatch: a throw or timeout cannot turn a
        // potentially issued commitment into permission to repeat it next turn.
        const execution = beginAction(session, { action, effect, status: 'uncertain', capturedAt: seen.frame.capturedAt,
          target: { window: seen.frame.window, control }, ...(permission.requestQuote ? { requestQuote: permission.requestQuote } : {}) });
        if (!execution) return toolError('action-limit', 'Action history reached its count or size limit. No further input was issued; prior outcomes remain retained.');
        actions.push(recorded);
        if (actions.length > 12) actions.shift();
        let result;
        try { result = inputResultSchema.parse(await adapter.execute(target, action, fingerprint, signal)); }
        catch (error) {
          signal.throwIfAborted();
          const message = 'The native action may have taken effect. Input is stopped for this turn; inspect and report the outcome without retrying.';
          const issue = desktopIssue(error);
          return issue ? desktopToolError(issue, 'input-uncertain', `${message} ${desktopMessages[issue]}`) : toolError('input-uncertain', message);
        }
        signal.throwIfAborted();
        recorded.status = result.status;
        finishAction(session, execution, result.status);
        if (permission.mode === 'independent-check' && (effect === 'edit' || effect === 'submit')
          && (result.status === 'issued' || result.status === 'verified')) scope?.targetReviewed?.();
        return { isError: ['not-issued', 'uncertain'].includes(result.status), content: [{ type: 'text', text: JSON.stringify({
          action: action.kind, effect, status: result.status, ...(result.reason ? { code: result.reason } : {}), permission,
          message: result.status === 'not-issued' ? 'Native checks rejected input before execution. Recheck the target, focus and permissions with fresh evidence.'
            : 'Input may change the UI. Inspect the fresh observation included with this result, or capture again if unavailable. Issued events are not proof of submission success.',
          inputStopped: session.stopped,
        }) }] };
      },
    };
  });
  return { definitions, invalidate, conversationActions: () => structuredClone(actions),
    feedbackTarget: (observationId: string) => {
      if (closed || session.stopped || !observation || observation.id !== observationId || observation.revision !== session.revision || performance.now() - observation.at > 30_000) return undefined;
      return structuredClone(observation.frame.window);
    },
    observe: (frame: Frame) => {
      const id = `observation-${++next}`;
      observation = { id, frame: structuredClone(frame), at: performance.now(), revision: session.revision };
      return id;
    },
    close: () => { closed = true; invalidate(); closeInputSession(session); actions.length = 0; conversation.length = 0; },
  };
}
