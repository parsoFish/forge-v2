---
title: Dual boundary snapshot pattern signals two-pass delivery — first pass messy, second clean
description: Cycles 3 and 4 both show two pre-review boundary snapshots; in both cases the first pass produced multiple safety-net commits and an unfinished feature, and the second pass produced a single clean semantic commit. The dual-boundary fingerprint is now a detectable delivery pattern.
category: pattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Dual boundary snapshot — two-pass delivery fingerprint

## Observation

Cycle 4 (since-flag) git log:

```
9797e2d  safety-net WI iter 1
cde0b52  safety-net WI iter 2
5b7233c  safety-net WI iter 5
9060276  safety-net WI iter 4 (golden fixture)
423a6d4  chore(developer-loop): pre-review boundary snapshot  ← first boundary
fbaf1ec  feat(git): add getCommits(jsonPath)                  ← note: before boundary
b370931  feat: add --since flag to claude-trail CLI           ← clean semantic
bffb87f  chore(developer-loop): pre-review boundary snapshot  ← second boundary
```

Wait — `fbaf1ec` is before `423a6d4` in the log (older). The sequence in time was:
1. `fbaf1ec` — clean git helper (self-committed)
2. `9797e2d`..`9060276` — 4 safety nets for main WI
3. `423a6d4` — first boundary (submitted to reviewer, rejected or requeued to dev-loop)
4. `b370931` — clean semantic commit for the complete feature
5. `bffb87f` — second boundary (submitted and accepted)

Cycle 3 (git-enrich) had the same pattern: `aad2de0` was an intermediate boundary snapshot,
followed by a second pass that produced `fbaf1ec` as the git helper and eventually the clean
ship.

## What this means

The dual-boundary pattern indicates:
1. **First pass**: agent produces messy work (safety nets dominate, feature incomplete or partially wired)
2. **Reviewer/self-assessment gate**: first submission fails review or the agent detects a gap
3. **Second pass**: agent revisits from the current state of the repo, produces a clean semantic commit

The final shipped commit (`b370931`) in cycle 4 has a well-structured message, covers the full
feature cleanly, and references the acceptance criteria. The second pass appears to benefit from
the messy first-pass work already in the tree — it can "clean up" rather than start from scratch.

## Diagnostic value

When reviewing a merged cycle, count pre-review boundary snapshots:
- **1 boundary**: normal single-pass delivery
- **2 boundaries**: two-pass delivery — first pass was likely messy; final result may still be clean
- **3+ boundaries**: possible wedge or oscillation (check wedge-loop themes)

The dual-boundary itself is not a failure — cycle 4 shipped cleanly. But it indicates the dev-loop
iterated more than planned, likely consuming extra iteration budget.

## Sources

- `brain/_raw/cycles/INIT-2026-05-25-claude-trail-since-flag.md` — cycle 4 archive (commit table)
- `_logs/INIT-2026-05-25-claude-trail-since-flag/events.jsonl` — cycle 4 event log
