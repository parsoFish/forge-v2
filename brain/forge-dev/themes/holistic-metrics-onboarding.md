---
title: >-
  Holistic project metrics are an onboarding contract clause — without them,
  agentic ideation is blind
description: >-
  The forge↔project contract (C1–C6) is necessary but not sufficient for
  measurement-driven loops. A new clause — C7 holistic metrics, with a
  measurement command and locked baselines — is the missing piece. Tests verify
  "did this break"; metrics verify "did this help".
category: decision
keywords:
  - holistic-metrics
  - onboarding
  - contract
  - C7
  - eval-driven
  - locked-baselines
  - measurement
  - agentic-ideation
  - score-delta
  - project-bootstrap
created_at: 2026-05-23T00:00:00.000Z
updated_at: 2026-05-23T00:00:00.000Z
related_themes:
  - forge-project-onboarding-contract
  - eval-driven-development
  - phase-isolation-benchmarks
  - parametric-design-search
---

# Holistic project metrics are a contract clause

The existing forge↔project contract (C1–C6, [forge-project-onboarding-contract](./forge-project-onboarding-contract.md))
ensures forge can **run** a project's gate, route work to isolated worktrees,
honour locked-core mandates, and merge without stranding. It does NOT ensure
forge can **evaluate whether a change made the project better**.

The trafficGame collision/elevation arc (PR #57) hammered this gap into view.
Across 34 commits the simulation was rebuilt twice, each iteration judged not by
tests but by two scalars from an in-sim grading harness: throughput
(vehicles/sim-second) and severe-overlap count. The 788-test suite passed
throughout — it said every elevation-model iteration was *correct*; the numbers
said only the third was actually *better*. Without that pair of scalars there's
no way to settle "this should be cleaner" against "throughput dropped 30%"
agentically.

## The missing clause — C7

**C7 — Holistic project metrics with a measurement command and locked
baselines.** A project declares at least one holistic outcome metric, a
command that produces it, and a baseline file recording the current locked
value. Every initiative must check the metric and either preserve the baseline
within a declared tolerance or document + deliberately update it. Concretely:

- **A metric command** — like `npm test` for C1 but for holistic performance
  (trafficGame's is the sweep harness + locked `docs/baselines/*.md`; ~10 s with
  8 workers, cheap enough to run per-PR).
- **Locked baseline files** — machine- and human-readable, committed to the repo
  so architect/PM/dev-loop read them as brain context.
- **A regression budget** — explicit (trafficGame uses ±1% on its locks);
  anything outside is a trade-off the PR must explain.
- **Negative examples** — the screenshot index includes designs that scored
  badly, so an agent learns the failure modes, not just what passed.

## Why tests aren't enough

Tests cover correctness under specific conditions ("given X, returns Y"); a
green suite proves nothing about overall system performance. trafficGame's tests
did not flag cars deadlocking on the elevated split-grid (observable only in a
sweep), false-positive overlaps from grade-separated cars (only in the sweep raw
JSON), or the ramp entry-jam (only in a mid-sim screenshot). A unit test is a
single assertion; a holistic metric ("3.314 v/sim-s at 0 severe overlaps over
60 s with 12 flows") is a system-level claim. Both are needed; forge lacks the
latter as a contract clause.

## Implications if C7 lands

The architect must consume the locked baselines (C4 extended), the PM must emit
WIs whose AC is "metric within budget" not just "tests pass", the reviewer must
compare against the baseline (eval-driven-development from principle to
enforcement), and a project-onboarding skill should walk the operator through
choosing the metric, command, baselines, and budget. Not every project has a
metric as clean as trafficGame's (a documentation project's outcome is "is the
doc useful"); the onboarding skill should help find the cleanest available
proxy, since even an imperfect one beats none — it converts prose to deltas.

## Sources

- [`projects/trafficGame/scripts/grading/runSweep.mjs`](../../../projects/trafficGame/scripts/grading/runSweep.mjs) — the measurement engine.
- [`projects/trafficGame/docs/baselines/`](../../../projects/trafficGame/docs/baselines/) — the locks.
- PR #57 — the arc that demonstrated the gap.

## See also

- [[forge-project-onboarding-contract]] — C1–C6 (C7 extends).
- [[eval-driven-development]] — the principle this clause enforces.
- [[phase-isolation-benchmarks]] — forge's own (now-retired) per-phase analogue.
- [[parametric-design-search]] — the ideation pattern C7 enables.
