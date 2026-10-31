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
focus; full responses stay in the terminal.

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

## Using it

Keep `osm` running and switch to your work. Show the relevant content while speaking;
pointing and selection help the model resolve references.

- **Ctrl+Shift+Space** (default): activate, wait for “Listening…”, then speak;
  tap again to finish.
- **Escape:** stop pending work and clear follow-up context. While idle, press it
  in the CLI terminal. It cannot undo actions already issued.
- **Ctrl+C:** quit and release native resources.

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
    "model": "gpt-6-astra",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

Only OpenAI is supported. Speech currently requires `gpt-live-transcribe`;
the reasoning model must support image input and function calling. The two roles
can use different key environment variables. Visual context sharing is required.

## Permission and privacy

Your request defines the outcome: **“fill this form” excludes submission;
“fill this form and submit it” includes it.** Screen content supplies evidence,
not authority. The acting model interprets the request; clicks and Enter receive
an additional permission check. Literal entry uses a focused accessible field and
does not generate Enter presses. Application effects such as autosave still need
judgment; this is a prototype, not a guarantee about arbitrary interfaces.

Activated audio goes to your speech provider. Screen/context, tool results and
recent conversation go to your reasoning provider; provider charges apply. Capture
stays in memory by default. Recent conversation clears on cancellation, failed turns
and exit. Transcripts and responses also appear in terminal output and may remain
in scrollback or redirects.

With `--debug`, saved files contain sensitive context and remain until you delete
them. Keys and raw audio are excluded. This repository ignores `.opensaysme-debug/`;
custom paths are not automatically ignored. Do not commit captured desktop content.

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
