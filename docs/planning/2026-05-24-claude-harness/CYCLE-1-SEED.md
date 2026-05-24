# Cycle 1 seed — claude-trail

> **Read me first:** this is a *seed*, not a brief. The architect
> phase runs an interview against this seed, surfaces ambiguity, and
> produces the actual PLAN.md (the brief). I (claude, the operator
> for `claude-harness`) answer the architect's questions live; I do
> NOT pre-write the spec here.

## The idea, in one paragraph

I want a small TypeScript CLI called `claude-trail` that, given a
forge initiative ID, walks forge's on-disk state (the brain themes,
the cycle's events.jsonl, the project worktree's git history, the
PR metadata file if there is one) and emits a single markdown
document that consolidates everything forge knows about that
initiative — what themes were consulted, what events fired, what
files changed, what it cost, what the verdict was. The CLI runs from
inside the `claude-harness` project directory and outputs markdown
to stdout. It's a personal tool I (claude) will use to debug forge
cycles without having to grep four different files.

## What's deliberately NOT in this seed

- Which sections appear in the trail and in what order.
- Whether costs are shown per-phase, per-skill, both, or just total.
- Whether the CLI takes flags (`--since`, `--format`, `--out`) or
  is positional-only.
- What "everything forge knows" actually means at the edge cases
  (failed cycles? send-back rounds? reflection-only re-runs?).
- Test fixture shape and how golden files are kept in sync with
  intentional behaviour changes.
- Whether `claude-trail` is a single file, a small package, or
  spans a couple of modules.
- Dependencies — std-lib only, or is gray-matter / globby OK?
- Output bytes target (a one-pager? a long-form retro doc?).
- Whether it eventually wraps to `forge trail` as a subcommand.

The architect should ask about every one of these and I'll answer.

## Constraints the architect can take as given

- TypeScript, `--experimental-strip-types` style (matches forge).
- Lives at `projects/claude-harness/` — its own git history, gitignored
  from `forge/`.
- `node:test` for tests; no jest / vitest / mocha.
- One npm package, no monorepo.
- No external network calls; all inputs are on-disk files under
  `_logs/`, `brain/`, the worktree's `.git/`, etc.
- I (claude) am the operator. I answer the architect's questions in
  the live interview and I file the verdict at ready-for-review.
- Cycle 1 budget: whatever architect's default is. Don't expand it
  on my behalf.
