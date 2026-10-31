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

`--permissions` is the read-only setup report. It returns microphone, Accessibility
and Screen Recording grant states separately, the helper path/bundle identifier,
and a bounded search for the nearest observed launcher application in the parent
process chain. The observed launcher is guidance, not proof of which identity macOS
uses for a particular grant. The report requests no access and reads no window
titles, selected text, microphone frames or screenshots.

After explicit setup consent, `--verify-permission microphone|accessibility|screenCapture`
may request that permission and verify it locally. Microphone verification receives
up to three seconds of frames and retains only a count; Accessibility reads the
focused window's role without changing focus; screen verification captures one
frame and discards its image inside the helper. Only a permission name and finite
outcome code leave the helper. No capture data is printed, saved or sent to a
provider. The operation has a twenty-second deadline and the parent enforces a
twenty-five-second process timeout. Cancellation releases microphone resources.
Permission prompts may need a Settings change or launcher restart before a new
check can pass. A reported grant alone is not successful verification.

The setup checks have synthetic protocol, grant-state and launcher-ancestry tests;
actual grant prompts, revocation/restarts and device behavior require manual macOS
validation. `--probe` and the public `doctor` command remain read-only.

Explicit commands `--inspect` and `--inspect-selection` return JSON. Only the
second reads the current selection; secure fields are rejected. `--focus <id>`
uses an ID from inspection, raises the matched window, and verifies its focus.
It never simulates copy/paste or changes the clipboard.

`--list-windows` lists accessible windows of regular applications without raising
them or reading selections. It retains up to 128 windows, stops discovery after
three seconds, and reports inaccessible, ambiguous, or truncated results. Rebuild
the helper after updating to make this operation available.

Window IDs combine PID and kernel process start time (microseconds, read with
Darwin `sysctl` / `KERN_PROC_PID`) with a hash of the window's title and AX identifier.
The kernel query must return a complete record with the matching PID and a valid
start time. This supports directly launched executables, for which LaunchServices
does not supply `NSRunningApplication.launchDate`, while rejecting reused PIDs.
They are temporary: title changes and app restarts invalidate
them, and identical windows fail as ambiguous. Applications vary in Accessibility
support, so this is a feasibility adapter rather than universal window targeting.

`--inspect-window <id>` reads accessibility content from a discovered window without
activating it. Rebuild the helper to enable the `inspect_window` agent tool. It
returns capture time, source identity, and a bounded tree of roles, titles,
descriptions, and string values. It resolves the window before and after reading;
changed, closed, or ambiguous sources discard the result. This does not make the
content atomic or detect every edit inside an unchanged window.

Traversal stops at 128 elements, eight child levels, 16,384 UTF-16 text units total,
or its time budget (at most 1.5 seconds for content within a three-second operation).
Individual text attributes are limited to 2,048 units during public inspection.
Input revalidation allows values up to 4,096 units so prepared text remains fully
covered by the fingerprint; the total text budget is unchanged. Reads use short Accessibility
message deadlines; the parent also cancels the child at four seconds. Secure text
fields and their descendants are skipped before reading labels or values. Failed
protection checks skip that subtree. Truncation, inaccessible elements, and protected
content produce omission warnings. Apps may expose only part of their content, and
virtualized/off-screen text may be absent. No clipboard reads or screenshots are
performed. Node parent indices describe this observation and cannot be used as
action handles. The voice runtime retains content only for the activated turn;
opt-in debug bundles retain tool results. Calling the helper directly prints the
captured content as JSON on stdout.

`--capture-window <id>` captures a discovered window on macOS 14+ using
ScreenCaptureKit's desktop-independent window filter. It requires Accessibility
for targeting and Screen Recording for pixels. A unique normal-layer capture
source must match the AX window's process, title, and bounds (within one logical
point for cross-API rounding). The AX inventory must also identify only one window
that could match those capture bounds, so a missing capture source cannot silently
select another AX window. Both AX identity/geometry and ScreenCaptureKit
window ID/geometry are rechecked after capture. A changed, replaced, or ambiguous
source discards the pixels. Same-process identifier reuse with unchanged evidence
remains a platform limitation.

Capture does not raise, restore, or focus the target and does not crop the current
display. Hidden/minimized windows are rejected. The full window is captured without
cursor or shadow framing, resized to a maximum 1,600-pixel edge, and encoded as at
most 700 KB of JPEG in memory. Metadata includes capture-request time, source window,
and global top-left bounds in logical points (including negative origins). Image
coordinates scale into those bounds; movement after capture invalidates that map.
Native work has a four-second deadline; the parent terminates it after five seconds
or cancellation. Permission, unsupported OS, unavailable/ambiguous source, stale
source, timeout, and capture failure have explicit protocol errors. Protected or
non-rendered content may be blank; images are not redacted. Direct helper use prints
image data to stdout; the voice runtime sends it to the reasoning provider and
retains it only for the turn unless debug output is enabled.

Both window and display capture isolate their entire async capture body to
`@MainActor`, including filter construction and image encoding after awaited
framework callbacks. A synchronous main-run-loop bridge keeps those tasks running
until completion or cancellation. Each fresh helper calls the public
`CGMainDisplayID()` before ScreenCaptureKit work to initialize CoreGraphics.
Without this initialization, window-filter construction crashed at the SkyLight
assertion `CGS_REQUIRE_INIT: did_initialize`, including on the main thread.
Permission preflight alone does not initialize it. A missing display fails explicitly.
Synthetic checks cover initialization order, missing displays, physical main-thread
resumption, error propagation and cancellation; they do not replace a live capture check.

The input adapter uses internal `--inspect-input` and `--execute-input` commands.
Both read one strictly validated, bounded JSON payload from stdin. Text and target
evidence never appear in argv or temporary files. Inspection resolves the discovered
window, requires it to be focused/unhidden/unminimized, maps the screenshot's logical
bounds, and hit-tests the visible AX control. Protected ancestors and oversized or
unreadable evidence are rejected. The returned fingerprint includes control labels,
value, identifier, bounds, focus/editability, window bounds, pointer position, HID
event counts, and a SHA-256 digest of the bounded window Accessibility content.
This catches changes to other fields while the target control remains unchanged.
Input rejects incomplete traversal (including protected, inaccessible, truncated
or repeated elements); hidden/virtualized state remains outside the observation.
Execute recomputes it after the independent provider check; changes
produce `not-issued`. Held modifiers, keys, or mouse buttons also prevent input.

Pointer movement uses `CGWarpMouseCursorPosition`. Click, scroll, and unmodified
Tab/Return events target the validated process using `CGEvent.postToPid`; Tab/Return
also require the intended input to remain focused. Down/up pairs briefly ignore
SIGTERM process-wide while queuing release, then the one-shot helper exits; the
parent retains a bounded SIGKILL fallback. Literal text uses
[AXUIElementSetAttributeValue](https://developer.apple.com/documentation/applicationservices/1460434-axuielementsetattributevalue)
on a settable AXTextField/AXTextArea value, with no pasteboard or synthetic text keys.
Line breaks and tab indentation require AXTextArea at inspection and execution;
single-line controls and unsupported roles reject that payload. Text is bounded
to 4096 UTF-16 code units, with no newline normalization. Exact read-back is
required for `verified`; a changed, truncated or normalized value is `uncertain`,
and no fallback key sequence is attempted. Literal newlines never become Return
events. Other C0 controls and DEL remain rejected. The helper verifies resulting
pointer state where possible; click/scroll/key events report only `issued`.
Failures after issuing input are `uncertain`. The parent stops retries
after uncertain results and stops further input after a submitted effect.

The helper validates targets and mechanics; request authorization belongs to the
TypeScript tool host, which is the only input path exposed to the agent. Direct local
helper use does not interpret a spoken request. Native checks cannot make OS event
dispatch atomic, detect every same-evidence control replacement, or prove arbitrary
web/application side effects. Live click routing, scrolling, text application state,
keyboard delivery and cancellation races remain unverified. No desktop input is
issued by the synthetic test suite.

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

`--feedback` is a separate persistent helper for the CLI's small on-screen panel.
It accepts bounded JSONL `show` messages with `title`, `message` and `detail`, plus
`hide` and `shutdown`. Limits are 160, 4096 and 512 UTF-16 units respectively;
unknown fields and malformed/oversized commands close the helper without echoing
their contents. The only stdout event is `ready`. No keys, credentials, screenshots
or provider requests enter this process.

The plain-text panel is nonactivating, click-through and absent from the Dock.
It stays near the top-right of the pointer's display without following every
pointer movement. Message/detail display is bounded to twelve/three lines; the
CLI retains the full response. Hiding clears displayed text. EOF, shutdown and
signals close it; a 120-second native deadline hides stale content even if the
parent stops updating it. Normal response dismissal is controlled by the CLI.

Discovery and target resolution reject windows owned by the exact helper executable,
using the kernel-reported process path rather than window titles. Display capture
explicitly excludes those helper applications from its ScreenCaptureKit filter;
window capture rejects them. This avoids treating feedback as fresh desktop evidence
and does not rely solely on the panel's window-sharing setting. Synthetic tests cover
the strict protocol, executable matching and negative-origin/small-screen placement.
Panel rendering, focus preservation and capture exclusion still need live macOS
validation; routine tests display no panel and capture no screen.

Run native identity, conversion and protocol checks without microphone access:

```sh
sh native/macos/test.sh
```

Process identity checks cover direct launches, stable reads, PID reuse, invalid
timestamps, and missing or partial kernel records without desktop access.
The same command exercises synthetic accessibility trees for correct source text,
protected subtrees, Unicode/text/node/depth limits, cycles, deadlines, and failures.
They also check complete-content fingerprints and rejection of non-target field
changes or incomplete evidence before input.
It reads no real application content. These checks do not verify live application
coverage, Accessibility permission grants, or model target inference.
Synthetic window-capture checks cover unique source matching, ambiguous/replaced
sources, geometry changes, negative coordinates, and pixel scaling. They do not
invoke ScreenCaptureKit capture or establish live screenshot accuracy.

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
Window inspection uses [Accessibility message timeouts](https://developer.apple.com/documentation/applicationservices/1459345-axuielementsetmessagingtimeout)
and excludes [secure text fields](https://developer.apple.com/documentation/applicationservices/kaxsecuretextfieldsubrole).
Window screenshots use [desktop-independent content filters](https://developer.apple.com/documentation/screencapturekit/sccontentfilter).
Screenshots use [SCScreenshotManager](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager).
