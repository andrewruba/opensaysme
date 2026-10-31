import { z } from 'zod';
import { keyboardActionSchema, keyboardEvidenceSchema, type KeyboardAdapter, type KeyboardEvidence } from '../desktop/keyboard-types.js';
import { inputResultSchema } from '../desktop/input-types.js';
import { screenFrameCaptureSchema, type ScreenFrameCapture } from '../desktop/visual-types.js';
import { desktopIssue, desktopMessages, type DesktopIssue } from '../desktop/errors.js';
import { conversationSchema, type ConversationEvidence } from '../conversation.js';
import { desktopToolError, toolError } from './registry.js';
import { permissionDecisionSchema, permitsKeyboard, type KeyboardReview, type PermissionDecision } from './permissions.js';
import type { InputSession, RequestScope } from './input.js';
import type { ToolDefinition, ToolResult } from './types.js';
import { activationHotkeySchema, defaultActivationHotkey } from '../hotkey.js';

const noneditableFocusGuidance = 'The current focus does not support text entry; this does not establish that the requested input is unavailable. Locate the intended input in fresh window evidence, then focus it with a supported click or keyboard navigation and capture_screen again. Do not type into this surface or guess a target.';

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
        if (before.fingerprint === after.fingerprint) {
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
    return { ...(keyboardIssue ? { desktopIssue: keyboardIssue } : {}), content: [
      { type: 'text', text: JSON.stringify({ ...metadata, image: { width: image.width, height: image.height, mimeType: image.mimeType },
        ...(focus ? { keyboardObservationId: observation!.id, keyboardFocus: {
          application: focus.application, role: focus.role, title: focus.title, description: focus.description, value: focus.value,
          valueTruncated: focus.valueTruncated, editable: focus.editable,
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
        ? 'Press and release one key with modifiers (Cmd, Ctrl, Alt, Shift; [] for none) at the current keyboard focus. Supports system shortcuts such as Cmd+Space for Spotlight, Cmd+L for the browser address bar, and navigation/editing keys. Letter/digit keys use US physical positions. Escape and Ctrl+C are reserved; clipboard paste is unavailable. Shortcuts and Enter receive an independent request check; Enter in a verified launcher/address bar can navigate when opening was requested. Sending/submitting requires that requested outcome.'
        : 'Type literal single-line text at the focused editable control using keyboard events, inserting at its caret or replacing its selection. Useful for Spotlight and browser address bars, including controls without writable AX values. This does NOT replace the entire field automatically; use a permitted selection shortcut if needed. No clipboard or newline/control characters. Use type_text for exact whole-value or multiline AX replacement. Text is unsent; submission is a separate authorized key/click.')
        + ' Requires keyboardObservationId from a fresh capture_screen. No coordinates or existing app window required. Focus and user intervention are rechecked natively. Stay within the original request. After each action capture again, read the actual outcome, and obtain a new observation. Do not retry or use another tool after inputStopped, denial, or uncertainty.',
      run: async (args, signal): Promise<ToolResult> => {
        if (session.stopped) return toolError('input-stopped', 'Input stopped after a commitment or uncertain outcome. Inspect and report; do not retry.');
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
        if (target.fingerprint !== seen!.target.fingerprint) {
          invalidate(); return toolError('stale-observation', 'Keyboard focus or user input changed. Capture again before acting.');
        }
        if (proposed.kind === 'type_keyboard_text' && !target.editable) return toolError('unsupported-text-target', noneditableFocusGuidance);
        let effect: 'navigate' | 'edit' | 'submit' | undefined = proposed.kind === 'type_keyboard_text' ? 'edit'
          : proposed.modifiers.length === 0 && ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(proposed.key) ? 'navigate' : undefined;
        let permission: { mode: string; requestQuote?: string } = { mode: 'actor-request' };
        if (!effect) {
          if (!scope?.authorize) return toolError('permission-unavailable', 'This keyboard action requires an independent request check.');
          const completed: KeyboardReview['completed'] = actions.map(({ action, effect, status }) => ({ action: action.kind, effect, status }));
          const decision: PermissionDecision = permissionDecisionSchema.parse(await scope.authorize(structuredClone({
            request, referenceContext: scope.referenceContext ?? [], conversation, action: proposed, target, frame: seen!.frame, completed,
          }), signal));
          signal.throwIfAborted();
          if (!permitsKeyboard(request, proposed, decision)) {
            invalidate(); session.stopped = true;
            return toolError('outside-request', `Keyboard action not issued: ${decision.reason} Input stopped for this turn; do not route around this decision.`);
          }
          effect = decision.effect as 'navigate' | 'edit' | 'submit';
          permission = { mode: 'independent-check', requestQuote: decision.requestQuote };
        }
        if (!fresh() || session.stopped) return toolError('stale-observation', 'Keyboard observation expired during the request check. Capture again.');
        signal.throwIfAborted();
        invalidate(); session.stopped = true;
        const { fingerprint, ...recordedTarget } = target;
        const recorded: (typeof actions)[number] = { capturedAt: seen!.frame.capturedAt, action: proposed,
          target: recordedTarget, effect: effect!, status: 'uncertain' };
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
        session.stopped = result.status !== 'not-issued' && (result.status === 'uncertain' || effect === 'submit');
        return { isError: ['uncertain', 'not-issued'].includes(result.status), content: [{ type: 'text', text: JSON.stringify({
          action: proposed.kind, effect, status: result.status, ...(result.reason ? { code: result.reason } : {}),
          permission, inputStopped: session.stopped,
          message: result.status === 'not-issued' ? 'Native checks rejected input before execution. Use the failure code and fresh screen/focus evidence to resolve the target before retrying.'
            : result.status === 'uncertain' ? 'Input may have taken effect. Input stopped; inspect without retrying.'
            : 'Capture fresh screen evidence to verify the outcome. Issued keys do not prove completion.',
        }) }] };
      },
    };
  });
  return { definitions, capture, invalidate, conversationActions: () => structuredClone(actions),
    feedbackTarget: (id: string) => observation?.id === id && !session.stopped
      && observation.revision === session.revision && performance.now() - observation.at <= 30_000
      ? { application: observation.target.application, title: observation.target.title } : undefined,
    close: () => { invalidate(); actions.length = 0; conversation.length = 0; } };
}
