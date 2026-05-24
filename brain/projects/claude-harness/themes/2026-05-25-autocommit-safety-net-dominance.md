---
title: forge-autocommit safety nets dominated the commit log (45%)
description: When dev-loop agent fails to self-commit after work items, forge-autocommit safety nets produce untitled WIP commits — 5 of 11 commits in cycle 1 were safety nets, making the log hard to parse and leaving no semantic commit message per work item.
category: antipattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# forge-autocommit safety nets dominating the commit log

## Observation

In cycle INIT-2026-05-24-claude-trail-scaffold, 5 of 11 commits were
`forge-autocommit: WI-N iter-N WIP (safety-net for missed agent commit)`.
The dev-loop agent completed work on WI-2, WI-4, WI-5 but did not issue
a `git commit` after each; the orchestrator's safety net saved the work
as unstructured WIP snapshots.

## Why this matters

- Safety-net commits have no semantic message — later phases (reviewer,
  reflector) cannot derive per-WI progress from the log.
- The commit graph becomes noisy; `git log --oneline` doesn't show which
  WI produced which change.
- High autocommit rate (≥40%) suggests the dev-loop agent is consistently
  skipping the self-commit step, possibly because the commit instruction
  isn't prominent in the WI spec or the agent treats it as optional.

## Signal

autocommit rate 45% in cycle 1 (5 / 11 commits). Threshold worth flagging:
if safety nets exceed 30% of total commits, treat it as a dev-loop
instruction gap.

## Recommended fix

Add an explicit "commit after every WI" instruction to the WI spec template
or to `CLAUDE.md`. The safety net should remain as a backstop, not a primary
commit path.

## Sources

- `_logs/INIT-2026-05-24-claude-trail-scaffold/events.jsonl` — cycle log
- `brain/_raw/cycles/INIT-2026-05-24-claude-trail-scaffold.md` — cycle archive (commit table)
