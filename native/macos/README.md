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

Pointer movement uses `CGWarpMouseCursorPosition`. Click, scroll and unmodified
Tab/Return use `CGEvent.postToPid`; keys require the same focused editable input.
Down/up pairs briefly defer SIGTERM while queuing release; the parent has a bounded
SIGKILL fallback. Pointer position or text can be locally verified, while other
input reports only `issued`. Failures after possible dispatch are uncertain.

The helper verifies mechanics and target evidence. Request interpretation belongs
to the acting model; the TypeScript host adds an independent check for clicks and
Enter, consumes observations, and stops input after submission or uncertainty.
Direct local helper use does not interpret speech. OS dispatch is not atomic and
arbitrary application side effects cannot be proved from issued events.

## Voice and feedback

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
