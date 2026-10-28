# CLI-first MVP implementation plan

Build a local tool that makes existing agents easier to navigate and interact
with. Launch it from a terminal, activate it with a hotkey, and use voice plus
desktop context to identify the target and action.

```sh
opensaysme setup    # Configure providers, keys, hotkey, and agent targets
opensaysme         # Run until Ctrl+C
opensaysme doctor  # Check permissions, providers, and desktop capabilities
```

Use TypeScript and Node.js, Commander and Clack for the CLI, AI SDK for direct
provider calls, and Zod for configuration and action validation. Keep desktop
access behind platform adapters and agent-specific behavior behind integration
adapters. Use native helpers where necessary; a graphical helper can be added
for feedback without making it the application core.

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

3. **Connect speech and intent.** Start with one hosted transcription adapter and
   two reasoning-provider adapters, with independent speech and reasoning settings.
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

Keep gaze behind the same targeting interface as pointer and selection. Run an
early feasibility experiment for window-level targeting, but make it optional
for the MVP. Defer background-service installation, local transcription, broad
agent coverage, and general OS automation until the core interaction works well.

Retain the MIT license and prefer permissive dependencies. Check licenses for
bundled binaries and model weights separately to preserve commercialization options.

The MVP is complete when a user can install, configure their own keys, and perform
the three interactions on each supported OS without opening a separate app UI.
