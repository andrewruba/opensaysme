# Developing the CLI prototype

This slice provides terminal setup, a foreground runtime scaffold, and desktop
capability experiments. It does not yet transcribe speech, call models, route
agent messages, or perform actions automatically. All desktop tests are local.

Use Node.js 22.20+ and npm. From the repository:

```sh
npm ci
npm run build:native
npm run build
node dist/cli.js --help
node dist/cli.js doctor --json
```

`npm run dev -- <arguments>` runs the TypeScript source directly. Desktop probes
work without provider setup. The npm package is private until release packaging
is ready; no published `npx opensaysme` installation is promised by this prototype.

## Platform prerequisites

| Platform | Prerequisites and limits |
| --- | --- |
| macOS | Xcode Command Line Tools to build the Swift helper. Window inspection, focus, and selection require Accessibility access for the relevant terminal/helper. Microphone access is separate. Development binaries are unsigned; stable signing and prebuilt Intel/Apple Silicon packages remain release work. |
| Windows | Native Windows Node.js, Windows PowerShell, and an interactive desktop. Helpers use Win32/UI Automation and the installed .NET Framework. Execution policy is respected. WSL does not provide access to native Windows windows through the Linux adapter. |
| Linux/X11 | `xdotool`, `xsel`, and `xprop` (often in `x11-utils`) for windows and PRIMARY selection; Python 3 and `libX11` for the explicit hotkey test. `arecord` from `alsa-utils` is optional for microphone testing. An EWMH-compatible window manager is required. |
| Linux/Wayland | Detected separately, even when XWayland sets `DISPLAY`. Native window/selection/focus and GlobalShortcuts portal support are not implemented. The ALSA microphone experiment remains separately available. |

Dependencies are never installed by the CLI. Linux utilities are external system
prerequisites, not bundled binaries. Their licenses need separate review before
redistribution. Native implementation details are in
[macOS](../native/macos/README.md) and [Windows](../native/windows/README.md).

## Explicit desktop experiments

`doctor` checks capabilities without recording audio, registering hotkeys,
reading selected text, requesting permissions, or changing focus. Its statuses
are `available`, `permission-required`, `unavailable`, and `unverified`. An
available API or permission alone does not prove a complete interaction works.
Doctor exits zero when it produces a report; inspect individual capability
statuses rather than treating that exit code as universal desktop support.

```sh
# Focus another application during the delay; output can include private titles.
node dist/cli.js desktop inspect --delay 3

# Opt in to reading the selection. Text is printed locally as escaped JSON.
node dist/cli.js desktop inspect --selection --delay 3

# Copy an ID from inspect; this changes focus but does not type or submit text.
node dist/cli.js desktop focus '<target-id>'

# Press Ctrl+Shift+Space during the bounded test.
node dist/cli.js desktop test-hotkey --seconds 10

# Records briefly and discards audio; only capture metrics are printed.
node dist/cli.js desktop test-microphone --seconds 3
```

Test durations are limited to 1–30 seconds. Input tests exit zero for `passed`,
one for `not-observed`, and two for `unavailable`; unexpected failures exit one.
Ctrl+C cancels running helpers. Audio tests prove buffer delivery, not speech
quality. No recordings, transcripts, or snapshots are stored by these commands.

Window IDs are temporary. Reinspect after an app closes or changes its windows.
macOS rejects ambiguous windows and invalidates tokens after title changes.
Linux selection reads the last X11 PRIMARY selection; it is not guaranteed to
belong to the active window. Windows selection depends on UI Automation support.

## Provider configuration

Run `node dist/cli.js setup` in an interactive terminal. This first version saves
reasoning/speech preferences and environment-variable names, never key values.
Supply keys through your environment for development; OS credential-store setup
will be added when provider calls are implemented. Doctor reports key presence,
not authentication success, and never makes a paid request.

The configuration is stored under the user's platform config directory. Use
`OPENSAYSME_CONFIG_DIR` to override it. For non-interactive setup, create
`config.json` there with this shape, replacing the model placeholders:

```json
{
  "version": 1,
  "reasoning": {
    "provider": "anthropic",
    "model": "your-reasoning-model",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  },
  "speech": {
    "provider": "openai",
    "model": "your-transcription-model",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

Reasoning preferences accept `openai` or `anthropic`; speech currently accepts
`openai`. These are configuration choices, not implemented provider adapters.
Setup will not overwrite existing configuration. After setup, `node dist/cli.js`
stays alive until Ctrl+C, without opening devices or starting voice activation.

## Checks and verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run check        # All four checks above
npm pack --dry-run   # Inspect packaging; local binaries/caches must be excluded
```

The opt-in X11 integration suite uses two synthetic windows in Xvfb to test
inspection, focus restoration, PRIMARY selection, and actual shortcut delivery
and cleanup. Run it in an isolated container with Docker:

```sh
docker build -f scripts/Dockerfile.x11 -t opensaysme-x11-test .
docker run --rm --init --network none opensaysme-x11-test
```

The container runs as an unprivileged user, uses no host mounts, and needs no
provider keys. `npm test` skips these live tests unless explicitly enabled inside
the virtual display.

Tests cover native-response validation, config privacy, helper deadlines and
cancellation, and CLI lifecycle. Mocked platform tests do not establish live
desktop support. CI builds/checks each OS and compiles the relevant helpers;
physical microphone and permission/focus behavior require interactive checks.

For each supported desktop session, manually test inspect, focus-away-and-back,
selection, hotkey activation, microphone delivery, and Ctrl+C cleanup. Record
the OS/session and results. Never treat unrun tests or denied permissions as a
successful capability proof.

### Initial verification (2026-10-28)

- **Linux/X11, Debian bookworm ARM64 with Xvfb/Openbox:** All four live integration
  tests passed: active-window inspection, switching and restoring focus, PRIMARY
  selection with whitespace preserved, and shortcut delivery followed by
  successful re-registration. This exercised real X11 APIs in an isolated virtual
  desktop; no physical desktop or microphone was accessed.
- **macOS 15.7.3, Apple Silicon:** Swift helper built and the read-only doctor
  reached the desktop. Temporary hotkey registration and timeout cleanup worked;
  key delivery was not exercised. Accessibility was not granted, so window
  inspection, focus, and selection remain unverified. Microphone permission was
  present; physical capture was not tested. The Intel helper was cross-compiled,
  not run.
- **Windows:** Adapter fixtures pass. Native helper compilation, input delivery,
  focus, and selection still require a Windows run. The CI workflow includes
  Windows checks but has not yet been run remotely.
- **Wayland:** Desktop actions are explicitly unavailable in this slice.

These results establish a scaffold and repeatable experiments, not completion of
the plan's cross-platform desktop-access milestone. Physical microphone tests and
interactive permission/focus checks remain necessary before connecting voice to
actions.
