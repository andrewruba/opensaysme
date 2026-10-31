import { z } from 'zod';
import { desktopInputSchema, inputEvidenceSchema, inputResultSchema, textRequiresTextArea, type DesktopInput, type DesktopInputAdapter } from '../desktop/input-types.js';
import type { WindowFrameCapture } from '../desktop/types.js';
import { permissionDecisionSchema, permits, routineEffect, type ActionAuthorizer, type ActionReview } from './permissions.js';
import { desktopToolError, toolError } from './registry.js';
import { desktopIssue, desktopMessages } from '../desktop/errors.js';
import type { ToolDefinition, ToolResult } from './types.js';
import { conversationSchema, type ConversationTurn, type ConversationEvidence } from '../conversation.js';

type Frame = Extract<WindowFrameCapture, { status: 'ok' }>;
export interface RequestScope {
  request: string; authorize?: ActionAuthorizer; referenceContext?: ActionReview['referenceContext'];
  conversation?: ConversationTurn[];
}
const position = { observationId: z.string().regex(/^observation-[1-9]\d{0,15}$/),
  x: z.number().finite().min(0).max(1600), y: z.number().finite().min(0).max(1600) };
const descriptions = {
  move_pointer: 'Move the pointer to indicate a target without clicking.',
  click: 'Issue one left click on a visible, accessible target. A click may edit or submit.',
  scroll: 'Scroll vertically at the target; positive deltaY scrolls content down, negative up, in logical pixels (at most 600).',
  type_text: 'Replace the entire value of the focused writable Accessibility input with literal text (at most 4096 UTF-16 code units). Tabs and line breaks require AXTextArea; ordinary single-line text also supports AXTextField. Preserves exact text, including indentation and line endings, without keyboard events or clipboard use. This is not append. Empty text clears the field. Some applications autosave; entering text does not authorize sending. Unsupported targets fail without a typing or paste fallback.',
  press_key: 'Send one unmodified Tab or Enter to the already-focused editable input under this point. Enter requires submission authority. Tab can trigger blur/save. No other keys or shortcuts are supported.',
};

export function createInputTools(adapter: DesktopInputAdapter, scope?: RequestScope) {
  // Copy the original finalized request; neither tool arguments nor captured content can replace it.
  const request = scope?.request ?? '';
  const authorize = scope?.authorize;
  const referenceContext = structuredClone(scope?.referenceContext ?? []);
  const conversation = conversationSchema.parse(scope?.conversation ?? []);
  const actions: ConversationEvidence['actions'] = [];
  let observation: { id: string; frame: Frame; at: number } | undefined;
  let next = 0;
  let stopped = false;
  let closed = false;
  const completed: ActionReview['completed'] = [];
  const invalidate = () => { observation = undefined; };
  const definitions: ToolDefinition[] = desktopInputSchema.options.map((schema) => {
    const kind = schema.shape.kind.value;
    const parameters = Object.fromEntries(Object.entries(schema.shape).filter(([name]) => name !== 'kind'));
    return { name: kind, effect: 'input', timeoutMs: 20_000, input: z.object({ ...position, ...parameters }).strict(),
      description: `${descriptions[kind]} Requires a recent capture_window observationId and x/y in that image's pixels, not screen coordinates. Target window must already be focused and unobscured. You must stay within the original request; only clicks and Enter receive a separate permission check. Other input uses your request interpretation with native target checks. Tools cannot grant permission. Every issued action invalidates observations; capture again to inspect the outcome. Stop after a submission or uncertain outcome. macOS only.`,
      run: async (args, signal): Promise<ToolResult> => {
        if (closed || stopped) return toolError('input-stopped', 'Input has stopped for this turn after a commitment, uncertain outcome, or close. Inspect and report the result; do not retry.');
        if (!request.trim() || request.length > 65_536) return toolError('request-required', 'Input requires the original user request.');
        const seen = observation;
        if (!seen || seen.id !== args.observationId || performance.now() - seen.at > 30_000) {
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
        if ((action.kind === 'type_text' || action.kind === 'press_key') && !evidence.focused) {
          invalidate();
          return toolError('input-not-focused', 'The editable input must already have keyboard focus. Focus the intended field, capture it again, then enter text or press a key. No input was issued.');
        }
        let effect: 'point' | 'navigate' | 'edit' | 'submit' | undefined = routineEffect(action);
        let permission: { mode: 'actor-request' | 'independent-check'; requestQuote?: string; reason: string } = {
          mode: 'actor-request', reason: 'Actor-scoped routine input; no separate permission check.',
        };
        if (effect === undefined) {
          if (!authorize) return toolError('permission-unavailable', 'Clicks and Enter require an independent request check. No input was issued.');
          const decision = permissionDecisionSchema.parse(await authorize(structuredClone({ request, referenceContext, conversation, action, target: evidence,
            frame: seen.frame, point, completed }), signal));
          signal.throwIfAborted();
          if (!permits(request, action, decision)) return toolError('outside-request',
            `Input was not issued: ${decision.reason} Do not repeat this action or ask to expand the request merely because a control exists; clarify only if necessary to fulfill the request.`);
          effect = decision.effect as 'navigate' | 'edit' | 'submit';
          permission = { mode: 'independent-check', requestQuote: decision.requestQuote, reason: decision.reason };
        }
        signal.throwIfAborted();
        if (closed || observation !== seen || performance.now() - seen.at > 30_000) return toolError('stale-observation', 'The observation expired while checking the target or request. Inspect again.');
        // Consume evidence and block retries BEFORE touching the OS, including timeouts/cancellation.
        invalidate(); stopped = true;
        const { fingerprint, ...control } = evidence;
        const recorded: ConversationEvidence['actions'][number] = structuredClone({
          window: seen.frame.window, capturedAt: seen.frame.capturedAt, action, target: control,
          point, effect, status: 'uncertain',
        });
        // Record uncertainty before dispatch: a throw or timeout cannot turn a
        // potentially issued commitment into permission to repeat it next turn.
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
        completed.push({ action: action.kind, effect, status: result.status });
        if (result.status === 'not-issued') stopped = false;
        else if (result.status !== 'uncertain' && effect !== 'submit') stopped = false;
        return { isError: ['not-issued', 'uncertain'].includes(result.status), content: [{ type: 'text', text: JSON.stringify({
          action: action.kind, effect, status: result.status, permission,
          message: result.status === 'not-issued' ? 'Native checks rejected input before execution. Recheck the target, focus and permissions with fresh evidence.'
            : 'Input may change the UI. Capture fresh evidence to verify the intended outcome. Issued events are not proof of submission success.',
          inputStopped: stopped,
        }) }] };
      },
    };
  });
  return { definitions, invalidate, conversationActions: () => structuredClone(actions),
    feedbackTarget: (observationId: string) => {
      if (closed || stopped || !observation || observation.id !== observationId || performance.now() - observation.at > 30_000) return undefined;
      return structuredClone(observation.frame.window);
    },
    observe: (frame: Frame) => {
      const id = `observation-${++next}`;
      observation = { id, frame: structuredClone(frame), at: performance.now() };
      return id;
    },
    close: () => { closed = true; invalidate(); completed.length = 0; actions.length = 0; conversation.length = 0; },
  };
}
