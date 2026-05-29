---
title: Exploration initiatives differ structurally from implementation initiatives
description: >-
  The trafficGame collision/elevation arc (PR #57) was scientific exploration —
  "find the best measurable outcome", not "build feature X" — and the forge
  pipeline has no shape for it. Captures the exploration-cycle shape: a
  metric/parameter/hypothesis manifest, sweep-batch WIs, a dev-loop that runs the
  harness instead of writing code, and a score-delta reviewer.
category: decision
keywords:
  - exploration
  - implementation
  - initiative-types
  - autonomy
  - score-delta-completion
  - measurement-driven
  - ideation-fanout
created_at: 2026-05-23T00:00:00.000Z
updated_at: 2026-05-23T00:00:00.000Z
related_themes:
  - holistic-metrics-onboarding
  - parametric-design-search
  - human-directed-work-as-initiatives
  - forge-current-architecture-as-built
---

# Exploration vs implementation initiatives

The forge pipeline (architect → PM → dev-loop → review → reflect) is shaped for
**implementation initiatives**: a manifest describes features with acceptance
criteria; the PM breaks them into file-scoped WIs; the dev-loop writes code that
passes the ACs; the reviewer verifies the diff matches the spec.

The trafficGame collision/elevation arc (PR #57) was **scientific exploration**.
The "spec" wasn't "implement function X"; it was "find a map design that hits the
highest throughput at zero severe overlaps" — the discovery WAS the AC. That's
why it ran conversationally: the pipeline has no shape for it.

## How exploration initiatives differ

| Dimension | Implementation | Exploration |
|---|---|---|
| Goal | Build feature X | Find the best value of a measurable outcome |
| Acceptance criterion | Tests + spec checks pass | Score-delta improves; locked baselines preserved |
| Decomposition | Features → WIs by file scope | Parameter space → sweep batches |
| Dev-loop output | Code that satisfies the spec | A new locked baseline + screenshots |
| Reviewer focus | Diff matches spec | Score-delta vs locks; visual confirmation |
| Reflection | What went wrong with spec / code | What the deltas suggest for next ideation |

Implementation initiatives are **closed** (the spec finitely defines "done");
exploration initiatives are **open** ("done" = "no obvious further improvement at
the current budget" plus a recorded score).

## What a forge exploration cycle would look like

- **Architect** emits a `type: exploration` manifest carrying a `metric_command`,
  `locked_baselines` (file + value + tolerance), a `parameter_space`, a
  `hypothesis` (from the brain), and a budget — not an implementation spec.
- **PM** decomposes the parameter space into sweep-batch WIs: coarse sweep → fine
  sweep around the peak → locked-baseline regression check → screenshot +
  frontier-doc update.
- **Dev-loop** *runs the provided sweep command* and writes the result to the
  WI's output artifact — it does NOT write code. The metric is the gate; the
  quality gate runs once at the end. Code changes are a separate prior
  implementation initiative the exploration consumes.
- **Reviewer** compares score-deltas against the locked baselines (±tolerance),
  eyeballs the screenshots, updates the frontier doc, and approves iff
  champion-improved AND baselines-held AND flow-is-clean. The PR-comment loop
  fits: operator sees numbers + screenshot, approves or asks for a direction.

(The concrete manifest + WI-list shapes live in the cycle archive cited below.)

## Operator load vs what a cycle would automate

The operator's load-bearing work was **hypothesis-formation**, **naming the
failure mode**, and **pivoting between theories** — all needing operator + brain
context. The automatable bulk was the 30+ sweep runs, the per-change regression
check, the screenshot capture, the doc updates, and the PR description. A cycle
wouldn't remove the operator — it would reduce them to **hypothesis + approval**.

## When this isn't yet ready

The shape requires (none huge alone, together a second operational mode): C7
holistic metrics onboarded ([holistic-metrics-onboarding](./holistic-metrics-onboarding.md)),
a parametric-design-search harness ([parametric-design-search](../../cycles/themes/parametric-design-search.md)),
an architect that reads brain themes for prior hypotheses, a PM that accepts a
`type: exploration` manifest and emits sweep-batch WIs, and a reviewer that
accepts a "score-delta + visual confirmation" verdict shape.

## Why this matters

A lot of real engineering is exploration — tuning, optimisation, A/B design
searches, calibration. If forge can only run implementation cycles, every
exploration arc looks like the trafficGame arc: an operator-driven multi-session
conversation that succeeds but pollutes the autonomy signal. Distinguishing the
two modes structurally (per [human-directed-work-as-initiatives](../../cycles/themes/human-directed-work-as-initiatives.md)'s
`origin` tag) is the start; building the second pipeline shape is the finish.

## Sources

- PR #57 (merged 2026-05-23) — the arc that ran as exploration with no forge shape.
- [`brain/cycles/_raw/2026-05-23_trafficgame-elevation-grading-arc.md`](../../cycles/_raw/2026-05-23_trafficgame-elevation-grading-arc.md) — the cycle archive (full manifest + WI shapes).

## See also

- [[holistic-metrics-onboarding]] — C7, the contract clause this builds on.
- [[parametric-design-search]] — the harness pattern.
- [[human-directed-work-as-initiatives]] — the `origin` tag distinguishing hand-directed from autonomous.
