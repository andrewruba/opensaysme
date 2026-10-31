import type { VoiceOutput } from './runtime.js';
import type { FeedbackSink } from './desktop/feedback-process.js';
import { desktopMessages, type DesktopIssue } from './desktop/errors.js';
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
  focus_window: 'Switching window…', move_pointer: 'Pointing…', click: 'Checking click…',
  scroll: 'Scrolling…', type_text: 'Preparing input…', press_key: 'Checking key press…', type_keyboard_text: 'Typing…',
};

/** Projects runtime events into optional UI; never makes requests or decisions. */
export function createFeedback(sink: FeedbackSink, activationHotkey = defaultActivationHotkey) {
  let turnId: string | undefined;
  let settled = false, closed = false;
  let closing: Promise<void> | undefined;
  let expiry: NodeJS.Timeout | undefined;
  let recovery: DesktopIssue | undefined;
  const clearExpiry = () => { clearTimeout(expiry); expiry = undefined; };
  const hide = () => { clearExpiry(); sink.send({ type: 'hide' }); };
  function show(title: string, message = '', detail = '', expires = false) {
    clearExpiry();
    sink.send({ type: 'show', title: clip(title, 160), message: clip(message, 4096), detail: clip(detail, 512) });
    if (expires) expiry = setTimeout(hide, 60_000);
  }
  return {
    handle(event: VoiceOutput) {
      if (closed) return;
      if (event.type === 'dismiss-feedback') { settled = true; recovery = undefined; hide(); return; }
      if (event.type === 'debug') return;
      if (event.type === 'state' && event.state === 'starting' && event.turnId) {
        hide(); // Clear the prior answer and let native placement follow the pointer display.
        turnId = event.turnId; settled = false; recovery = undefined;
      } else if ('turnId' in event && event.turnId && event.turnId !== turnId) return;
      if (event.type === 'state') {
        if (event.state === 'ready') { if (!settled) hide(); return; }
        if (event.state === 'cancelling') { settled = true; hide(); return; }
        if (!settled) show(stateTitles[event.state], '', recovery ? `Earlier warning: ${desktopMessages[recovery]}` : event.state === 'listening'
          ? `${activationHotkey} to finish · Escape to cancel` : 'Escape to cancel');
      } else if (event.type === 'cancelled') {
        settled = true; hide();
      } else if (event.type === 'result') {
        if (settled) return;
        settled = true;
        show(recovery ? 'OpenSaysMe · Earlier desktop warning' : 'OpenSaysMe', event.response,
          recovery ? `Earlier warning: ${desktopMessages[recovery]}` : `${activationHotkey} to reply · Full response in terminal`, true);
      } else if (event.type === 'error' || event.type === 'warning') {
        if (settled && event.type === 'warning') return;
        if (event.type === 'warning' && event.desktopIssue) recovery = event.desktopIssue;
        show(event.type === 'error' ? 'Couldn’t complete the request' : 'OpenSaysMe warning', event.message,
          'Details in terminal', true);
        if (event.type === 'error' || !turnId) settled = true;
      } else if (event.type === 'activity' && !settled) {
        const target = event.target ? [event.target.application, event.target.title].filter(Boolean).join(' — ') : 'Resolving target…';
        show(actionTitles[event.name] ?? 'Checking action…', target, recovery ? `Earlier warning: ${desktopMessages[recovery]}` : 'Escape to cancel');
      }
    },
    close(): Promise<void> {
      if (!closing) { closed = true; hide(); closing = sink.close(); }
      return closing;
    },
  };
}
