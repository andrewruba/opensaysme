# Product backlog

Reduce the work between a user's request and useful agent behavior: finding the
right windows, copying context, explaining references, and operating interfaces.
Build a local, cross-platform, CLI-first runtime that combines spoken intent with
relevant desktop context and gives the model tools to carry out that intent.

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

These are intended behavior and acceptance criteria, not capabilities already
implemented. OS access grants and provider-sharing consent allow access to data or
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

First prove the core interaction on the available development desktop, then verify
the same outcomes on each supported platform. Cross-platform adapters remain part
of the design throughout; packaging and provider breadth do not define the first
useful interaction.

1. **Understand and target.** Improve context inspection and model input, then
   prove reference resolution and pointing (W03–W06, M01–M02, T01).
2. **Act with a permission boundary.** Implement request-scoped execution policy
   alongside click/scroll/type tools (E01–E04, T02–T05). Prove both form variants
   and both agent-input variants above; the policy is required before enabling
   tools that can edit or submit.
3. **Continue naturally and ship.** Add follow-ups, prove useful agent interactions,
   reduce measured friction/latency, and complete platform/setup/release checks.

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
requires clean installation and validation on macOS, Windows, and the explicitly
supported Linux desktops. Wayland is currently unsupported.

**Statuses:** `Done` = implemented with routine checks; `Partial` = partly delivered;
`Next` = upcoming implementation; `Todo` = remaining work; `Deferred` = outside the
MVP. `Done` does not imply live validation on every desktop. Keep existing IDs for
continuing work; update statuses when behavior lands, not when it is planned.

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
| W03 | Next | Inspect relevant accessibility text and controls in a discovered window, including background windows where supported, without requiring a focus change. |
| W04 | Next | Capture a discovered background window where supported, with identity, bounds, and capture time for reliable reference and action targeting. |
| W05 | Next | Detect stale, closed, inaccessible, or changed targets; reuse valid evidence and refresh what is needed without repeatedly scanning the whole desktop. |
| W06 | Next | Live trial: distinguish similarly titled windows by contents and resolve spoken/pointed references; record accuracy, ambiguity, and latency. |

## Give the model useful context and tools

Status: **Partial** — the tool loop exists; richer context selection and capabilities remain.

| ID | Status | Outcome |
| --- | --- | --- |
| W01 | Done | Typed in-process tool host and bounded, cancellable model/tool loop that returns evidence and action results to the model. |
| M01 | Next | Assemble relevant context for the request while retaining source, time, target identity, and uncertainty; make missing or omitted evidence explicit and allow further inspection. |
| M02 | Next | Describe available tools, their input/coordinate conventions, effects, platform limits, and current execution permissions to the model. Separate captured content from user instructions. |
| M03 | Todo | Support the steps needed for multi-field/multi-window requests within measured time, call, and data budgets; report partial progress honestly when a limit stops work. |

The model chooses a useful sequence; the runtime validates and executes known,
typed tools. Adding a capability should not require a new prescribed workflow or
arbitrary model-generated shell commands.

## Desktop action capabilities

Status: **Todo** — verified window focus is already available under W02.

| ID | Status | Outcome |
| --- | --- | --- |
| T01 | Next | Move the pointer to a grounded target and point it out without clicking; map observed image/control coordinates to the correct window and display. |
| T02 | Todo | Click a verified control or visual target with an understood effect and authority from the request. Recheck when layout, focus, or target identity changes. |
| T03 | Todo | Scroll the intended surface to find or reveal relevant content; inspect the new state before using prior target positions. |
| T04 | Todo | Enter/replace text and send supported keys to the intended input; distinguish editing from shortcuts or keys that submit/execute. |
| T05 | Todo | Observe outcomes after input, handle user intervention or focus changes, and recover from failures without typing into another window or blindly repeating side effects. |

## Enforce the user's permission boundary

Status: **Todo** — current tools only read context and focus windows.

| ID | Status | Outcome |
| --- | --- | --- |
| E01 | Next | Carry the user's authorized outcome, target, and limits through the turn; distinguish filling/preparing from submitting/sending, including explicit negative instructions. |
| E02 | Next | Check each proposed effect against that scope at the execution boundary. Explicit authorization is sufficient when still applicable; missing authority or unresolved effects cannot be supplied by the model's own plan or captured content. |
| E03 | Todo | Test the paired permission examples through mouse, keyboard, and any API path, including Enter-to-submit, autosave, changed destinations, and misleading instructions in captured content. |
| E04 | Todo | Stop pending work on cancellation or timeout; verify uncertain outcomes before retrying and prevent duplicate submissions. Report effects already completed without claiming cancellation undid them. |

## Useful interactions with existing agents

Status: **Todo**

| ID | Status | Outcome |
| --- | --- | --- |
| A01 | Todo | Prove a useful context-to-agent request through an existing agent UI using the shared desktop capabilities; choose the test surface without making a dedicated integration a prerequisite. |
| A02 | Todo | Discover the intended agent/session and inspect its input or status from reliable UI evidence or a documented API; do not infer status from a window title alone. |
| A03 | Todo | Deliver dictated instructions and relevant context to the right agent, with distinct acceptance for prepare-only and explicitly send/start requests. |
| A04 | Todo | Add a dedicated adapter only where a concrete interaction needs more reliable or efficient access; apply the same permission and verification rules to UI and API paths. |
| A05 | Todo | Retain bounded, short-lived conversational context for references, corrections, clarification, and follow-ups; revalidate targets and permission before continuing. |
| A06 | Todo | Run the core acceptance trials, including multiple source windows, ambiguous agents, stale targets, cancellation, and action outcomes. |

## Responsiveness and feedback

Status: **Partial**

| ID | Status | Outcome |
| --- | --- | --- |
| R01 | Done | Measure audio/transcript delivery, visual preparation, tool time, and stop-to-response latency. |
| R02 | Todo | Show minimal listening/processing/completion/error feedback usable away from the terminal, including the current target when acting. |
| R03 | Todo | Ask necessary clarification or permission questions near the user's work and resume from the answer; do not reconfirm an already explicit, still-applicable request. |
| R04 | Todo | Establish live accuracy, friction, and latency baselines/targets for the acceptance trials, rapid navigation, scrolling, and incidental cursor movement. |
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
| P01 | Done | Native adapters and capability reporting for macOS, Windows, and Linux/X11; unsupported operations fail explicitly. |
| P02 | Done | Cross-platform CI, mocked provider/tool tests, native protocol checks, and isolated X11 desktop tests. |
| P03 | Todo | Verify the core acceptance trials on macOS, including fresh grants, denial/revocation, launcher restart, and helper rebuilds. |
| P04 | Todo | Verify the same trials on native Windows, including physical audio/hotkeys, PowerShell, and desktop-session restrictions. |
| P05 | Todo | Verify the same trials on physical Linux/X11 with documented desktop/dependency coverage. |
| P06 | Todo | Assess Wayland access and decide release coverage; implement and verify any claimed support or explicitly release Linux as X11-only. |
| P07 | Todo | Validate input targeting across displays/DPI, stale/reused handles, layout changes, user intervention, and cleanup after cancellation/failure. |

## Distribution and release

Status: **Todo** — release work follows proof of the core interaction.

| ID | Status | Outcome |
| --- | --- | --- |
| D01 | Todo | Establish stable macOS helper signing/permission identity before distributing native packages. |
| D02 | Todo | Package helpers and handle platform prerequisites so installation needs no compiler; document supported OS versions/desktops. |
| D03 | Todo | Audit redistribution licenses/notices for bundled binaries, including sharp/libvips and any bundled Linux dependencies; retain MIT for the project. |
| D04 | Todo | Prepare versioned release artifacts and publishing/install/update instructions; remove the package's private flag only when ready. |
| D05 | Todo | Run clean-machine install → setup → core acceptance trials on every supported OS and record results. |

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
