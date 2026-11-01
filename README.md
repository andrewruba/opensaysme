# OpenSaysMe — Give AI agents tasks by talking and pointing

[![CI](https://github.com/andrewruba/opensaysme/actions/workflows/check.yml/badge.svg?branch=main&event=push)](https://github.com/andrewruba/opensaysme/actions/workflows/check.yml)
[![Version 0.6.0](https://img.shields.io/badge/version-0.6.0-blue?style=flat-square)](package.json)
[![macOS 14 or newer](https://img.shields.io/badge/macOS-14%2B-000000?style=flat-square)](#run-it)
[![MIT license](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

OpenSaysMe is a command-line tool that lets you give AI agents tasks by talking and
pointing on your screen. It gathers the relevant context across apps and can act on
the desktop or pass the request to your existing agent. Essentially, this is how
Siri *should* work.

## What works today

Tap a hotkey and talk. Point at a UI bug or failing test's output to show
what you mean. OpenSaysMe can read what's there, switch apps, click and type. You can
make short follow-up requests without repeating the context. It can discover
running apps even when their windows are not listed, inspect candidate destinations,
and keep a clarification tied to the work you requested.

OpenSaysMe adapts its approach to development and general tasks. A selected command,
build failure, configuration, code question or API response can guide development
investigation. It uses available desktop tools to gather relevant context, keeps
the tickets and selections you showed, and follows your requested outcome.

For substantive work, such as fixing a build, researching options or creating a
presentation, OpenSaysMe defaults to gathering enough context for a useful handoff
to an appropriate agent. It handles simple explanations, short edits and desktop
actions directly. Your explicit instructions take precedence. It inspects likely
destinations and asks when important ambiguity remains. A verified handoff means
the agent received the request; it does not establish that the underlying work is
finished.

For example, while it's listening, point out a broken page in your browser,
select the error in your terminal, and highlight the expected behavior in an issue.
Then say:

> Collect these into a bug report for my coding agent and ask it to fix the problem.

OpenSaysMe pulls the relevant details together and passes the request to your
coding agent, saving you from copying each piece between apps.

Your request sets the boundary: **“fill this form” excludes submission;
“fill this form and submit it” includes it.** Screen content supplies evidence,
not authority. You can request several actions together; after sending or submitting,
OpenSaysMe verifies the result before continuing to the next requested step. If
the outcome is uncertain, it stops without repeating the action.

## Run it

Requires **macOS 14+** and an **OpenAI API key**.

### Install from package

Package downloads will be listed under [Releases](https://github.com/andrewruba/opensaysme/releases).
Open the `.pkg` for your Mac and follow the installer.
The runtime is included; Node and Xcode are not required.

### Install from source

Requires **Node.js 26.13+** and **Xcode Command Line Tools**.

```sh
git clone https://github.com/andrewruba/opensaysme.git
cd opensaysme
npm ci
npm run install:cli
```

Keep the source folder after installing. If using nvm, run `nvm install` and
`nvm use` in it first.

Then, for either installation:

```sh
export OPENAI_API_KEY='your-key'
osm
```

First launch guides setup. Grant Microphone, Accessibility and Screen Recording
access in macOS settings; `osm doctor` checks access.

## Using it

Keep `osm` running and switch to your work. Show the relevant content while you
speak. A simple white overlay shows progress and answers without taking focus. Its
ASCII face listens, thinks and concentrates along with the agent, then smiles when a
response is ready. Recoverable desktop warnings stay in the terminal; the overlay
only interrupts progress for notices that need attention.

| Shortcut | Action |
| --- | --- |
| **Ctrl+Shift+Space** (default) | Start recording. Wait for “Listening…” before speaking; tap again to finish. |
| **Escape** | Dismiss a completed response; during a request, cancel and clear follow-up context. |
| **Ctrl+C** | Quit. |

After a task, Escape closes its overlay without switching apps. The key still
reaches the focused app; idle Escape in the CLI terminal also clears follow-up
context. Cancelling stops further actions; it cannot undo anything already done.

### Change the shortcut

```sh
osm hotkey                   # press a key combination at the prompt
osm hotkey --show            # show the saved shortcut
osm hotkey --help            # supported keys and modifiers
```

Keep the terminal focused, press and release your combination, then press Enter
to save. Restart `osm` to use it. Escape and Ctrl+C stay fixed.

### Recent work

OpenSaysMe remembers recent app/window names across restarts to help find your
work and recognize spoken names. This history contains only names and timestamps,
saved locally and shared with the model as context.

```sh
osm context                 # show remembered app/window names
osm context --clear         # stop voice mode first, then forget saved names
```

## Configuration

Settings live at `~/Library/Application Support/opensaysme/config.json`.
Edit the file directly or run `osm setup --replace` to repeat setup.
Set `OPENSAYSME_CONFIG_DIR` to use a different folder.

OpenAI is currently the only provider. Reasoning defaults to GPT-6.1 Terra with
low reasoning effort; speech uses `gpt-live-transcribe`.

```json
{
  "version": 1,
  "activationHotkey": "Ctrl+Shift+Space",
  "shareVisualContext": true,
  "speech": {
    "provider": "openai",
    "model": "gpt-live-transcribe",
    "apiKeyEnv": "OPENAI_API_KEY"
  },
  "reasoning": {
    "provider": "openai",
    "model": "gpt-6.1-terra",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

If you change the reasoning model, choose one that supports images, tool calls and
structured responses. Speech currently requires `gpt-live-transcribe`, and sharing
screen context is required.

## Development

Use the Node version in `.nvmrc`, then `npm ci`. Run the CLI from source with
`npm run dev -- --help`. `npm run check` checks versions, types, lint, tests and
the TypeScript build; individual commands are `npm run typecheck`, `npm run lint`,
`npm test` and `npm run build`.

For native changes, also run `sh native/macos/test.sh` and `npm run build:native`.
Restart a running `osm` process after rebuilding. See [agent tools](docs/tools.md)
for discovery, destination resolution and execution behavior.

Build installers with `npm run package:macos`; see [distribution](docs/distribution.md).

## Troubleshooting

For troubleshooting, opt in to saving context, screenshots, model inputs, responses
and diagnostics:

```sh
osm --debug                 # save under .opensaysme-debug/ in the current directory
osm --debug ./my-captures    # choose a directory
```

## Update or uninstall

```sh
osm update                 # update a package installation
osm uninstall              # remove OpenSaysMe, keeping settings
osm uninstall --purge      # also remove settings and recent history
```
