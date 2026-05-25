---
title: Unifier wedged on pre-existing npm test failures for second consecutive cycle — no fix applied
description: Cycles 6 and 7 both produced 15–16 unifier iterations ($9.90 each) on npm test failures outside initiative scope. The structural antipattern is documented in the brain; no fix has been deployed. Pattern is now confirmed recurring.
category: antipattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Unifier pre-existing failure wedge — second consecutive cycle

## Observation

**Cycle 6** (`INIT-2026-05-25-claude-trail-verify-cascade`): unifier ran 15
iterations on `npm test`, all failed on pre-existing `_pr-metadata.json`
fixture absence. Total unifier cost: ~$9.90. Budget: $4.00.

**Cycle 7** (`INIT-2026-05-26-claude-trail-verify-cascade-v2`): unifier ran
16 iterations on `npm test`, all `unifier.gate.initiative-failed`. Stop
reason: `iteration-budget`. Total unifier cost: ~$9.90. Budget: $6.00.

Both cycles had correctly completed ralph phases (5-of-6 WIs in 1 iteration
in Cycle 7; all 3 WIs in 1 iteration in Cycle 6). Both cycles were
functionally correct — the features worked. Both were blocked exclusively
by the `npm test` full-suite gate hitting failures the unifier couldn't fix.

## Timeline

```
Cycle 6: 15 unifier failures → iteration-budget → pr-open (eventually merged)
Cycle 7: 16 unifier failures → iteration-budget → pr-open (awaiting merge)
```

The brain documented this antipattern after Cycle 6 in:
- `2026-05-25-unifier-wedge-preexisting-test-failures.md`
- `2026-05-25-wi-gate-vs-unifier-gate-mismatch.md`

No structural fix was applied between cycles. Cycle 7 reproduced the failure
identically.

## Cost impact (two-cycle aggregate)

| Metric | Cycle 6 | Cycle 7 | Total |
|---|---|---|---|
| Budget (USD) | $4.00 | $6.00 | $10.00 |
| Actual cost (USD) | $13.65 | $19.76 | $33.41 |
| Unifier cost (est.) | $9.90 | $9.90 | $19.80 |
| Unifier iterations | 15 | 16 | 31 |
| Budget overspend | $9.65 | $13.76 | $23.41 |

60% of total two-cycle spend ($19.80 / $33.41) was in the unifier, on
failures the unifier could not fix.

## Required fix (escalated — now confirmed recurring)

The three options documented in `2026-05-25-wi-gate-vs-unifier-gate-mismatch.md`:

**Option A (preferred):** Unifier captures `npm test` baseline on `main`
before touching the branch. If a test failure existed on `main`, it is
pre-existing; the unifier should log a `preexisting-failure-skipped` event
and proceed to PR description + merge.

**Option B:** Manifest declares a scoped initiative gate (e.g. `node --test
tests/filter-*.test.ts`) instead of defaulting to `npm test`. Loses full
regression check but eliminates the mismatch.

**Option C:** Wedge detection for "same `npm test` failure count + same
failing test names across N consecutive iterations" — declare wedge after
N=3 and surface for operator.

This antipattern is now a **blocking issue** for claude-harness. Every cycle
that ships new WIs but inherits unclean `main` will produce this overspend.

## Sources

- `_logs/2026-05-25T13-39-35_INIT-2026-05-26-claude-trail-verify-cascade-v2/events.jsonl` — 16 unifier.gate.initiative-failed events
- `brain/_raw/cycles/2026-05-25T13-39-35_INIT-2026-05-26-claude-trail-verify-cascade-v2.md` — cycle archive
- `brain/projects/claude-harness/themes/2026-05-25-unifier-wedge-preexisting-test-failures.md` — Cycle 6 first occurrence
- `brain/projects/claude-harness/themes/2026-05-25-wi-gate-vs-unifier-gate-mismatch.md` — structural analysis
