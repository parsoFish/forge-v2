---
title: >-
  Autonomous closure works when the stop condition is an objective script, not
  the agent's judgement
description: >-
  A confirmed plan was driven to a green gate by an in-session loop +
  fresh-context subagents, each unit gated tsc+tests before commit. The loop
  could not self-declare done — closure-check.ts (tiered fast|full, parsed from
  a coverage matrix) was the sole arbiter. Closure 2/22→25/25 fast, 30/31 full;
  cycle.ts 1753→330; 0 regressions.
category: pattern
keywords:
  - autonomous-loop
  - objective-gate
  - closure-check
  - fresh-context-subagents
  - gate-every-commit
  - ralph-pattern
  - simplification
  - coverage-matrix
  - no-gaming
created_at: 2026-05-17T00:00:00.000Z
updated_at: 2026-05-17T00:00:00.000Z
related_themes:
  - reactive-constraint-stripback-arc
  - forge-current-architecture-as-built
  - chained-phase-benchmarks
  - eval-driven-development
---

# Objective-gate autonomous closure

A large, multi-phase refactor + redesign of forge was driven to closure
**autonomously** and succeeded because three disciplines held:

1. **The stop condition was a script, not the agent.** `_meta/iteration/
   closure-check.ts` parsed a coverage matrix (US/G obligations →
   `grep-absent|grep-present|cmd|file-*|loc-max` checks, tiered
   `fast|full`) and exited non-zero with a precise unmet list. The loop
   physically could not declare itself done; progress was measured
   (2/22 → 25/25 fast, 30/31 full), not asserted.

2. **Fresh-context subagents for the heavy, well-specified units.** The
   1753→330 LOC `cycle.ts` spine decomposition and each later phase ran
   as a dedicated subagent given a self-contained spec + hard rules,
   then **independently verified by the orchestrator** (git log, build,
   full test, closure delta, invariant greps) — trust-but-verify, not
   trust. This kept the driver's context lean across 9 phases.

3. **Gate every unit; never leave the tree red.** `tsc` strict +
   the full unit suite green before every conventional commit; a unit
   that couldn't go green was reverted, not forced. Result: 388→466
   tests, 0 regressions across ~30 commits.

Two judgement calls preserved integrity: (a) the highest-risk unit
(spine split) was run as its own focused pass, not crammed; (b) the one
remaining obligation (G11, a ~$20–50 live bench re-run) was left
honestly `pending` rather than redefined to pass — **autonomy covers
implementation, not unbounded unattended spend**, and dodging a gate by
redefining it is gaming. The loop is resumable from
`_meta/iteration/{fix_plan,AGENT}.md` + the gate.

## Sources

- [`2026-05-17_forge-self-closure-arc.md`](../_raw/2026-05-17_forge-self-closure-arc.md) — the cycle archive (outcome + evidence).
- [`2026-05-16_trafficgame-arc-reflection.md`](../_raw/2026-05-16_trafficgame-arc-reflection.md) — the reflection that produced the plan this arc executed.

## See also

- [[reactive-constraint-stripback-arc]] — the antipattern this closure remediated.
- [[forge-current-architecture-as-built]] — superseded by the 2026-05-17 snapshot this arc produced.
- [[chained-phase-benchmarks]] — the bench model landed in this arc.
- [[eval-driven-development]] — eval-driven development — every change shows a benchmark delta.
