---
project: claude-harness
title: claude-harness project profile
purpose: forge dogfood + harness; claude operates autonomously
operator: claude
language: typescript
created_at: '2026-05-24'
---

# claude-harness

The harness project claude (me) owns and operates autonomously inside
forge. Lives at `projects/claude-harness/` with its own git history,
gitignored from forge per the standard `projects/*` rule.

## Why this project exists

So the operator's real projects (trafficGame,
terraform-provider-betterado, …) stay clean while forge cycles get
exercised on realistic-but-binary work. Claude writes seeds, runs
architect interviews, files verdicts, and validates output against
its own intent. See
[`docs/planning/2026-05-24-claude-harness/PROPOSAL.md`](../../../docs/planning/2026-05-24-claude-harness/PROPOSAL.md).

## Current product

`claude-trail` — a TypeScript CLI that consolidates everything forge
knows about a single initiative into one markdown trail doc. The
seed is at
[`docs/planning/2026-05-24-claude-harness/CYCLE-1-SEED.md`](../../../docs/planning/2026-05-24-claude-harness/CYCLE-1-SEED.md);
the actual brief is whatever PLAN.md the architect produces.

## Constraints the architect should take as given

- **Language:** TypeScript, `--experimental-strip-types` style.
  Matches the forge orchestrator. No build step beyond `tsc`.
- **Test framework:** `node:test`. No jest / vitest / mocha.
- **Package shape:** one npm package, no monorepo.
- **External I/O:** none. All inputs are on-disk files under
  `_logs/`, `brain/`, the worktree's `.git/`, etc. No network calls.
- **Operator:** claude. Claude answers the architect's interview
  questions in real time and files the verdict at ready-for-review.
- **Project repo:** standalone (gitignored from forge), no GitHub
  remote yet — the merge model is local fast-forward via the gh
  shim (same as the e2e bench).

## Taste signals

- Prefer std-lib over deps. `gray-matter` is fine for frontmatter if
  the architect deems it useful; otherwise stick to readFileSync +
  regex.
- Markdown output should be greppable (section headings stable, IDs
  inline).
- Tests use frozen fixtures committed to the repo — no test pollution
  across runs.

## Anti-patterns

- Anything that calls the network at runtime.
- Anything that requires a build step beyond the std `tsc` /
  `--experimental-strip-types` path.
- Re-inventing forge's existing tools (events parser, manifest
  parser); if claude-trail wants those, it imports them from forge
  rather than re-deriving.
