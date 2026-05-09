---
initiative_id: INIT-2026-05-09-env-optimiser-redact-argv
project: env-optimiser
project_repo_path: /tmp/env-optimiser
created_at: 2026-05-09T10:00:00Z
iteration_budget: 50
cost_budget_usd: 25
phase: in-flight
features:
  - feature_id: FEAT-1
    title: Add redact_argv helper
    depends_on: []
---

# Initiative: Add `redact_argv` helper

The capture pipeline currently calls `redact(events)` to scrub stored events.
We need a sibling helper, `redact_argv(argv)`, named after its caller's intent
(sanitising argv before logging). Same redaction patterns; different caller.

## Why now

Argv values flow into a different log path than events do, so a misnamed
`redact()` call there is hard to spot in review. Naming the helper after its
intent makes the call sites self-documenting.

## Out of scope

- Modifying `redact_one` or `PATTERNS` (those are constitution-locked).
- Adding new redaction patterns (separate WI if needed).
