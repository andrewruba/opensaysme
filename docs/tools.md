# Agent tools

The agent chooses how to fulfill a request using available evidence and tools.
There is no window-naming step, frontend/backend heuristic, or fixed sequence of
actions. A tool catalog describes capabilities; the model decides when they help.

The voice runtime calls the tool host directly in the same Node.js process. The
provider loop uses its catalog to discover capabilities and return tool results
to the model.

## Current capabilities

V1 targets macOS 14+ only. Existing Windows/Linux adapters remain available for
development; completing those platforms is deferred until after v1.

| Tool | Behavior |
| --- | --- |
| `list_windows` | Discover application/window titles and automatic references. |
| `inspect_desktop` | Read active-window, selection, and pointer context. |
| `capture_screen` | Capture the current pointer display, or X11 virtual desktop. |
| `inspect_window` | Read bounded accessibility text/control roles from a discovered window without focusing it (macOS only). |
| `capture_window` | Capture a discovered window's own image without focusing it, including when obscured (macOS 14+). |
| `focus_window` | Recheck a discovered target, focus it, and verify the result. |
| `move_pointer` | Indicate a target without clicking (macOS input tools require a recent window screenshot). |
| `click` | Issue a single left click on a visible, accessible target after a request/effect check. |
| `scroll` | Scroll vertically at the target by up to 600 logical pixels; positive means content down. |
| `type_text` | Replace the entire value of a writable Accessibility input with literal text, up to 4096 UTF-16 code units. Line breaks and tabs require AXTextArea; empty text clears it. |
| `press_key` | Send unmodified Tab or Enter to the focused editable input; Enter always requires submission authority. |

Window references are internal tool handles. Unchanged windows keep their references
across relisting; removed, retitled, or replaced windows lose theirs. They are never
names the user must organize. Voice creates a fresh tool host per activated turn
and closes it on completion or cancellation. Native tokens remain temporary:
macOS title changes and process restarts can invalidate targets. Ambiguous and
inaccessible windows are omitted with warnings. Same-process window-handle reuse
remains a platform limitation.
Focus also rechecks the title evidence; a changed title prompts rediscovery.
Fresh window labels can include `previousTurnIds` for retained turns whose native
window identity, application and title match. This links historical evidence to a
current tool handle; it neither proves unchanged contents nor grants permission.

`inspect_window` returns its source window, capture time, control roles, available
titles/descriptions/string values, and omission warnings. Parent indices describe
only this observation; they are not action handles. The helper resolves the target
before and after reading; changed or ambiguous source identities discard the result.
Inspection reads fresh content without focusing the window or reading the clipboard.
Bounded textual observations can enter recent conversation after the turn completes.
Permission denial and unavailable content are explicit tool errors. The catalog
omits this tool on Windows/Linux, where no implementation exists yet.

`capture_window` provides visual evidence when text is insufficient or a screenshot
better fits the request. It returns a full window JPEG, source identity, capture
time, global desktop bounds in logical points, and actual image dimensions in pixels.
Coordinates within the image are local to that window; they do not share a display
history frame's origin or cursor trails. Bounds describe the observation, not a
guarantee that a future click would hit the same content.

The macOS helper requires a unique match between the discovered window and a
ScreenCaptureKit window using process, title, and geometry. It revalidates both
sources after capture and discards images if the window changes. Hidden, minimized,
unmatched, and ambiguous windows fail explicitly, with no focus/restore operation
or foreground-screen fallback. Accessibility and Screen Recording grants are
required separately. Pixels may contain private data and are not redacted; protected
or non-rendered content may be blank. Normal captures stay in memory; opt-in debug
bundles save tool images. The catalog omits window capture on Windows/Linux.

Accessibility may expose little content; omitted or
truncated text does not prove that a window cannot match. Identical native window
identities remain ambiguous even when content might distinguish them. Broader
platform coverage is deferred until after v1. Shared input tools do not depend on choosing a
dedicated agent integration. See the
[product backlog](../BACKLOG.md) for delivery order and acceptance trials.

The macOS feedback panel is local runtime UI, not an agent tool. During focus/input
calls, it displays target labels resolved from the host's stored window or current
input-observation evidence. Unknown, expired or consumed references provide no
target label. Labels do not grant permission or prove success. Helper-owned windows
are excluded from discovery, targeting and ScreenCaptureKit display captures by
executable identity, so panel text is not deliberately fed back as desktop context.

## Input and execution permissions

The request defines the authorized outcome. “Fill this form” permits filling it
and stops before submission; “fill this form and submit it” also permits submission
without another confirmation when the target, contents, and consequences match.
Likewise, populating an agent input and sending it are distinct effects. Ask when
material ambiguity remains or additional authority is needed, not after every step.

The macOS implementation retains the current finalized spoken request, its desktop
reference context and bounded recent conversation in a fresh tool host. Before each
input, an independent call to the configured reasoning model checks that exact action
against current speech, relevant prior user requests, the window image and freshly
inspected native control. The acting model cannot supply
an approval, permission scope, or effect label. The guard has no tools, sees UI and
proposed input as untrusted evidence, and must return a strict decision with an exact
supporting excerpt from the current speech. Malformed, unavailable, denied, unknown,
or materially ambiguous decisions issue no input. This is an internal check, not a
user confirmation after every step. Explicit applicable submission requests suffice.
The provider uses [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

Effect interpretation is model-dependent, not a deterministic guarantee about
arbitrary application behavior. Fixtures test enforcement of decisions; live model
accuracy, prompt injection resistance and application effects still need acceptance
trials. Text may autosave and Tab may save on blur; the guard must account for such
effects. Enter cannot pass an edit-only decision, even where it would insert a
newline. C0 controls other than literal tab, LF and CR, DEL, arbitrary shortcuts, held keys/buttons,
clipboard operations and model-supplied shell commands are unavailable. Existing
`focus_window` is still governed by the acting model's navigation instructions;
the independent gate currently covers the five input tools.

Input tools require `observationId` from the most recent successful `capture_window`
and `x`/`y` in that image's pixel coordinates. Focus the window before capturing the
action observation. The host maps pixels through the captured global logical bounds;
native code hit-tests the actual visible control and checks window identity, focus,
geometry, protected fields, and whether keys/buttons are held. Immediately before
input it checks the same control evidence and an interaction fingerprint again.
Movement, focus changes and user input during authorization can reject the action.
The fingerprint also hashes the bounded Accessibility content of the whole window,
so a changed form field can invalidate a pending Submit click even when the button
is unchanged. Input requires a complete traversal of the exposed tree: truncated,
protected or inaccessible subtrees reject the action. Hidden/virtualized application
state is still unavailable, and this does not make capture, inspection and input atomic.
The observation expires after 30 seconds and is consumed before input; a focus
operation, rediscovery, new capture, or any issued input invalidates it. Recapture
to inspect the result before another action. Purely visual targets without accessible
hit-test evidence are not yet supported.

`type_text` uses a direct Accessibility value write, avoiding clipboard changes and
synthetic key events. It supports single-line text in writable AXTextField or
AXTextArea controls; line breaks and tab indentation require AXTextArea. Literal
newlines do not invoke Enter or authorize sending. It replaces the entire value,
preserves the supplied text without newline normalization, and reports `verified`
only when exact read-back matches. Applications that normalize, truncate or reject
the value yield an uncertain outcome; unsupported controls reject entry without
a keyboard or clipboard fallback. Other C0 controls, DEL and oversized text
are rejected. Keyboard input goes only to the validated process
and requires the intended editable control to remain focused. Text value equality
or pointer position can be verified locally; click/scroll/key events report `issued`,
which does not prove the intended application outcome. Any uncertain native result
stops input for the turn, including transport failure after execution may have begun.
A submission decision also stops subsequent input after one issued action, preventing
blind repeat submissions. Read tools remain available to inspect and report. A native
`not-issued` result permits a fresh observation and retry. Cancellation stops pending
work; it cannot undo effects already issued. The remaining OS dispatch race and
same-evidence control replacement are not eliminated by these checks.

Tool handles, observations and permission decisions end with the turn. Recent
conversation preserves requests, assistant responses, window/control observations
and native outcomes for up to three turns, 64 KiB total, and two minutes per turn.
It excludes screenshots and audio. Action targets record pre-dispatch control
values; `action.text` describes a requested replacement, whose outcome is established
only to the extent reported by native status. The actor and guard use prior user speech to
interpret a current follow-up or clarification answer; assistant responses and
historical evidence cannot expand authority. “Now submit it” may authorize a new
commitment after filling; a destination clarification alone cannot. Fresh discovery,
capture and native inspection remain required. Changed-content and prior-commitment
comparison across turns is model-dependent, not a deterministic fingerprint check.
Cancellation, failed turns and shutdown clear recent context. Escape in the CLI terminal
also clears context while idle; the global Escape shortcut applies only during a turn.
An invalid or individually oversized turn clears it rather than dropping user constraints.

Each guard call adds provider usage and up to ten seconds of latency. No live provider or
desktop input trial has established completion accuracy or latency yet. Routine
tests use scripted provider responses to check tool behavior and permission
enforcement; they do not establish model permission accuracy or successful native input.

Window capture distinguishes a helper terminated by a signal (`helper-crashed`)
from an explicit permission denial or timeout. No image or input observation is
returned after a crash. Unexpected tool failures report an unknown cause rather
than attributing them to permissions; native output and crash-report contents are
not forwarded to the model.

## Inspect the catalog

```sh
npm run dev -- tools   # Catalog only; no desktop reads or provider calls
```

Run `npm run dev` for the voice interaction. See [development instructions](development.md)
for provider setup and desktop permissions.

## Add a capability

Define a `ToolDefinition` with a name, description, strict Zod input object, effect,
and async handler. Register it in the host. The registry derives JSON Schema for
provider function calling and validates arguments and results locally.
Input properties must be required (use nullable values where appropriate).

Return text or JPEG content, or a bounded `isError` result with actionable guidance.
Handlers receive an `AbortSignal`; pass it to OS/provider work and check it before
any side effect or state update after an await. Keep OS details in platform adapters.
Descriptors distinguish read, focus, and input. Adding other consequential
capabilities requires the request-scoped execution policy described above, alongside
tests for authorized, unauthorized, ambiguous, stale-target, and cancelled actions.

The registry bounds read/focus calls to six seconds and input calls to twenty seconds
(native inspection, up to ten seconds of authorization, then native revalidation/input).
Without input capabilities the loop allows six model requests/five tools within 45
seconds. With input it allows thirteen model requests/twelve tools within 90 seconds;
each acting-provider request has a 20-second deadline. It replays tool results and
reasoning context with `store: false`; independent checks also use `store: false`.
It does not run arbitrary shell commands or load model-supplied code. Normal runs
release images at the end of the turn and retain only the bounded recent conversation
described above. `--debug` saves numbered requests, including recent conversation,
and tool exchanges; these files remain until deleted. Provider keys, raw audio,
and opaque encrypted reasoning are excluded.

Use mocked adapters for routine tests. Test validation, cancellation, stale targets,
and errors at the tool boundary; test provider sequencing with fixture responses.
