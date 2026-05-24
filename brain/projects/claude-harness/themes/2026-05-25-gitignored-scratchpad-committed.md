---
title: Gitignored scratchpad files committed into branch by dev-loop
description: Cycle 5 dev-loop committed AGENT.md and fix_plan.md — both listed in .gitignore — into the cycle branch. These are unifier-memory scratchpads that must never appear in PR history. The dev-loop used an explicit add (bypassing gitignore) rather than relying on normal tracking.
category: antipattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Gitignored scratchpad files committed into branch

## Observation

`projects/claude-harness/.gitignore` contains:

```
AGENT.md
fix_plan.md
```

Yet both files appear in the cycle-5 commit history:

- `97b238a` — `forge-autocommit: WI-1 iter 1 WIP` — touched `AGENT.md`, `fix_plan.md`, `src/cli.ts`, `tests/format-flag.test.ts` (4 files)
- `466b96b` — `forge-autocommit: iter 1 WIP` — touched only `AGENT.md`, `fix_plan.md` (2 files)

`AGENT.md` is the unifier-Ralph memory file (reads "Unifier Agent Memory — INIT-…"); `fix_plan.md` holds initiative-level AC checklists. Both are cycle-scoped scratch and must not pollute the PR diff or the project's permanent history.

## How it happened

`git add -f` or `git add --force` bypasses `.gitignore`. The forge autocommit safety net likely runs `git add -A` or `git add .` — which RESPECTS `.gitignore` — so this was a deliberate dev-loop action, not the autocommitter.

The agent appears to have run `git add AGENT.md fix_plan.md` (or `-A` with the files already staged/untracked-forcibly) before the autocommit triggered.

## Impact

- PR diff includes scratchpad content unrelated to the feature.
- `fix_plan.md` with unchecked AC boxes (`[ ]`) appears in the merged history — visually signals incomplete work even when it isn't.
- Unifier memory is now permanently recorded, leaking agent reasoning into the project history.

## Fix

Two complementary approaches:

1. **CLAUDE.md instruction**: "Never `git add` AGENT.md or fix_plan.md. These are gitignored scratchpad files. If git status shows them staged, unstage with `git restore --staged AGENT.md fix_plan.md`."
2. **Pre-commit hook** in `projects/claude-harness`: reject commits that include gitignored files by name.

## Sources

- `_logs/INIT-2026-05-25-claude-trail-format-flag/events.jsonl` — sparse log confirming cycle identity
- `brain/_raw/cycles/INIT-2026-05-25-claude-trail-format-flag.md` — cycle 5 archive (commit table showing AGENT.md + fix_plan.md in staged diff)
