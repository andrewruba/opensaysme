import { z } from 'zod';
import { keyboardActionSchema, keyboardEvidenceSchema, type KeyboardAdapter, type KeyboardEvidence } from '../desktop/keyboard-types.js';
import { inputResultSchema } from '../desktop/input-types.js';
import { screenFrameCaptureSchema, type ScreenFrameCapture } from '../desktop/visual-types.js';
import { desktopIssue, desktopMessages, type DesktopIssue } from '../desktop/errors.js';
import { conversationSchema, type ConversationEvidence } from '../conversation.js';
import { desktopToolError, toolError } from './registry.js';
import { permissionDecisionSchema, permitsKeyboard, type PermissionDecision } from './permissions.js';
import type { InputSession, RequestScope } from './input.js';
import type { ToolDefinition, ToolResult } from './types.js';
import { activationHotkeySchema, defaultActivationHotkey } from '../hotkey.js';
import { beginAction, closeInputSession, completedActions, finishAction, rejectAction, requestProgress, requiresReview } from './input-session.js';

const noneditableFocusGuidance = 'The current focus does not support text entry. When the request requires text entry and the intended destination is already established, locate its input in fresh window evidence, then focus it with a supported click or keyboard navigation. For text entry into an unresolved destination, resolve the destination before looking for an input; current focus does not establish where the request belongs. This does not establish that the requested input is unavailable. Do not type into this surface or guess a target.';
const sameFocus = (left: KeyboardEvidence, right: KeyboardEvidence) => left.fingerprint === right.fingerprint
  && left.applicationId === right.applicationId && left.windowId === right.windowId;

export function createKeyboardTools(adapter: KeyboardAdapter, captureFrame: (signal: AbortSignal) => Promise<ScreenFrameCapture>,
  scope: RequestScope | undefined, session: InputSession) {
  const request = scope?.request ?? '';
  const activationHotkey = scope?.activationHotkey ?? defaultActivationHotkey;
  const conversation = conversationSchema.parse(scope?.conversation ?? []);
  const actions: NonNullable<ConversationEvidence['keyboardActions']> = [];
  let observation: { id: string; frame: ScreenFrameCapture; target: KeyboardEvidence; at: number; revision: number } | undefined;
  let next = 0;
  const invalidate = () => { observation = undefined; session.revision++; };
  const capture = async (signal: AbortSignal): Promise<ToolResult> => {
    invalidate();
    let before: KeyboardEvidence | undefined, keyboardUnavailable: string | undefined, keyboardIssue: DesktopIssue | undefined;
    try { before = keyboardEvidenceSchema.parse(await adapter.inspect(signal)); }
    catch (error) {
      signal.throwIfAborted();
      keyboardIssue = desktopIssue(error) ?? 'input-unavailable';
      keyboardUnavailable = desktopMessages[keyboardIssue];
    }
    const frame = screenFrameCaptureSchema.parse(await captureFrame(signal));
    signal.throwIfAborted();
    if (before) {
      try {
        const after = keyboardEvidenceSchema.parse(await adapter.inspect(signal));
        signal.throwIfAborted();
        if (sameFocus(before, after)) {
          observation = { id: `keyboard-${++next}`, frame: structuredClone(frame), target: before, at: performance.now(), revision: session.revision };
        } else {
          keyboardIssue = 'focus-changed';
          keyboardUnavailable = 'Keyboard focus or user input changed during capture. Capture again before sending keys.';
        }
      } catch (error) {
        signal.throwIfAborted();
        keyboardIssue = desktopIssue(error) ?? 'input-unavailable';
        keyboardUnavailable = desktopMessages[keyboardIssue];
      }
    }
    const { image, ...metadata } = frame;
    const focus = observation?.target;
    // AX document values can begin with old, offscreen history. They are not
    // current-screen evidence; retain field values and compact control labels.
    const omitReadOnlyValue = focus && !focus.editable && (['AXTextArea', 'AXWebArea', 'AXDocument', 'AXScrollArea'].includes(focus.role)
      || focus.valueTruncated || focus.value.length > 512);
    const observationId = session.stopped ? undefined : observation?.id;
    if (session.stopped) observation = undefined;
    return { ...(keyboardIssue ? { desktopIssue: keyboardIssue } : {}), content: [
      { type: 'text', text: JSON.stringify({ ...metadata, image: { width: image.width, height: image.height, mimeType: image.mimeType },
        ...(focus ? { ...(observationId ? { keyboardObservationId: observationId } : {}), keyboardFocus: {
          application: focus.application, applicationId: focus.applicationId, ...(focus.windowId ? { windowId: focus.windowId } : {}),
          role: focus.role, title: focus.title, description: focus.description, editable: focus.editable,
          ...(omitReadOnlyValue
            ? { valueOmitted: 'Read-only content may include offscreen history. Use capture_text when its contents are needed; omission does not mean the control is empty.' }
            : { value: focus.value, valueTruncated: focus.valueTruncated }),
        }, ...(!focus.editable && !session.stopped ? { keyboardGuidance: noneditableFocusGuidance } : {}) } : { keyboardUnavailable, keyboardIssue }) }) },
      { type: 'image', mimeType: image.mimeType, data: image.data },
    ] };
  };
  const definitions: ToolDefinition[] = keyboardActionSchema.options.map((schema) => {
    const kind = schema.shape.kind.value;
    const properties = Object.fromEntries(Object.entries(schema.shape).filter(([key]) => key !== 'kind'));
    return {
      name: kind, effect: 'input', timeoutMs: 20_000,
      input: z.object({ keyboardObservationId: z.string().regex(/^keyboard-[1-9]\d{0,15}$/), ...properties }).strict(),
      description: (kind === 'press_key'
        ? 'Press and release one key with modifiers (Cmd, Ctrl, Alt, Shift; [] for none) at the current keyboard focus. Supports system and application shortcuts and navigation/editing keys. Letter/digit keys use US physical positions. Escape and Ctrl+C are reserved; clipboard paste is unavailable. Shortcuts and Enter receive an independent request check; Enter can navigate when current evidence shows it serves the requested navigation. Sending/submitting requires that requested outcome.'
        : 'Type literal single-line text at the focused editable control using keyboard events, inserting at its caret or replacing its selection. Supports focused inputs including controls without writable AX values. This does NOT replace the entire field automatically; use a permitted selection shortcut if needed. No clipboard or newline/control characters. Use type_text for exact whole-value or multiline AX replacement. Text is unsent; submission is a separate authorized key/click.')
        + ' Requires keyboardObservationId from a fresh capture_screen. No coordinates or existing app window required. Focus and user intervention are rechecked natively. Stay within the original request. The desktop host attempts to include a fresh screen and keyboardObservationId with the action result. Read that evidence and use the new observation directly; call capture_screen only if it is unavailable or stale. After a submission, continue_task may verify completion before a different requested step. Denied and uncertain actions stay stopped. A needs-evidence result permits inspection before another independently checked attempt.',
      run: async (args, signal): Promise<ToolResult> => {
        if (session.stopped) return toolError('input-stopped', 'Input is stopped. Use continue_task only to verify an issued commitment before a different requested step; denied or uncertain actions cannot resume.');
        if (!request.trim() || request.length > 65_536) return toolError('request-required', 'Keyboard input requires the original user request.');
        const seen = observation;
        const fresh = () => seen && observation === seen && seen.revision === session.revision && performance.now() - seen.at <= 30_000;
        if (!fresh() || seen!.id !== args.keyboardObservationId) return toolError('stale-observation', 'Call capture_screen before keyboard input.');
        const action = keyboardActionSchema.safeParse({ kind, ...Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'keyboardObservationId')) });
        if (!action.success) return toolError('invalid-arguments', 'Unsupported key combination or keyboard text. Escape, Ctrl+C and clipboard paste are unavailable.');
        const proposed = action.data;
        if (proposed.kind === 'press_key'
          && activationHotkeySchema.safeParse([...proposed.modifiers, proposed.key].join('+')).data === activationHotkey) {
          return toolError('reserved-shortcut', 'That shortcut activates OpenSaysMe and cannot be generated by the agent. Use another supported route.');
        }
        let target: KeyboardEvidence;
        try { target = keyboardEvidenceSchema.parse(await adapter.inspect(signal)); }
        catch (error) {
          signal.throwIfAborted(); invalidate();
          const issue = desktopIssue(error);
          return issue ? desktopToolError(issue) : toolError('keyboard-unavailable', 'Keyboard focus could not be verified. No input was issued.');
        }
        signal.throwIfAborted();
        if (!sameFocus(target, seen!.target)) {
          invalidate(); return toolError('stale-observation', 'Keyboard focus or user input changed. Capture again before acting.');
        }
        if (proposed.kind === 'type_keyboard_text' && !target.editable) return toolError('unsupported-text-target', noneditableFocusGuidance);
        let effect: 'navigate' | 'edit' | 'submit' | undefined = proposed.kind === 'type_keyboard_text' ? 'edit'
          : proposed.modifiers.length === 0 && ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(proposed.key) ? 'navigate' : undefined;
        if (effect === 'edit') {
          const targetProblem = await scope?.checkTarget?.({ application: target.application, applicationId: target.applicationId,
            ...(target.windowId ? { windowId: target.windowId } : {}) }, effect, signal);
          signal.throwIfAborted();
          if (targetProblem) return toolError('target-unresolved', targetProblem);
        }
        let permission: { mode: string; requestQuote?: string } = { mode: 'actor-request' };
        if (!effect || requiresReview(session) || (effect === 'edit' && scope?.reviewTarget?.())) {
          if (!scope?.authorize) return toolError('permission-unavailable', 'This keyboard action requires an independent request check.');
          const decision: PermissionDecision = permissionDecisionSchema.parse(await scope.authorize(structuredClone({
            request, referenceContext: scope.referenceContext ?? [], conversation, action: proposed, target, frame: seen!.frame,
            completed: completedActions(session), progress: requestProgress(session), resolution: scope.resolution?.(),
          }), signal));
          signal.throwIfAborted();
          if (!permitsKeyboard(request, proposed, decision)) {
            invalidate();
            const code = rejectAction(session, request, decision, proposed, target);
            return toolError(code, `Keyboard action not issued: ${decision.reason} ${code === 'needs-evidence'
              ? 'Inspect useful evidence before another attempt. All subsequent input requires an independent check.'
              : 'Input stopped; do not route around this decision.'}`);
          }
          effect = decision.effect as 'navigate' | 'edit' | 'submit';
          permission = { mode: 'independent-check', requestQuote: decision.requestQuote };
        }
        if (proposed.kind === 'press_key' && (effect === 'edit' || effect === 'submit')) {
          const targetProblem = await scope?.checkTarget?.({ application: target.application, applicationId: target.applicationId,
            ...(target.windowId ? { windowId: target.windowId } : {}) }, effect, signal);
          signal.throwIfAborted();
          if (targetProblem) return toolError('target-unresolved', targetProblem);
        }
        if (!fresh() || session.stopped) return toolError('stale-observation', 'Keyboard observation expired during the request check. Capture again.');
        signal.throwIfAborted();
        invalidate();
        const { fingerprint, ...recordedTarget } = target;
        const recorded: (typeof actions)[number] = { capturedAt: seen!.frame.capturedAt, action: proposed,
          target: recordedTarget, effect: effect!, status: 'uncertain' };
        const execution = beginAction(session, { action: proposed, effect: effect!, status: 'uncertain', capturedAt: seen!.frame.capturedAt,
          target: recordedTarget, ...(permission.requestQuote ? { requestQuote: permission.requestQuote } : {}) });
        if (!execution) return toolError('action-limit', 'Action history reached its count or size limit. No further input was issued; prior outcomes remain retained.');
        actions.push(recorded); if (actions.length > 12) actions.shift();
        let result;
        try { result = inputResultSchema.parse(await adapter.execute(proposed, fingerprint, signal)); }
        catch (error) {
          signal.throwIfAborted();
          const issue = desktopIssue(error);
          const message = 'Keyboard input may have taken effect. Input stopped; inspect without retrying.';
          return issue ? desktopToolError(issue, 'input-uncertain', message) : toolError('input-uncertain', message);
        }
        signal.throwIfAborted(); recorded.status = result.status;
        finishAction(session, execution, result.status);
        if (permission.mode === 'independent-check' && (effect === 'edit' || effect === 'submit')
          && (result.status === 'issued' || result.status === 'verified')) scope?.targetReviewed?.();
        return { isError: ['uncertain', 'not-issued'].includes(result.status), content: [{ type: 'text', text: JSON.stringify({
          action: proposed.kind, effect, status: result.status, ...(result.reason ? { code: result.reason } : {}),
          permission, inputStopped: session.stopped,
          message: result.status === 'not-issued' ? 'Native checks rejected input before execution. Use the failure code and fresh screen/focus evidence to resolve the target before retrying.'
            : result.status === 'uncertain' ? 'Input may have taken effect. Input stopped; inspect without retrying.'
            : 'Inspect the fresh screen evidence included with this result, or capture again if unavailable. Issued keys do not prove completion.',
        }) }] };
      },
    };
  });
  return { definitions, capture, invalidate, conversationActions: () => structuredClone(actions),
    feedbackTarget: (id: string) => observation?.id === id && !session.stopped
      && observation.revision === session.revision && performance.now() - observation.at <= 30_000
      ? { application: observation.target.application, title: observation.target.title } : undefined,
    close: () => { invalidate(); closeInputSession(session); actions.length = 0; conversation.length = 0; } };
}
