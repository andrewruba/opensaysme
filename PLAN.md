# CLI-first MVP implementation plan

Build a local tool that makes existing agents easier to navigate and interact
with. Launch it from a terminal, activate it with a hotkey, and use voice plus
desktop context to express intent and identify what the user means.

```sh
opensaysme setup    # Configure providers, keys, hotkey, and agent targets
opensaysme         # Run until Ctrl+C
opensaysme doctor  # Check permissions, providers, and desktop capabilities
```

Use TypeScript and Node.js, Commander and Clack for the CLI, direct provider
adapters, and Zod for configuration and provider validation. Keep desktop
access behind platform adapters and agent-specific behavior behind integration
adapters. Use native helpers where necessary; a graphical helper can be added
for feedback without making it the application core.

## Current slice: aligned visual attention and natural responses

Implemented: tap-to-talk transcription, bounded full-screen history, timed cursor
trails, cancellation, and a natural-language OpenAI response. Audio capture clocks
map final phrases onto the desktop timeline. These are phrase envelopes, not word
timestamps. Live reference accuracy and response latency need further evaluation.

Treat cursor movement, selections, and later annotations and gaze as evidence of
attention. Preserve their source and timing; let the model interpret them with the
whole spoken request and visible content. Avoid gesture-to-command mappings,
content categories, or a required outcome for every phrase.

1. **Retain full visual history.** Keep bounded captures, including repeated images
   that may accompany later speech or movement, plus window/selection changes and
   cursor paths. Associate samples with display coordinates and capture times.
   Report missing permissions or context explicitly.
2. **Align nearby evidence.** Pair frames with overlapping speech intervals and
   short, timed cursor trails in image coordinates. Break trails across observed
   window/display changes and sampling gaps. Compare full frames when navigating;
   nearby timestamps do not establish that content stayed still. Never interpolate
   word times from phrase envelopes.
3. **Respond naturally.** On the second tap, freeze capture and prepare optional
   full-size trail copies alongside clean screenshots. One independently configured
   BYOK reasoning call receives the transcript and attention history, then returns
   text without a fixed action enum. Keep clean images available for reading details.
   There are no crops, on-screen overlays, or executed actions. Defer the structure
   for future answers and executable actions until concrete integrations need it.
4. **Bound work and evaluate.** Keep images in memory only for the active turn.
   Limit local rendering and retain clean images plus coordinates if a trail copy
   is unavailable. Measure preparation, reasoning, and stop-to-response latency;
   test rapid navigation, multiple referents, incidental movement, and cancellation.

Acceptance: ask about content while indicating it, then try a request spanning
multiple windows. Check whether the response uses the relevant historical frames
and speech intervals, and acknowledges uncertainty where evidence is insufficient.
No gesture or region needs a predefined semantic category.

## Follow-up: permission setup

Setup currently configures providers and sharing consent but leaves OS permissions
to manual steps. In the macOS trial, speech worked while screenshots failed;
Terminal was absent from the Screen Recording list until added manually and
restarted. See [the current workaround](docs/development.md#macos-screen-recording-setup).

- Guide microphone, Accessibility, and screen-capture permissions separately in
  setup. Identify the launching app/helper where reliable and provide specific
  grant, restart, and recheck instructions. Keep `doctor` read-only.
- Offer deliberate local verification after a grant; distinguish permission
  granted from capture verified. Discard test data without a provider request.
- Preserve actionable failure reasons through the runtime: permission denied,
  missing dependency, unsupported platform, and timeout need different guidance.
  Make missing screen evidence visible in results.
- Verify fresh installs, denial/revocation, terminal restart, and helper rebuilds.
  Resolve macOS helper signing/permission identity before packaging; distinguish
  Windows session restrictions and unsupported Wayland access from missing grants.

## MVP roadmap

1. **Prove desktop access across platforms.** Test global activation, microphone
   capture, active-window detection, focus changes, and selected-text access on
   macOS, Windows, and Linux. Include X11 and Wayland in the capability assessment;
   record supported environments and disable unavailable actions explicitly.
   Resolve native dependency packaging and permission prompts before expanding
   the feature set. Run inside the logged-in desktop session.

2. **Build setup and the local runtime.** Store non-secret configuration locally
   and provider keys in the OS credential store. Allow environment-variable keys
   for development; never put keys in command arguments or logs. Setup should
   explain external data transfer and validate the chosen providers. Add clear
   startup status, cancellation, and cleanup on exit. Keep microphone recording
   tied to deliberate activation.

3. **Connect speech and intent.** Build on the hosted transcription adapter with
   the aligned visual context above, then add a second reasoning-provider adapter
   before completing the MVP. Keep speech and reasoning settings independent.
   Users supply their own keys; requests go directly to their configured providers.
   Validate provider capabilities rather than assuming interchangeable APIs.
   Define typed execution and target validation when connecting concrete actions;
   keep informational responses unrestricted by an action enum.
   Keep context in memory by default and send only the context needed for the request.

4. **Deliver three useful interactions.** Register agent targets with user-chosen
   names, then support switching to a named agent, returning to the previous
   window, and inserting dictated text or selected context into a confirmed agent
   input. Start with one documented agent integration available across platforms.
   Use its APIs or supported links where possible. Keep submission explicit and
   resolve ambiguous targets before acting. Read agent status only when the
   integration exposes it reliably.

5. **Add minimal feedback and ship.** Show listening, processing, target, and error
   states through terminal output, audio cues, and brief desktop feedback. Provide
   confirmation near the user's work when needed. Package platform dependencies
   so users do not need compilers. Add CI on all three OSes and test provider
   parsing, action routing, cancellation, and focus restoration. Manually verify
   the complete hotkey-to-action flow in each supported desktop environment.

Defer the drawing overlay and gaze integration until visual context and cursor
attention work well. Future gaze should contribute to the same attention timeline
and remain optional for the MVP. Also defer background-service installation, local
transcription, broad agent coverage, and general OS automation.

Retain the MIT license and prefer permissive dependencies. Before redistribution,
audit bundled binaries and model weights separately. The image renderer uses
Apache-2.0 sharp; its bundled libvips package declares LGPL-3.0-or-later and includes
additional dependency licenses that need review before release packaging.

The MVP is complete when a user can install, configure their own keys, and perform
the three interactions on each supported OS without opening a separate app UI.
