# Working on OpenSaysMe

Read `README.md` for the product intent and `PLAN.md` for the current MVP scope.
Keep both accurate as implementation decisions become concrete. This repository
contains a tap-to-talk runtime, visual attention history, an agent tool loop,
an in-process tool host, and desktop probes. See
`docs/development.md` for setup, validation commands, and platform limitations.

## Project direction

- Build a cross-platform, CLI-first tool that runs locally and complements
  existing agents. Keep setup in the terminal and desktop feedback minimal.
- Reduce friction between user intent and agent behavior. Context gathering,
  preparing input, navigation, answers, and actions are possible interactions.
  Let the user's request determine the flow; do not impose a universal
  draft-review-send sequence or a fixed output type.
- Center the experience on spoken requests and available desktop context.
  Pointing and selection can clarify references. Keep future inputs such as gaze
  optional; the core interaction must work without them.
- Let the agent discover targets and gather evidence through tools. Do not require
  users to label windows or maintain routing rules. Resolve references using
  available context before asking; clarify only material unresolved ambiguity.
- Use TypeScript and Node.js for the core. Isolate OS access, provider APIs, and
  agent integrations behind small, typed interfaces.
- Support user-supplied provider keys and direct provider calls. Keep speech and
  reasoning configuration independent.
- Treat voice latency as a core UX requirement. Aim for immediate feedback and
  conversational responsiveness. Measure end-to-end delays and minimize serial
  waits; a two-call transcription/reasoning pipeline is not a fixed requirement.
- Require deliberate activation. Captured context helps interpret requests but
  does not authorize execution. Resolve ambiguity and confirm consequential actions.
- Prioritize the interactions in `PLAN.md`. Add abstractions when a concrete
  integration needs them; avoid speculative frameworks and unrelated features.

## Implementation practices

- Inspect the current code and working tree before editing. Preserve unrelated
  user changes and follow established conventions.
- Keep changes focused. Separate unrelated cleanup and broad formatting from
  behavior changes.
- This is a greenfield project with no backward-compatibility commitment yet.
  Replace obsolete internal designs directly; do not retain compatibility shims,
  legacy paths, or speculative migrations just to preserve earlier architecture.
  Update affected callers, tests, and docs together, and remove superseded code.
  Add compatibility only for a concrete external requirement or an explicit user
  request. Adapters for current OS/provider differences remain appropriate.
- Validate configuration, provider responses, and native-helper messages at
  boundaries. Execute known, typed actions rather than arbitrary model-generated
  shell commands.
- Handle cancellation, timeouts, permission denial, and cleanup explicitly.
  Release microphones, hooks, and child processes when stopped.
- Detect platform capabilities. Report unsupported operations clearly rather
  than silently pretending they succeeded.
- Prefer documented integrations and maintained, permissively licensed
  dependencies. Check bundled binaries and model licenses separately.
- Keep credentials in OS credential storage or environment variables. Never
  commit secrets, record them in logs, or pass them in command arguments. Minimize
  retention of audio, transcripts, screenshots, and captured context.

## Validation

- Run the existing checks relevant to the change. Once tooling exists, document
  its canonical install, development, typecheck, lint, and test commands.
- Add meaningful tests for behavior and regressions, especially action routing,
  target resolution, provider parsing, and cancellation. Avoid tests that merely
  mirror implementation details; documentation-only edits need no code tests.
- Use fixtures or mocks for routine provider tests so CI needs no personal keys
  or paid requests.
- Verify desktop behavior on the affected platforms where available. State which
  environments were tested and which remain unverified.
- Review the final diff and run `git diff --check`. Report relevant checks and
  remaining limitations without claiming unperformed validation.

## Commits

- Use Conventional Commits: `type(scope): imperative summary`. Scope is optional.
  Common types are `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, and
  `chore`.
- Keep the subject concise, preferably at most 72 characters, with no trailing
  period. Examples: `feat(cli): add provider setup` and
  `fix(windows): restore the previous window after cancellation`.
- Commit one coherent change at a time, including the tests and documentation
  needed to explain and validate it. Prefer a few hundred changed lines or fewer
  when practical; do not split a cohesive change just to meet a line count.
- Keep commits independently understandable and working. Separate unrelated
  refactors, dependency upgrades, and generated churn when they can stand alone.
- Use a commit body when the motivation, tradeoffs, or compatibility impact need
  explanation. Describe why the change matters rather than listing every file.
- Stage only intended files and inspect the staged diff. Do not include unrelated
  user changes or rewrite existing commits without explicit direction.
