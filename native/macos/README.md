# macOS desktop helper

Build on macOS 12 or later with Xcode Command Line Tools:

```sh
sh native/macos/build.sh
native/macos/bin/opensaysme-desktop --probe
```

The helper uses public AppKit and Accessibility APIs. `--probe` checks the current
desktop and authorization without prompting, changing focus, reading selections,
capturing screenshots, or recording. An absent Accessibility grant is reported with setup instructions.
Authorization can depend on the launching terminal and helper signature; rerun
the probe after granting it. Development builds are unsigned; stable signing and
prebuilt Intel/Apple Silicon distribution are still release work.
Local binaries and compiler caches are excluded from npm packages; build the
helper on the target Mac for this source prototype.

Explicit commands `--inspect` and `--inspect-selection` return JSON. Only the
second reads the current selection; secure fields are rejected. `--focus <id>`
uses an ID from inspection, raises the matched window, and verifies its focus.
It never simulates copy/paste or changes the clipboard.

`--list-windows` lists accessible windows of regular applications without raising
them or reading selections. It retains up to 128 windows, stops discovery after
three seconds, and reports inaccessible, ambiguous, or truncated results. Rebuild
the helper after updating to make this operation available.

Window IDs combine process launch identity with a hash of the window's title and
AX identifier. They are temporary: title changes and app restarts invalidate
them, and identical windows fail as ambiguous. Applications vary in Accessibility
support, so this is a feasibility adapter rather than universal window targeting.

Interactive tests are separate, deliberate commands:

```sh
native/macos/bin/opensaysme-desktop --test-hotkey 10
native/macos/bin/opensaysme-desktop --test-microphone 5
```

The hotkey test temporarily registers Ctrl+Shift+Space and waits for you to press
it. The microphone test may request recording permission, counts incoming frames,
and discards every buffer without saving or transmitting audio. Its usage
description is embedded in the binary. Both tests are bounded to 1–30 seconds,
handle termination, and release resources on exit. The microphone deadline
includes time spent waiting for permission. A passing frame test proves input
delivery, not speech intelligibility. Doctor never performs these tests.

`--context` captures the active window, available selection, pointer coordinates,
and the accessible window under that fixed pointer position. Capture is best
effort: unavailable or secure selections are omitted, missing Accessibility
permission produces warnings and null window targets, and focus never changes.
Coordinates use the top-left desktop coordinate system, including negative
coordinates on some monitor arrangements. This operation does not read the
clipboard or capture pixels.

`--frame` captures the display under the pointer through ScreenCaptureKit on
macOS 14 or later. Screen Recording permission is separate from Accessibility
and microphone access. Grant it to the launching terminal/helper in System
Settings > Privacy & Security, then restart the terminal; a missing grant returns
an explicit error without prompting repeatedly. Older systems report screenshot
capture unavailable while retaining the existing desktop and voice operations.
Frames stay in memory and are emitted as JPEG JSON, with a maximum 1600-pixel long
edge and 700 KB encoded image size. Display bounds use the same global logical
coordinates as pointer samples; scaled image pixels map proportionally into those
bounds, including Retina displays and monitors with negative origins. The timestamp
marks the screenshot request, so delivery/processing delay must remain separate.
Screen frames and selected context are sent to the configured reasoning provider
by the CLI for action previews; the helper itself has no provider access.

`--voice` runs the persistent JSONL helper used by the CLI. It registers
Ctrl+Shift+Space without opening the microphone. A `start` command begins one
turn and may prompt for microphone permission. Audio is resampled to 24 kHz mono
signed 16-bit little-endian PCM, sent in bounded base64 chunks, and never saved.
Each audio chunk includes its first sample's UTC `capturedAt`, cumulative 24 kHz
`startSample`, and `timing`. Device host timestamps are mapped to a fixed wall-clock
anchor before queueing and adjusted for resampling and final converter output.
Missing device timestamps use an explicitly `estimated` sample clock; discontinuous
device times or a stalled estimate fail the turn instead of silently misaligning it.
`stop` drains the microphone before acknowledging completion; `cancel` discards
it. Escape is registered only during an active turn, including transcription,
and is released by `cancel` or `settled`. Key repeat does not retrigger turns.
EOF, shutdown, signals, failed output, and the 120-second capture limit release
capture and hotkeys. Slow consumers cause a bounded failure instead of unbounded
audio buffering. No provider key or network request enters this helper.
During the activated recording interval, changed pointer positions emit `pointer`
events at up to 20 Hz with a fractional-second UTC capture timestamp and display
ID. Sampling also covers microphone startup, stops on the finishing tap or
cancellation, and stays off during transcription/preview processing. Cursor paths
carry attention evidence only; the helper does not recognize gesture categories.

Run native conversion and protocol checks without microphone access:

```sh
sh native/macos/test.sh
```

These checks convert and timestamp synthetic 44.1/48 kHz mono/stereo buffers,
including delayed delivery, resampler tail, clock gaps, and turn reset; reject invalid
commands, exercise pointer sampling lifecycle, and encode a bounded synthetic JPEG
with display coordinates. They never capture the screen. Native compilation and protocol checks do not establish microphone
quality, real hotkey delivery, or AX behavior in every application; those require
the deliberate CLI flow in a logged-in session with the appropriate permissions.

Reference APIs: [AXIsProcessTrusted](https://developer.apple.com/documentation/applicationservices/1460720-axisprocesstrusted),
[NSRunningApplication](https://developer.apple.com/documentation/appkit/nsrunningapplication),
and [microphone authorization](https://developer.apple.com/documentation/avfoundation/avcapturedevice/authorizationstatus(for:)).
Streaming uses [AVAudioConverter](https://developer.apple.com/documentation/avfaudio/avaudioconverter/convert(to:error:withinputfrom:));
pointer targets use [Accessibility hit testing](https://developer.apple.com/documentation/applicationservices/1462077-axuielementcopyelementatposition).
Screenshots use [SCScreenshotManager](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager).
