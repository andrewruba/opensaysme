# OpenSaysMe — Human interface for AI agents

[![CI](https://github.com/andrewruba/opensaysme/actions/workflows/check.yml/badge.svg?branch=main&event=push)](https://github.com/andrewruba/opensaysme/actions/workflows/check.yml)
[![Version 0.4.1](https://img.shields.io/badge/version-0.4.1-blue?style=flat-square)](package.json)
[![Node.js 26.13.0 or newer](https://img.shields.io/badge/node-%3E%3D26.13.0-339933?style=flat-square)](package.json)
[![macOS 14 or newer](https://img.shields.io/badge/macOS-14%2B-000000?style=flat-square)](#run-it)
[![MIT license](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

OpenSaysMe is a command-line tool that lets you give AI agents instructions by
speaking and showing them what you mean. It gathers context from the apps you're
using and can pass your request to the agent you're working with.

## What works today

Tap a hotkey and talk. Point at something on screen or select text to show what
you mean. OpenSaysMe can read what's there, switch apps, click and type. You can
make short follow-up requests without repeating the context. It can discover
running apps even when their windows are not listed, inspect candidate destinations,
and keep a clarification tied to the work you requested.

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

You'll need **macOS 14+**, **Node.js 26.13+**, **Xcode Command Line Tools** and an
**OpenAI API key**.

Clone the repository and open its folder:

```sh
git clone https://github.com/andrewruba/opensaysme.git
cd opensaysme
```

If you use nvm, run `nvm install` and `nvm use` here first. Then install and configure:

```sh
npm ci
npm run install:cli
osm setup
export OPENAI_API_KEY='your-key'
```

Replace `your-key` with your API key in the terminal where you'll run `osm`.
Setup saves the name of the environment variable, not the key itself.

Grant **Microphone**, **Accessibility** and **Screen Recording** access to your
terminal or the OpenSaysMe helper in **System Settings → Privacy & Security**.
`osm doctor` checks access and whether your key is set; it doesn't test the key
with OpenAI.

Check your setup and start OpenSaysMe:

```sh
osm doctor
osm
```

`osm` and `opensaysme` are the same command. They run from this repository folder,
so keep it on your computer. If you move it, rerun `npm run install:cli` from the
new location.

## Using it

Keep `osm` running and switch to your work. Show the relevant content while you
speak. A small overlay shows progress and answers without taking focus.

| Shortcut | Action |
| --- | --- |
| **Ctrl+Shift+Space** (default) | Start recording. Wait for “Listening…” before speaking; tap again to finish. |
| **Escape** | Cancel the current request and clear follow-up context. |
| **Ctrl+C** | Quit. |

While idle, press Escape in the CLI terminal. Cancelling stops further actions;
it cannot undo anything already done.

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

If you change the reasoning model, choose one that supports images and tool calls.
Speech currently requires `gpt-live-transcribe`, and sharing screen context is
required.

## Development

Use the Node version in `.nvmrc`, then `npm ci`. Run the CLI from source with
`npm run dev -- --help`. `npm run check` checks versions, types, lint, tests and
the TypeScript build; individual commands are `npm run typecheck`, `npm run lint`,
`npm test` and `npm run build`.

For native changes, also run `sh native/macos/test.sh` and `npm run build:native`.
Restart a running `osm` process after rebuilding. See [agent tools](docs/tools.md)
for discovery, destination resolution and execution behavior.

## Troubleshooting

For troubleshooting, opt in to saving context, screenshots, model inputs, responses
and diagnostics:

```sh
osm --debug                 # save under .opensaysme-debug/ in the current directory
osm --debug ./my-captures    # choose a directory
```

## Uninstall

```sh
osm uninstall
```

Removes both `osm` and `opensaysme` commands. Your repository folder, saved settings
and debug captures stay on disk.
