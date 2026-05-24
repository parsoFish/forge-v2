---
title: Safety-net autocommit rate worsened to 60% in cycle 2 — WI-2 had zero self-commits
description: Dev-loop self-committed for WI-1 (2 files) but issued zero git commits across all of WI-2 (4 files); safety-net rate rose from 45% in cycle 1 to 60% in cycle 2, and the pattern is WI-scope-selective rather than random.
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

Both cycles: semantic commit rate correlates with WI scope narrowness.

## Recommended fix

The WI spec (or CLAUDE.md) should state: "Commit after EACH WI regardless of whether
further WIs remain. A commit is a checkpoint, not a declaration of feature completeness."
Add an explicit example: "WI-N done → `git commit -m 'feat: ...'` → move to WI-N+1."

## Sources

- `_logs/INIT-2026-05-25-claude-trail-cost-only/events.jsonl` — cycle log
- `brain/_raw/cycles/INIT-2026-05-25-claude-trail-cost-only.md` — cycle archive (commit table)
