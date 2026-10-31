# macOS desktop helper

Build from source on the Mac where you run OpenSaysMe. The full interaction targets
macOS 14+ and requires Xcode Command Line Tools.

```sh
sh native/macos/build.sh
native/macos/bin/opensaysme-desktop --probe
sh native/macos/test.sh
```

The helper uses AppKit, Accessibility, AVFoundation, Carbon and ScreenCaptureKit.
Development builds are unsigned. Grants may belong to the launching terminal or
helper; after changing Privacy & Security settings, restart the launcher if access
still fails. Distribution/signing work is parked while the core loop is developed.

`--probe` is passive: no prompts, selection reads, recording, screenshots or focus
changes. The real voice run exercises access. Separate permission-verification,
hotkey/microphone test and credential-storage commands have been removed.

## Discovery and context

- `--inspect` returns the active window; `--inspect-selection` also reads selected
  text and rejects secure fields.
- `--list-windows` discovers accessible windows without raising them. Results are
  bounded and include warnings about inaccessible or ambiguous sources.
- `--focus <id>` raises a matched window and verifies focus.
- `--context` reads current window, selection and pointer context without changing
  focus or using the clipboard.

Window IDs combine PID, validated kernel process start time and a hash of title/AX
identifier. This supports directly launched apps that lack a LaunchServices launch
date and rejects PID reuse. IDs are temporary: title changes and app restarts
invalidate them; identical candidates remain ambiguous.

`--inspect-window <id>` reads a bounded AX tree without focusing the window. It
rechecks source identity before and after. Limits are 128 elements, eight child
levels, 16,384 UTF-16 text units overall and 2,048 per attribute, with short message
timeouts. Secure subtrees and failed protection checks are omitted before reading
values. Truncated or unavailable content yields warnings. Node indices describe
that observation; they are not reusable action handles. Calling the helper directly
prints the observed content, which can be private.

## Screenshots

`--frame` captures the display under the pointer. `--capture-window <id>` uses a
desktop-independent ScreenCaptureKit filter for a discovered window, including
when obscured. Window capture requires a unique normal-layer source matching the
AX process, title and bounds. It rechecks both source identities and geometry,
rejecting changed, hidden, minimized or ambiguous targets without a foreground
fallback. It never focuses the target.

Images are JPEG, at most 1,600 pixels on the long edge and 700 KB. Metadata includes
capture-request time, source, and global top-left bounds in logical desktop points.
Negative display origins and Retina scaling are represented in these bounds.
Pixels may be private or blank for protected content. Captures remain in memory
unless the TypeScript runtime enables debug persistence.

The async capture body runs on `@MainActor` through a synchronous run-loop bridge.
Each fresh helper initializes CoreGraphics with `CGMainDisplayID()` before creating
ScreenCaptureKit filters; omitting this caused the observed
`CGS_REQUIRE_INIT: did_initialize` crash. Capture work and parent processes have
bounded timeouts. A missing display, grant, unsupported system or crashed helper
returns a distinct failure rather than substitute pixels.

## Input

`--inspect-input` and `--execute-input` accept strict bounded JSON over stdin.
Text and target evidence do not appear in arguments or temporary files. Inspection
requires a focused, visible window, matching screenshot geometry and a native hit
on the intended AX control. Target ancestry is checked for protected fields;
unreadable protection evidence rejects the action.

A fingerprint covers the actual control's role, labels, value, identifier, bounds,
focus/editability, window identity/geometry, pointer and HID counters. Execute
rechecks it immediately before dispatch. Held keys/buttons or a user focus/input
change reject the action. The whole window AX tree is neither traversed nor hashed:
unrelated badges, timers, fields or incomplete sibling trees do not block input.
This narrower check does not freeze other submission fields during a model call.

Literal text entry requires the intended control already focused and its AX value
settable. AXTextField supports single-line text; AXTextArea also supports literal
tab/LF/CR, with at most 4,096 UTF-16 units. It replaces the whole value, generates
no key events and uses no clipboard. Exact read-back reports `verified`; a changed,
normalized or unreadable result is `uncertain`. There is no fallback typing/paste.
Other control characters and DEL are rejected.

Pointer movement uses `CGWarpMouseCursorPosition`. Click and scroll use
`CGEvent.postToPid` with the validated target application.
Down/up pairs briefly defer SIGTERM while queuing release; the parent has a bounded
SIGKILL fallback. Pointer position or text can be locally verified, while other
input reports only `issued`. Failures after possible dispatch are uncertain.

`--inspect-keyboard` reads the system's focused AX element, including accessory
interfaces such as Spotlight. If the system-wide lookup is unavailable, it queries
the current foreground application's AX focus, checking the foreground process
before and after the read and requiring the returned element to belong to it.
`--execute-keyboard` takes strict JSON containing a
typed action and that focus fingerprint over stdin. It supports named keys with
Cmd/Ctrl/Alt/Shift and literal single-line Unicode typing. Keys use physical US
positions; text does not. The keyboard fingerprint includes process launch identity,
focused control labels, identifiers, owning-window bounds and HID counters. A
window title is used only when no window identifier is available. Editable controls
also bind their value, selection and control bounds. Noneditable text areas and web
areas bind their index path within the owning window and use the window's bounds,
so same-labeled panes stay distinct while output and scrollback can grow. Finding
this path reads at most 16 parents and 512 direct siblings per parent, without
reading sibling values or traversing descendants. If the path or window bounds
are unavailable, the control's own bounds remain required. Other controls retain
their own bounds.
Returned values are bounded and marked when truncated.
Held keys/buttons, changed focus and protected fields reject dispatch. Typing needs
a text field or combo box even without a writable AX value; text areas must expose
a writable AX value or selected-text attribute, excluding terminal output.
Literal typing inserts at the current selection, unlike AX value replacement.
Escape, Ctrl+C, clipboard paste shortcuts and control characters in typed text are
rejected. Key events go through the HID event stream so system shortcuts work.
Shortcuts include explicit modifier presses and releases around the main key;
each complete shortcut or text chunk defers termination until all keys are released.
Longer typing checks cancellation and focus between chunks. After posting any
events, the helper keeps the event source and events alive for one 100ms drain
before exiting, with cancellation unblocked. Partial typing is `uncertain`, never
retried automatically.

The helper verifies mechanics and target evidence. Request interpretation belongs
to the acting model; the TypeScript host checks consequential keys/shortcuts and
clicks against the request, consumes observations, and stops input after submission
or uncertainty.
Direct local helper use does not interpret speech. OS dispatch is not atomic and
arbitrary application side effects cannot be proved from issued events.

## Voice and feedback

`--record-hotkey` temporarily records a physical activation shortcut for the CLI
prompt. It needs existing Accessibility permission and the foreground application
must be an ancestor of the helper (the terminal or editor that launched it). It
does not request permission or focus another app. After installing a session event
tap it emits `{"status":"ready"}`. Keep stdin open until the result arrives.
Key presses are suppressed while recording, so a Command shortcut is
not also sent to the terminal. Modifier changes pass through. It returns
`{"status":"captured","shortcut":"Cmd+Shift+Space"}` only after the key and
modifiers are released; Escape or Ctrl+C returns `{"status":"cancelled"}`.
Unsupported keys are ignored. No character strings are read or retained.

Focus leaving the original launching app/window, missing permission, unavailable capture, or the
30-second deadline returns `{"status":"unavailable","reason":"..."}` with
`focus-changed`, `accessibility-permission-required`, `capture-unavailable`, or
`timeout`. EOF, any stdin command, parent exit, SIGINT and SIGTERM cancel and remove
the event tap. A disabled tap fails instead of silently waiting without capturing.
The original AX focused-window identity is checked without reading titles or
window text; inability to establish it reports capture unavailable.
Detached terminal servers whose ancestry no longer includes the foreground app
cannot record shortcuts; run `osm hotkey` in a local terminal instead.
The CLI owns confirmation and saving.

`--voice [activation-hotkey]` is the persistent JSONL process. It registers the
configured shortcut without opening the microphone; the default is Ctrl+Shift+Space.
The shortcut is a `+`-separated list of Ctrl, Alt, Shift and Cmd modifiers followed
by Space, A–Z, 0–9 or F1–F12. At least Ctrl, Alt or Cmd is required. Letters and
digits use physical ANSI key positions. Duplicate modifiers, unknown keys, Escape
and any Ctrl+C combination are rejected before registration. Invalid shortcuts emit
`invalid-command`; unavailable registrations emit `hotkey-unavailable` without
falling back to another shortcut. `start` begins an activated turn and may request
microphone access. Audio is resampled to 24 kHz mono signed 16-bit PCM in bounded base64 chunks;
events include `capturedAt`, cumulative `startSample` and device/estimated timing.
Device timestamps map to a fixed wall-clock anchor. Missing timestamps use an
explicit estimate; discontinuities fail instead of silently misaligning context.

`stop` drains capture; `cancel` discards it. Escape is registered only during an
active turn and released on cancel/settle. EOF, shutdown, signals, slow consumers
and the capture deadline release microphone and hotkeys. Pointer samples accompany
recording and stop with it. No provider key or network access enters this process.

`--feedback` accepts bounded JSONL `show`, `hide` and `shutdown` messages for a
nonactivating, click-through panel. It clears text when hidden and closes on EOF,
shutdown or signals; a native deadline hides stale content. It stays on the
pointer's display and emits only `ready`. Full responses remain in the terminal.
Discovery, targeting and display capture exclude windows belonging to the helper's
exact executable identity, rather than filtering by panel title.

## Validation

The synthetic native suites cover process identity, AX traversal/protected fields,
source matching and geometry, target fingerprints, literal text constraints,
capture initialization/main-thread behavior, activation shortcut validation,
audio timing/encoding and panel protocol/layout. They do not record, capture screens,
show the panel or issue input.
Use actual work to investigate app compatibility, hotkeys, display coordinates and
cancellation races; record a short observation rather than adding a new live runner.

Public API references: [Accessibility](https://developer.apple.com/documentation/applicationservices),
[ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit),
[AVAudioConverter](https://developer.apple.com/documentation/avfaudio/avaudioconverter).
