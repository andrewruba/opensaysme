# OpenSaysMe

Less friction between what you want and what your AI agents do, using voice and desktop context.

## Why

Speaking to an agent can feel effortless. Getting it to understand what you mean and do what you want often takes more work.

The details may be scattered: a ticket in one browser tab, a discussion in a chat app, an error in your terminal, eight windows in between. You end up hunting for windows, copying context, and re-explaining what you mean to keep the work moving.

OpenSaysMe explores a simpler way: say what you want, with context from what you're working on.

## What we're exploring

Tap a hotkey and say:

> "Take the ticket I was just reading and that chat thread, and have the agent start on it."

OpenSaysMe explores how what you say and the context of your work can make that interaction easier. Gathering context, preparing input, getting an answer, navigating windows, or directing an agent's actions are all possibilities. The interaction should fit the request.

The core is collecting the right context, giving it to the model alongside the tools it can use, and carrying out the request within the permission you gave. The intended tools include inspecting windows, switching between them, moving the pointer to indicate something, clicking, scrolling, and typing. The model uses the results to decide what to do next. These shared desktop capabilities should work with existing agent interfaces; dedicated integrations can improve particular interactions.

That might mean bringing together context:

- A bug report in one tab and logs in another: "Debug this."
- PR review comments: "Address these."
- A spec plus a screenshot of the current UI: "Build this."

It can also mean navigating or directing agent work:

- With a terminal error visible, say: "Send this to the debugging agent."
- Say: "Switch to the agent working on authentication."
- Say: "Show me the agent waiting for my input, then take me back here."

Voice expresses the request. Screen content and application state provide context; pointing or selecting can help clarify what you mean. Gaze could supplement that context later as an optional input. A hotkey or other deliberate action initiates the interaction.

The goal is to complement the mouse and keyboard, not replace them or build another coding agent.

## Design goals

- **User control:** Explicit activation and permission scoped to your request. “Fill in this form” leaves it unsubmitted; “fill in this form and submit it” authorizes submission without a redundant confirmation. Ask when the target, information, or consequences remain materially unclear or exceed the request. Context alone never authorizes execution.
- **Privacy:** Local processing where practical, minimal retention, and explicit consent for external data transfer.
- **Interoperability:** Work alongside existing agents through their interfaces and documented integrations, using shared desktop capabilities wherever practical.

## Status

Early development prototype. Tap-to-talk combines speech with desktop history and a local tool loop: the agent can discover windows, inspect current context, capture the current screen, and focus a verified target. You do not need to name windows or define routing rules. Full screenshots remain paired with nearby speech phrases and timed cursor trails.

The voice agent calls desktop tools directly within the local runtime. Background-window inspection, pointer control, clicking, scrolling, typing, and enforcement of edit/submit permissions are upcoming core work. Agent-specific integrations can follow where useful; the agent can currently distinguish windows using titles and available desktop context.

See the [MVP backlog](BACKLOG.md) for feature status and remaining work.

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

Tap Ctrl+Shift+Space to start and stop; Escape cancels. Activated audio streams to OpenAI using your key. After stopping, the agent can gather additional evidence and switch windows to fulfill your request. Context and tool results go to your independently configured reasoning provider. macOS screen capture requires Screen Recording permission.

Run `npm run dev -- tools` to inspect the catalog without reading the desktop. See [the tool framework](docs/tools.md) for how to add capabilities.

## Debugging a session

To inspect a session, run `npm run dev -- --debug` (optionally followed by a directory). This saves captured context, clean screenshots and trail copies, prepared model requests, responses, and timed diagnostics locally. Files remain until you delete them; normal runs keep this data in memory.

See [development instructions](docs/development.md) for platform prerequisites, provider configuration, explicit desktop tests, and current limitations.
