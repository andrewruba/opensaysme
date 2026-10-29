# Agent tools

The agent chooses how to fulfill a request using available evidence and tools.
There is no window-naming step, frontend/backend heuristic, or fixed sequence of
actions. A tool catalog describes capabilities; the model decides when they help.

The voice runtime calls the tool host directly in the same Node.js process. The
provider loop uses its catalog to discover capabilities and return tool results
to the model.

## Current capabilities

| Tool | Behavior |
| --- | --- |
| `list_windows` | Discover application/window titles and automatic references. |
| `inspect_desktop` | Read active-window, selection, and pointer context. |
| `capture_screen` | Capture the current pointer display, or X11 virtual desktop. |
| `focus_window` | Recheck a discovered target, focus it, and verify the result. |

Window references are internal tool handles. They reset on relisting and are never
names the user must organize. Voice creates a fresh tool host per activated turn
and closes it on completion or cancellation. Native tokens remain temporary:
macOS title changes and process restarts can invalidate targets. Ambiguous and
inaccessible windows are omitted with warnings. Same-process window-handle reuse
remains a platform limitation.
Focus also rechecks the title evidence; a changed title prompts rediscovery.

These tools cannot yet inspect a specific background window's pixels/code, click,
type, or submit to another agent. If two windows have indistinguishable titles and
no useful captured context, the agent may need clarification. Background window
capture and accessibility inspection are the next evidence sources to add. Pointer
movement/pointing, clicking, scrolling, and typing are core planned capabilities;
they do not depend on choosing a dedicated agent integration. See the
[product backlog](../BACKLOG.md) for delivery order and acceptance trials.

## Planned execution permissions

The request defines the authorized outcome. “Fill this form” permits filling it
and stops before submission; “fill this form and submit it” also permits submission
without another confirmation when the target, contents, and consequences match.
Likewise, populating an agent input and sending it are distinct effects. Ask when
material ambiguity remains or additional authority is needed, not after every step.

Before enabling editing or submission, extend the runtime to check effects against
the request at execution time. A click, keypress, or API call can submit or otherwise
commit a change; the input mechanism does not determine permission. Revalidate the
target and expected effect, inspect uncertain outcomes before retrying, and apply
the same boundary to every path. Captured content and model plans cannot authorize
actions. These checks are planned work; the current catalog only reads and focuses.

## Inspect the catalog

```sh
npm run dev -- tools   # Catalog only; no desktop reads or provider calls
```

Run `npm run dev` for the voice interaction. See [development instructions](development.md)
for provider setup and desktop permissions.

## Add a capability

Define a `ToolDefinition` with a name, description, strict Zod input object, effect,
and async handler. Register it in the host. The registry derives JSON Schema for
provider function calling and validates arguments and results locally.
Input properties must be required (use nullable values where appropriate).

Return text or JPEG content, or a bounded `isError` result with actionable guidance.
Handlers receive an `AbortSignal`; pass it to OS/provider work and check it before
any side effect or state update after an await. Keep OS details in platform adapters.
Read tools and focus are the initial effects. Adding input or other consequential
capabilities requires the request-scoped execution policy described above, alongside
tests for authorized, unauthorized, ambiguous, stale-target, and cancelled actions.

The registry bounds each call to six seconds. The voice loop allows six model
requests and five tool calls within 45 seconds; each provider request has a
20-second deadline. It replays tool results and reasoning context with `store: false`.
It does not run arbitrary shell commands or load model-supplied code. Normal runs
retain context only for the turn. `--debug` saves numbered requests and tool exchanges;
provider keys, raw audio, and opaque encrypted reasoning are excluded.

Use mocked adapters for routine tests. Test validation, cancellation, stale targets,
and errors at the tool boundary; test provider sequencing with fixture responses.
