# OpenSaysMe 🧙 — Less friction with your AI agents

[![CI](https://github.com/andrewruba/opensaysme/actions/workflows/check.yml/badge.svg?branch=main&event=push)](https://github.com/andrewruba/opensaysme/actions/workflows/check.yml)
[![Version 0.3.0](https://img.shields.io/badge/version-0.3.0-blue?style=flat-square)](package.json)
[![Node.js 26.13.0 or newer](https://img.shields.io/badge/node-%3E%3D26.13.0-339933?style=flat-square)](package.json)
[![macOS 14 or newer](https://img.shields.io/badge/macOS-14%2B-000000?style=flat-square)](#run-it)
[![MIT license](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

OpenSaysMe is a command-line tool for interacting with AI agents through voice
and desktop context. Speak while showing the relevant work; it gathers
context, finds the right window, and carries out your request.

## What works today

Tap a hotkey to talk; the model receives speech, screen history, selection and
pointer context, and can inspect windows, navigate, point, click, scroll, type and
use keyboard shortcuts. It can use Spotlight to open an app and a browser's address
bar to navigate, including when the app has no open window yet. Short follow-ups
carry context across activations. A small panel shows status and readable,
scrollable answers without taking focus. Responses stay open until you close them
or start another request; they also remain in the terminal.

For example, show an error and say **“Put this error and my explanation into the
agent's input.”** Then say **“Now send it.”** Preparation should leave the input
unsent; the follow-up authorizes sending. “Point to that setting” should only point.
No window labels, routing rules or mandatory review ceremony.

Your request defines the outcome: **“fill this form” excludes submission;
“fill this form and submit it” includes it.** Screen content supplies evidence,
not authority.

## Run it

Requires macOS 14+, Node.js 26.13+, Xcode Command Line Tools, and your own OpenAI API
key in an environment variable. Reasoning defaults to GPT-6.1 Terra (`gpt-6.1-terra`)
with low reasoning effort; speech uses `gpt-live-transcribe` independently.

If you use nvm, run `nvm install` and `nvm use` in this folder first; `.nvmrc` selects
the project's Node version.

```sh
npm ci
npm run install:cli
osm setup
export OPENAI_API_KEY='your-key'
osm doctor
osm
```

Run the install commands from this repository folder. `install:cli` builds the app
and makes `osm` and `opensaysme` available in your terminal. Both commands run files
from this folder, even when called from another directory. Keep the folder on your
computer; if you move it, run `npm run install:cli` again from its new location.

Setup stores environment-variable names, never keys. Replace `your-key` above with
your API key; if you chose different variable names during setup, export those in
the same terminal used to launch `osm`. Grant Microphone, Accessibility and Screen
Recording for your terminal/helper in System Settings → Privacy & Security.
`osm doctor` reports access and key presence without capturing, requesting
permissions or calling a provider; it does not verify authentication.
`osm --help` includes this first-run guidance and usage examples.
Startup prints the active models, configuration path and shortcut.
Run `osm --version` to see the installed version.

## Using it

Keep `osm` running and switch to your work. Show the relevant content while speaking;
pointing and selection help the model resolve references.

- **Ctrl+Shift+Space** (default): activate, wait for “Listening…”, then speak;
  tap again to finish.
- **Escape:** stop pending work and clear follow-up context. While idle, press it
  in the CLI terminal. It cannot undo actions already issued.
- **Ctrl+C:** quit and release native resources.

The agent can use shortcuts such as Cmd+Space and Cmd+L, then type into the focused
input. It checks fresh screen and focus evidence between actions. Enter can open a
requested app or website; sending a message or submitting a form still requires
that outcome in your request. Escape, Ctrl+C and your activation shortcut stay
reserved for you. Keyboard typing inserts single-line text; multiline preparation
uses direct text replacement in supported inputs.

```sh
osm hotkey                   # press a key combination at the capture prompt
osm hotkey --show            # show the saved shortcut
osm hotkey --help            # supported keys and modifiers
```

To record a shortcut, grant Accessibility access, wait for the prompt, then press
and release the combination, including its modifiers. Press Enter to confirm
saving. Keep the terminal focused; focus changes, Escape, Ctrl+C or a 30-second
timeout cancel capture. Restart voice mode after changing the saved shortcut.
Letter/digit shortcuts use US physical key positions. Escape and Ctrl+C stay fixed.

## Configuration

`osm setup` retains a valid saved configuration; `osm setup --replace` replaces it.
Settings live at `~/Library/Application Support/opensaysme/config.json`.
Set `OPENSAYSME_CONFIG_DIR` to use a different directory, or edit the file directly:

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

Only OpenAI is supported. Speech currently requires `gpt-live-transcribe`;
the reasoning model must support image input and function calling. The two roles
can use different key environment variables. Visual context sharing is required.

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
