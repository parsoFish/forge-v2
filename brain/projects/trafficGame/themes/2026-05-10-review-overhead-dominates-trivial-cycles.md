---
title: trafficGame — review-loop overhead dominates cost for trivial initiatives
description: For simple utility additions, the reviewer phase (2 iterations, demo scaffolding, PR description) consumed 53% of total cycle cost, more than PM (28%) and developer (19%) combined; fixed review scaffolding cost is disproportionate to implementation complexity.
category: reference
keywords: [trafficgame, reviewer, cost, overhead, scaffolding, demo, pr-description, cost-distribution]
created_at: 2026-05-10T03:23:11Z
updated_at: 2026-05-10T03:23:11Z
related_themes: []
---

# Review-loop overhead dominates cost for trivial initiatives

## Observation

In cycle `2026-05-10T03-08-21` (add `manhattanDistance` utility, trivial scope):

| Phase | Cost | % of total |
|---|---|---|
| PM | $0.643 | 28% |
| Developer (WI-1 only) | $0.447 | 19% |
| Review (2 iterations) | $1.220 | 53% |
| **Total** | **$2.31** | 100% |

The reviewer phase cost more than developer + PM combined, for an initiative that was a single pure function + 3 test cases.

## Why

The review loop has fixed scaffolding work it does regardless of initiative complexity:
- Creates a Playwright demo spec (`source.spec.ts`).
- Creates a `playwright.demo.config.ts`.
- Writes a `pr-description.md`.
- Updates `AGENT.md`.
- Runs gate invocations (3 in this cycle).

This scaffolding makes sense for feature-rich cycles. For a 10-line pure-function addition, it is a large fixed overhead.

## Implication

Do not use cycle cost alone to judge developer-loop efficiency for trivial initiatives. The marginal cost of a second trivial WI in the same cycle (if the brain-skip issue were fixed) would be low — the review loop's fixed scaffolding is already paid. Batching 2-3 small utility additions into a single initiative with multiple WIs would amortise the review overhead more efficiently.

## Sources

- `_logs/2026-05-10T03-08-21_INIT-2026-05-10-trafficgame-manhattan-v5/events.jsonl` — cost fields in phase-end events: PM $0.643, developer-ralph $0.447, reviewer $1.220.
- `/home/parso/forge/brain/_raw/cycles/2026-05-10T03-08-21_INIT-2026-05-10-trafficgame-manhattan-v5.md`
