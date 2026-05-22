---
title: Branch model consolidated to single main (repo CLAUDE.md superseded)
description: main IS the fork now; the repo's documented two-branch upstream-merge workflow no longer applies.
category: decision
keywords: [branch, main, betterado, fork, upstream, consolidation, onboarding]
created_at: 2026-05-18T10:43:08Z
updated_at: 2026-05-18T10:43:08Z
related_themes: [2026-05-18-stack-and-test-layout]
---

# Branch model consolidated to a single `main`

At onboarding (2026-05-18) the repo shipped a deliberate **two-branch
model**: `main` tracked pristine upstream `microsoft/terraform-provider-
azuredevops`, and a `betterado` branch held *all* fork work, synced via
`git merge upstream/main` → `betterado`. The repo's own `CLAUDE.md` still
documents this.

Forge's project model is single-branch (one working tree per project; the
cycle operates on `main` + per-initiative branches). So onboarding
consolidated: `main` was a strict ancestor of `betterado` (0 ahead, 4
behind), so `main` was **fast-forwarded** onto `betterado`'s tip — no merge
commit, no history rewrite, zero data loss — then pushed, and `betterado`
deleted local + remote. `main` now IS the fork at `0822657`.

**Consequence for planners/architects:** the `CLAUDE.md` "Fork Workflow"
section (main = upstream, betterado = work, `upstream` remote merges) is
**stale and must not be trusted**. Upstream syncs, if ever wanted, now need
a different mechanism — an `upstream` remote merged directly into `main`,
which will hit the known ~450-file `microsoft/`→`parsoFish/` rename + the
`betterado_` prefix conflicts. Treat upstream-sync as out of scope unless
an initiative explicitly asks for it.

## Sources

- [`_raw/projects/terraform-provider-betterado/2026-05-18-onboarding.repo.md`](../../../_raw/projects/terraform-provider-betterado/2026-05-18-onboarding.repo.md) — onboarding actions, the 4 fork commits, and why the fast-forward was lossless.

## Related

- [Theme: stack-and-test-layout](./2026-05-18-stack-and-test-layout.md)
