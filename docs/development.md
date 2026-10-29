# Developing the voice prototype

This slice runs a local tap-to-talk loop: record, stream transcription, capture
near-activation desktop context, and print the result with latency measurements.
It does not interpret commands, execute agent actions, capture screenshots, or
track gaze yet.

Use Node.js 22.20+ and npm:

```sh
npm ci
npm run build:native
npm run build
node dist/cli.js setup
node dist/cli.js doctor
node dist/cli.js
```

Set the API-key environment variable chosen during setup before starting voice
mode. `npm run dev -- <arguments>` runs the TypeScript source directly; `npm run
dev` starts voice mode. Desktop probes work without keys. The package remains
private while release packaging is unfinished.

## Voice interaction

- Keep the CLI running and work in another app. Tap **Ctrl+Shift+Space** to begin.
- Wait for `listening` and its terminal bell, then speak. Terminal bell behavior
  depends on your terminal settings; no overlay is installed.
- Tap **Ctrl+Shift+Space** again to finish. Partial transcripts arrive while you
  speak; the final text appears as soon as the provider completes the turn.
- **Escape** cancels recording or processing. **Ctrl+C** in the launching terminal
  quits and cleans up native hooks, microphone capture, and the provider socket.
- The runtime returns to `ready` after each completed, cancelled, or failed turn.
  While processing, additional activation taps are ignored; Escape cancels.

The recording limit is two minutes. Microphone startup, provider connection,
finalization, and native cleanup have deadlines. If cleanup cannot be confirmed,
the runtime exits instead of claiming that it is ready to record again.

Audio startup, the provider connection, and context capture begin concurrently.
Context contains the active window, available selection, and a separate pointer
position/window candidate. These are snapshots taken just after activation;
process startup and OS queries introduce a small capture delay. Moving the cursor
later does not retarget the turn. Pointer position alone does not override the
focused window or selection. Unsupported context fields produce warnings and do
not prevent speech capture. Final text does not wait for context; the combined
result waits at most for the three-second context deadline.

## Provider configuration and data

The first speech adapter uses OpenAI `gpt-live-transcribe` through the Realtime
transcription WebSocket API, with manual turn boundaries and low-delay streaming.
Other transcription models are rejected before desktop hooks are opened. See the
[official realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription).

Setup saves an environment-variable name, never the key. Configuration lives in
the platform's user config directory; `OPENSAYSME_CONFIG_DIR` overrides it. Setup
will not overwrite an existing file. This is the minimal `config.json`:

```json
{
  "version": 1,
  "speech": {
    "provider": "openai",
    "model": "gpt-live-transcribe",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

Existing prototype configurations may need their speech model changed. There is
no migration layer. An optional `reasoning` block remains independently
configurable, but this slice makes no reasoning requests. OS credential-store
setup remains future work.

Activated audio streams directly to OpenAI using the user's key; provider charges
and data policies apply. Desktop context is **not uploaded** in this slice. A new
connection is opened per utterance, in parallel with local capture, so turns do
not inherit earlier transcripts. Audio buffering and socket backpressure are
bounded. No audio files are created.

Results are JSON on stdout; states and partial/final transcript feedback are on
stderr. Both can include private content and may remain in terminal scrollback or
user-created redirects. The application does not write audio, transcripts, or
context logs. Cancellation closes the connection and discards pending local
work; audio already streamed to the provider cannot be recalled. `doctor` checks
key presence only, without authentication, paid requests, or device capture.

## Latency measurements

Each completed result includes millisecond measurements using a monotonic clock:

- `activationToListeningMs`: native microphone-ready notification.
- `activationToFirstAudioMs`: first PCM chunk received by the runtime.
- `activationToProviderReadyMs`: provider confirms the session configuration.
- `activationToFirstTranscriptMs`: first partial transcript, when one is emitted.
- `stopToFinalTranscriptMs`: second tap to final provider transcript.
- `stopToResultMs`: second tap to combined transcript/context result.
- `contextCaptureMs`, `recordingMs`, and `totalMs`: context query, activation-to-stop,
  and activation-to-result durations.

These measure observed boundaries including IPC and network overhead. They are
not acoustic latency measurements. Compare real microphone runs before tuning;
fixture timings do not establish real-world performance.

## Platform prerequisites

| Platform | Prerequisites and limits |
| --- | --- |
| macOS | Xcode Command Line Tools to build Swift helpers. Accessibility access for the launching terminal/helper enables window and selection capture; microphone access is separate. Missing Accessibility can yield partial context while audio works. Development binaries are unsigned. |
| Windows | Native Windows Node.js, Windows PowerShell 5.1, and an interactive desktop. Helpers use Win32/UI Automation and .NET Framework. Execution policy is respected; WSL does not provide native Windows desktop access. |
| Linux/X11 | `xdotool`, `xprop`, `xsel`, Python 3, `libX11`, and `arecord` from `alsa-utils`; an EWMH-compatible window manager. Voice captures 24 kHz mono S16LE from the default ALSA device. PRIMARY selection may belong to another window; context includes that warning. |
| Linux/Wayland | Native window targeting and global activation are not implemented. Voice mode rejects Wayland explicitly, even when XWayland sets `DISPLAY`. |

System dependencies are never installed by the CLI. Linux utilities are external
prerequisites, not bundled binaries. Review their licenses before redistribution.
Helper protocols, limits, and platform details are documented under
[macOS](../native/macos/README.md), [Windows](../native/windows/README.md), and
[Linux](../native/linux/README.md).

## Desktop experiments

`doctor` checks without recording, registering shortcuts, requesting permissions,
reading selected text, or changing focus. Its statuses are `available`,
`permission-required`, `unavailable`, and `unverified`; a zero exit means a report
was produced, not that every capability works.

```sh
node dist/cli.js desktop inspect --delay 3
node dist/cli.js desktop inspect --selection --delay 3
node dist/cli.js desktop focus '<target-id>'
node dist/cli.js desktop test-hotkey --seconds 10
node dist/cli.js desktop test-microphone --seconds 3
```

Focus another app during the inspection delay. IDs are temporary; reinspect after
windows change. Input experiments run for 1–30 seconds and exit 0 for passed, 1 for
not observed, or 2 for unavailable. Microphone probes discard captured audio.

## Checks and verification

```sh
npm run check        # Typecheck, lint, automated tests, TypeScript build
npm test            # Automated tests alone; no keys or paid requests
sh native/macos/test.sh  # Synthetic PCM conversion/protocol checks on macOS
npm pack --dry-run
```

The live X11 suite uses synthetic windows and a fixture recorder inside an
unprivileged Docker container, without host mounts, physical audio, or networking:

```sh
docker build -f scripts/Dockerfile.x11 -t opensaysme-x11-test .
docker run --rm --init --network none opensaysme-x11-test
```

Routine tests skip the live X11 suite unless explicitly enabled in its virtual
display. Provider fixtures cover the actual message protocol and failures without
sending audio externally. Windows CI compiles helpers and runs the device-free
`native/windows/test-voice.ps1` protocol checks.

Verification for this slice (2026-10-28):

- **Linux/X11:** nine live Xvfb/Openbox tests passed, including repeated activation,
  pointer-window identity, synthetic PCM streaming, cancellation, provider-stage
  Escape, recorder failure recovery, and process/grab cleanup.
- **macOS:** native build, synthetic 44.1/48 kHz conversion, context permission
  fallback, and persistent helper startup/cancel/shutdown/re-registration passed.
  The assembled CLI also reached ready and exited cleanly on Ctrl+C in two
  consecutive terminal sessions, without opening the microphone or provider.
  Physical microphone streaming, real key delivery, and AX window/selection
  capture remain unverified; this host lacks the required Accessibility grant.
- **Windows:** adapter fixtures and C# 5 compilation/pure protocol checks under
  Mono passed. Native Windows desktop, PowerShell execution, and physical
  microphone behavior still require a Windows run.
- **Hosted transcription:** tested with protocol fixtures, not a live paid request.
  Provider access, real speech accuracy, and end-to-end latency need an interactive
  run with the user's configured key and microphone.

For manual acceptance, complete several turns from another app, cancel both while
recording and processing, disconnect the network for one turn, then retry. Confirm
focus stays put, context remains tied to activation, and all resources release on
Ctrl+C. Do not treat mocks or denied permissions as successful native verification.
