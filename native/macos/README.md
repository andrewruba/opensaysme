# macOS desktop helper

Build on macOS 12 or later with Xcode Command Line Tools:

```sh
sh native/macos/build.sh
native/macos/bin/opensaysme-desktop --probe
```

The helper uses public AppKit and Accessibility APIs. `--probe` checks the current
desktop and authorization without prompting, changing focus, reading selections,
or recording. An absent Accessibility grant is reported with setup instructions.
Authorization can depend on the launching terminal and helper signature; rerun
the probe after granting it. Development builds are unsigned; stable signing and
prebuilt Intel/Apple Silicon distribution are still release work.
Local binaries and compiler caches are excluded from npm packages; build the
helper on the target Mac for this source prototype.

Explicit commands `--inspect` and `--inspect-selection` return JSON. Only the
second reads the current selection; secure fields are rejected. `--focus <id>`
uses an ID from inspection, raises the matched window, and verifies its focus.
It never simulates copy/paste or changes the clipboard.

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
coordinates on some monitor arrangements. No screenshots or clipboard reads
are involved. The CLI keeps this context local in the current voice slice.

`--voice` runs the persistent JSONL helper used by the CLI. It registers
Ctrl+Shift+Space without opening the microphone. A `start` command begins one
turn and may prompt for microphone permission. Audio is resampled to 24 kHz mono
signed 16-bit little-endian PCM, sent in bounded base64 chunks, and never saved.
`stop` drains the microphone before acknowledging completion; `cancel` discards
it. Escape is registered only during an active turn, including transcription,
and is released by `cancel` or `settled`. Key repeat does not retrigger turns.
EOF, shutdown, signals, failed output, and the 120-second capture limit release
capture and hotkeys. Slow consumers cause a bounded failure instead of unbounded
audio buffering. No provider key or network request enters this helper.

Run native conversion and protocol checks without microphone access:

```sh
sh native/macos/test.sh
```

These checks convert synthetic 44.1/48 kHz mono/stereo buffers and reject invalid
commands. Native compilation and protocol checks do not establish microphone
quality, real hotkey delivery, or AX behavior in every application; those require
the deliberate CLI flow in a logged-in session with the appropriate permissions.

Reference APIs: [AXIsProcessTrusted](https://developer.apple.com/documentation/applicationservices/1460720-axisprocesstrusted),
[NSRunningApplication](https://developer.apple.com/documentation/appkit/nsrunningapplication),
and [microphone authorization](https://developer.apple.com/documentation/avfoundation/avcapturedevice/authorizationstatus(for:)).
Streaming uses [AVAudioConverter](https://developer.apple.com/documentation/avfaudio/avaudioconverter/convert(to:error:withinputfrom:));
pointer targets use [Accessibility hit testing](https://developer.apple.com/documentation/applicationservices/1462077-axuielementcopyelementatposition).
