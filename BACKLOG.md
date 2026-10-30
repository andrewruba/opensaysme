# Product backlog

Reduce the work between a user's request and useful agent behavior: finding the
right windows, copying context, explaining references, and operating interfaces.
Build a local, CLI-first runtime that combines spoken intent with relevant desktop
context and gives the model tools to carry out that intent. **V1 targets macOS 14+
only.** Windows and Linux implementation, validation, and distribution are deferred
until after v1. Keep existing adapters and checks, with OS access isolated for later
ports; other-platform parity does not hold macOS features open.

The core is three connected capabilities:

1. **Collect the right context.** Understand what the user means by “this,” “that
   window,” or “the error I just showed you,” using speech, screens, application
   state, selection, and pointing. Let the model gather missing evidence.
2. **Give the model context and capabilities.** Supply the request, relevant
   evidence, and an accurate tool catalog. The model can answer, switch windows,
   move the pointer, point things out, click, scroll, type, and inspect results as
   the request requires. Each tool result informs the next step.
3. **Act within explicit permission.** The user's request defines the allowed
   outcome. Execute the steps needed for it, verify the result, and stop at its
   boundary. Ask only about material unresolved ambiguity or additional authority.

Desktop interaction is core MVP work. A dedicated integration can improve access
to an agent, but choosing one is not a prerequisite for useful interaction through
its UI. Prefer reliable documented APIs or accessibility operations where available;
support visual targeting and desktop input where needed. No user-maintained window
labels, routing rules, fixed response type, or universal draft-review-send flow.

## Permission comes from the request

These are acceptance criteria; the first macOS input/permission implementation is
partial and has not passed live trials. OS access grants and provider-sharing consent allow access to data or
devices; they do not authorize an agent to perform every action those tools enable.

| User request | Authorized outcome | Boundary |
| --- | --- | --- |
| “Fill in this form.” | Enter the requested information in the intended form. | Leave it unsubmitted; do not ask to submit merely because a Submit button exists. |
| “Fill in this form and submit it.” | Fill and submit the intended form, then check the result. | No redundant confirmation when the target, information, and consequences match the request. Clarify missing material details or an unexpected consequence. |
| “Put this error and my explanation into the agent's input.” | Locate the intended input and populate it with relevant context. | Leave it unsent. |
| “Send this error to the debugging agent and ask it to fix it.” | Locate the intended agent, provide context, and send the request. | Sending is authorized; unrelated actions are not. |
| “Point to the setting.” | Move the pointer to indicate the setting. | Do not click or change it. |

Permission follows the effect, not the tool name: clicking a text field differs
from clicking Submit; pressing Enter may submit; entering text may save or trigger
an action. Inspect the target and expected effect before acting. If they cannot be
established, clarify rather than treating generic input tools as blanket authority.
Screen content, tool results, and model-generated plans never grant permission.
A later “submit it” can authorize that step for a still-valid, previously filled
form; it must not silently apply to a different form or changed contents.

## Delivery order and acceptance

Prove and ship the core interaction on macOS 14+. Other-platform implementations
and acceptance trials belong to the deferred work below. Packaging and provider
breadth do not define the first useful interaction.

1. **Understand and target.** Improve context inspection and model input, then
   prove reference resolution and pointing (W03–W06, M01–M02, T01).
2. **Act with a permission boundary.** Implement request-scoped execution policy
   alongside click/scroll/type tools (E01–E04, T02–T05). Prove both form variants
   and both agent-input variants above; the policy is required before enabling
   tools that can edit or submit.
3. **Continue naturally and ship.** Add follow-ups, prove useful agent interactions,
   reduce measured friction/latency, and complete macOS setup and release checks.

The core MVP must pass these end-to-end trials without manual window labels or
copy/paste by the user. Use controlled forms and agent inputs for submission tests.

| Trial | Observable success |
| --- | --- |
| “Explain this error” after showing relevant windows. | Uses the right evidence across speech and screen history; answers without unnecessary navigation or actions. |
| “Switch to the project I was just showing you,” with similar window titles. | Inspects contents, selects the supported target, and verifies focus; clarifies only if useful inspection leaves material ambiguity. |
| “Point to that setting,” then “click it.” | Points without activating it, retains the reference, and clicks only after the follow-up authorizes activation. |
| Fill a form, with and without “and submit.” | Correct fields and values; submission occurs exactly once only in the authorized variant. |
| Prepare an agent input, then explicitly send/start an agent request. | Relevant context reaches the correct agent; preparation alone does not send, while an explicit send/start request completes without a second permission ritual. |
| Target changes, access is denied, or Escape is pressed during work. | Stops or gathers fresh evidence; reports completed and unverified effects accurately and issues no further actions after cancellation. |

Record completion accuracy, unintended actions, user corrections, unnecessary
clarifications, manual context transfers, and end-to-end latency. Compare with doing
the same task manually. Core completion requires the trials to pass; release also
requires clean installation and validation on supported macOS versions and
architectures. Windows, Linux/X11, and Wayland do not gate v1.

**Statuses apply to macOS v1:** `Done` = implemented with routine checks; `Partial` = partly delivered;
`Next` = upcoming implementation; `Todo` = remaining work; `Deferred` = outside the
v1 scope. `Done` does not imply live acceptance has passed; W06, A06, P03 and P07
track the outstanding macOS trials, including implemented capabilities. Keep existing IDs for
continuing work; update statuses when behavior lands, not when it is planned.

During v1 development, use unit tests and mocked provider responses. Once the v1
implementation is ready, build one unified suite that calls the live provider and
asserts expected behavior across the acceptance trials. Avoid separate live-test
flags and runners for individual features.

## Collect and resolve context

Status: **Partial** — capture exists; relevance and live reference accuracy need work.

| ID | Status | Outcome |
| --- | --- | --- |
| V01 | Done | Tap-to-toggle streaming transcription, Escape cancellation, and resource cleanup. |
| V02 | Done | Bounded full screenshots, window/selection history, and timed cursor trajectories. |
| V03 | Done | Audio capture timestamps and phrase envelopes aligned to desktop observations; no inferred word timing. |
| V04 | Done | Clean full frames plus optional trail copies, paired with nearby speech; natural-language responses. |
| V05 | Done | In-memory context by default; opt-in debug bundles excluding credentials and raw audio. |
| W02 | Done | Discover windows, inspect current context, capture the current screen, and revalidate/verify focus. |
| W03 | Done | Inspect bounded accessibility text/control roles from a discovered macOS background window without changing focus, omitting protected fields. Routine checks cover traversal, source identity and failures; live application coverage is tracked under W06/P03. |
| W04 | Done | Capture a discovered background window on macOS 14+ without focusing it, with source identity, bounds, capture time, and stale/ambiguous-source rejection. Routine checks cover the native protocol and source/geometry validation; live capture and coordinate validation are tracked under P03/P07. |
| W05 | Partial | Unchanged windows retain discovery references within a turn; fresh window outputs identify matching native sources from recent turns. macOS inspection/capture revalidates sources and reports stale, ambiguous, inaccessible, and permission failures. Broader evidence reuse and invalidation remain. |
| W06 | Todo | In the unified live suite after v1 implementation, distinguish similarly titled windows by contents and resolve spoken/pointed references; record accuracy, ambiguity, and latency. |

## Give the model useful context and tools

Status: **Partial** — the tool loop exists; richer context selection and capabilities remain.

| ID | Status | Outcome |
| --- | --- | --- |
| W01 | Done | Typed in-process tool host and bounded, cancellable model/tool loop that returns evidence and action results to the model. |
| M01 | Partial | Actor and guard receive bounded recent requests, responses, source observations and native action outcomes alongside current context. Fresh discovery links matching native sources to prior turns. Broader request-specific context selection and live reference accuracy remain. |
| M02 | Partial | Catalog describes input effects, screenshot pixel coordinates, native constraints and request checks. Input results include the permission interpretation; broader current-permission summaries remain. |
| M03 | Partial | Input-enabled loops allow twelve tools within 90 seconds, including internal authorization time. Multi-field/multi-window completion and latency need live measurement. |

The model chooses a useful sequence; the runtime validates and executes known,
typed tools. Adding a capability should not require a new prescribed workflow or
arbitrary model-generated shell commands.

## Desktop action capabilities

Status: **Partial** — initial macOS input tools are implemented; broader target support, outcome recovery and live behavior remain.

| ID | Status | Outcome |
| --- | --- | --- |
| T01 | Partial | macOS maps fresh window-image pixels into logical desktop points, checks native hit/focus/geometry, and moves without clicking. Live coordinate/pointing trials remain. |
| T02 | Partial | macOS single click requires an independent request/effect check and revalidated native target. Purely visual targets without Accessibility evidence and live coverage remain. |
| T03 | Partial | macOS scrolls a verified surface by a bounded vertical amount and invalidates prior action observations. Live application behavior remains. |
| T04 | Partial | macOS replaces literal text in accessible inputs, including multiline text and indentation in writable AXTextArea controls, with exact value read-back. Newlines never become key presses. Unmodified Tab/Enter remain separate; Enter requires submission authority. Unsupported controls and arbitrary shortcuts are rejected; broader entry methods and live coverage remain. |
| T05 | Partial | Native checks cover focus, geometry, user input and the complete bounded AX window content since inspection, rejecting changed non-target fields and incomplete trees. Live application outcome validation/recovery remains; tool/model success claims alone are insufficient. |

## Enforce the user's permission boundary

Status: **Partial** — runtime input checks exist; semantic permission accuracy and end-to-end acceptance remain unverified.

| ID | Status | Outcome |
| --- | --- | --- |
| E01 | Partial | Independent input checks receive current finalized speech separately from recent user requests and historical evidence, enabling follow-ups and clarification answers without reusing approvals. Supporting quotes must come from current speech. Semantic scope and changed-content comparison remain model-dependent; live accuracy is unverified. |
| E02 | Partial | Input executes only after a valid independent decision tied to original speech and exact arguments/evidence. The actor cannot provide approval/effect fields. Semantic effect inference remains model-dependent; existing focus remains governed by the actor's navigation instructions. |
| E03 | Partial | Fixture regressions cover fill/submit, prepare/send, Enter, autosave decisions, changed targets, misleading screen text and malformed policy responses. These validate enforcement of scripted decisions; live model permission accuracy, adversarial trials and future API paths remain. |
| E04 | Partial | Input consumes observations before execution, blocks further input after submission/uncertain outcomes, and propagates cancellation/timeouts. Native events release down/up pairs. Real input, physical Escape and dispatch-race validation remain. |

## Useful interactions with existing agents

Status: **Partial** — conversational context is implemented; concrete agent interactions remain.

| ID | Status | Outcome |
| --- | --- | --- |
| A01 | Todo | Prove a useful context-to-agent request through an existing agent UI using the shared desktop capabilities; choose the test surface without making a dedicated integration a prerequisite. |
| A02 | Todo | Discover the intended agent/session and inspect its input or status from reliable UI evidence or a documented API; do not infer status from a window title alone. |
| A03 | Partial | Literal multiline entry can transfer prompts, code and error details into a supported accessible agent text area. Preparation and explicit send/start requests retain separate permission checks and follow-up context. Unit coverage verifies preservation and enforcement; real agent-composer compatibility and live completion remain unverified. |
| A04 | Todo | Add a dedicated adapter only where a concrete interaction needs more reliable or efficient access; apply the same permission and verification rules to UI and API paths. |
| A05 | Partial | Retain up to three completed turns and 64 KiB in memory, with two-minute per-turn expiry. Fresh tool sessions, captures and independent checks are required; cancellation, failed turns and shutdown clear history. Unit coverage includes continuation and invalidation; live follow-up interpretation remains unverified. |
| A06 | Todo | Run the core acceptance trials, including multiple source windows, ambiguous agents, stale targets, cancellation, and action outcomes. |

## Responsiveness and feedback

Status: **Partial**

| ID | Status | Outcome |
| --- | --- | --- |
| R01 | Done | Measure audio/transcript delivery, visual preparation, tool time, and stop-to-response latency. |
| R02 | Todo | Show minimal listening/processing/completion/error feedback usable away from the terminal, including the current target when acting. |
| R03 | Partial | CLI follow-ups can carry a clarification answer back to the prior request. Feedback near the user's work and live clarification accuracy remain; do not reconfirm an already explicit, still-applicable request. |
| R04 | Todo | Measure actual completion accuracy, unintended actions, unnecessary clarifications and user corrections against manual interaction baselines; separate capture, authorization and actor latency. |
| R05 | Todo | Reduce measured capture/preparation delays and unnecessary model/tool round trips; verify improvements against the same trials. |

## Setup, permissions, and providers

Status: **Partial** — these access/setup permissions are separate from action authority.

| ID | Status | Outcome |
| --- | --- | --- |
| S01 | Done | Terminal setup, independent speech/reasoning settings, environment-key references, sharing consent, and read-only doctor. |
| S02 | Todo | Add OS credential storage while retaining environment keys; keep secrets out of configuration, arguments, and logs. |
| S03 | Todo | Guide microphone, Accessibility, and screen-capture grants separately, including launcher/helper identity and restart/recheck instructions. |
| S04 | Todo | Offer deliberate local permission verification that discards capture data and makes no provider request. |
| S05 | Todo | Distinguish permission denial, missing dependencies, unsupported operations, and timeouts; expose missing context clearly. |
| S06 | Todo | Offer explicit provider authentication/capability checks and explain which data each configured provider receives. |
| S07 | Deferred | Add a second reasoning provider with validated image/tool support and fixture tests when needed; provider count does not gate the core MVP. |
| S08 | Todo | Review context sharing and retention as tools and follow-up context expand, including opt-in diagnostics. |

## Desktop reliability

Status: **Partial**

| ID | Status | Outcome |
| --- | --- | --- |
| P01 | Done | macOS native adapter and capability reporting; unsupported operations fail explicitly. Existing Windows/Linux adapters remain as a starting point for later support. |
| P02 | Done | CI, mocked provider/tool tests and native protocol checks. Existing Windows checks and isolated X11 desktop tests remain available without extending v1 release scope. |
| P03 | Todo | Verify the core acceptance trials on macOS, including fresh grants, denial/revocation, launcher restart, and helper rebuilds. |
| P07 | Todo | Validate macOS input targeting across displays/scales, stale/reused window identities, layout changes, user intervention, and cleanup after cancellation/failure. |

## Distribution and release

Status: **Todo** — release work follows proof of the core interaction.

| ID | Status | Outcome |
| --- | --- | --- |
| D01 | Todo | Establish stable macOS helper signing/permission identity before distributing native packages. |
| D02 | Todo | Package the macOS helper so installation needs no compiler; document supported macOS versions and architectures. |
| D03 | Todo | Audit redistribution licenses/notices for macOS release binaries, including sharp/libvips; retain MIT for the project. |
| D04 | Todo | Prepare versioned release artifacts and publishing/install/update instructions; remove the package's private flag only when ready. |
| D05 | Todo | Run clean-machine install → setup → core acceptance trials on supported macOS versions and architectures, and record results. |

## After v1: other platforms

Status: **Deferred** — retain the existing adapters and tests; complete support
when each platform becomes a release target.

| ID | Status | Outcome |
| --- | --- | --- |
| L04 | Deferred | Implement Windows/Linux background-window accessibility inspection, window capture and desktop input with the same context, permission and verification contracts as macOS (W03–W04, T01–T05, E01–E04). |
| P04 | Deferred | Verify the core trials on native Windows, including physical audio/hotkeys, PowerShell, and desktop-session restrictions. |
| P05 | Deferred | Verify the core trials on physical Linux/X11 with documented desktop/dependency coverage. |
| P06 | Deferred | Assess Wayland access and decide Linux release coverage; implement and verify any claimed support or explicitly release Linux as X11-only. |
| L05 | Deferred | Complete Windows/Linux permission setup, packaging, prerequisite guidance, binary/license review and clean-machine installation checks before releasing either platform. |

## Later exploration

Status: **Deferred**

| ID | Status | Outcome |
| --- | --- | --- |
| L01 | Deferred | Freehand drawing overlays and optional gaze as additional attention signals; moving the pointer to indicate a target is already core work under T01. |
| L02 | Deferred | Local transcription/models and background-service/autostart installation. |
| L03 | Deferred | A broad catalog of dedicated agent adapters and desktop capabilities beyond those needed for the core acceptance trials. |

Current implementation limits and recorded validation live in
[development notes](docs/development.md#desktop-experiments-and-checks); tool
contracts live in [tool documentation](docs/tools.md).
