# OpenSaysMe
A more natural way to navigate and direct AI agents using voice and desktop context.

## Why

Speaking to an agent can feel effortless. Finding the right
conversation, switching windows, and copying context often does not.

This project explores a simpler way to navigate and interact with
agents: say what you want, with context from what you're working on.

## What we're exploring

- With a terminal error visible, say:
  “Send this to the debugging agent.”
- Say: “Switch to the agent working on authentication.”
- Say: “Show me the agent waiting for my input, then take me back here.”

Voice expresses the request. Screen content and application state provide context;
pointing or selecting can help clarify what you mean. Gaze could supplement that
context later as an optional input. A hotkey or other deliberate action initiates
the interaction.

The goal is to complement the mouse and keyboard—not replace them
or build another coding agent.

## Design goals

- **User control:** Explicit activation, visible targets, and
  confirmation for consequential actions. Context alone never
  authorizes execution.
- **Privacy:** Local processing where practical, minimal retention,
  and explicit consent for external data transfer.
- **Interoperability:** Work alongside existing agents through
  documented integrations rather than replace their interfaces.

## Development prototype

The CLI supports tap-to-talk transcription and natural-language responses grounded
in desktop history. Full screenshots are paired with nearby speech phrases and
timed cursor trails, preserving attention without assigning gestures fixed meanings.
Trail copies are model input only: there are no crops or on-screen overlays.
Action execution remains future work.

```sh
npm ci
npm run build:native  # Builds the helper on macOS; requires Xcode Command Line Tools
npm run build
node dist/cli.js doctor
node dist/cli.js setup
node dist/cli.js       # Requires the API-key environment variable chosen in setup
```

Tap Ctrl+Shift+Space to start and stop; Escape cancels. Activated audio streams to
OpenAI using your key. After stopping, selected screen frames and attention history
go to your independently configured reasoning model for a response. Nothing is
executed. Run `npm ci` after updating to install the image-processing dependency;
existing visual-sharing configuration and keys still work. macOS screen capture
requires Screen Recording permission.

To inspect a session, run `npm run dev -- --debug` (optionally followed by a
directory). This saves captured context, clean screenshots and trail copies,
prepared model requests, responses, and timed diagnostics locally. Files remain
until you delete them; normal runs keep this data in memory.

See [development instructions](docs/development.md) for platform prerequisites,
provider configuration, explicit desktop tests, and current limitations.
