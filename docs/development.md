# Developing the macOS loop

OpenSaysMe is a macOS 14+ source-built prototype. The immediate goal is to use
speech and desktop context to get useful work into an existing agent, then improve
whatever makes that interaction awkward.

## Setup

Use Node.js 22.20+ and Xcode Command Line Tools. From the repository:

```sh
npm ci
npm run install:cli
osm setup
export OPENAI_API_KEY='your-key'
osm doctor
osm
```

`install:cli` builds TypeScript and the native helper, then runs `npm link` against
this checkout. Both `osm` and `opensaysme` invoke the same launcher and work from
any directory; nothing is published to npm. Keep the checkout in place. After code
changes, run `npm run build` and, for Swift changes, `npm run build:native`. Rebuilds
keep the linked commands usable. If you move the checkout or switch Node versions,
rerun `npm run install:cli`.

If the shell cannot find either command, run `npm prefix --global` and ensure its
`bin` directory is on PATH, then reopen the terminal. Use a user-managed Node
installation if the global directory is not writable; no `sudo` is needed. To
remove both commands, run `npm uninstall --global opensaysme`. Your saved
configuration stays in place.

`npm run dev -- <arguments>` runs TypeScript directly; `npm run dev` starts voice
mode. Rebuild the native helper after Swift changes. Setup stores environment
variable names and independent speech/reasoning settings. It makes no provider
request and never asks for a key value. Replace `your-key` above with your API key;
if you chose different environment-variable names, export those instead. Use the
same terminal to launch voice mode; variables may need exporting again after a
terminal restart. `osm --help` includes the setup sequence, permission
guidance, shortcut commands and spoken-request examples. Startup displays the
configuration path, active models and shortcut.

A valid saved configuration is retained by `osm setup`. Use `osm setup --replace` to
change it. There is no Keychain storage or automatic configuration migration.
If you tried the removed Keychain experiment, rerun `osm setup --replace`; any
previously saved `dev.opensaysme.provider` items can be removed manually in Keychain
Access. The application no longer reads or modifies them.

Configuration lives at `~/Library/Application Support/opensaysme/config.json`.
`OPENSAYSME_CONFIG_DIR` overrides the directory. For example:

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

Only OpenAI is implemented. Speech uses streaming transcription; reasoning needs
image input and function calling. New setups default to
[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), using low
reasoning effort for the actor and click/Enter checks. Saved provider choices are
retained; edit `reasoning.model` to `gpt-6-astra` to switch an existing configuration.
The actual request reports authentication/model failures; setup and doctor do not
issue test requests.

Change only the activation shortcut without repeating setup:

```sh
osm hotkey                   # press a key combination at the capture prompt
osm hotkey "Cmd+Shift+Space"  # save directly, without a prompt
osm hotkey --show             # print the saved shortcut
osm --hotkey "Ctrl+Alt+Space"  # start with a shortcut for this run only
osm hotkey --help
```

Run `osm hotkey` in the focused terminal. Wait until it is ready, then physically
press and release the desired combination, including its modifier keys. The CLI
shows the recognized shortcut and asks whether to save it; press Enter to confirm.
Escape or Ctrl+C cancels. Capture also stops without saving if focus changes or
30 seconds pass. Both command names work, so `opensaysme hotkey` opens the same
prompt. Use the direct argument or `--show` in scripts.

Shortcut recording uses a temporary native keyboard capture with Accessibility
access so Command combinations can be recognized without activating terminal
commands. It runs only during the prompt while that terminal stays focused, ends
before confirmation, captures no audio or screenshots, and makes no provider requests.
Initial `osm setup` uses Ctrl+Shift+Space; change it with `osm hotkey` after granting
Accessibility access. Directly supplying a shortcut does not need capture access.

Restart voice mode after changing the saved setting. A `--hotkey` override applies
only to that voice session and leaves the configuration file unchanged. The order
is CLI override, saved `activationHotkey`, then Ctrl+Shift+Space. Supported modifiers
are Ctrl, Alt, Cmd and Shift with Space, A–Z, 0–9 or F1–F12; include at least Ctrl,
Alt or Cmd. Case and surrounding spaces are normalized. Letter/digit keys use US
physical key positions.
Escape and any Ctrl+C combination are reserved. Other controls keep their existing
bindings. If another app or macOS owns the shortcut, startup reports it unavailable;
choose another combination. Omitting `activationHotkey` uses Ctrl+Shift+Space.

## Permissions and the first run

Microphone, Accessibility and Screen Recording are separate macOS grants. Use
System Settings → Privacy & Security to enable the terminal/helper identified by
macOS. Screen Recording is called Screen & System Audio Recording on some versions.
If access still fails after a grant, fully quit/reopen the launching terminal and
retry. Moving or rebuilding an unsigned helper can require renewed access.

`doctor` reports available access and missing dependencies without requesting
permissions, recording, capturing selections/screenshots or changing focus. It
checks provider key presence, not authentication. Start voice mode and try a real
request to find out whether capture and interaction work. There are no separate
microphone, screenshot or hotkey verification commands.

Known desktop failures preserve specific error codes and useful recovery advice.
A crash, timeout or unavailable device is not automatically a permission denial.
The panel can retain an earlier warning while the agent continues with the context
it has. Permission grants allow access; they do not authorize arbitrary actions.

## Using the loop

Keep the CLI running while working in another app. Tap your activation shortcut
(**Ctrl+Shift+Space** by default), wait
for “Listening…”, speak and show the relevant content, then tap again. The model
can inspect windows before answering or acting. Pointing and selection help resolve
references without requiring manual window labels.

**Escape** cancels pending work and clears recent conversation. While idle, use
Escape in the CLI terminal; the global Escape shortcut runs only during a turn.
**Ctrl+C** shuts down capture, native helpers and provider work. Cancellation cannot
undo input already issued. The feedback panel passes mouse input through, never
takes keyboard focus, and leaves full responses in the terminal.

Start with a real task such as preparing an error and explanation in your agent's
input. Follow with “now send it.” Preparation should leave the input unsent;
the follow-up authorizes sending.
No automated live-provider harness or formal baseline report is required.

## Context and action behavior

Audio streams while recording. Screen, active-window, selection and cursor samples
are collected locally and paired with nearby speech intervals. Phrase intervals
are capture-time envelopes, not exact word timestamps. The agent can then discover
windows, inspect background Accessibility content, capture a window image, focus
it and act using the tools in [tools.md](tools.md).

The acting model interprets the request for every operation. Clicks and Enter get
an additional independent check using the current request, screenshot and native
target. Pointing, scrolling, Tab and literal text entry skip that extra model call.
Text entry requires an already-focused writable AXTextField or AXTextArea; multiline
text requires AXTextArea. It replaces the value without generating keyboard events.
The model must still account for autosave or blur handlers; the routine path does
not independently verify their effect.

Before input, native code rechecks the target window/control, focus, geometry and
user input. It no longer traverses or fingerprints the entire window; unrelated
badges, timers, protected siblings or truncated AX trees do not block an otherwise
supported target. Other form fields can change during a pending click check, so
material submission contents still require fresh model inspection. Clicks, scroll
and key events report issued events; that is not proof the intended app outcome
occurred. Uncertain outcomes stop further input rather than encouraging blind retry.

Recent conversation is bounded in memory and cleared on cancellation, failed turns
and shutdown. Images, audio, action handles and approvals do not carry over. The
size/time constants in `src/conversation.ts` are conservative development defaults;
change them based on actual follow-ups, not as a separate product milestone.

Known limits to investigate when they block a task:

- Some apps expose little Accessibility content or no writable composer. Purely
  visual input targets and arbitrary keyboard shortcuts are unsupported.
- Window titles/process identity can become stale or ambiguous; matching titles
  alone do not establish the intended agent or unchanged contents.
- Retained requests and screenshots can be misinterpreted by the model. Routine
  mocks do not establish real-model permission accuracy.
- Multi-display coordinates, focus races, app normalization of entered text and
  physical cancellation behavior need observation on the desktop being used.

## Privacy and debugging

Activated audio goes to the speech provider. Selected screen frames, context,
transcripts, recent conversation and requested tool results go to the reasoning
provider. Click/Enter checks also send the proposed action and target evidence.
Provider charges and retention policies apply. Reasoning requests use `store: false`.
There is no clipboard use or arbitrary model-generated shell execution.

Normal capture stays in memory. Terminal output includes transcripts, responses
and metadata, which may remain in scrollback or redirects. Optional debug files
include sensitive screen pixels and captured context; screenshots are not redacted.
Keys and raw audio are excluded from diagnostics.

```sh
npm run dev -- --debug
npm run dev -- --debug ./my-captures
```

The default `.opensaysme-debug/` directory is ignored by Git. Custom paths are not.
A session contains `session.jsonl` plus per-turn context, prepared requests,
responses, tool events and images. Files remain until deleted. A prepared request
is not proof it was dispatched. Debug failures warn without stopping normal use.
Do not commit captured desktop content; use a minimal synthetic regression instead.

Normal results already contain timing information for capture, transcription,
reasoning/tools and stop-to-response. Use it when a wait is noticeable; do not
build another metrics system before finding a bottleneck worth fixing.

## Checks

```sh
npm run typecheck
npm run lint
npm test
npm run check          # typecheck, lint, unit tests, TypeScript build
sh native/macos/test.sh
npm run build:native
```

Routine tests use mocked providers and synthetic native inputs. They require no
keys, provider charges, actual screenshots or desktop input. Keep regressions for
target resolution, request boundaries, provider parsing and cancellation; add
new tests for observed failures rather than expanding an abstract acceptance matrix.
CI runs on macOS only. Other-platform implementations and checks were removed from
the active tree; previous versions remain in Git history.

The native capture path includes fixes for process-start identity and CoreGraphics
initialization before ScreenCaptureKit use. Compilation and synthetic tests do not
prove real application behavior. Follow the [native protocol notes](../native/macos/README.md)
when changing OS access. Distribution/signing and prebuilt binaries are parked;
this repository is currently installed from source.
