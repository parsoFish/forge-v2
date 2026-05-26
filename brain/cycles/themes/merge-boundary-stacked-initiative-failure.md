---
title: >-
  Merge boundary is forge's real unattended ceiling — stacked initiatives strand
  in done/
description: 12 trafficGame cycles; only PR
category: antipattern
keywords:
  - merge-boundary
  - stacked-prs
  - queue-truth
  - done-not-merged
  - reviewer-merge-failed
  - unattended-ceiling
  - partial-merge
  - trafficgame
created_at: 2026-05-16T00:00:00.000Z
updated_at: 2026-05-16T00:00:00.000Z
related_themes:
  - squash-merge-stacked-prs
  - layered-merge-order
  - file-based-state-machine
---

# Merge boundary is forge's real unattended ceiling

Across the trafficGame arc the loop was reliable **PM → developer-loop →
reviewer-approve** — the three feature initiatives reached approve with
**zero send-backs**, gates green, work items implemented faithfully. The
loop was **not** reliable at the merge boundary. Of 12 cycle attempts
exactly **one** (manhattan-v5, PR #47) actually merged into main.

Every approved feature initiative (world-graph-foundation #50,
world-graph-ux #51, intersection-backpressure #52, simplification-arch
#49) ended `reviewer.merge-failed` with a GraphQL merge-conflict because
the feature branch was stacked on a base that had not itself merged —
and the manifest was moved to `_queue/done/` regardless. manhattan-v5
*did* merge but with **WI-2 silently dropped** (per-WI brain-skip) and
the reviewer merged the partial without flagging it.

Two compounding defects: (1) `_queue/done/` is treated as success but is
**not** ground truth — it can hold unmerged or partially-merged
initiatives; (2) the reflector fires only on `reviewerOutcome ===
'merged'`, so partial and queue-says-done-but-PR-open cycles silently
skip the learning loop. This is the **single largest gap between forge's
stated goal (unattended → merged) and its as-built behaviour**, and it is
the v2 recurrence of the v1 stacked-PR hazard. Remediations: serialize
feature initiatives behind their base merge OR enforce non-stacked
branches before `gh pr merge`; assert `done/` ⇒ PR `MERGED` (closure
goal G1); flag partial merges instead of approving them.

## Sources

- [`2026-05-16_trafficgame-arc-reflection.md`](../_raw/2026-05-16_trafficgame-arc-reflection.md) — cycle archive: the 12-cycle merge-outcome table.
- [`retro.md`](../../../_logs/2026-05-16_trafficgame-arc-reflection/retro.md) — §1 fidelity, Inconsistency #1, closure goal G1.

## See also

- [[squash-merge-stacked-prs]] — the v1 form of the same hazard.
- [[layered-merge-order]] — the intended branch-flow this violates.
- [[file-based-state-machine]] — why queue state drifted from truth.
