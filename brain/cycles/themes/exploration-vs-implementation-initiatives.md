---
title: >-
  Exploration initiatives differ structurally from implementation initiatives —
  the architect/PM/dev-loop pipeline is shaped for the latter and needs new
  artifacts for the former
description: The trafficGame collision/elevation arc (PR
category: decision
keywords:
  - exploration
  - implementation
  - initiative-types
  - counterfactual
  - autonomy
  - architect
  - pm
  - dev-loop
  - reviewer
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

The forge pipeline (architect → PM → dev-loop → review → reflect) is
shaped for **implementation initiatives**: a manifest describes
features with acceptance criteria; the PM breaks them into work items
with file scopes; the dev-loop writes code that makes the ACs pass;
the reviewer verifies the diff matches the spec.

The trafficGame collision/elevation arc (PR #57) was a different kind
of work: **scientific exploration**. The "spec" wasn't "implement
function X with these inputs and outputs"; it was "find a map design
that hits the highest throughput at zero severe overlaps." There was
no obvious AC because the discovery WAS the AC.

This is why the arc ran conversationally rather than as a forge cycle.
The pipeline currently has no shape for it. This theme captures what
that shape would look like.

## How exploration initiatives differ

| Dimension | Implementation | Exploration |
|---|---|---|
| Goal | Build feature X | Find the best value of a measurable outcome |
| Acceptance criterion | Tests + spec checks pass | Score-delta improves; locked baselines preserved |
| Decomposition | Features → WIs by file scope | Parameter space → sweep batches |
| Dev-loop output | Code that satisfies the spec | A new locked baseline + screenshots |
| Reviewer focus | Diff matches spec | Score-delta vs locks; visual confirmation |
| Reflection | What went wrong with the spec / code | What the score-deltas suggest about next ideation |

Implementation initiatives are **closed**: the spec finitely defines
"done." Exploration initiatives are **open**: "done" is "no obvious
further improvement at the current budget" plus a recorded score.

## The trafficGame arc — what actually happened, structurally

The work ran across multiple operator-driven sessions, roughly:

1. **Diagnose**: operator screenshots → "cars are colliding /
   deadlocking / flickering / not yielding."
2. **Hypothesize**: chosen architectural direction (FIFO → geometric
   walk → elevation-aware → binary model).
3. **Implement**: code change in `src/traffic/*`.
4. **Measure**: parametric sweep via `scripts/grading/sweep-*.mjs`.
5. **Compare**: throughput + severe-count vs locked baselines and
   prior frontier numbers.
6. **Visual confirm**: screenshot the new champion mid-sim, eyeball
   for unexpected behaviour.
7. **Lock or revert**: update `docs/baselines/grading-frontier-*.md`
   or roll back.
8. **Iterate**: operator looks at the screenshot or the
   non-monotonicities, forms next hypothesis, return to step 2.

Steps 2 and 7 required operator-level judgement (which architectural
direction; is this the new champion). Steps 1, 3, 4, 5, 6 are
automatable.

## What a forge exploration cycle would look like

### Architect deliverable — an "exploration manifest"

Different from an implementation manifest:

```yaml
initiative_id: INIT-2026-05-23-trafficgame-elevation-search
project: trafficGame
type: exploration                            # NEW field
quality_gate_cmd: [npm, test]                # existing — still required
metric_command:                              # NEW — what produces the scalar
  - node
  - scripts/grading/sweep-grid-elevation-split.mjs
locked_baselines:                            # NEW — what the metric must not regress
  - file: docs/baselines/grading-frontier-roundabouts.md
    metric: 1.921
    tolerance: 0.01
  - file: docs/baselines/grading-frontier-grids.md
    metric: 1.236
    tolerance: 0.01
parameter_space:                             # NEW — what to sweep
  - name: spacing
    min: 100
    max: 500
    step: 50
hypothesis: |
  H lanes elevated, V lanes ground, split at intersection points so
  shared CPs become ramps. Cross-direction flows use the ramps to
  switch levels; same-direction traffic crosses geometrically without
  conflict thanks to the binary-elevation model.
budget:
  iteration_count: 4                         # coarse → fine sweep passes
  cost_budget_usd: 5
```

The architect's job here isn't to specify the implementation; it's to
specify the HYPOTHESIS, the MEASUREMENT, the PARAMETER SPACE, and the
REGRESSION BUDGET. The hypothesis comes from the brain (prior themes,
operator notes, screenshots).

### PM deliverable — sweep batches as WIs

Each WI is a sweep over a slice of the parameter space:

```yaml
work_items:
  - id: WI-1
    title: Coarse sweep s ∈ [100, 500] step 100
    spec: |
      Run `node scripts/grading/sweep-grid-elevation-split.mjs 100 500 100`.
      Identify the best severe-clean parameter value.
    output_artifact: /tmp/grading-grid-elevation-split/sweep.md
  - id: WI-2
    title: Fine sweep around the WI-1 peak ± 50 step 10
    depends_on: [WI-1]
    spec: |
      Read WI-1's best `spacing`. Run a finer sweep ±50 with step 10
      around it.
  - id: WI-3
    title: Locked-baseline regression check
    depends_on: [WI-2]
    spec: |
      Re-run sweep-roundabouts.mjs at r=300 and sweep-grids.mjs at
      s=60. Both must be within ±1% of locked values.
  - id: WI-4
    title: Capture screenshot + update grading-frontier doc
    depends_on: [WI-3]
    spec: |
      Run `node scripts/grading/capture-notable.mjs` for the new
      champion. Update `docs/baselines/grading-frontier-cross-theories.md`
      with the new headline number, the new locked screenshot, and the
      old champion demoted.
```

This is the parallelism-friendly shape: WI-1's coarse sweep parallelises
8-wide automatically; WI-2 narrows; WI-3 is the regression gate; WI-4
is the documentation deliverable.

### Dev-loop — runs the harness, NOT writes code

For an exploration initiative the dev-loop's job is to run the
provided sweep command, capture the output, and write the result to
the WI's `output_artifact` path. No `npm test` after every WI
because the metric IS the gate. The quality gate runs ONCE at the end
(WI-3 regression check).

Code changes (the binary elevation model rewrite, the IDM
elevation-lookahead extension, the dead-code removal) are a SEPARATE
prior implementation initiative — the exploration initiative consumes
the already-merged code, it doesn't write new code.

### Reviewer — compares deltas

The reviewer's job:

- Read the score-deltas from the sweep markdown
- Compare against the locked-baselines (must hold ±tolerance)
- Visually inspect the screenshots for unexpected behaviour
- Update the `grading-frontier` doc if the champion changed
- Approve if (champion improved) AND (locked baselines held) AND
  (screenshots show clean flow)

The PR comment loop is naturally suited here: the operator looks at
the screenshot + numbers and either approves or asks for more
exploration in a specific direction.

## What the operator had to do that the cycle would have automated

Reviewing the trafficGame arc against the proposed shape, the operator's
load-bearing contributions were:

- **Choosing the architectural direction** (FIFO → back-edge walk →
  binary model). This is hypothesis-formation; it required reading
  diagnostic screenshots and the existing collision code. Hard to
  automate; needs operator + brain context.
- **Naming the failure mode** ("cars are flickering up and down",
  "yielding across levels"). Operator was the eye that connected the
  visual symptom to the underlying mechanism. Some of this could be
  automated by an anomaly-detection layer on the screenshots, but
  the framing was operator-supplied.
- **Pivoting between theories** (when grid-elevation-no-ramps failed,
  switching to grid-elevation-split). This is meta-ideation; the
  current architect doesn't do it.

The work that the cycle SHOULD have automated:

- The 30+ sweep runs across 7 different theories
- The regression-budget check after every change
- The visual capture-notable.mjs invocation
- The doc updates to `grading-frontier-*.md` and `LEARNINGS.md`
- The PR description writing

So the cycle would NOT have eliminated the operator from the loop —
it would have reduced the operator's involvement to **hypothesis +
approval**, not **hypothesis + every parametric sweep + every
regression check + every doc update + every PR description**.

## When this isn't yet ready

The exploration-initiative shape requires:

1. **C7 (holistic metrics) onboarded for the project** — otherwise
   there's no metric_command to put in the manifest. See
   [holistic-metrics-onboarding](./holistic-metrics-onboarding.md).
2. **A parametric-design-search harness** — generic or project-local.
   See [parametric-design-search](./parametric-design-search.md).
3. **The architect skill must read the brain themes for prior
   hypotheses** so it can propose new ones (not just enumerate
   existing failures). The brain-first-research clause already
   covers this.
4. **The PM skill must accept a `type: exploration` manifest** and
   produce sweep-batch WIs instead of feature-decomposition WIs.
5. **The reviewer must accept a "score-delta + visual confirmation"
   verdict shape** instead of the current "diff matches spec" shape.

None of these is huge individually. Together they constitute a second
operational mode for forge alongside implementation cycles.

## Why this matters (the broader principle)

Implementation cycles are forge's well-understood unit of work, but
**a lot of real engineering is exploration**: tuning, optimisation,
A/B-style design searches, calibration. If forge can only run
implementation cycles, every exploration arc is going to look like
the trafficGame arc — an operator-driven multi-session conversation
that succeeds but pollutes the autonomy signal.

Distinguishing the two operational modes structurally (per
[human-directed-work-as-initiatives](./human-directed-work-as-initiatives.md)'s
`origin` tag) is the start; building the second pipeline shape is
the finish.

## Sources

- PR #57 (merged 2026-05-23) — the trafficGame arc that ran as
  exploration but had no forge shape for it.
- [`projects/trafficGame/brain/themes/2026-05-23-grading-frontier-infrastructure.md`](../../../projects/trafficGame/brain/themes/2026-05-23-grading-frontier-infrastructure.md) — the project-local instance.
- [`brain/_raw/cycles/2026-05-23_trafficgame-elevation-grading-arc.md`](../_raw/2026-05-23_trafficgame-elevation-grading-arc.md) — the cycle archive.

## See also

- [[holistic-metrics-onboarding]] — C7, the contract clause this builds on.
- [[parametric-design-search]] — the harness pattern.
- [[human-directed-work-as-initiatives]] — the `origin` tag that distinguishes hand-directed from autonomous.
- [[forge-current-architecture-as-built]] — what's shaped for implementation only.
