---
title: trafficGame — reviewer per-iteration budget undersized for medium-complexity initiatives
description: HISTORICAL — REVIEWER_LIVE_MAX_BUDGET_USD_PER_ITERATION = $0.60 cut off all 3 reviewer iterations before a verdict could be emitted. This evidence motivated CONTRACTS.md C19 (2026-05-23), which removed all $-budgets entirely; the mechanism this theme documents no longer exists.
category: antipattern
keywords: [trafficgame, reviewer, budget, per-iteration, send-back-cap, verdict, medium-initiative, forge-config, historical, c19]
created_at: 2026-05-17T14:30:00Z
updated_at: 2026-05-23T00:00:00Z
retention: archived
supersedes_by: CONTRACTS.md C19
related_themes: []
---

> **Historical (C19 superseded).** The per-iteration $/turn budget guard
> documented here was removed on 2026-05-18 and ratified by
> [CONTRACTS.md C19](../../../../docs/planning/2026-05-20-refinement/CONTRACTS.md)
> on 2026-05-23. All $-budgets are gone; the iteration cap is the sole
> bound. This theme is retained as the evidence that motivated C19, not
> as current guidance.

# trafficGame — reviewer per-iteration budget undersized for medium-complexity initiatives

## What happened

In cycle `2026-05-17T13-36-43_INIT-2026-05-17-world-graph-connectivity` the review-loop ran 3 iterations at a total cost of $3.69. Each iteration cost approximately $0.61 — just above `REVIEWER_LIVE_MAX_BUDGET_USD_PER_ITERATION = 0.60`. Every iteration was cut off before it could:

1. Finish reading the changed files (3 production files + 2 test files, ~500 lines diff).
2. Cross-check all 13 acceptance criteria.
3. Author a hand-crafted PR description.
4. Emit a verdict (approve / send-back).

The loop exhausted its send-back cap with **zero verdicts ever emitted**. The initiative was routed to `_queue/ready-for-review/` for manual operator pickup. The operator inspected the code directly, confirmed it was correct, and merged manually.

## Impact

- $3.69 review cost with no autonomous output.
- Manual operator merge required (negates autonomy goal for this cycle).
- Demo screenshots captured against stale server (separate but related issue).
- Total cycle cost ~$8.41, of which 44% was wasted review budget.

## Why the dev-loop was unaffected

The dev-loop's per-WI budget was appropriate for the work (WI-1: $0.45, WI-2: $0.52, WI-3: $0.41 — all within budget and each completed in a single iteration). The per-iteration reviewer budget is a separate config value; the mismatch is narrowly in the reviewer phase.

## Mitigation

The operator's recommended fix: **scale the reviewer iteration budget with diff size**, the same way `computeAdaptiveReviewIterationCap` already scales the reviewer iteration cap. A 3-file / ~500-line diff with 13 ACs and a demo to validate reasonably requires ~$0.80–1.00 per iteration.

An alternative (simpler) fix: raise `REVIEWER_LIVE_MAX_BUDGET_USD_PER_ITERATION` to $1.00 as a flat baseline and treat $0.60 as a small-diff value.

## Sources

- `_logs/2026-05-17T13-36-43_INIT-2026-05-17-world-graph-connectivity/events.jsonl` — reviewer.send-back-cap-exhausted event, review iteration costs.
- `_logs/2026-05-17T13-36-43_INIT-2026-05-17-world-graph-connectivity/user-feedback.md` — §"Secondary findings #1".
- `/home/parso/forge/brain/_raw/cycles/2026-05-17T13-36-43_INIT-2026-05-17-world-graph-connectivity.md` — cycle archive §"Finding 2".
