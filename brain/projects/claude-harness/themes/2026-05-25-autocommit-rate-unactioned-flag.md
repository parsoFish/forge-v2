---
title: Safety-net autocommit rate worsening continues — recommended fix flagged 3 cycles ago, unimplemented
description: The dev-loop safety-net commit rate has increased every cycle (45% → 60% → 63.6% → 67%). The brain has recommended adding an explicit "commit after each WI" instruction to CLAUDE.md since cycle 2; the instruction has not been added. The antipattern will continue to worsen until the fix is applied.
category: antipattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Safety-net autocommit rate — four-cycle trend, recommended fix unactioned

## Observation

Cross-cycle safety-net (autocommit) rate:

| Cycle | Safety nets | Total non-boundary commits | Rate |
|-------|-------------|---------------------------|------|
| 1 (scaffold) | 5 | 11 | 45% |
| 2 (cost-only) | 3 | 5 | 60% |
| 3 (git-enrich) | 7 | 11 | 63.6% |
| 4 (since-flag) | 4 | 6 | 67% |

The rate has increased every cycle without exception. The trend is linear and worsening.

Cycle 4 commit pattern:
- `fbaf1ec` — semantic self-commit (git.ts helper, 2 files) ✓
- `9797e2d..9060276` — 4 safety nets for main WI (cli.ts + test file + golden) ✗
- `b370931` — semantic self-commit (final clean feature delivery) ✓

The agent self-commits on simple helper work (2 files, single concern) and on its final clean
revision, but not during the messy middle iterations of multi-file WIs.

## Recommended fix (documented since cycle 2, unapplied)

Add to `CLAUDE.md` (in the projects/claude-harness repo):

> **After each work item:** once you believe the WI is complete, run the gate command.
> If it passes, commit immediately: `git commit -m 'feat: ...'`. Do not wait for
> all WIs to be complete before committing. A commit is a checkpoint, not a declaration
> of feature completeness.

Explicit example required: "WI-1 done → commit → WI-2 done → commit → submit for review."

## Why this keeps being skipped

Hypothesis: the dev-loop treats "I have more WIs remaining" as a reason not to commit.
Adding the explicit instruction + example breaks this assumption by framing commits as
checkpoints, not feature-completion markers.

## Escalation

The brain has flagged this in:
- `2026-05-25-autocommit-safety-net-dominance.md` — cycle 1

The fix is a one-line change to `CLAUDE.md`. It has been three cycles. Apply it before cycle 5.

## Sources

- `brain/_raw/cycles/INIT-2026-05-25-claude-trail-since-flag.md` — cycle 4 archive (commit table)
- `_logs/INIT-2026-05-25-claude-trail-since-flag/events.jsonl` — cycle 4 event log
