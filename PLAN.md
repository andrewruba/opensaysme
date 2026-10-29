# CLI-first MVP implementation plan

Build a local tool that makes existing agents easier to navigate and interact
with. Launch it from a terminal, activate it with a hotkey, and use voice plus
desktop context to identify the target and action.

```sh
opensaysme setup    # Configure providers, keys, hotkey, and agent targets
opensaysme         # Run until Ctrl+C
opensaysme doctor  # Check permissions, providers, and desktop capabilities
```

Use TypeScript and Node.js, Commander and Clack for the CLI, direct provider
adapters, and Zod for configuration and action validation. Keep desktop
access behind platform adapters and agent-specific behavior behind integration
adapters. Use native helpers where necessary; a graphical helper can be added
for feedback without making it the application core.

## Current slice: visual context history, cursor trajectories, and action preview

Implemented: tap-to-talk transcription, bounded visual/context history, cursor
trajectories, cancellation, and a structured OpenAI action preview. The current
speech adapter has no word timestamps; alignment remains explicitly uncertain.
Live reference accuracy and preview latency still need interactive evaluation.

Treat cursor movement, selections, and later annotations and gaze as evidence of
attention. Preserve their source and timing; let the model interpret them together
with speech and visible content. Avoid gesture-to-command mappings or requiring
regions to be classified into categories such as "error" before interpretation.
Attention helps identify a referent; the user's request establishes the intended
action.

1. **Collect visual context history.** Capture an initial screen frame and bounded
   updates while recording, alongside window/selection changes and cursor paths.
   Associate samples with their display, coordinates, frame, and capture time so
   references survive scrolling and window movement. Coalesce redundant samples
   while preserving useful trajectories. Detect screen-capture capabilities and
   permissions per platform and report missing context explicitly.
2. **Check temporal alignment.** Relate context and audio to a common turn clock.
   Distinguish capture time from delivery time; transcript arrival does not tell
   us when a word was spoken. Test alignment early, retain uncertainty, and change
   the speech adapter if the interaction needs timing it cannot provide.
3. **Produce an action preview.** On the second tap, freeze capture and use one
   independently configured BYOK reasoning provider that accepts text and images.
   Send the transcript and a compact selection of relevant frames and attention
   history. Validate a structured proposal and show the intended action, referenced
   regions/windows, and any clarification needed in the CLI. Execution follows in
   a later slice; do not require an overlay for this preview.
4. **Bound capture and evaluate.** Keep history in memory for the active turn and
   discard it after completion or cancellation. Explain external screen/context
   sharing in setup. Measure context overhead, reference accuracy, and stop-to-preview
   latency; test delayed transcripts, incidental movement, scrolling, and cleanup.

Acceptance: indicate a region in one window while saying "use this," move to
another window and say "over here," then stop. The preview should identify the
intended source and destination, or ask a specific clarification. It should work
without assigning the region or gesture a predefined semantic category.

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
   the visual-context preview above, then add a second reasoning-provider adapter
   before completing the MVP. Keep speech and reasoning settings independent.
   Users supply their own keys; requests go directly to their configured providers.
   Validate provider capabilities rather than assuming interchangeable APIs.
   Translate speech into a small set of typed actions and validate targets locally.
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

Retain the MIT license and prefer permissive dependencies. Check licenses for
bundled binaries and model weights separately to preserve commercialization options.

The MVP is complete when a user can install, configure their own keys, and perform
the three interactions on each supported OS without opening a separate app UI.
