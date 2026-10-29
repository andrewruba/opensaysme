# Developing the visual attention prototype

The CLI records speech with visual context history and cursor trajectories, then
produces a structured action preview. Gestures indicate attention; there are no
predefined gesture commands or content categories. Execution, drawing overlays,
and gaze capture remain future work.

Use Node.js 22.20+ and npm:

```sh
npm ci
npm run build:native
npm run build
node dist/cli.js setup
node dist/cli.js doctor
node dist/cli.js
```

Set the API-key environment variables chosen during setup before starting. Speech
and reasoning can use the same key or separate keys. `npm run dev -- <arguments>`
runs TypeScript directly; `npm run dev` starts the runtime. Desktop probes need no
keys. The package remains private while release packaging is unfinished.

Existing speech-only configurations need `npm run dev -- setup --replace`. This
asks for reasoning preferences and visual-sharing consent before replacing the
file. Configuration is not silently migrated or opted into screen sharing.

## Voice interaction

- Keep the CLI running and work in another app. Tap **Ctrl+Shift+Space** to begin.
- Wait for `listening` and its terminal bell, then speak and indicate content.
  Terminal bell behavior depends on terminal settings; no overlay is installed.
- Tap **Ctrl+Shift+Space** again to stop audio and freeze visual capture. No hold
  is needed. Silence does not automatically finish a turn.
- Final transcript feedback appears immediately when transcription finishes.
  `interpreting` then produces a preview and any clarification question.
- **Escape** cancels recording or interpretation. **Ctrl+C** quits and cleans up
  native hooks, microphone capture, screenshot processes, and provider requests.
- The runtime returns to `ready` after each turn. Activation is ignored during
  processing. A subsequent turn starts fresh; clarification answers do not yet
  continue an earlier conversation.

Recording is limited to two minutes. Startup, provider connection, finalization,
preview, and native cleanup have deadlines. If microphone cleanup cannot be
confirmed, the runtime exits rather than claiming it is ready to record again.

## Attention history and preview

Audio, speech connection, screen capture, and window/selection capture start
concurrently. Native helpers report changed cursor positions at up to 20 Hz. The
collector retains points about 80 ms apart, plus display changes, up to 1,500.
No gesture is assigned a fixed meaning.

Screenshots run sequentially, 1.5 seconds after the previous capture completes;
window and selection queries use a one-second interval. Each query times out after
three seconds. Two consecutive screenshot failures stop image retries for that
turn. Speech continues with explicit warnings when context is unavailable.

History retains at most twelve representative JPEGs, 24 context observations,
and 8 MB of base64 image data. Images have a maximum edge of 1,600 pixels and a
maximum JPEG size of 700 KB. Identical frames/context are coalesced; crowded
interior samples are thinned while retaining the first and latest. Selected text
is capped at 4,096 characters per observation. Limits appear in history warnings.

Frame IDs, display bounds, and capture times identify historical screen content.
macOS and Windows capture the display under the pointer at each sample; Linux
captures the X11 virtual root. Sampling can miss scrolling or a brief display
switch. Cursor paths between frames do not prove that the image stayed unchanged.

Native wall timestamps map to a monotonic turn clock. Capture and receipt times
remain separate, and invalid clock intervals generate warnings. Speech deltas
have **receipt times only**, not word timestamps. Audio metadata records first
chunk arrival and sample duration, not acoustic alignment. The model receives
these limitations and can ask for clarification instead of assuming which
position corresponds to a spoken word.

After the transcript finishes, one OpenAI Responses request combines it with
representative frames and bounded attention history. The initial reasoning model
is `gpt-5.4-mini`, independently configurable from speech. Outputs are proposals
for `focus_window`, `return_to_previous`, `insert_text`, `clarify`, or `unsupported`.
Frame/context/window IDs and normalized image regions are checked against the
supplied evidence. Action types do not classify gestures or screen content.
Nothing is executed. Returning to a previous window needs focus history within
this turn. A preview request times out after twenty seconds.

## Configuration and data sharing

Speech uses OpenAI `gpt-live-transcribe` over Realtime WebSocket transcription,
with manual turn boundaries and low-delay streaming. Other speech models are
rejected before native access. Reasoning uses image input and structured output
through Responses. Official documentation: [transcription](https://developers.openai.com/api/docs/guides/realtime-transcription),
[image input](https://developers.openai.com/api/docs/guides/images-vision), and
[structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses).

Setup saves environment-variable names, never keys. Configuration lives in the
platform's user config directory; `OPENSAYSME_CONFIG_DIR` overrides it. Setup only
overwrites an existing file with `--replace`. Minimal `config.json`:

```json
{
  "version": 1,
  "shareVisualContext": true,
  "speech": {
    "provider": "openai",
    "model": "gpt-live-transcribe",
    "apiKeyEnv": "OPENAI_API_KEY"
  },
  "reasoning": {
    "provider": "openai",
    "model": "gpt-5.4-mini",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

Reasoning configuration and explicit `shareVisualContext: true` are required.
Only OpenAI is implemented for this slice; OS credential-store setup remains
future work. Setup makes no provider request.

Activated audio streams directly to OpenAI. After stopping, selected screenshots,
window titles, selected text, cursor history, and transcripts go directly to the
reasoning provider. Setup explains and asks to enable this sharing. Provider
charges and data policies apply. The Responses request uses `store: false`;
provider retention policies still apply.

Screenshots and audio stay in memory locally; no files or application logs are
created. Frame/context history is released on completion or cancellation. Screen
image payloads are never printed. Results are JSON on stdout; state, transcript,
and preview feedback appear on stderr. Text and attention metadata can contain
private content and remain in terminal scrollback or user-created redirects.
Cancellation aborts requests; data already sent cannot be recalled. `doctor`
checks key presence only, without authentication, paid requests, or device capture.

## Latency measurements

Completed results include milliseconds on a monotonic clock:

- `activationToListeningMs`, `activationToFirstAudioMs`: native microphone readiness
  and the first PCM chunk received by the runtime.
- `activationToProviderReadyMs`, `activationToFirstTranscriptMs`: speech session
  configuration and first nonempty partial transcript.
- `stopToFinalTranscriptMs`: second tap to final speech transcript.
- `contextCaptureMs`: activation to the first retained context observation, if any.
- `previewMs`: interpretation request through validated response.
- `stopToPreviewMs`, `stopToResultMs`: second tap through the preview/result.
- `recordingMs`, `totalMs`: activation-to-stop and activation-to-result.

Frame/context capture and receipt timestamps expose query overhead. These
measurements include IPC/network delays and do not establish acoustic or
word-level alignment. Real reference accuracy and responsiveness need interactive
evaluation; fixture timings are not performance results.

## Platform prerequisites

| Platform | Prerequisites and limits |
| --- | --- |
| macOS | Xcode Command Line Tools for Swift helpers. Screenshots require macOS 14+ and Screen Recording permission for the terminal/helper. Accessibility enables window/selection capture; microphone access is separate. Development binaries are unsigned. |
| Windows | Native Windows Node.js, Windows PowerShell 5.1, and an interactive desktop. Screen/cursor capture requires Windows 10 1703+ per-monitor DPI support. Uses Win32/UI Automation, System.Drawing, and .NET Framework. Execution policy is respected; WSL is unsupported. |
| Linux/X11 | `xdotool`, `xprop`, `xsel`, Python 3, `libX11`, `arecord`, and Pillow with XCB support (`python3-pil` on Debian); an EWMH window manager. Frames cover the virtual root. PRIMARY selection may belong to another window, reported as a warning. |
| Linux/Wayland | Native targeting and global activation are not implemented; voice mode rejects Wayland even when XWayland sets `DISPLAY`. |

Dependencies are never installed by the CLI. See platform protocols and
permission instructions under [macOS](../native/macos/README.md),
[Windows](../native/windows/README.md), and [Linux](../native/linux/README.md).
External Linux utilities are not bundled; review licenses before redistribution.

### macOS Screen Recording setup

Microphone and Accessibility grants do not grant screen capture. If `doctor`
reports `screenCapture: permission-required`, open System Settings > Privacy &
Security > Screen & System Audio Recording. For a run launched from Terminal,
enable Terminal in the upper screen-recording list. If absent, use **+**, then
**Cmd+Shift+G** and `/System/Applications/Utilities/Terminal.app` to add it.
Other launchers may have a different permission identity.

Fully quit and reopen the launching terminal, then rerun `npm run dev -- doctor`.
Shell-only API-key exports may need to be set again; setup stores variable names,
not their values. `unverified` with a permission-granted explanation is expected:
doctor does not capture a test image. An activated voice turn verifies real capture;
look for nonempty `attention.frames` in the result. Images remain in memory.

Guided permission setup and local verification are tracked in
[the permission setup follow-up](../PLAN.md#follow-up-permission-setup).

## Desktop experiments and checks

`doctor` does not record, register shortcuts, request permissions, read selected
text, or change focus. A zero exit means a report was produced, not that every
capability works. Explicit desktop experiments remain available:

```sh
node dist/cli.js desktop inspect --selection --delay 3
node dist/cli.js desktop focus '<target-id>'
node dist/cli.js desktop test-hotkey --seconds 10
node dist/cli.js desktop test-microphone --seconds 3
npm run check
sh native/macos/test.sh
npm pack --dry-run
```

Window IDs are temporary. Microphone probes discard audio; bounded input tests
exit 0 for passed, 1 for not observed, and 2 for unavailable. Routine provider
tests use fixtures without keys or paid requests. Windows CI compiles helpers,
parses PowerShell scripts, and runs device-free protocol/image encoding tests.

The live X11 suite uses an isolated virtual desktop and synthetic recorder:

```sh
docker build -f scripts/Dockerfile.x11 -t opensaysme-x11-test .
docker run --rm --init --network none opensaysme-x11-test
```

Verification for this slice (2026-10-28):

- **macOS:** native build, synthetic audio/pointer/JPEG checks, and screen permission
  denial passed. A subsequent user-run session captured five screen frames with
  cursor/window context and returned a live preview after granting Screen Recording
  permission. Multi-monitor behavior and visual reference accuracy remain unverified.
- **Linux/X11:** eleven isolated Xvfb/Openbox tests passed, including in-memory
  screenshots, cursor samples, recording stop/cancellation, and cleanup. Audio is
  synthetic; this does not verify a physical desktop or microphone.
- **Windows:** adapter fixtures, C#5 compilation, protocol and synthetic image
  checks passed. Native Windows desktop and PowerShell behavior remain unverified.
- **Providers:** protocol fixtures cover multimodal requests, validated references,
  cancellation, timeouts, refusal, and bounded/redacted failures. The user's live
  session completed transcription and a multimodal preview, with 3.48 seconds from
  the stopping tap to the preview. This single run is not a performance benchmark.

Manual acceptance: indicate a generic region while speaking, move to another
window, and refer to the destination. Review proposed references without assigning
any gesture/content category. Repeat after scrolling, with incidental pointer
movement, missing screen permission, and multiple displays. Cancel during capture
and interpretation, disconnect/retry, and confirm resources release on Ctrl+C.
