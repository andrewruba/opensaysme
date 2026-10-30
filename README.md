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

Early development prototype. Tap-to-talk combines speech with desktop history and a local tool loop: the agent can discover windows, inspect current context, capture the current screen, and focus a verified target. On macOS it can also read bounded accessibility text and controls from a discovered background window, or capture that window's image on macOS 14+, without changing focus. You do not need to name windows or define routing rules. Historical full-screen images remain paired with nearby speech phrases and timed cursor trails.

The voice agent calls desktop tools directly within the local runtime. On macOS 14+, a first mouse/keyboard slice adds pointing, single clicks, scrolling, literal text replacement in accessible inputs, and Tab/Enter. Each input is checked independently against the original spoken request and target evidence; filling and submission are distinct effects. Targets must be focused, visible, and grounded in a recent window screenshot. The guard interprets natural language with the configured reasoning model; live permission accuracy and desktop input behavior still need validation. Windows/Linux input and background-window inspection/capture remain work. Some apps expose little accessibility content, and ambiguous native window identities remain a limitation.

Recent conversation now carries across activations for follow-ups such as “now submit it,” “click it,” or an answer to a clarification. The runtime keeps up to three completed turns in memory, at most 64 KiB total, with each turn expiring after two minutes. It retains requests, responses, target observations and action outcomes; screenshots, audio and input approvals do not carry over. Each turn still gathers fresh action evidence and checks permission independently. Follow-up interpretation and comparison of changed contents remain model-dependent and need live validation.

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

Tap Ctrl+Shift+Space to start and stop; Escape cancels pending work and clears recent conversation, but cannot undo input already issued. While idle, press Escape in the CLI terminal to clear conversation; the global Escape shortcut is active only during a turn. Activated audio streams to OpenAI using your key. After stopping, the agent can gather additional evidence and use available desktop actions within your request. Context, recent conversation, tool results, and input authorization checks go to your independently configured reasoning provider. macOS screen capture requires Screen Recording permission, and input also requires Accessibility access.

Run `npm run dev -- tools` to inspect the catalog without reading the desktop. See [the tool framework](docs/tools.md) for how to add capabilities.

## Debugging a session

To inspect a session, run `npm run dev -- --debug` (optionally followed by a directory). This saves captured context, clean screenshots and trail copies, prepared model requests including recent conversation, responses, and timed diagnostics locally. Files remain until you delete them; normal runs keep this data in memory.

See [development instructions](docs/development.md) for platform prerequisites, provider configuration, explicit desktop tests, and current limitations.
