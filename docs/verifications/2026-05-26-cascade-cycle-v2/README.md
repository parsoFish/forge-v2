# Verification v2 — per-WI status colours + varied feature shape

> Cycle: `INIT-2026-05-26-claude-trail-verify-cascade-v2` (claude-harness).
> Recorded: 2026-05-26 13:39 → 14:24 (autonomous + auto-approve + closure + reflection).
> Outcome: **merged + reflected, fully autonomous** (auto-approve now works).

## What this verifies

The post-v1 operator notes:

1. **Features + WIs follow blue / green / yellow / red independently.**
   Sibling WIs stay in their own colours; one WI's transient error
   doesn't tint its siblings.
2. **Yellow = retrying** (had a transient error, still going). Red is
   reserved for cycle-level terminal failure. The dev-loop phase no
   longer flips red on the unifier's transient `unifier.gate.initiative-failed`
   retries.
3. **Varied feature sizes** — the seed deliberately calls out
   different WI counts per feature. This run produced **FEAT-1 with 1
   WI, FEAT-2 with 2 WIs, FEAT-3 with 3 WIs**. Total 6 WIs / 3
   features.
4. **Auto-approve works end-to-end** — the `verify-cycle.mjs` Promise
   .race-falsy-0 bug from v1 is fixed (sentinel symbol now used),
   so the cycle reaches done + reflection without operator
   intervention.

## What the cycle shipped

A `claude-trail --filter <key>:<value> <cycles-dir>` mode (explicitly
throwaway). 17 files: 4 src + 6 test + fixtures + 3 changes. 1095
insertions.

## Frame highlights

| # | Frame | What to see |
|---|---|---|
| 09 | [project-manager-complete](./frames/09-project-manager-complete.png) | **Variation visible**: FEAT-1 (1 hex), FEAT-2 (2 hexes), FEAT-3 (3 hexes). All blue while dev-loop is active. |
| 11 | [developer-loop-complete](./frames/11-developer-loop-complete.png) | All WI hexes green; sibling features all green; dev-loop green. |
| 12 | [review-loop-complete](./frames/12-review-loop-complete.png) | PR opened; review-loop transitions cleanly. |
| 14 | [after-serve-ready-for-review](./frames/14-after-serve-ready-for-review.png) | Cycle waiting for operator verdict; verify-cycle.mjs about to auto-approve. |
| 15 | [final-state](./frames/15-final-state.png) | **Status-independence working**: WI-3 yellow (retried), FEAT-2 yellow (rollup of WI-3), other WIs + features stay green; dev-loop phase stays green (cycle didn't fail terminally). |

## Status-colour matrix observed

| Unit | Final colour | Why |
|---|---|---|
| FEAT-1 / WI-1 | green | clean pass |
| FEAT-2 | yellow | rollup: WI-3 yellow |
| WI-2 | green | clean pass |
| WI-3 | yellow | had transient error, recovered, cycle ended OK |
| FEAT-3 / WI-4..6 | green | clean pass |
| dev-loop phase | green | cycle ended successfully — no terminal failure |
| arc/pm/review/closure/reflection | green | all ran cleanly |

## What's solid

- Auto-approve + reflection: `verify-cycle.mjs` ran fully autonomous;
  no operator intervention needed between cycle.start and cycle.end.
- PM produced varied WI counts per feature (the manifest decomposition
  hint was honoured).
- Per-WI / per-feature status colours work as specified.
- Bug 3 (iter-0 expected-fail) is invisible to the UI status — confirmed
  by the dev-loop staying green throughout.

## Next-tier candidates (deferred)

- Tier 2 thinning: orchestrator-side enforcement audit
  (`failure-classifier`, `wedgedNoProgressIterations: 3`,
  `requiredPaths` gate). See [`docs/planning/2026-05-25-thin-forge/PLAN.md`](../../planning/2026-05-25-thin-forge/PLAN.md).
- Cost-pill positioning when the cascade is tall (cost pill currently
  hugs the phase row; fine for now).
- Live agent-flow tier under each WI hex (per operator's "hooks into
  claude hooks" thread).

## Notes

- The video (~120MB raw .webm) lives at
  `forge-ui/.demo-shots/verify/INIT-2026-05-26-claude-trail-verify-cascade-v2/`
  on the operator's machine (gitignored — too large to commit raw).
- The code shipped by the cycle (filter.ts et al) is functional but
  explicitly throwaway per the initiative manifest. Safe to revert
  later.
