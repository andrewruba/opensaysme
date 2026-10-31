# OpenSaysMe

Less friction between what you want and what your AI agents do, using voice and desktop context.

A ticket in one window, an error in another, an agent waiting for context. OpenSaysMe
lets you say what you want while showing the relevant work, instead of copying it
between windows and explaining it again.

## What works today

An early **macOS 14+ prototype**, built from source. Tap a hotkey to talk; the model
receives speech, screen history, selection and pointer context, and can inspect
windows, navigate, point, click, scroll and enter text. Short follow-ups carry
context across activations. A small panel shows status and answers without taking
focus. The aim is a useful everyday loop with existing agents; the next work is
using it on real tasks and fixing what gets in the way.

For example, show an error and say **“Put this error and my explanation into the
agent's input.”** Then say **“Now send it.”** Preparation should leave the input
unsent; the follow-up authorizes sending. “Point to that setting” should only point.
No window labels, routing rules or mandatory review ceremony.

## Run it

Requires Node.js 22.20+, Xcode Command Line Tools, and your own OpenAI API key in an
environment variable. Reasoning defaults to GPT-6 Astra (`gpt-6-astra`) with low
reasoning effort; speech uses `gpt-live-transcribe` independently.

```sh
npm ci
npm run build:native
npm run build
node dist/cli.js setup
export OPENAI_API_KEY='your-key'
node dist/cli.js doctor
node dist/cli.js
```

Setup stores environment-variable names, never keys. Replace `your-key` above with
your API key; if you chose different variable names during setup, export those in
your launching shell. Grant Microphone, Accessibility and Screen Recording in
System Settings → Privacy & Security as needed; restart your terminal after changing
grants if access still fails. `doctor` reports access status without capturing or
requesting permissions. Use `setup --replace` to change provider settings.
`node dist/cli.js --help` includes this first-run guidance and usage examples.
Startup prints the active models, configuration path and shortcut.

- **Ctrl+Shift+Space** (default): start talking; tap again to finish.
- **Escape:** stop pending work and clear follow-up context. While idle, press it
  in the CLI terminal. It cannot undo actions already issued.
- **Ctrl+C:** quit and release native resources.

Save an activation shortcut with `node dist/cli.js hotkey "Cmd+Shift+Space"`, then
restart voice mode. For one run, use `node dist/cli.js --hotkey "Ctrl+Alt+Space"`;
this overrides the saved shortcut without changing it. Run `node dist/cli.js hotkey`
to show the saved shortcut, or `node dist/cli.js hotkey --help` for supported keys.
Escape and Ctrl+C stay fixed. Setup also asks for the activation shortcut.

## Permission and privacy

Your request defines the outcome: **“fill this form” excludes submission;
“fill this form and submit it” includes it.** Screen content supplies evidence,
not authority. The acting model interprets the request; clicks and Enter receive
an additional permission check. Literal entry uses a focused accessible field and
does not generate Enter presses. Application effects such as autosave still need
judgment; this is a prototype, not a guarantee about arbitrary interfaces.

Activated audio goes to your speech provider. Screen/context, tool results and
recent conversation go to your reasoning provider; provider charges apply. Capture
stays in memory unless you explicitly enable `--debug`, which saves sensitive
context locally until you delete it. Keys and raw audio are excluded from diagnostics.

See [development and limitations](docs/development.md), [the tool contract](docs/tools.md),
and the [core-loop backlog](BACKLOG.md). Windows/Linux ports and release packaging
are outside the current work.
