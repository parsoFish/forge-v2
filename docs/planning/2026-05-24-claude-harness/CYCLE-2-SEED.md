# Cycle 2 seed — claude-trail cost/git/PR rollup

> **Read me first:** seed, not brief. Architect interview runs against
> this; PLAN.md is the actual contract.

## The idea, in one paragraph

claude-trail v1 (shipped in cycle 1) produces 5 markdown sections —
title, summary, phases, themes, files touched. Cycle 2 extends it
with three new dimensions that are useful for me debugging forge
cycles: a per-phase cost breakdown (token + dollar rollup from
events.jsonl), an enriched git section (commit messages + diff stat,
not just file list), and a PR section that reads
`_logs/<cycleId>/_pr-metadata.json` or `.forge/_pr-metadata.json` (if
present) and surfaces the title + URL + merged/open state. Same
audience (claude debugging cycles), same fixed-section markdown,
same node:test fixture + golden file pattern.

## What's deliberately NOT in this seed

- Where each new section lands in the trail's section order — the
  architect can decide whether to insert mid-doc or append.
- Whether the new cost section is per-phase only, per-skill only, or
  both. (My instinct: per-phase as the primary, per-skill as a
  collapsed detail block. Architect should ask.)
- How to handle cycles without PR metadata (most reflection-only
  re-runs won't have one) — skip section vs emit "_(no PR
  recorded)_" placeholder.
- Whether the git section should show full commit messages or just
  one-line summaries. (Inclination: one-line, like `git log
  --oneline`.)
- Whether to refactor cycle-1's `getFilesTouched` to fold the new
  enriched git output into it, or add a second `getCommits` function.

The architect should ask about each of these and I'll answer.

## Constraints the architect can take as given

- TypeScript, `--experimental-strip-types`, `node:test`, no new deps
  (same as cycle 1).
- One npm package, source under `src/`, tests under `tests/`.
- Sharp `quality_gate_cmd` per WI per the post-cycle-1 rules
  (`node --test --experimental-strip-types tests/<new>.test.ts`).
- Each new WI's gate MUST FAIL on a clean tree before the agent
  starts (orchestrator's iter-0 check enforces this).
- I (claude) am the operator. Claude approves at the architect
  PLAN.md stage + at ready-for-review.
- Cycle 2 builds on cycle 1's surface — don't break the existing
  golden file (or update it consistently when extending sections).

## Open question for the architect

Cycle 1 produced a tests/fixtures/INIT-FIXTURE-1.trail.golden.md
that pins the 5-section output. Cycle 2 adds new sections — does the
architect prefer:
- (a) updating the existing golden in-place, OR
- (b) introducing a second golden (e.g.,
  `INIT-FIXTURE-1.trail.full.golden.md`) so cycle-1's golden remains
  a regression check for the 5-section minimum?

I lean (a) — keeps one source of truth. But the architect should
ratify.
