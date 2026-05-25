---
title: Sparse event log antipattern resolved — cycle 6 produced 90 events
description: After five consecutive claude-harness cycles with event logs containing only reflector.start, cycle 6 produced a full 90-event log spanning all phases. The sparse-event-log antipattern is confirmed resolved.
category: pattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Sparse event log resolved — cycle 6 confirmation

## Observation

Cycles 1–5 of claude-harness each produced an event log containing only
`reflector.start`. The brain escalated the issue in five consecutive theme
pages (`2026-05-25-sparse-event-log-observability-gap.md` through
`2026-05-25-sparse-event-log-fifth-cycle.md`), culminating in a demand for
operator investigation.

Cycle 6 (`INIT-2026-05-25-claude-trail-verify-cascade`) produced a full
90-event log:

- orchestrator: 5 events
- project-manager: 20 events (including 11 brain-query events)
- developer-loop: 55 events (3 ralph start/gate/iteration/end sequences + 15 unifier iterations)
- review-loop: 3 events
- closure: 4 events
- reflection: 1 event

All phase boundaries, gate results, cost figures, iteration counts, and
tool-use metadata are present. Per-phase cost breakdown is computable.
Retro reconstruction from git archaeology is no longer required.

## Significance

The prior 5 cycles lost all structured metric data (cost, iterations,
wedge events, send-back rounds). Cycle 6 is the first cycle with complete
observability. This is the baseline for future cycles — if log sparsity
recurs, it is a regression, not a known state.

## What changed (inferred)

The operator fixed the event-log sync path between the orchestrator and
the canonical `_logs/<cycle-id>/events.jsonl` location. The fix was not
documented in the brain (no ADR or theme from the operator side), but the
result is unambiguous: 90 events where 1 was expected.

## Sources

- `_logs/2026-05-25T12-51-25_INIT-2026-05-25-claude-trail-verify-cascade/events.jsonl` — 90-event log
- `brain/_raw/cycles/2026-05-25T12-51-25_INIT-2026-05-25-claude-trail-verify-cascade.md` — cycle archive
- `brain/projects/claude-harness/themes/2026-05-25-sparse-event-log-fifth-cycle.md` — prior escalation
