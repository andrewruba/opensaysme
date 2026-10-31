# Using OpenSaysMe for real work

No sessions are recorded here yet. This is a place for short human observations,
not an automatic log or an acceptance scorecard. Omit private context and secrets.

For a real task, note:

- **Task/request:** What were you trying to get done?
- **What happened:** Right context, target and outcome? Any unwanted action?
- **Friction:** What did you repeat, correct, copy manually, or wait for?
- **Next change:** The smallest fix worth trying, if any.

Repeat the same task after a fix before widening the scope. Copy timings from the
normal output only when they help explain a noticeable delay. Use opt-in debug
captures for a specific failure; do not commit captured desktop content.

## Manual scenarios

These examples describe useful behavior. Try the ones relevant to the current task
or change; they are not a required release matrix or a plan for a live-test harness.
Use a controlled form or agent request when trying submission behavior.

| Scenario | What to look for |
| --- | --- |
| Explain an error shown across windows. | Uses the relevant evidence without unnecessary navigation. |
| Switch projects with similar window titles. | Resolves the intended project from useful evidence, not the title alone. |
| Point to a setting, then say “click it.” | Points first; only the follow-up activates it. |
| Fill a form with and without “and submit.” | Exact values; submission only in the authorized case, once. |
| Prepare agent input, then explicitly send. | Right agent and useful context; preparation alone stays unsent. |
| Change the target, deny access, or press Escape during work. | Stops or refreshes evidence; reports what happened without blind retries. |

Keep the [request and effect rules](tools.md#requests-and-effects) when investigating
a failure. A follow-up applies to the intended current target, not a different form
or an unresolved prior submission. An issued event is not a verified application
result. Escape prevents further work but cannot undo actions already issued.

Use a short note to select the next concrete fix in the [backlog](../BACKLOG.md).
Add an automated regression when the cause is stable and mockable; routine tests
do not need provider keys, actual screen captures or a metrics dashboard.
