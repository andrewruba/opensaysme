# Backlog

Build a useful macOS 14+ loop: speak while showing relevant work, let the model
gather context and resolve the target, then answer or act within the request.
The current install is from source with environment-variable provider keys.

`In progress` means implementation is underway. `Todo` means queued work.
`Done` means the described implementation and routine checks landed; it does not
claim compatibility with every app or a successful real-world interaction.
Real-use observations belong in [field notes](docs/field-notes.md).

## Active queue

Work in this order. Add concrete failures from use as new items, with a reproduction
and an observable result, instead of reopening broad feature areas as “partial.”

| ID | Priority | Status | Work | Done when |
| --- | --- | --- | --- | --- |
| B03 | P1 | Todo | Try one real context-to-agent task and its follow-up. | A field note records the request, app, actual outcome and friction: show an error or ticket, prepare it in the intended agent input, then explicitly send it. Record failures as well as successes. |
| B04 | P1 | Todo | Turn the first run's friction into the next scoped fix. | Review B03, queue the smallest concrete blocker if one was observed, and repeat the same task after fixing it. Use a small regression where the cause is reproducible offline. |
| B05 | P2 | Todo | Show a useful interaction in the README. | After a useful real run, add a short demo showing the request and result, with private context removed. |

B03 is the next use of the implemented loop, not a six-scenario release gate.
App compatibility, additional input methods, better reference resolution and latency
work enter this queue when a real task identifies the missing behavior. An agent
integration is appropriate only if it solves that concrete problem.

## Completed work

Backfilled from Git history, followed by completed changes in the working tree.
Entries describe delivered scope. Operational details and current limits live in
[development notes](docs/development.md) and the [tool contract](docs/tools.md).

| Completed | Work | Record |
| --- | --- | --- |
| 2026-10-28 | CLI, local provider configuration, environment-key references, desktop capability reporting and routine test tooling. | `3e62670` |
| 2026-10-28 | Tap-to-talk streaming transcription, cancellation and native resource cleanup. | `953d97e` |
| 2026-10-28 | Screen/window/selection history, timed pointer trails and speech-aligned full frames. | `87db009`, `934d682` |
| 2026-10-28 | Opt-in session diagnostics and turn bundles, excluding keys and raw audio. | `5125068` |
| 2026-10-29 | Typed model/tool loop, window discovery, active context inspection, screen capture and verified window focus. | `3bdee5e` |
| 2026-10-29 | Background-window Accessibility inspection and screenshots without changing focus. | `d784afe`, `ae1bcab` |
| 2026-10-29 | macOS pointing, click, scroll, literal entry and Tab/Enter tools with request-scoped permission checks, target revalidation and cancellation. | `fe051eb` |
| 2026-10-30 | Process identity and capture initialization fixes; bounded helper failure diagnostics. | `3f1c48a` |
| 2026-10-30 | In-memory conversational follow-ups with fresh target evidence and cleanup on cancellation/failure. | `b15e2a8` |
| 2026-10-30 | Literal multiline context transfer into supported accessible agent inputs; preparation and sending remain separate outcomes. | `82435f7` |
| 2026-10-30 | macOS v1 scope, followed by status/target/answer feedback without taking focus. | `0133e9a`, `264b31f` |
| 2026-10-30 | Guided macOS access setup and recovery messages. The separate permission-check menu was subsequently removed below. | `c92d642` |
| 2026-10-30 | Simplified the active implementation: macOS only, environment keys, setup guidance plus read-only doctor, target-level freshness checks, and additional model authorization only for clicks/Enter. Removed other-platform ports/CI and separate permission probes; parked distribution and formal live evaluation work. | Working tree; uncommitted |
| 2026-10-30 | **B01 — Done:** Setup and local configuration select `gpt-6-astra`. Image/tool turns and click/Enter checks use low reasoning effort; speech stays independent. Provider behavior checked with mocks; live account access remains unverified. | Working tree; uncommitted |
| 2026-10-30 | **B02 — Done:** Saved activation shortcut through setup or `hotkey`; validated before native registration and reflected in terminal/panel hints. Escape and Ctrl+C retain their behavior. Unit and synthetic native checks pass; physical shortcut delivery remains a manual check. | Working tree; uncommitted |
| 2026-10-30 | Restored this status-bearing work queue and backfilled delivery history; moved manual scenarios into field notes. | Working tree; uncommitted |

## Deferred

These are outside the active queue, not unfinished requirements for trying the loop:

- Windows/Linux support and their CI. Earlier implementations remain in Git history
  (for example `c92d642`); they are not maintained in the active tree.
- Binary distribution, signing/notarization, prebuilt helpers, release artifacts,
  clean-machine/version/architecture matrices and redistribution audits for those binaries.
- Keychain storage, provider capability probes, separate local permission tests,
  additional providers and automated live evaluation suites.
- Gaze, drawing overlays, autostart and a broad catalog of agent integrations.

Reconsider a deferred item when it solves an observed need. Preserve request-scoped
permission and cancellation while simplifying; the examples to try by hand are in
[manual scenarios](docs/field-notes.md#manual-scenarios).
