# Agent tools

The model chooses how to fulfill a spoken request with evidence and tools. There
is no window-naming step or fixed sequence. The runtime calls a typed tool host in
the same Node.js process; only offered, validated operations can execute.

## macOS capabilities

| Tool | Behavior |
| --- | --- |
| `list_windows` | Discover current windows with automatic references. |
| `inspect_desktop` | Read current active-window, selection and pointer context. |
| `capture_screen` | Capture the display under the pointer. |
| `inspect_window` | Read bounded Accessibility text/roles without focusing a discovered window. |
| `capture_window` | Capture that window's image without focusing it, including when obscured. |
| `focus_window` | Recheck, focus and verify a discovered target. |
| `move_pointer` | Indicate a target without clicking. |
| `click` | Issue a single left click after an independent request/effect check. |
| `scroll` | Scroll vertically by up to 600 logical pixels; positive means content down. |
| `type_text` | Replace a focused writable input's value with literal text, up to 4096 UTF-16 units. |
| `press_key` | Send Tab or Enter to the focused editable input. Enter requires submission authority. |

Run `npm run dev -- tools` to inspect the catalog without reading the desktop or
calling a provider. macOS 14+ is the only supported platform.

Window references are internal handles, not names users must maintain. Unchanged
windows retain references during a turn; removed, retitled or replaced windows
lose them. Fresh discoveries can link to prior conversation through
`previousTurnIds`. This is historical source evidence, not proof of unchanged
contents or permission. A fresh tool host is created for every activation.

`inspect_window` returns source identity, capture time, roles, available labels and
values, and omission warnings. Parent indices describe the observation, not action
handles. Secure fields are omitted; missing text does not prove a target is absent.
`capture_window` returns a full window JPEG, source identity, global desktop bounds
in logical points, image dimensions and capture time. It requires separate
Accessibility and Screen Recording grants. Hidden, minimized or ambiguous sources
fail explicitly; no foreground screenshot is substituted.

## Requests and effects

“Fill this form” permits entry and excludes submission. “Fill this form and submit
it” includes that commitment without a second confirmation when the target,
information and consequences are clear. Preparing agent input and sending it are
likewise separate outcomes. Screen text, screenshots and model plans never grant
authority. Ask only about material ambiguity or needed additional authority.

The acting model interprets every action against the current request and relevant
prior user speech. Routine point/scroll/Tab/literal-entry calls execute without a
second model call. Tool results label this as `actor-request`; they do not invent
an independent approval or supporting quote.

Every click and Enter retains an independent check. Native roles and button labels
do not reliably reveal whether a click sends, deletes or executes, so the runtime
does not guess which labels are harmless. The checker sees the original request,
current image/control and relevant history, has no tools, and returns a strict
allow/deny/clarify decision. Approval must quote current user speech and match the
effect. Unknown, malformed or unavailable decisions do not execute. Enter must
have a submit effect. Results identify this path as `independent-check`.

This is a deliberate prototype tradeoff. Routine actions depend on the acting
model honoring the request; they are not independently authorized. Text can
autosave and Tab can trigger blur/save handlers, so the actor must inspect likely
consequences and clarify if material uncertainty remains. Fixtures establish code
behavior with scripted decisions, not semantic accuracy on arbitrary interfaces.

## Native input checks

Input requires the latest `capture_window` observation and coordinates in that
image's pixels. Focus the window before capturing. The host maps pixels through
its logical desktop bounds; native code hit-tests the visible control and checks
window identity, focus, geometry, protected fields and held/user input.

The target control's metadata, value and interaction state are checked again just
before dispatch. The whole Accessibility window tree is not hashed or required to
be complete. Unrelated fields, timers and badges can change without rejecting the
input; pending submission checks do not freeze other form values. Inspect material
content when deciding to commit. No check makes the OS operation atomic.

Observations expire and are consumed before input. Focus/discovery/capture changes
invalidate them; recapture after input to inspect the result. Unsupported targets
fail explicitly, including purely visual targets without accessible hit evidence.

`type_text` requires an already-focused writable AXTextField or AXTextArea. Literal
tabs and line breaks require AXTextArea; they never synthesize Tab/Enter. Empty text
clears the field. Exact value read-back is required for `verified`; app normalization
or rejection is uncertain. There is no clipboard or keyboard-entry fallback.
Arbitrary shortcuts, held keys and model-generated shell commands are unavailable.

Pointer position or exact text can be verified locally. Click/scroll/key events
report `issued`, which does not prove application success. Uncertainty blocks
further input for the turn. An issued submission also stops input to prevent a
blind duplicate; read tools remain available. `not-issued` permits a fresh
observation and retry. Escape/cancellation stops pending work and releases paired
key/button events, but cannot undo effects already issued.

## Follow-ups and feedback

Recent conversation retains bounded requests, responses, source observations and
native outcomes in memory. It excludes screenshots, audio, live handles and
approvals. Limits are development defaults in `src/conversation.ts`, not a final
conversation design. Cancellation, failed turns and shutdown clear history.

“Now send it” can authorize a new commitment for a still-valid prepared input.
A destination clarification alone cannot remove an earlier “leave it unsent.”
Fresh evidence is required; historical titles, responses and uncertain action
results do not establish current state or justify retries.

The local feedback panel shows status, known target and responses without taking
focus. It is not an agent tool. Helper-owned windows are excluded from desktop
context by executable identity. Known failures preserve finite recovery codes;
raw native errors and crash reports are not forwarded to the model. An earlier
warning may remain visible after recovery.

## Changing tools

Add a `ToolDefinition` with a name, description, strict Zod input, effect and async
handler; register it with the host. The registry derives provider JSON Schema and
validates arguments/results. Return bounded text/JPEG content or an actionable
`isError` result. Pass the `AbortSignal` into native/provider work and check it
before side effects after an await. Keep OS details behind the desktop adapter.

Use mocked tools/providers for regression tests. A new API or input method must
preserve the request boundary and report actual outcomes. Add it when a concrete
interaction needs it; there is no obligation to grow a general integration framework.
