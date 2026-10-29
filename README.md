# OpenSaysMe

Say what you want your AI agent to do. OpenSaysMe uses voice and what you were just looking at to gather the context for you.

## Why

Speaking to an agent can feel effortless. Gathering the context, finding the right window, and copying it all into a prompt often does not.

You're about to ask an agent to do something. The details are scattered: a ticket in one browser tab, a discussion in a chat app, an error in your terminal, eight windows in between. Before you can say what you want, you're hunting for windows, copying text, and pasting it into a prompt box.

OpenSaysMe explores a simpler way: say what you want, with context from what you're working on.

## What we're exploring

Tap a hotkey and say:

> "Take the ticket I was just reading and that chat thread, and have the agent start on it."

OpenSaysMe uses what was on your screen, where your cursor lingered, and what you said to assemble the prompt. You review it, then send it yourself.

More examples of gathering context:

- A bug report in one tab and logs in another: "Debug this."
- PR review comments: "Address these."
- A spec plus a screenshot of the current UI: "Build this."

Later, the same context can help you navigate between windows and agents:

- With a terminal error visible, say: "Send this to the debugging agent."
- Say: "Switch to the agent working on authentication."
- Say: "Show me the agent waiting for my input, then take me back here."

Voice expresses the request. Screen content and application state provide context; pointing or selecting can help clarify what you mean. Gaze could supplement that context later as an optional input. A hotkey or other deliberate action initiates the interaction.

The goal is to complement the mouse and keyboard, not replace them or build another coding agent.

## Design goals

- **User control:** Explicit activation, visible targets, and confirmation for consequential actions. Context alone never authorizes execution.
- **Privacy:** Local processing where practical, minimal retention, and explicit consent for external data transfer.
- **Interoperability:** Work alongside existing agents through documented integrations rather than replace their interfaces.

## Status

Early development prototype (macOS). Today it supports tap-to-talk transcription and natural-language responses grounded in desktop history. Full screenshots are paired with nearby speech phrases and timed cursor trails, preserving attention without assigning gestures fixed meanings. Trail copies are model input only: there are no crops or on-screen overlays.

It does not yet draft prompts or take actions. Action execution remains future work.

<!-- demo video goes here -->

## Quick start

```sh
npm ci
npm run build:native  # Builds the helper on macOS; requires Xcode Command Line Tools
npm run build
node dist/cli.js doctor
node dist/cli.js setup
node dist/cli.js       # Requires the API-key environment variable chosen in setup
```

Tap Ctrl+Shift+Space to start and stop; Escape cancels. Activated audio streams to OpenAI using your key. After stopping, selected screen frames and attention history go to your independently configured reasoning model for a response. Nothing is executed. Run `npm ci` after updating to install the image-processing dependency; existing visual-sharing configuration and keys still work. macOS screen capture requires Screen Recording permission.

## Debugging a session

To inspect a session, run `npm run dev -- --debug` (optionally followed by a directory). This saves captured context, clean screenshots and trail copies, prepared model requests, responses, and timed diagnostics locally. Files remain until you delete them; normal runs keep this data in memory.

See [development instructions](docs/development.md) for platform prerequisites, provider configuration, explicit desktop tests, and current limitations.
