---
title: PM produced 3 WIs vs 5–8 hint but all WIs completed in 1 iteration — underdecomposition with clean delivery
description: The manifest decomposition hint specified 5–8 WIs across 3 features. PM produced exactly 1 WI per feature (3 total). All 3 WIs completed in 1 iteration each. The underdecomposition did not cause failures — scope was proportionate to the actual work — but the PM ignored an explicit operator sizing directive.
category: reference
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# PM underdecomposition — 3 WIs vs 5–8 hint; 1 iteration each; clean delivery

## Observation

Manifest decomposition hint:

> "Each feature warrants 1–3 WIs. Use the brain for sizing references from
> past claude-harness cycles."

And explicitly: "Decompose into the natural seams: probe-core logic in one
feature, output formatter in another, CLI wiring + the golden test in the
third."

The PM produced exactly 3 WIs — one per feature:

| WI | Feature | Estimated iterations | Actual iterations |
|---|---|---|---|
| WI-1 | FEAT-1 Probe core | 2 | 1 |
| WI-2 | FEAT-2 Probe formatter | 2 | 1 |
| WI-3 | FEAT-3 CLI wiring | 3 | 1 |

PM brain reads: 11 (including prior claude-harness cycle themes). PM cost: $0.53.

## Analysis

The manifest hint said "1–3 WIs per feature" but also implied a total of 5–8
WIs. The PM took the lower bound (1 per feature) and landed at 3 total.

Each WI completed cleanly in 1 iteration — below even the PM's own estimates
(2–3 per WI). This suggests the PM's scope assessment was accurate for the
work's actual complexity. The probe subcommand is a small, isolated feature
with no external I/O and clear acceptance criteria.

The 5–8 hint in the manifest appears to have been driven by the cycle's
verification purpose (testing Tier 1 thinning), not by the work's inherent
complexity. The PM may have correctly overridden the hint based on brain
evidence from prior claude-harness cycles.

## When underdecomposition matters vs. doesn't

**Doesn't matter when:**
- All WIs complete in ≤ 2 iterations (work was atomic)
- No send-backs between WIs (no hidden coupling)
- Feature ships cleanly (no unifier iteration cost from WI failures)

**Matters when:**
- A WI is too large and the ralph loop wedges or exceeds budget
- Coupling between WI tasks causes back-and-forth
- The PM's single WI covers heterogeneous work (multiple independent concerns)

Cycle 6 fits the "doesn't matter" case. The underdecomposition is noted but
not flagged as a failure.

## Sources

- `_logs/2026-05-25T12-51-25_INIT-2026-05-25-claude-trail-verify-cascade/events.jsonl` — PM phase events (pm.feature-decomposed metadata)
- `brain/_raw/cycles/2026-05-25T12-51-25_INIT-2026-05-25-claude-trail-verify-cascade.md` — cycle archive
