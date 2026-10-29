# OpenSaysMe
A more natural way to navigate and direct AI agents using voice, context, and gaze tracking.

## Why

Speaking to an agent can feel effortless. Finding the right
conversation, switching windows, and copying context often does not.

This project explores a simpler way to navigate and interact with
agents: indicate what you mean and say what you want.

## What we're exploring

- Look at or select a terminal error:
  “Send this to the debugging agent.”
- Say: “Switch to the agent working on authentication.”
- Say: “Show me the agent waiting for my input, then take me back here.”

Voice expresses the request. Selections, pointer position, application
context, and gaze help identify the target. A hotkey or
other deliberate action initiates the interaction.

The goal is to complement the mouse and keyboard—not replace them
or build another coding agent.

## Design goals

- **User control:** Explicit activation, visible targets, and
  confirmation for consequential actions. Looking alone never
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
Action execution and gaze capture remain future work.

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

See [development instructions](docs/development.md) for platform prerequisites,
provider configuration, explicit desktop tests, and current limitations.
