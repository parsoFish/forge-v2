---
batch: 2026-05-20-refinement
date_drafted: 2026-05-20
date_councilled: 2026-05-21
date_contracts_locked: 2026-05-21
date_iteration_2: 2026-05-23
plans: 9                       # 7 → 8 (07 split) → 9 (plan 08 added)
councils: 7                    # combined 07 council kept; plan 08 not councilled (single-source iteration)
contracts: 28
learnings_doc: LEARNINGS-trafficgame.md
---

# Forge holistic refinement — 2026-05-20 batch

Refinement plans drafted by parallel planning agents, each councilled by
the 4-critic chain (CEO / engineering / design / DX), synthesised into
a stage-by-stage execution plan with contract decisions ratified by the
operator, then **iterated 2026-05-23** with post-S0 trafficGame learnings,
graphify (additive brain layer), and a token economy plan.

## Start here

1. **[CONTRACTS.md](./CONTRACTS.md)** — the 28 ratified cross-plan
   contracts (C1–C28). Source of truth.
2. **[EXECUTION-PLAN.md](./EXECUTION-PLAN.md)** — the stage-by-stage
   execution doc. S0 (landed) → S8 (token economy). Daily-driver.
3. **[LEARNINGS-trafficgame.md](./LEARNINGS-trafficgame.md)** — canonical
   reference for "what good looks like": 10 learnings the operator
   surfaced through trafficGame post-S0, mapped to the plans they amend.
4. **[S2A-CWC-AMENDMENTS.md](./S2A-CWC-AMENDMENTS.md)** — front-of-architect
   interview step (`AskUserQuestion`) + sibling `PLAN.html` rich viewer,
   distilled from `anthropics/cwc-workshops/how-we-claude-code`. Additive
   to S2A; doesn't disturb the locked surface.
5. **[S2B-CLOSURE.md](./S2B-CLOSURE.md)** — S2B (architect bench reground +
   cross-phase handoff + `interview_section_present` gate) closure. Bench
   surface + scoring + fixtures + harness migration landed; LLM-driven
   bench run operator-pending (API-key blocker).
6. **[S3-CLOSURE.md](./S3-CLOSURE.md)** — S3 (PM refinement: C5 WI schema,
   knownFeatureIds wiring, hallucinated-FEAT retry, bench rubric, C11
   migration, architect→PM handoff) closure. Plumbing wired; chained-bench
   run operator-pending.
7. Each plan + its council review below.

## Plans

| # | Area | Plan | Council | Ships in stage |
|---|---|---|---|---|
| 01 | Brain | [01-brain.md](./01-brain.md) | [01-brain.council.md](./01-brain.council.md) | 01a → S1.2 / 01b → S5 / **01c → S1.4 (graphify)** |
| 02 | Architect | [02-architect.md](./02-architect.md) | [02-architect.council.md](./02-architect.council.md) | S2A then S2B |
| 03 | Project Manager | [03-project-manager.md](./03-project-manager.md) | [03-project-manager.council.md](./03-project-manager.council.md) | S3 |
| 04 | Dev-loop | [04-dev-loop.md](./04-dev-loop.md) | [04-dev-loop.council.md](./04-dev-loop.council.md) | S1.3 (precursor) + S4 (atomic with 05) |
| 05 | Review | [05-review.md](./05-review.md) | [05-review.council.md](./05-review.council.md) | S4 (atomic with 04) |
| 06 | Reflect | [06-reflect.md](./06-reflect.md) | [06-reflect.council.md](./06-reflect.council.md) | S6A then S6B |
| 07a | Logging UX | [07a-logging-ux.md](./07a-logging-ux.md) | [07-general-logging-ids.council.md](./07-general-logging-ids.council.md) (combined) | S7 |
| 07b | Init IDs | [07b-init-ids.md](./07b-init-ids.md) | [07-general-logging-ids.council.md](./07-general-logging-ids.council.md) (combined) | S1.1 |
| **08** | **Token economy** | [08-token-economy.md](./08-token-economy.md) | (not councilled — iteration-2 addition) | **S8** |

## Master execution plan

**The orchestrating doc is [EXECUTION-PLAN.md](./EXECUTION-PLAN.md)** —
catalogues the 28 cross-plan inconsistencies + contract decisions
([CONTRACTS.md](./CONTRACTS.md)), lays out the 9-stage execution order
(S0 contract lock → S1 foundations parallel → S2 architect →
S3 PM → S4 dev-loop+review atomic → S5 brain bench → S6 reflect →
S7 logging → **S8 token economy**). Use it as the daily-driver.

## Cross-plan dependency map (after iteration-2)

```
07b (IDs, S1.1)            01a (brain hygiene, S1.2)        01c (graphify, S1.4)
   ↓                          ↓                                ↓
   └──────────────────────────┴────────────────────────────────┘
                              ↓
02 (architect, S2A→S2B) ──┐    (architect benefits from graphify + brain hygiene)
                           ├──→ 03 (PM contract, S3) ──→ 04 (dev-loop, S4) ─┐
                           │                                                 │ (atomic)
                           │                                          05 (review, S4)
                           ↓                                                 ↓
                       01b (brain bench growth, S5) ← 06 (reflect, S6)

07a (logging, S7) — orthogonal; after S4 lands unifier's phase events.

08 (token economy, S8) — orthogonal; after S2 stabilises so caching
                         isn't fighting a moving prompt.
```

## Status

- **S0 contract lock** — landed 2026-05-21 (commit `d61e258` on main).
- **Iteration-2 additions** — this batch (graphify + token economy +
  trafficGame learnings + C20-C28).
- **S1 stages (S1.1, S1.2, S1.3, S1.4)** — unblocked; parallelisable.

## Contracts at a glance (C1–C28)

See [CONTRACTS.md](./CONTRACTS.md) for full text. Iteration-2 additions
(C20-C28) cover:

- **C20-C22** (graphify): dual-index brain (markdown wiki + graph),
  `brain/graph.json` canonical, `brain-graph` skill ownership.
- **C23-C25** (token economy core): prompt caching default-on, council
  Haiku-by-default, output style per-phase (no global caveman install).
- **C26** (holistic metrics): `.forge/project.json` `metrics` block as
  onboarding clause; visual confirmation non-optional for visual projects.
- **C27** (exploration manifest type): architect emits `type:
  'implementation' | 'exploration'`; explorations carry
  `parameter_space` + `hypothesis` + `metric_command` + `locked_baselines`.
- **C28** (`project-sweep` skill): forge-provided abstract harness
  skeleton; per-project plug-ins via `.forge/project.json` `sweep` block.

## Known issues with the batch (resolved into stages)

- **`scripts/council-refinement-plans.ts` failed end-to-end** (I-23) →
  bundled into S2A (architect refinement).
- **Cross-plan artefact-name drift** (`pr-feedback.md`, `.forge/project.json`,
  `user-feedback.md`, etc.) → resolved by C1–C19 in [CONTRACTS.md](./CONTRACTS.md).
- **trafficGame post-S0 learnings** → folded into plans 02-06 via the
  amendment blocks; the canonical record is [LEARNINGS-trafficgame.md](./LEARNINGS-trafficgame.md).
- **Token-economy levers** → new plan 08 + C23-C26 (positive counterpart
  to C19's "no budgets").
- **Graphify adoption** → plan 01 refinements #8-#10 + C20-C22 (additive
  layer; existing themes / raw not rewritten).

## How to pick a stage up

1. Open [EXECUTION-PLAN.md](./EXECUTION-PLAN.md) and find the next stage.
2. Confirm the previous stage's **join step** verifies (acceptance
   criteria met in code).
3. Run `/forge-architect forge` with the stage's brief copy-pasted as
   the user prompt.
4. Let the cycle run.
5. Don't skip the join step.

> If, mid-stage, you find a need to change a C-decision, **stop the
> stage** and follow CONTRACTS.md §"Change control".
