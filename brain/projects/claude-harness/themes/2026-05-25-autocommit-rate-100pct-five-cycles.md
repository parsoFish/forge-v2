---
title: Safety-net autocommit rate reached 100% in cycle 5 — CLAUDE.md fix now critical
description: Cycle 5 (format-flag) has a 100% safety-net rate (2/2 non-boundary commits are forge-autocommits). Combined with cycles 1-4 showing 45%→60%→63.6%→67%, the trend has now reached saturation. The recommended CLAUDE.md fix has been documented for 4 cycles without being applied.
category: antipattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Safety-net autocommit rate — 100% in cycle 5; fix overdue by 4 cycles

## Cross-cycle trend

| Cycle | Safety nets | Total non-boundary commits | Rate |
|-------|-------------|---------------------------|------|
| 1 (scaffold) | 5 | 11 | 45% |
| 2 (cost-only) | 3 | 5 | 60% |
| 3 (git-enrich) | 7 | 11 | 63.6% |
| 4 (since-flag) | 4 | 6 | 67% |
| 5 (format-flag) | 2 | 2 | **100%** |

The rate has increased every cycle without exception and has now reached saturation.

## Cycle 5 pattern

Cycle 5 had only 2 non-boundary commits — both safety-nets:

- `97b238a` — safety-net covering `cli.ts` + `format-flag.test.ts` + `AGENT.md` + `fix_plan.md`
- `466b96b` — safety-net covering only `AGENT.md` + `fix_plan.md`

No semantic self-commit was produced at any point. Even the final submission to reviewer (`e987c6d` boundary) followed immediately after a safety-net, not after a self-commit.

## Positive note

Despite 100% safety-net rate, the feature is correct: 18/18 gate tests pass, 81/81 total tests pass. The autocommit mechanism is preserving forward progress. The problem is not correctness but hygiene and observability.

## Recommended fix (documented since cycle 2, unapplied for 4 cycles)

Add to `CLAUDE.md` in `projects/claude-harness`:

> **After each work item:** once you believe the WI is complete, run the gate command. If it passes, commit immediately: `git commit -m 'feat: <description>'`. Do not wait for all WIs to complete before committing. Commits are checkpoints, not feature-completion declarations.
>
> Example: WI-1 done → gate passes → `git commit -m 'feat: add --format flag'` → submit for review.

This instruction has been recommended in:
- `2026-05-25-autocommit-safety-net-dominance.md` — cycle 1
- `2026-05-25-autocommit-rate-unactioned-flag.md` — cycle 4

**It must be applied before cycle 6.**

## Sources

- `brain/_raw/cycles/INIT-2026-05-25-claude-trail-format-flag.md` — cycle 5 archive (commit table)
- `_logs/INIT-2026-05-25-claude-trail-format-flag/events.jsonl` — cycle 5 event log
- `brain/projects/claude-harness/themes/2026-05-25-autocommit-rate-unactioned-flag.md` — cycle 4 escalation
