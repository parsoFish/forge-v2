---
title: Initiative requeued 6 times with no event-log evidence of failure cause
description: The manifest recorded 6 requeue attempts before the successful run, but the event log held no failure events — root cause was undiagnosable from structured data alone, requiring git-history archaeology instead.
category: antipattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Six requeue attempts with no event-log evidence

## Observation

`_queue/done/INIT-2026-05-24-claude-trail-scaffold.md` carries:

```yaml
previous_failure_modes:
  - requeued-from-failed-2026-05-24
  - requeued-from-failed-2026-05-24
  - requeued-from-failed-2026-05-24
  - requeued-from-failed-2026-05-24
  - requeued-from-failed-2026-05-24
  - requeued-from-failed-2026-05-24
```

Six failed runs before the initiative completed. The event log for the
successful run contains only `reflector.start`; no failure-phase events
survived from prior runs.

## Why this matters

`previous_failure_modes` entries are identical strings with no structured
failure type, no phase, no error message. Without event-log evidence from
the failed runs, it's impossible to determine:

- Which phase failed (architect / PM / dev-loop / reviewer)?
- Did the same phase fail all 6 times, or different phases?
- Was it a rate-limit, a build error, a test failure, or an orchestration bug?

This makes it impossible to close the learning loop — the brain can't be
updated with a specific antipattern because the failure mode is opaque.

## Recommended fix

1. Persist the failed run's events.jsonl to
   `_logs/<id>/failed-run-<n>/events.jsonl` before requeuing, so
   post-mortem analysis is possible.
2. Populate `previous_failure_modes` with structured entries (phase, error
   type, iteration count) not a repeated literal string.

## Sources

- `_logs/INIT-2026-05-24-claude-trail-scaffold/events.jsonl` — the (sparse) log
- `brain/_raw/cycles/INIT-2026-05-24-claude-trail-scaffold.md` — cycle archive
