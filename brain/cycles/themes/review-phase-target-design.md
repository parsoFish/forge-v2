---
title: >-
  Review-phase target design — initiative branch synced, holistic intent gate,
  PR-as-feedback-surface, no auto-merge
description: >-
  Operator's authoritative redesign. Dev-loop keeps the initiative branch in
  local↔remote sync and creates NO PR. Review = automated loop that assesses the
  branch against initiative INTENT holistically, may spawn dev-loops to refine,
  then emits a demo-embedded PR. The GitHub PR is the human feedback/merge
  surface; closure aligns local to remote.
category: decision
keywords:
  - review-phase
  - initiative-branch
  - local-remote-sync
  - holistic-intent
  - spawn-dev-loop
  - pr-feedback-surface
  - no-auto-merge
  - user-triggered
  - C6
  - merge-boundary
created_at: 2026-05-16T00:00:00.000Z
updated_at: 2026-05-16T00:00:00.000Z
related_themes:
  - merge-boundary-stacked-initiative-failure
  - forge-project-onboarding-contract
  - forge-current-architecture-as-built
  - review-fix-loop-spinning
---

# Review-phase target design

The operator's authoritative direction after working the trafficGame arc.
It replaces the as-built review loop (PR created **and** auto-merged
inside `runReviewer`, gated by a default-approve verdict) and closes
contract clause **C6** + finding **I1** (queue `done/` ≠ merged,
local/remote divergence).

**Precondition (dev-loop close).** Developer loops land features/work
items on the **initiative branch**, kept **in sync locally and with the
remote** every WI — no divergence. At close: `main` = pre-initiative
state; the initiative branch holds all completed work; **the dev-loop
creates NO PR.**

**Review = automated loop.**
1. Load the initiative **intent** (manifest + architect narrative).
2. Assess the initiative branch **against that intent holistically** —
   not isolated WIs — verifying all acceptance criteria are broadly met.
3. It has the **freedom to kick off dev-loops** to increase alignment to
   intent, fix bugs, or refine, now that the work is viewable as a whole.
4. Once the gate passes, generate the demo and **create the PR on the
   project repo with the demo embedded**, so it is reviewable on GitHub.

**The PR is the human surface.** No auto-merge. The PR is where the
operator gives feedback and where the showcase lives. For now this is
**user-triggered**: the operator either signals feedback for the review
agent to process on the PR (→ re-assess/refine), or merges the PR
manually in GitHub to signal the review phase is closed. **On closure
the agent aligns local to remote** (fast-forward main, prune the
initiative branch) before the phase ends. Reflection then fires on a
**confirmed** merge, not an orchestrator-internal flag.

This makes the review phase an *orchestrator of dev-loops* rather than a
Ralph that may not author code (F-41). It implies new closure goals
**G8** (local↔remote invariant at dev-loop close), **G9** (no auto-merge
reachable from the unattended path), **G10** (reflection only on a
GitHub-confirmed merge). Full graph + delta table:
`_logs/2026-05-16_trafficgame-arc-reflection/architecture.md` §G.

## Sources

- [`2026-05-16_trafficgame-arc-reflection.md`](../_raw/2026-05-16_trafficgame-arc-reflection.md) — cycle archive: merge-boundary evidence.
- [`architecture.md`](../../../_logs/2026-05-16_trafficgame-arc-reflection/architecture.md) — §C.3 as-built vs §G target, delta table, G8–G10.

## See also

- [[merge-boundary-stacked-initiative-failure]] — the failure this design fixes.
- [[forge-project-onboarding-contract]] — this is C6's resolution.
- [[forge-current-architecture-as-built]] — forge as-built — 5 wired phases + hand-run architect, pm/reflector-only brain-first, ~4,400 loc, a real resilience layer.
- [[review-fix-loop-spinning]] — why spawned dev-loops still need progress termination.
