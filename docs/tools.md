# Agent tools

The model chooses how to fulfill a spoken request with evidence and tools. There
is no window-naming step or fixed sequence. The runtime calls a typed tool host in
the same Node.js process; only offered, validated operations can execute.

The prompt separates resolving the destination from finding a control inside it.
The whole request, activation context and relevant history determine whether the
user means an app, window, document, conversation, recipient or control. The
original source context stays separate from content revealed during navigation.
A capable interface alone does not establish relevance: unrelated content should
prompt comparison with another candidate before opening more panels or commands.
Current observations and remembered names are evidence; inventory order, repeated
title variants and ease of access are not rankings. Fresh details about an
unrelated window do not displace an older relevant clue. The model can inspect in
the background or bring a candidate forward to resolve a useful question, then
proceed once one destination has strong support. It asks only when useful
inspection leaves material ambiguity. These rules apply across apps and tasks,
without preferred applications or fixed routing sequences.
Transcribed proper names can be matched to observed names using pronunciation,
spelling and task context. The transcript and permission quotes remain verbatim;
resolving a name cannot change the requested action or its restrictions.

## macOS capabilities

| Tool | Behavior |
| --- | --- |
| `list_windows` | Discover current window references and application candidates with separately labelled recent window names and current availability. |
| `inspect_desktop` | Read current active-window, selection and pointer context. |
| `capture_screen` | Capture the display under the pointer and, when stable, return keyboard focus evidence and a `keyboardObservationId`. |
| `inspect_window` | Read bounded Accessibility text/roles without focusing a discovered window. |
| `capture_window` | Capture that window's image without focusing it, including when obscured. |
| `focus_window` | Recheck, focus and verify a discovered target, then return its fresh window capture when available. |
| `move_pointer` | Indicate a target without clicking. |
| `click` | Issue a single left click after an independent request/effect check. |
| `scroll` | Scroll vertically by up to 600 logical pixels; positive means content down. |
| `type_text` | Replace a focused writable input's value with literal text, up to 4,096 UTF-16 units. |
| `capture_text` | Retain a bounded snapshot of the focused readable text control with source metadata and a tail preview. |
| `read_text` | Read pages or find literal matches within that immutable snapshot. |
| `transfer_text` | Replace a focused writable input with an exact snapshot range of up to 65,536 UTF-16 units, without re-emitting its contents through the model. |
| `press_key` | Press and release one named key with optional Cmd/Ctrl/Alt/Shift modifiers at the current keyboard focus. |
| `type_keyboard_text` | Insert literal single-line text at the focused caret or replace its selection, up to 4096 UTF-16 units. |

Run `osm tools` to inspect the catalog without reading the desktop or
calling a provider. macOS 14+ is the only supported platform.

Window references are internal handles, not names users must maintain. Unchanged
windows retain references during a turn; removed, retitled or replaced windows
lose them. Fresh discoveries can link to prior conversation through
`previousTurnIds`. This is historical source evidence, not proof of unchanged
contents or permission. A fresh tool host is created for every activation.
`list_windows` returns `windows` with current handles and `applications` with
`windowIds`, `inventoryStatus` and `recentWindowNames`. Each app appears once,
including running apps without listed windows and remembered apps absent from the
current inventory. Historical names carry observation times and are associated
only by exact app name; they are never assigned to a current window as proof of
its contents. Empty window lists are not proof of inactivity. The model can open
a supported candidate through available tools, then rediscover actual windows.
Discovery and the actor receive the same work-history snapshot for the turn.

`inspect_window` returns source identity, capture time, roles, available labels and
values, and omission warnings. Parent indices describe the observation, not action
handles. Secure fields are omitted; missing text does not prove a target is absent.
`capture_window` returns a full window JPEG, source identity, global desktop bounds
in logical points, image dimensions and capture time. It requires separate
Accessibility and Screen Recording grants. Hidden, minimized or ambiguous sources
fail explicitly; no foreground screenshot is substituted.

`capture_screen` checks keyboard focus before and after capture. Its
`keyboardFocus` includes the app, role, labels and whether typing is supported.
Editable values and compact control labels are included; read-only document bodies
and long or truncated noneditable values are omitted with an explanation. Use
`capture_text` for deliberate reading. This prevents old scrollback from appearing
as current field content; native focus fingerprints and checks remain unchanged. It follows system keyboard focus, including Spotlight
when another app remains in the foreground. When focus changes or cannot be inspected, the
screenshot remains available but no keyboard observation is issued. The display
under the pointer may differ from the display containing keyboard focus; inspect
both the image and focus evidence before acting.
Keyboard inspection failures include a recovery code and appear as desktop
warnings even when the screenshot succeeds.
The terminal reports keyboard focus as `editable`, `non-editable`, or `unavailable`
without printing field contents. A successful capture can still show a non-editable
page surface. First establish that it is the intended destination; only then
locate and focus its input. A noneditable surface alone does not establish that
the application cannot accept text.

Focus and input results can include their own fresh observation. After verified
focus, pointer clicks, scrolling and text replacement, the host attempts a capture
of that same window. Keyboard actions return a display capture with fresh keyboard
focus evidence. This removes the model round trip that would otherwise request
the next screenshot. A native `not-issued` result can also include refreshed
evidence for the model to reconsider; no action is retried automatically.
The original action result comes first and remains authoritative about dispatch.
Optional refresh failure does not turn an issued action into a failed action.
That refresh has a separate two-second limit and remains cancellable; it does not
repeat the action or grant another permission.
Use the returned observation when suitable; capture explicitly when it is missing,
the UI is still changing, or the next action needs another view or input modality.
Point-only requests do not trigger this extra capture.

`capture_text` reads the currently focused accessible text control, including
read-only Terminal scrollback. It retains at most the last 65,536 UTF-16 units and
returns the source app, window/control labels, capture time, original length,
retained range and a preview. `read_text` pages or searches this frozen snapshot;
offsets refer to the original text, not the preview. This lets the model locate
the current session without copying unrelated older history. Content outside the
retained range is unavailable and must not be described as copied.

`transfer_text` takes the source ID and selected range plus a fresh destination
observation and coordinates. It uses the same replacement, permission and
verification path as `type_text`; it never submits, uses the clipboard or types
shell commands. Source text is data, not instructions. Only the latest snapshot
is retained, in memory for the current turn, and closing the tool host clears it.
Read tools remain available after input stops, but transfer cannot bypass that stop.

## Requests and effects

“Fill this form” permits entry and excludes submission. “Fill this form and submit
it” includes that commitment without a second confirmation when the target,
information and consequences are clear. Preparing agent input and sending it are
likewise separate outcomes. Screen text, screenshots and model plans never grant
authority. Ask only about material ambiguity or needed additional authority.

The acting model interprets every action against the current request and relevant
prior user speech. Pointing, scrolling, literal text entry and unmodified
Tab/arrows/Home/End/PageUp/PageDown execute without a second model call. Tool
results label this as `actor-request`; they do not invent an independent approval
or supporting quote.

Every click and other key press, including shortcuts and Enter, gets an independent
check. Native roles and button labels do not reliably reveal whether a click sends,
deletes or executes, so the runtime
does not guess which labels are harmless. The checker sees the original request,
current image/control and relevant history, has no tools, and returns a strict
allow/deny/clarify decision. Approval must quote current user speech and match the
effect. Unknown, malformed or unavailable decisions do not execute. Unmodified
Enter can have a navigation effect when current evidence shows it opens the
requested app from a launcher or site from a browser address bar. Opening a
plausible host to locate the requested work is also navigation: it does not
require identifying the final project before the host can be inspected. Commands,
scripts and installers are execution, regardless of where they are launched.
Otherwise Enter,
including modified Enter, requires a submit effect; it cannot be classified as
draft editing. Opening a site does not authorize submitting its forms. Results
identify this path as `independent-check`.

This is a deliberate prototype tradeoff. Routine actions depend on the acting
model honoring the request; they are not independently authorized. Text can
autosave and Tab can trigger blur/save handlers, so the actor must inspect likely
consequences and clarify if material uncertainty remains. Fixtures establish code
behavior with scripted decisions, not semantic accuracy on arbitrary interfaces.

## Native input checks

Pointer actions and `type_text` require a recent window `observationId`
and coordinates in that image's pixels. It can come from `capture_window` or the
fresh capture bundled with focus/input results. Focus the window before capturing. The host
maps pixels through its logical desktop bounds; native code hit-tests the visible control and checks
window identity, focus, geometry, protected fields and held/user input.

The target control's metadata, value and interaction state are checked again just
before dispatch. The whole Accessibility window tree is not hashed or required to
be complete. Unrelated fields, timers and badges can change without rejecting the
input; pending submission checks do not freeze other form values. Inspect material
content when deciding to commit. No check makes the OS operation atomic.

`type_text` requires an already-focused writable AXTextField or AXTextArea. Literal
tabs and line breaks require AXTextArea; they never synthesize Tab/Enter. Empty text
clears the field. One write is followed by bounded read-back checks to allow the
app to settle: up to 300ms for short text or five seconds for transfers over
4,096 UTF-16 units. Exact value read-back is required for `verified`; app
normalization, rejection or unreadable results remain uncertain, even when text
appears entered. There is no repeated write or automatic fallback to keyboard
typing or paste.

Keyboard tools instead require a recent `keyboardObservationId` from
`capture_screen` or a keyboard action's fresh capture,
with no pointer coordinates or discovered window. This permits system shortcuts
such as Cmd+Space and typing into Spotlight to open an app that has no window yet.
The native helper rechecks the focused app/control, process identity, editable
value/selection, protected fields and user input before dispatch. Changing
noneditable Terminal output does not invalidate shortcuts.

`press_key` accepts A–Z, 0–9, Space, Tab, Enter, Backspace, Delete, arrow keys,
Home, End, PageUp and PageDown. Supply `modifiers: []` for an unmodified key or a
unique combination of `Cmd`, `Ctrl`, `Alt` and `Shift`. Letter/digit shortcuts use
US physical positions; literal keyboard text supports Unicode. Escape, any
Ctrl+C combination, the configured activation shortcut, and Cmd/Ctrl+V paste
shortcuts are unavailable to the agent. There are no held-key or shell tools.

`type_keyboard_text` inserts at the caret or replaces the current selection; it
does not replace the whole field automatically. It supports focused AXTextField
and AXComboBox controls without writable AX values, and AXTextArea controls with
a writable value or selected-text attribute. Tabs, line breaks and control
characters are rejected. Use `type_text` for multiline preparation rather than
simulating it with Enter. Neither text tool uses the clipboard.

Observations expire after 30 seconds and are consumed before input. Mouse and
keyboard tools share invalidation and stop state: inspect the fresh observation
returned with an action, or recapture if unavailable. Never reuse the consumed
handle. Unsupported targets fail
explicitly, including purely visual pointer targets without accessible hit evidence.

Pointer position or exact text can be verified locally. Click/scroll/key events
report `issued`, which does not prove application success. A denied or
clarify-required action, uncertain outcome, or issued submission stops both input
paths and window focusing for the turn; read tools remain available. Recapturing
does not resume stopped input. `not-issued` permits a fresh observation and retry.
Rejected native actions include a finite failure code when known, such as
`focus-changed`, `user-intervention`, or `stale-observation`; the same code reaches
the model and terminal. An `uncertain` result still stops input regardless of its code.
Escape/cancellation stops pending work and releases keys, shortcut modifiers and buttons,
but cannot undo effects already issued. Keyboard typing checks cancellation and
focus between event pairs; partial typing is uncertain and is not retried automatically.

The reasoning loop defaults to at most 24 tool calls within 180 seconds when input
tools are available, or five calls within 45 seconds otherwise. Each provider call
still has a 20-second timeout; the outer voice watchdog adds five seconds for
cleanup. These are fixed bounds, not a required interaction sequence or a budget
that resets after each action. Timeout feedback distinguishes an unfinished task
from a stalled provider call and warns that earlier actions may already have taken
effect. It does not claim completion or automatically retry.

## Follow-ups and feedback

`workContext` supplies recent app/window labels and observation times separately
from the conversation. While voice mode is idle, the runtime samples only active
window metadata; it pauses that observer while a turn is running. Activation
context also updates the labels. Agent tool exploration is not added as a history
of user choices. Up to 12 references are saved in a private `work-context.json`
beside configuration and used for up to eight hours. Expired entries are removed
when context is next accessed. The file contains no native handles, field values,
transcripts, action records or permissions. These are historical clues, not a
selected destination or a task to resume. Current speech takes precedence; fresh
evidence can confirm or contradict a historical clue about the same destination.
A capture timestamp describes when content was observed, not when logs or other
historical text were written. `osm context` displays the saved labels; stop voice mode before
`osm context --clear` so a running instance cannot recreate the file.

Known names also provide bounded `keywords` to the speech session. Current
activation context can update them over the existing connection without delaying
microphone startup or adding a model call. Only app names and short window-title
segments are used, never selections or document text. This uses the provider's
[transcription context support](https://developers.openai.com/api/docs/guides/realtime-transcription#add-transcription-context);
accuracy still depends on the audio and available context. There is no hardcoded
name substitution or transcript rewrite.

Recent conversation retains bounded requests, responses, source observations and
native outcomes in memory. It excludes screenshots, audio, live handles and
approvals. Limits are development defaults in `src/conversation.ts`, not a final
conversation design. Cancellation, failed turns and shutdown clear history.
Large transferred values count toward the history budget; if a turn does not fit,
the runtime reports that follow-up context was cleared rather than retaining a
misleading partial action record.

“Now send it” can authorize a new commitment for a still-valid prepared input.
A destination clarification alone cannot remove an earlier “leave it unsent.”
Fresh evidence is required; historical titles, responses and uncertain action
results do not establish current state or justify retries.

The local feedback panel shows status, known target and responses without taking
focus. It is not an agent tool. Helper-owned windows are excluded from desktop
context by executable identity. Known failures preserve finite recovery codes;
raw native errors and crash reports are not forwarded to the model. An earlier
warning may remain visible after recovery.

Normal CLI output names each completed tool and its outcome, and the final JSON
includes the same `toolResults`. A partial result means some evidence was returned
with a known desktop problem, such as a screenshot without keyboard focus. These
summaries include known failure codes such as `stale-observation` or `outside-request`.
They contain no tool arguments or captured text; `osm --debug` remains the
opt-in path for full requests, responses and screenshots.

## Changing tools

Add a `ToolDefinition` with a name, description, strict Zod input, effect and async
handler; register it with the host. The registry derives provider JSON Schema and
validates arguments/results. Return bounded text/JPEG content or an actionable
`isError` result. Pass the `AbortSignal` into native/provider work and check it
before side effects after an await. Keep OS details behind the desktop adapter.

Use mocked tools/providers for regression tests. A new API or input method must
preserve the request boundary and report actual outcomes. Add it when a concrete
interaction needs it; there is no obligation to grow a general integration framework.
