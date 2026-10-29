# Linux desktop helpers

Run in an authorized X11 desktop session with Python 3, libX11, `arecord`
(`alsa-utils`), `xdotool`, `xprop` (`x11-utils`), and `xsel` installed through the
system package manager. These tools are external prerequisites, not bundled
binaries. Native Wayland sessions, including XWayland, are explicitly unsupported.
Visual history additionally requires Pillow with XCB support (`python3-pil` on
Debian/Ubuntu); missing screenshot support is reported separately from audio.

`x11.py` supplies the small shared Xlib surface used by the one-shot hotkey probe
and `voice.py`. Voice registers Ctrl+Shift+Space for repeated tap-to-talk turns;
held keys do not retrigger. Escape is registered only during a turn, including
transcription after recording stops, and released on cancellation or settlement.
The helper signals microphone readiness with the X11 bell, which desktop sound
settings may mute. It does not change keyboard focus.

The parent sends JSON lines on stdin: `start`, `stop`, `cancel`, and `settled`
with a validated `turnId`, or `shutdown`. Stdout emits only the typed voice
protocol. `start` opens the default ALSA input as 24 kHz mono signed 16-bit
little-endian PCM; base64 chunks go directly to stdout. No audio files are
written. `audio-started` precedes the first PCM chunk. `stop` drains capture and
emits `audio-stopped`, retaining Escape until `settled`; `cancel` discards capture
and acknowledges cleanup with `audio-stopped`. Escape emits `cancel`, stops
capture immediately, and awaits the parent's cancellation acknowledgement.

Capture is capped at 120 seconds, microphone startup at five seconds, command
input at 8 KiB, and pending protocol output at 512 KiB. Signal, EOF, and failure
paths stop/reap the recorder and release all grabs. Fixed error codes avoid
exposing native output. A blocked consumer causes bounded failure rather than
unbounded audio retention.

`voice.py --pointer` reads pointer coordinates and the client window beneath the
pointer without installing shortcuts. X11 context capture reads active and
pointer window identities independently. Selected text comes from PRIMARY,
which can belong to another application; that limitation accompanies each
snapshot. Missing context is reported without blocking microphone startup.

During recording, `voice.py` also emits changed pointer positions at up to 20 Hz,
with capture timestamps and the `x11:root` display ID. It samples only coordinates,
not window ancestry, on the audio loop. Stop and cancellation end pointer sampling;
movement is attention evidence with no predefined gesture meaning.

`frame.py` captures the X11 virtual root through Pillow's XCB implementation.
Passing an explicit display disables external screenshot-tool fallbacks. Frames
are converted to JPEG in memory, resized to at most 1600 pixels on the longest
edge, and capped at 700,000 bytes. Source bounds remain in root desktop pixels so
cursor paths can be related to the resized frame. Physical monitors are not
identified separately; each frame includes that limitation. `frame.py --probe`
checks library support only and does not capture pixels. No screenshot files are
created; the parent controls turn-scoped retention and provider sharing.

`tests/linux-live.test.ts` exercises real Xlib and X11 tools in isolated Xvfb,
with a synthetic `arecord` executable on the test child's PATH. This verifies
hotkeys, repeat suppression, pointer ownership and trajectories, bounded JPEG frames, streaming, cancellation,
restart, and shutdown; it does not validate a physical microphone or a hosted
provider. Run it using the Docker instructions in `docs/development.md`.
