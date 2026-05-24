---
title: Two-WI scope shipped cleanly — operator's small-cycle directive validated
description: Cycle 2's explicit scope-down to a single two-WI cluster (vs cycle 1's multi-WI complexity) produced zero send-backs, 36/36 tests, and clean merge — confirming that small cycles ship while integration-heavy WIs consistently wedge.
category: pattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Small cycle scope ships cleanly

## Observation

The cycle 2 manifest explicitly noted:

> "smaller cycles ship; integration WIs consistently wedge. Just one section, end-to-end,
> with golden update."

The operator scoped cycle 2 to exactly two dependent WIs:
- WI-1: `costByPhase` function + test file
- WI-2: `renderCostSection` + wiring + golden update + test file

Result:
- 0 send-backs (reviewer accepted on first pass)
- 36/36 tests (up from 28 in cycle 1; all 8 new tests pass)
- Clean merge, no wedge events, no requeue

Contrast with cycle 1, which had 5+ WIs, accumulated complexity in mid-cycle WIs,
and required 6 requeue attempts before shipping.

## Why this works

- Two WIs with a single `depends_on` edge form a clear dependency chain — no parallelism confusion.
- Acceptance criterion is concrete (golden file update) and binary (tests pass or not).
- The dev-loop agent has less accumulated context to juggle; commit/iterate boundary is clearer.
- Reviewer has a narrower diff to assess; less risk of subjective taste divergence.

## Generalisation

The "one section at a time" framing generalises: for CLI feature additions, scope each
cycle to one output section (or one function + its rendering). Let the golden file update
be the cycle's definition of done.

This is consistent with the forge-wide `roadmap-simplification-convergence` pattern:
when in doubt, simplify the unit of work before adding features.

## Sources

- `_logs/INIT-2026-05-25-claude-trail-cost-only/events.jsonl` — cycle log
- `brain/_raw/cycles/INIT-2026-05-25-claude-trail-cost-only.md` — cycle archive
