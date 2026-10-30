# Developing the voice and desktop context prototype

The product goal is to reduce friction between what the user wants and what their
AI agents do. Each interaction should fit the request and available capabilities.

Today, the CLI records a spoken request with desktop context, then lets the agent
gather more evidence, navigate, or answer naturally. Screens and application history provide context;
selections and timed cursor paths can help clarify references. Gestures have no
predefined command meanings, content categories, or required response types.
The shared tool host supports window discovery, current-context inspection,
current-screen capture, verified focus, and macOS background-window accessibility
inspection and image capture. A first macOS input slice adds pointer movement,
single clicks, vertical scrolling, literal Accessibility text replacement and Tab/Enter,
with an independent request check before input. Windows/Linux input and background-window
inspection/capture, broader keyboard entry, and live permission validation remain work.
Dedicated agent integrations and on-screen drawing overlays
remain future work. Gaze stays optional.
The voice runtime calls this host in the same Node.js process. See
[the tool framework](tools.md) for the catalog and extension points.

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
Rebuild the macOS helper with `npm run build:native` after updating: audio events
now require capture timestamps and sample offsets. Run `npm ci` after updating to
install sharp and its platform image-processing binaries. Existing visual-sharing
configuration and provider keys are unchanged.

## Voice interaction

- Keep the CLI running and work in another app. Tap **Ctrl+Shift+Space** to begin.
- Wait for `listening` and its terminal bell, then say your request. Point or select
  content when useful; existing desktop context is captured either way.
  Terminal bell behavior depends on terminal settings; no overlay is installed.
- Tap **Ctrl+Shift+Space** again to stop audio and freeze visual capture. No hold
  is needed. Silence does not automatically finish a turn.
- Final transcript feedback appears immediately when transcription finishes.
  `interpreting` prepares visual evidence and runs the agent loop; `inspecting`
  indicates evidence gathering and `acting` a requested focus/input operation (including its internal permission check).
- **Escape** cancels recording, interpretation, or pending tools and clears recent conversation.
  While idle, Escape in the CLI terminal clears conversation; global Escape is registered
  only during an active turn. **Ctrl+C** quits and cleans up
  native hooks, microphone capture, screenshot processes, and provider requests.
- The runtime returns to `ready` after each turn. Activation is ignored during
  processing. A subsequent activation starts fresh capture and tools while retaining
  bounded conversation context for follow-ups and clarification answers.

Recording is limited to two minutes. Startup, provider connection, finalization,
reasoning, and native cleanup have deadlines. If microphone cleanup cannot be
confirmed, the runtime exits rather than claiming it is ready to record again.
Automatic history capture stops at the second tap. The agent may request fresh
desktop evidence while fulfilling that activated turn. Cancellation cannot undo
an input or focus change already issued to the OS.

## Conversational follow-ups

Requests such as “fill this form” followed by “now submit it,” or “point to that
setting” followed by “click it,” receive recent conversation alongside new desktop
context. Clarification answers can complete an earlier user request without
repeating it. Current speech stays separate from verbatim earlier requests;
assistant responses and observed UI content never establish permission.

The runtime retains at most three completed turns and 64 KiB total in memory.
Each turn expires two minutes after completion, including while idle. A reasoning
turn receives the unexpired context at its start and releases that snapshot on
completion or cancellation. Records
contain the request, response, up to three reference-context samples, observed
window/control information and native action outcomes. They contain no screenshots,
audio, tool observation IDs or permission decisions. An invalid or individually
oversized record clears the history with a warning rather than truncating user
constraints. Cancellation, failed turns and shutdown also clear it.

Every activation gets a new tool host. Fresh window results include
`previousTurnIds` when native identity, application and title match a retained
source; this does not establish unchanged contents. Input still requires fresh
capture and native inspection. The independent guard receives the same prior
conversation and must ground its supporting quote in current speech. Comparing
changed contents and past commitments, including uncertain outcomes, remains
model-dependent; there is no cross-turn content fingerprint or reusable approval.
Action records distinguish pre-dispatch control values from requested replacement
text and the native result (`verified`, `issued`, `not-issued` or `uncertain`).
Unit tests exercise retention, expiry, continuation and enforcement with mocked
providers. Real-model acceptance belongs to the unified live suite after v1.

## Attention history and reasoning

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
maximum JPEG size of 700 KB. Repeated screenshots are retained so later speech
and movement still have a nearby frame; identical context observations are
coalesced. Crowded interior samples are thinned while retaining the first and
latest. Selected text
is capped at 4,096 characters per observation. Limits appear in history warnings.

Frame IDs, display bounds, and capture times identify historical screen content.
macOS and Windows capture the display under the pointer at each sample; Linux
captures the X11 virtual root. Sampling can miss scrolling or a brief display
switch. Cursor paths between frames do not prove that the image stayed unchanged.

Native wall timestamps map to a monotonic turn clock. Every audio chunk carries
the first sample's capture timestamp, a cumulative 24 kHz sample offset, and its
clock quality. macOS uses the device host clock when available. Windows uses an
estimated capture-start clock; Linux estimates from the first recorder pipe read.
Those estimates include unknown device/startup buffering. Missing or repeated
sample offsets fail the turn; invalid capture clocks leave phrase times null
with a warning instead of substituting arrival time.

Transcription uses one connection per activated turn. A lightweight local energy
check commits phrases after 400 ms of quiet following sound, or four seconds of
continuous input. All captured audio is streamed once; speech is never discarded
based on the energy check. Phrases finalize while recording continues, so stopping
waits only for unfinished phrases. There is no extra alignment model call and no
requirement to pause or change the tap-to-toggle interaction. A final fragment
shorter than the provider's minimum is padded with silence; that padding is excluded
from the recorded sample range.

`attention.transcript` contains final phrase text, `startSample`/`endSample`
(exclusive end), mapped `startMs`/`endMs`, `receivedAtMs`, a `pause`/`limit`/`stop`
boundary, and `device`/`estimated`/`unavailable` timing. Provider item IDs keep phrases
in capture order despite delayed results. These are **committed audio intervals**,
not exact word boundaries: pauses are included and duration limits can split words.
The model can compare a phrase's interval with cursor and screen history, but
should acknowledge ambiguity when timing or visual evidence is insufficient.

After the transcript finishes, each retained frame is paired with overlapping
speech phrases and a nearby cursor interval, at most 750 ms on either side of
capture. Adjacent frames and observed window changes narrow that interval. Cursor
coordinates are normalized using the captured display bounds. Trails break across
observed window/display changes, out-of-bounds samples, and gaps over 250 ms.
Sampling can still miss navigation, and a single phrase can refer to several frames.

Optional full-size copies show cyan trails fading from older to newer observations.
A filled dot marks the latest trail endpoint, which may be after frame capture; a
hollow ring marks the last observed pointer at or before capture. Exact point times
remain in metadata. The clean screenshot accompanies its marked copy so trails do
not hide the only view of content. No crops or on-screen overlays are created.

Local rendering uses two workers, a two-second deadline, and an additional 8 MB
base64 budget. Failures or limits fall back to clean images and timed coordinates,
with warnings. The initial OpenAI Responses request sends at most twelve originals
and twelve marked copies, plus bounded attention history. The initial reasoning
model is `gpt-5.4-mini`, independently configurable from speech. It can answer
directly or call local tools and inspect their results before answering. There is
no fixed action enum or required per-phrase outcome. The agent discovers window
references itself; no user naming or routing rules are required.

Without input tools the loop permits six provider requests/five tools within 45 seconds.
With input tools it permits thirteen provider requests/twelve tools within 90 seconds,
including authorization time. Each acting-provider request has a twenty-second deadline;
read/focus tools have six seconds and input tools have twenty. The runtime's outer
deadline is 95 seconds with input capabilities and 50 seconds otherwise.
Tool results, including requested screenshots, enter subsequent model requests.
On macOS, `inspect_window` can read a discovered window's accessibility content
without switching to it. Its results retain source identity and capture time;
protected fields, unavailable content, and truncation are explicit. The catalog
omits the operation on Windows/Linux. Unchanged window references survive inventory
refreshes within a turn, but content is read afresh and targets are revalidated.
`capture_window` supplies a full window image on macOS 14+ without changing focus,
including when another window covers it. It uses a uniquely matched, revalidated
ScreenCaptureKit source; hidden/minimized or ambiguous targets fail without a
foreground-screen fallback. The image comes with its window reference, capture
time, logical desktop bounds, and pixel dimensions. It is independent of historical
full-screen frames and cursor trails. Protected or non-rendered content may be blank.
The operation has a four-second native deadline and five-second parent timeout.
On macOS, successful window captures also return a short-lived `observationId` for
input. Input coordinates use that image's pixels. The host retains original speech
and desktop reference context; each input is independently checked by the reasoning
provider against that request and fresh native evidence. This uses one additional,
tool-free, structured-output request (ten-second maximum) per proposed input. Only
the validated exact action proceeds to native revalidation. Enter requires a submit
decision; text replacement cannot contain key/control characters. A submission or
uncertain outcome stops further input for the turn, while read tools can verify it.
See [input and execution permissions](tools.md#input-and-execution-permissions) for
coordinates, lifecycle, supported operations, model-dependent limits and sharing.
Requests remain stateless with `store: false`, replaying tool outputs and encrypted
reasoning context. More tool steps can increase latency and provider usage; simple
answers still need just one reasoning request. The model is instructed to gather
useful evidence before asking for clarification and to avoid unnecessary steps.

Result JSON contains `response`, `attention`, and `visualContext.frames`. Each
visual entry records its frame ID, interval, associated phrase/context IDs,
normalized timed paths, pointer sample, warnings, and `trailImageIncluded`.
`visualContext.warnings` describes rendering omissions. Image bytes are not printed.

## Configuration and data sharing

Speech uses OpenAI `gpt-live-transcribe` over Realtime WebSocket transcription,
with client-selected phrase boundaries and low-delay streaming. It does not return
word timestamps. Other speech models are
rejected before native access. Reasoning uses image input, function calling, and text output
through Responses. Official documentation: [transcription](https://developers.openai.com/api/docs/guides/realtime-transcription),
[image input](https://developers.openai.com/api/docs/guides/images-vision), and
[text generation](https://developers.openai.com/api/docs/guides/text), and
[function calling](https://developers.openai.com/api/docs/guides/function-calling).

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

Activated audio streams directly to OpenAI. After stopping, full screenshots and
optional trail copies, window titles, selected text, cursor history, and transcripts
go directly to the reasoning provider. Requested tool results can include window
inventory, current context, macOS window accessibility content, and additional screen
or window screenshots. Setup explains this sharing.
Actor requests and input checks also send the bounded recent conversation. Input
checks additionally send the current original request, reference context, proposed
text/action, control metadata and window image to the configured reasoning provider.
These guard requests are not currently saved as separate debug request files;
tool results record the decision's effect and supporting quote/reason. Provider
charges and data policies apply. The Responses request uses `store: false`;
provider retention policies still apply.

By default, screenshots and audio stay in memory locally; no files or application
logs are created. Images and full attention history are released on completion;
the bounded conversation record described above can retain text and target evidence
for follow-ups. Cancellation clears both. Screen
image payloads are never printed. Results are JSON on stdout; state, transcript,
and response feedback appear on stderr. Text and attention metadata can contain
private content and remain in terminal scrollback or user-created redirects.
Cancellation aborts requests; data already sent cannot be recalled. `doctor`
checks key presence only, without authentication, paid requests, or device capture.

## Inspect a debug session

Opt in for the current process only:

```sh
npm run dev -- --debug
npm run dev -- --debug ./my-captures
```

Without a directory argument, debug sessions go under `.opensaysme-debug/` in the
current directory (ignored by Git). The CLI prints the unique session directory;
turn results include their `debugDirectory`. Custom output paths are not automatically
ignored by Git. This flag does not change setup or configuration.

Each session contains `session.jsonl` and a `turns/<turn-id>/` directory for each turn:

- `context.json`: transcript, phrase timing, window/selection context, cursor history,
  frame bounds, and visual alignment.
- `request.json`, `request-2.json`, ...: each prepared model request, including
  recent conversation, the catalog and replayed tool exchanges, with image URLs replaced by local paths.
  Images remain the exact JPEG bytes prepared for the provider.
- `tool-1-started.json`, `tool-1-completed.json`, ...: tool arguments, results,
  and duration. Additional tool images are saved under `images/`.
- `result.json`: response, latency, and completed/failed/cancelled/interrupted status.
- `images/f1-clean.jpg`, `images/f1-trail.jpg`: retained clean frames and available
  annotated copies, with corresponding files for the other frame IDs.

The session log records startup, capabilities, helper and provider lifecycle,
request state, failures, cancellation, and cleanup. Entries include a wall timestamp,
monotonic session time, and a turn ID where applicable. A saved request means it was
prepared; dispatch and completion events distinguish what happened afterward.

Diagnostic text redacts configured provider keys; authorization headers, raw
audio, and opaque encrypted reasoning are not saved. Screenshot pixels remain unchanged; screenshots and captured
context can contain private content.
Completed records remain until you delete them, including failed or cancelled turns.
Unfinished writes are cleaned up where possible. Directories/files request owner-only
access on systems supporting Unix permissions; Windows uses inherited directory ACLs.

Debug writes run alongside the voice flow, with a 32 MiB pending queue and an
8 MiB/10,000-entry session log limit. Disk failures or limits warn and disable or
skip logging without failing the turn. The destination must support hardlinks
(standard APFS, ext4, and NTFS do). Shutdown waits at most two seconds to flush;
slow filesystem operations may settle and clean up later. Delete the debug
directory when finished.

## Latency measurements

Completed results include milliseconds on a monotonic clock:

- `activationToListeningMs`, `activationToFirstAudioMs`: native microphone readiness
  and the first PCM chunk received by the runtime.
- `activationToProviderReadyMs`, `activationToFirstTranscriptMs`: speech session
  configuration and first nonempty partial transcript.
- `activationToFirstPhraseMs`: first completed phrase delivered to the runtime.
- `maxPhraseFinalizationMs`: largest capture-end-to-phrase-delivery delay, when
  capture timing is available; estimated capture clocks also affect this metric.
- `maxAudioDeliveryLagMs`: largest captured-chunk-end-to-Node-delivery delay.
- `stopToFinalTranscriptMs`: second tap to final speech transcript.
- `contextCaptureMs`: activation to the first retained context observation, if any.
- `visualPreparationMs`: alignment and local trail-image preparation.
- `reasoningMs`: the full agent loop through the final text, including any tool time.
- `toolMs`, `toolCalls`: accumulated local tool time and completed call count, when tools run.
- `stopToResponseMs`, `stopToResultMs`: second tap through the response/result.
- `recordingMs`, `totalMs`: activation-to-stop and activation-to-result.

Frame/context capture and receipt timestamps expose query overhead. Audio delivery
and phrase finalization measurements expose buffering/provider delays separately.
These do not establish acoustic or word-level alignment. Real reference accuracy,
phrase-boundary quality, and responsiveness need interactive evaluation; fixture
timings are not performance results.

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
Sharp supplies prebuilt image-processing binaries for supported macOS, Windows,
and Linux targets through npm. Its wrapper is Apache-2.0; the bundled libvips package
declares LGPL-3.0-or-later and includes other dependency licenses. Audit these
binaries and notices before redistribution, including commercial packaging.
External Linux utilities are not bundled; review their licenses before redistribution.

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
[the setup backlog](../BACKLOG.md#setup-permissions-and-providers).

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

Continue v1 development with unit tests and mocked provider responses. Once the
v1 implementation is ready, add one unified live-provider suite with explicit
expected outcomes for the acceptance trials. There is currently no live-provider
test runner or per-feature live-test flag.

### Platform and regression checks

The live X11 suite uses an isolated virtual desktop and synthetic recorder:

```sh
docker build -f scripts/Dockerfile.x11 -t opensaysme-x11-test .
docker run --rm --init --network none opensaysme-x11-test
```

Current validation coverage and limits:

- Routine provider/tool tests cover multimodal request construction, source and
  timing metadata, tool sequencing, stale targets, bounded errors, cancellation
  and request-scoped input enforcement. Provider and authorization decisions are
  scripted, so these checks do not establish model understanding or permission accuracy.
- Native macOS checks cover process identity, Accessibility traversal and protected
  fields, complete-content input fingerprints, capture source/geometry validation,
  initialization, main-thread resumption, synthetic audio and JPEG encoding. They
  issue no desktop input and do not capture the screen.
- The isolated Linux/X11 suite exercises window discovery, screenshots, cursor
  sampling, recording lifecycle and cleanup. Its synthetic audio and virtual desktop
  do not establish physical-device behavior. Windows adapter/protocol/image checks
  likewise do not establish native desktop operation.
- User-run macOS sessions have exercised transcription, visual history, window
  discovery, accessibility inspection and focus. Complete background-window capture,
  target accuracy, desktop input outcomes, cancellation races and multi-display
  coordinates remain unverified. Earlier preview timings are individual observations,
  not performance benchmarks.

Two native fixes from those checks remain part of the runtime. Window identity uses
validated kernel process start time because directly launched applications may lack
`NSRunningApplication.launchDate`; PID reuse still invalidates old targets. Capture
initializes CoreGraphics through public `CGMainDisplayID()` before ScreenCaptureKit
filter construction. This addresses the confirmed `CGS_REQUIRE_INIT: did_initialize`
assertion; moving work to the main thread alone did not address it. The capture
bridge also retains main-thread execution across awaits, bounds execution time,
and reports missing displays or helper crashes without exposing native output.
Rebuild with `npm run build:native` after updating. Successful compilation and
synthetic checks do not replace a live capture check from the authorized terminal.

Manual acceptance: ask about visible content using existing context, then try
pointing or selecting to clarify a reference and a request spanning several windows.
Inspect `visualContext.frames` and compare phrase, cursor, and frame times with
the response. Repeat during rapid navigation,
scrolling, incidental movement, missing screen permission, and multiple displays.
Try both paused and continuous speech: energy-based phrase boundaries can include
several referents. Cancel during capture and interpretation, disconnect/retry, and
confirm resources release on Ctrl+C.
Open editor windows for two different projects and ask to switch to one by context,
without registering names. Use `--debug` to inspect the discovered titles, selected
window reference, and verified tool result. Try indistinguishable titles and a
window closed or retitled during processing; the agent should inspect again or
explain the remaining ambiguity.
On macOS, use two discoverable windows whose contents distinguish the projects and
check that `inspect_window` supplies relevant text without a focus change before
the requested navigation. Verify protected fields are omitted, try an application
with limited accessibility support, and close or retitle a candidate during
inspection. Native windows with identical title/AX-identifier tokens are still
omitted as ambiguous; this slice does not resolve that platform limitation.
For window screenshots, cover a target with another window and request a visual
detail from the target when its accessibility text is insufficient. Verify
`capture_window` returns that window's pixels without changing focus. Repeat with
a moved/resized/closed target, duplicate matching candidates, a minimized/hidden
window, denied Screen Recording access, and windows on a display with a negative
origin or different scale. Inspect the source identity, bounds, and capture time
in opt-in debug output; confirm failures do not contain substitute screen pixels.

For input acceptance, use a controlled form or disposable agent-input fixture.
Try “fill this form” and “fill this form and submit it”; verify exact field values,
no send in the first case and exactly one send in the second. Repeat prepare/send
through both a button and Enter, with negative instructions, an autosaving field,
similarly titled destinations and misleading instructions in UI content. Point
without clicking, scroll and inspect again, and check image coordinates across
display scales/negative origins. Change focus, move the pointer, hold a key, resize
the window, edit another field, and cancel during authorization/input; inspect and
record actual effects rather than assuming cancellation undid them. Measure guard
latency and unnecessary denials/clarifications separately from actor reasoning.
