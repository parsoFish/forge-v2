---
title: Wedged loop detector
description: One of Ralph's stop conditions — abort when the loop makes no progress for N iterations. Caps token burn on no-op iterations.
category: pattern
keywords: [wedged, stuck, no-progress, stop-condition, ralph, iteration-budget, abort]
created_at: 2026-05-04T17:55:00Z
updated_at: 2026-05-04T17:55:00Z
related_themes: [ralph-loop-pattern, quality-gates-orchestrator-verified]
---

# Wedged loop detector

Ralph runs until a stop condition fires. Three conditions ship in `loops/ralph/stop-conditions.ts`:

1. **Quality gates pass** — the work item's acceptance criteria are verified by the orchestrator (not the agent).
2. **Iteration budget exceeded** — `iteration_budget` from the initiative manifest is reached.
3. **Wedged-detector** — N consecutive iterations show no observable progress (no new commits, no new test passes, no diff in the work item's `fix_plan.md`).

The wedged-detector is the safety valve for "Ralph never converges." Without it, an agent can iterate indefinitely on a problem it can't solve, burning tokens with each pass. With it, the orchestrator detects no-op iterations early and moves the manifest to `_queue/failed/` for human triage.

Per [CONTRACTS.md C19](../../../docs/planning/2026-05-20-refinement/CONTRACTS.md) (2026-05-23), the iteration cap is the sole bound — `cost_budget_usd` was removed entirely. A wedged loop is now caught exclusively by the no-progress detector + the iteration-budget guard.

The wedge rate (≤5% of work items target) is one of the developer-loop benchmark's success signals.

## Sources

- [`forge-v2-phase-developer-loop.docs.md`](../../_raw/docs/forge-v2-phase-developer-loop.docs.md) — failure modes section.
- [`adr-002-ralph-loop-pattern.docs.md`](../../_raw/docs/adr-002-ralph-loop-pattern.docs.md) — stop condition design.

## Related

- [Theme: Ralph loop pattern](./ralph-loop-pattern.md) — the loop this guards.
- [Theme: Quality gates orchestrator-verified](./quality-gates-orchestrator-verified.md) — the other primary stop condition.
