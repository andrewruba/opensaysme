import type { VoiceOutput } from './runtime.js';
import type { FeedbackExpression, FeedbackSink } from './desktop/feedback-process.js';
import type { DesktopIssue } from './desktop/errors.js';
import { defaultActivationHotkey } from './hotkey.js';

// Cut on code-point boundaries while enforcing the native UTF-16 bound.
function clip(value: string, limit: number): string {
  // A previously clipped window label can contain an unpaired surrogate, which
  // Swift's JSON parser rejects. Unicode mode leaves intact pairs untouched.
  value = value.replace(/[\uD800-\uDFFF]/gu, '\uFFFD');
  if (value.length <= limit) return value;
  let result = value.slice(0, limit - 1);
  if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
  return `${result}…`;
}
const stateTitles = {
  starting: 'Starting…', listening: 'Listening…', processing: 'Finishing transcript…',
  interpreting: 'Thinking…', inspecting: 'Inspecting…', acting: 'Checking action…',
};
const actionTitles: Record<string, string> = {
  focus_window: 'Switching window…', activate_application: 'Switching app…', move_pointer: 'Pointing…', click: 'Checking click…',
  scroll: 'Scrolling…', type_text: 'Preparing input…', press_key: 'Checking key press…', type_keyboard_text: 'Typing…',
  transfer_text: 'Preparing input…',
};
const stateExpressions: Record<keyof typeof stateTitles, FeedbackExpression> = {
  starting: 'neutral', listening: 'listening', processing: 'thinking', interpreting: 'thinking', inspecting: 'focused', acting: 'focused',
};
// Recoverable discovery/input problems are already available to the agent and
// terminal. Interrupt the overlay only for warnings the user can act on now.
const attentionIssues = new Set<DesktopIssue>([
  'permission-required', 'screen-permission-required', 'microphone-permission-required', 'microphone-unavailable',
  'helper-missing', 'helper-unavailable', 'helper-crashed', 'helper-invalid-response', 'helper-failed', 'invalid-input', 'unsupported',
]);
function resultExpression(event: Extract<VoiceOutput, { type: 'result' }>): FeedbackExpression {
  const tools = event.toolResults ?? [];
  const lastInput = tools.findLast(({ effect }) => effect === 'input');
  // A later successful read does not resolve a possibly issued action or a
  // final failed input. This is a response-ready smile, not proof of task success.
  return tools.some(({ outcome }) => outcome === 'uncertain')
    || (lastInput && ['failed', 'not-issued'].includes(lastInput.outcome))
    || ['failed', 'partial'].includes(tools.at(-1)?.outcome ?? '') ? 'concerned' : 'happy';
}

/** Projects runtime events into optional UI; never makes requests or decisions. */
export function createFeedback(sink: FeedbackSink, activationHotkey = defaultActivationHotkey) {
  let turnId: string | undefined;
  let settled = false, closed = false;
  let closing: Promise<void> | undefined;
  let expiry: NodeJS.Timeout | undefined;
  const clearExpiry = () => { clearTimeout(expiry); expiry = undefined; };
  const hide = () => { clearExpiry(); sink.send({ type: 'hide' }); };
  function show(title: string, message = '', detail = '', options: { expires?: boolean; persistent?: boolean; expression?: FeedbackExpression } = {}) {
    clearExpiry();
    sink.send({ type: 'show', title: clip(title, 160), message: clip(message, 32_768), detail: clip(detail, 512),
      persistent: options.persistent ?? false, expression: options.expression ?? 'neutral' });
    if (options.expires) expiry = setTimeout(hide, 60_000);
  }
  return {
    handle(event: VoiceOutput) {
      if (closed) return;
      if (event.type === 'dismiss-feedback') { settled = true; hide(); return; }
      if (event.type === 'debug') return;
      if (event.type === 'state' && event.state === 'starting' && event.turnId) {
        hide(); // Clear the prior answer and let native placement follow the pointer display.
        turnId = event.turnId; settled = false;
      } else if ('turnId' in event && event.turnId && event.turnId !== turnId) return;
      if (event.type === 'state') {
        if (event.state === 'ready') { if (!settled) hide(); return; }
        if (event.state === 'cancelling') { settled = true; hide(); return; }
        if (!settled) show(stateTitles[event.state], '', event.state === 'listening'
          ? `${activationHotkey} to finish · Escape to cancel` : 'Escape to cancel', { expression: stateExpressions[event.state] });
      } else if (event.type === 'cancelled') {
        settled = true; hide();
      } else if (event.type === 'result') {
        if (settled) return;
        settled = true;
        show('Response', event.response, `${activationHotkey} to reply`, { persistent: true, expression: resultExpression(event) });
      } else if (event.type === 'error' || event.type === 'warning') {
        if (settled && event.type === 'warning') return;
        if (event.type === 'warning' && event.turnId && event.desktopIssue && !attentionIssues.has(event.desktopIssue)) return;
        show(event.type === 'error' ? 'Couldn’t complete the request' : 'Needs attention', event.message,
          'Details in terminal', { expires: true, expression: 'concerned' });
        if (event.type === 'error' || !turnId) settled = true;
      } else if (event.type === 'activity' && !settled) {
        const target = event.target ? [event.target.application, event.target.title].filter(Boolean).join(' — ') : 'Resolving target…';
        show(actionTitles[event.name] ?? 'Checking action…', target, 'Escape to cancel', { expression: 'focused' });
      }
    },
    close(): Promise<void> {
      if (!closing) { closed = true; hide(); closing = sink.close(); }
      return closing;
    },
  };
}
