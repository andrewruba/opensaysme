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
- `--list-windows` discovers up to 128 windows and 128 running applications without
  raising them. Application records carry process identity, name, bundle ID when
  available, hidden/frontmost state, linked window IDs, and window-discovery status:
  `available`, `empty`, `inaccessible` or `incomplete`. Empty AX lists do not prove
  inactivity. Focused and main windows supplement AXWindows and are deduplicated
  by native identity; colliding title/identifier tokens remain ambiguous. A
  three-second discovery deadline reports omissions. Without Accessibility access,
  running applications remain discoverable with inaccessible window status.
  Focus/input resolution and capture-source validation reject known count/deadline
  truncation because an unseen window could share a target token; focused/main
  fallback remains available when AXWindows itself is empty or inaccessible.
- `--activate-application <id>` activates an already-discovered running process
  and verifies its foreground identity. This works without a listed window and
  never launches an executable, opens a document or sends keyboard input. The
  returned application metadata is fresh; discover current windows after activation.
- `--focus <id>` raises a matched window and verifies focus.
- `--context` reads current window, selection and pointer context without changing
  focus or using the clipboard.

Window IDs combine PID, validated kernel process start time and a hash of title/AX
identifier. This supports directly launched apps that lack a LaunchServices launch
date and rejects PID reuse. IDs are temporary: title changes and app restarts
invalidate them; identical candidates remain ambiguous.
Application IDs combine PID and the same process start identity, so recycled PIDs
and restarted applications cannot reuse an activation target. Activation verifies
foreground state for up to 1.5 seconds and reads bounded metadata for up to one
additional second; failed verification reports `focus-unverified` without claiming
that no focus change occurred.

`--inspect-window <id>` reads a bounded AX tree without focusing the window. It
rechecks source identity before and after. Limits are 128 elements, 16,384 UTF-16
text units overall and 2,048 per attribute, with short message timeouts. Nested
native containers do not impose a separate depth cutoff before web content.
Secure subtrees and failed protection checks are omitted before reading
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

`--inspect-input` and `--execute-input` accept strict JSON up to 1 MiB over stdin.
Text and target evidence do not appear in arguments or temporary files. Inspection
requires a focused, visible window, matching screenshot geometry and a native hit
on the intended AX control. Before reading values, pointer and keyboard input
check up to 64 ancestors through AXApplication for protected fields. The walk
has a deadline and rejects cycles, incomplete ancestry and unreadable protection
evidence. This accommodates deep web composers without traversing sibling values.

A fingerprint covers the actual control's role, labels, value, identifier, bounds,
focus/editability, window identity/geometry, pointer and HID counters. Execute
rechecks it immediately before dispatch. Held keys/buttons or a user focus/input
change reject the action. The whole window AX tree is neither traversed nor hashed:
unrelated badges, timers, fields or incomplete sibling trees do not block input.
This narrower check does not freeze other submission fields during a model call.

Literal text entry requires the intended control already focused and its AX value
settable. AXTextField supports single-line text; AXTextArea also supports literal
tab/LF/CR, with at most 65,536 UTF-16 units for captured-text transfers. The model's
literal `type_text` tool remains limited to 4,096 units. Native target evidence
retains the full value through the same 65,536-unit limit. Replacement writes
once, generates no key events and uses no clipboard. Readback may settle for up
to 300ms, or five seconds for text over 4,096 units, with cancellation checked
between reads. Only exact UTF-16 equality
reports `verified`; changed, normalized or unreadable results remain `uncertain`.
The finite reasons `text-write-failed`, `text-read-unavailable` and
`text-value-mismatch` distinguish setter failure from failed verification.
There is no retry write or fallback typing/paste.
Other control characters and DEL are rejected.

Pointer movement uses `CGWarpMouseCursorPosition`. Click and scroll use
the HID event stream after rechecking the validated application's foreground
window, so WindowServer routes the event to the control. Direct process posting
can produce AppKit mouse events with no target window. Complete click pairs defer
SIGTERM/SIGINT until release, then retain their event source and events through one
100ms delivery drain with cancellation unblocked; scrolling uses the same lifecycle.
The parent has a bounded SIGKILL fallback. Pointer position or text can be locally verified, while other
input reports only `issued`. Failures after possible dispatch are uncertain.
Rejected or uncertain input includes a finite `reason` when known, distinguishing
stale evidence, changed focus, held user input, unsupported targets, event creation
failures and unverified writes. Diagnostics never include captured values or raw
exception messages. A reason does not change whether an action may have occurred.

`--inspect-keyboard` reads the system's focused AX element, including accessory
interfaces such as Spotlight. The CLI initializes AppKit on its physical main
thread without activating before querying system focus. An unavailable
system focus rejects keyboard input; a remembered control in the foreground app
does not establish focus when an accessory interface owns the keyboard.
`--execute-keyboard` takes strict JSON containing a
typed action and that focus fingerprint over stdin. It supports named keys with
Cmd/Ctrl/Alt/Shift and literal single-line Unicode typing. Keys use physical US
positions; text does not. The keyboard fingerprint includes process launch identity,
focused control labels, identifiers, owning-window bounds and HID counters. The
owning-window target token binds its discovered identity even when an AX identifier
is available. Editable controls
also bind their value, selection and control bounds. Noneditable text areas and web
areas bind their index path within the owning window and use the window's bounds,
so same-labeled panes stay distinct while output and scrollback can grow. Finding
this path reads at most 16 parents and 512 direct siblings per parent, without
reading sibling values or traversing descendants. If the path or window bounds
are unavailable, the control's own bounds remain required. Other controls retain
their own bounds.
Keyboard typing and returned value previews remain limited to 4,096 UTF-16 units;
previews are marked when truncated.
Held keys/buttons, changed focus and protected fields reject dispatch. Typing needs
a text field or combo box even without a writable AX value; text areas must expose
a writable AX value or selected-text attribute, excluding terminal output.
Literal typing inserts at the current selection, unlike AX value replacement.
Escape, Ctrl+C, clipboard paste shortcuts and control characters in typed text are
rejected. Key events go through the HID event stream so system shortcuts work.
Keyboard evidence exposes the owning process-start `applicationId` and, when
available, its native `windowId`, including system interfaces without an enumerated
window. The application name is a label, not its identity. The owning-window token
is also included in the fingerprint, so retitling or replacing a target while a
permission check is pending rejects dispatch even when its AX identifier is stable.
Shortcuts include explicit modifier presses and releases around the main key;
each complete shortcut or text chunk defers termination until all keys are released.
Longer typing checks cancellation and focus between chunks. After posting any
events, the helper keeps the event source and events alive for one 100ms drain
before exiting, with cancellation unblocked. Partial typing is `uncertain`, never
retried automatically.

`--read-focused-text` captures a readable string AXValue from the current system
focus, including noneditable Terminal output. It returns `capturedAt`,
`application`, `role`, `title`, `description`, `windowTitle`, `text`, `start` and
`totalLength`. Labels are bounded to 256 units for application, 128 for role and
1,024 for the three titles/descriptions. After checking protected ancestry, it
reads one immutable value and retains its last 65,536 UTF-16 units, moving the
start past a split surrogate pair. Offsets refer to that snapshot:
`start + text.length == totalLength`. Focus identity and protection are rechecked
before returning. Unknown/protected ancestry, absent/nonstring values, changed
focus or the three-second deadline reject the read. The operation does not type,
change selection, read the clipboard or move focus.

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
nonactivating panel. `show` includes `title`, `message`, `detail`, a required
`expression` (`neutral`, `listening`, `thinking`, `focused`, `happy`, `concerned`) and a required
boolean `persistent`. Messages allow 32,768 UTF-16 units inside a 256 KiB JSONL
command. TextKit wraps the complete message in a scrollable reading area; the
panel grows to a bounded portion of the pointer's display. Completed responses
are persistent and accept scrolling and close-button clicks without taking focus.
Transient progress remains click-through, with a native deadline for stale content.
Persistent responses observe unmodified Escape locally and in other apps, without
consuming the key or competing with the voice helper's cancellation shortcut.
Observers are removed on hide, new progress, EOF and shutdown; stale callbacks
cannot dismiss a newer response. Global key observation requires Accessibility
access. If unavailable, the close button remains usable.
The panel clears text when hidden and closes on EOF, shutdown or signals. It emits
only `ready`. Full responses also remain in the terminal.
The monochrome ASCII portrait occupies the header's right side on a white panel
with system typography, leaving the answer width intact. Small panels omit it.
Blinking and outward-moving thought bubbles respect Reduce Motion;
the finishing sparkle stops after a short sequence. Dismissal and hiding stop
animation timers. After native tests, `native/macos/bin/feedback-tests --preview-dir
/tmp/opensaysme-overlay-preview` renders the real AppKit states to PNGs without
showing a panel or capturing the desktop.
For an optional observer check, run `native/macos/bin/feedback-tests
--escape-observer-smoke`. It registers real observers using existing Accessibility
access and delivers Escape only inside the test app, without posting keyboard
input to the desktop. Physical Escape delivery from another app is not exercised.
Discovery, targeting and display capture exclude windows belonging to the helper's
exact executable identity, rather than filtering by panel title.

## Validation

The synthetic native suites cover process identity, application target parsing,
focused/main-window fallback and deduplication, AX traversal/protected fields,
source matching and geometry, target fingerprints, literal text constraints,
capture initialization/main-thread behavior, activation shortcut validation,
audio timing/encoding and panel protocol/layout, including offscreen text wrapping,
scrolling and clearing. They do not record, capture screens, show the panel or issue input.
Use actual work to investigate app compatibility, hotkeys, display coordinates and
cancellation races; record a short observation rather than adding a new live runner.

Public API references: [Accessibility](https://developer.apple.com/documentation/applicationservices),
[ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit),
[AVAudioConverter](https://developer.apple.com/documentation/avfaudio/avaudioconverter).
