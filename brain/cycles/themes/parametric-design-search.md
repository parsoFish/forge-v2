---
title: >-
  Parametric design search — the ideation-fanout pattern any project with a
  measurable outcome can use
description: >-
  trafficGame's runSweep.mjs library is ~250 lines of reusable infrastructure
  that turned every map-design hypothesis from prose into a ~30-line script +
  10s wall-clock sweep. Pattern generalises to any project where a parameter
  space and a holistic metric exist; forge should expose a project-agnostic
  harness skeleton.
category: pattern
keywords:
  - parametric
  - sweep
  - ideation
  - fanout
  - parallel
  - playwright
  - runsweep
  - holistic-metric
  - exploration
  - harness
  - agentic-loop
created_at: 2026-05-23T00:00:00.000Z
updated_at: 2026-05-23T00:00:00.000Z
related_themes:
  - holistic-metrics-onboarding
  - exploration-vs-implementation-initiatives
  - eval-driven-development
---

# Parametric design search

When a project has a parameter space (variables you can tune) and a holistic
metric (a measurable outcome), the agentic improvement loop collapses to:

1. Define the parameter range
2. Sweep it in parallel
3. Read the score-delta vs the locked baseline
4. Lock the new champion

trafficGame's [`scripts/grading/runSweep.mjs`](../../../projects/trafficGame/scripts/grading/runSweep.mjs)
is the reference instantiation: a parallel worker pool (default 8) pulls
parameter values off a shared queue, calls a per-value `drawDesign` + validation
+ measurement, and aggregates per-run JSON into a `sweep.csv` + `sweep.md` with
"best"/"worst" sections. Adding a new theory is **~30 lines** (a parameter range
+ a draw function); the reusable harness is **~250 lines**.

## Why this is a tight loop

The budget per hypothesis is **minutes, not hours**: ~10 parameter values × a
60-sim-second run at 20× time-scale, across 8 parallel workers, is ~10 s
wall-clock. A human does maybe 2–3 designs/hour by hand; the loop does ~8/min.
That speed unlocks ideation styles the slow loop can't afford — coarse-then-fine
sweeps, cross-parameter combos, deliberate negative-example collection.

## What forge should provide

A project-agnostic harness skeleton: a parallel worker pool with a shared queue,
a measurement protocol (start system → capture scalar → tear down), and a
CSV+markdown+raw-JSON output the reviewer skill can diff. The per-project bits
are how to start the system under test, the parameter draw function, and the
measurement extractor. A new `project-sweep` skill could be the runner. The
pattern doesn't care about the domain — any project with a parameter space, a
bounded-time measurement command, and a reproducible testbed can use it (a web
app's cache-TTL vs p95 latency; a compiler's inlining threshold vs runtime/size).

## Anti-patterns

- **Don't sweep without a regression budget.** A new champion is only meaningful
  if it didn't secretly regress something else. trafficGame checked every
  iteration against locked baselines (roundabout r=300 = 1.921 v/sim-s; grid
  s=60 = 1.236 v/sim-s) within ±1% — the elevated split-grid champion (3.314
  v/sim-s) counts BECAUSE the locks held.
- **Don't sweep without visualising.** Several times the score rose but the
  screenshot showed it was counting noise (grade-separated cars logged as
  overlaps before the binary elevation model). The screenshot index is part of
  the deliverable, not an afterthought.

## Sources

- [`projects/trafficGame/scripts/grading/runSweep.mjs`](../../../projects/trafficGame/scripts/grading/runSweep.mjs) — the reference implementation.
- [`projects/trafficGame/scripts/grading/README.md`](../../../projects/trafficGame/scripts/grading/README.md) — the "add a theory" guide.
- PR #57 — 8 theories graded against each other inside this loop.

## See also

- [[holistic-metrics-onboarding]] — what the harness measures.
- [[exploration-vs-implementation-initiatives]] — what kind of initiative this is.
- [[eval-driven-development]] — the principle.
