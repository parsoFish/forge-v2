---
title: Safety-net autocommit rate worsening across cycles — 45% → 60% → 63.6%
description: Dev-loop safety-net rate has increased across every claude-harness cycle; in cycle 3 WI-2 had zero self-commits (5 safety nets) while WI-1 self-committed cleanly, confirming the antipattern is WI-position-selective and worsening, not random.
category: antipattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Safety-net autocommit rate worsening — multi-file WI triggers commit skip

## Observation

Cycle 2 (INIT-2026-05-25-claude-trail-cost-only): 5 commits in the cycle.

| commit | type | WI | files touched |
|--------|------|----|--------------|
| `d1ef30f` | `feat:` semantic | WI-1 | 2 (events.ts + events-cost.test.ts) |
| `c9a7fbf` | autocommit safety-net | WI-2 | multi |
| `50f5a90` | autocommit safety-net | WI-2 | multi |
| `5e4338a` | autocommit safety-net | WI-2 | multi |
| `aad2de0` | boundary snapshot | — | — |

Safety-net rate: **3/5 = 60%** (up from cycle 1's 45%).

The split is not random. WI-1 = 2 files, single concern → agent self-committed.
WI-2 = 4 files (trail.ts + cli.ts + golden + trail-cost.test.ts) → agent never committed.

## Hypothesis

The dev-loop agent's self-commit behaviour is coupled to WI simplicity: when a WI
touches a single module and its test file, the agent naturally concludes the work and
commits. When a WI spans multiple files with cross-cutting concerns (rendering, wiring,
fixture update, test), the agent moves to the next iteration without committing — possibly
treating "I still have more to do" as precluding a commit, even after the WI is complete.

## Cross-cycle signal

- Cycle 1: 5/11 safety-nets (45%) — WIs 2, 4, 5 each had safety-nets
- Cycle 2: 3/5 safety-nets (60%) — WI-2 (4-file) entirely safety-net
- Cycle 3: 7/11 safety-nets (63.6%) — WI-1 self-committed; WI-2 had zero self-commits across 5 iterations

All three cycles: semantic commit rate correlates with WI position (first WI commits; subsequent WIs don't). Trend is worsening, not stabilising.

## Recommended fix

The WI spec (or CLAUDE.md) should state: "Commit after EACH WI regardless of whether
further WIs remain. A commit is a checkpoint, not a declaration of feature completeness."
Add an explicit example: "WI-N done → `git commit -m 'feat: ...'` → move to WI-N+1."

## Sources

- `_logs/INIT-2026-05-25-claude-trail-cost-only/events.jsonl` — cycle 2 log
- `brain/_raw/cycles/INIT-2026-05-25-claude-trail-cost-only.md` — cycle 2 archive (commit table)
- `_logs/INIT-2026-05-25-claude-trail-git-enrich/events.jsonl` — cycle 3 log
- `brain/_raw/cycles/INIT-2026-05-25-claude-trail-git-enrich.md` — cycle 3 archive
