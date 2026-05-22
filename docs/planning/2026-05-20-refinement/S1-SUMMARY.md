---
doc: stage-summary
stage: S1
status: landed
date: 2026-05-23
substages: [S1.1, S1.2, S1.3, S1.4]
parent_plan: EXECUTION-PLAN.md
---

# S1 Foundations — landed

Four parallelisable substages, all merged to `main` 2026-05-23.

## Substages

### S1.1 — Init-IDs (plan 07b) ✓

Dual-handle scheme: `<proj4>#<seq>` (e.g. `traf#7`) alongside canonical `INIT-…`.

- **Branch:** `s1.1-init-ids` (4 commits, merged)
- **New code:** `orchestrator/initiative-id.ts` (~360 LOC), `scripts/backfill-aliases.ts`
- **Tests:** 16 new (init-id) + 2 (backfill); full suite passing
- **Concurrency:** `proper-lockfile@^4.1.2` ensures atomic mints
- **Decisions:** [`S1.1-DECISIONS.md`](../../S1.1-DECISIONS.md) (11 numbered judgement calls)
- **Operator-pending:** none (the `.claude/` argument-hint blocker was unblocked on merge and committed in `237d886`).

### S1.2 — Brain hygiene 01a (plan 01 #1-#5) ✓

`forge brain lint` executable with 7 checks; `forge brain index --write` regenerator; 128 contamination dirs scrubbed.

- **Branch:** `s1.2-brain-hygiene` (7 commits, merged)
- **New code:** `orchestrator/brain-lint.ts` + 7 checks, `orchestrator/brain-index.ts` regenerator, `scripts/brain-scrub-test-contamination.ts`
- **Tests:** 23 brain-lint, 10 brain-index, 4 scrubber, 1 boundary regression
- **Root cause found:** `restoreLiveBrain`'s `rmSync(recursive: false)` silently raised EISDIR on empty dirs — fixed + boundary test added
- **Lint counts:** before 193 errors (incl. 128 contamination) → after 65 errors (54 broken `_logs/`/`projects/` links + 6 Tier-B frontmatter + 5 length errors, all pre-existing)
- **Decisions:** [`S1.2-DECISIONS.md`](../../S1.2-DECISIONS.md)
- **Operator-pending:**
  - [`S1.2-TIER-B-PROPOSALS.md`](../../S1.2-TIER-B-PROPOSALS.md) — 6 frontmatter category violations held for manual ratification (per `feedback_destructive_instruction_preserve_intent`). Sed-ready apply commands included.
  - `npm run bench:brain` — not run during stage (cost). Per plan 01 §"Cleanup playbook" #4, structural changes should not move the score; running on wake is the AC7 confirmation.

### S1.3 — `assertLocalRemoteSynced` at dev-loop close ✓

Small targeted bug-fix: dev-loop close now asserts local↔remote sync and emits a classified divergence event.

- **Branch:** `s1.3-assert-sync` (1 commit, merged)
- **New code:** ~80 LOC in `orchestrator/phases/developer-loop.ts` (helper `assertDevLoopCloseSync`)
- **Tests:** 3 (divergence-throws + unpushed-commit-throws + clean-passes-silently)
- **Event shape:** `event_type: 'error'` with `message: 'dev-loop.branch-divergence'` on fail, `'log'` with `'dev-loop.branch-sync-ok'` on pass
- **Preserve-intent:** existing `cycle.ts:enforceDevLoopCloseInvariant` kept intact — new call is additional, phase-scoped, fires before the cycle-level check
- **Decisions:** [`S1.3-DECISIONS.md`](../../S1.3-DECISIONS.md)
- **Operator-pending:** none.

### S1.4 — Graphify additive brain layer (plan 01 #8-#10) ✓

`brain/graph.json` as the canonical structural index alongside the existing markdown wiki; brain-query consults graph-first.

- **Branch:** `s1.4-graphify` (3 commits, merged)
- **New code:** `orchestrator/brain-graph.ts` (deterministic graph builder + queries), `skills/brain-graph/SKILL.md` (hand-authored, 4 ops)
- **Tests:** 5 brain-graph unit tests
- **Graph:** 168 nodes, 627 edges. Built deterministically from frontmatter `related_themes` + Obsidian `[[wikilinks]]` + `## Sources` citations. Render artefacts (`brain/graph.html`, `GRAPH_REPORT.md`) gitignored.
- **Karpathy gist re-ingested** as canonical at `brain/_raw/web/karpathy-llm-wiki.md`; synthesis archived to `brain/_archive/2026-05-23/` per preserve-intent.
- **Brain bench:** grew 18 → 21 questions (3 new structural: Q19 bridges, Q20 neighbours, Q21 connected antipatterns). Existing 18 keyword questions unchanged.
- **Decisions:** [`S1.4-DECISIONS.md`](../../S1.4-DECISIONS.md)
- **Operator-pending:**
  - `npm run bench:brain` — not run during stage (operator OAuth token doesn't authenticate direct Anthropic API). On wake: target ≥ 94.4% on the full 21.
  - **Plan 01 was wrong about the graphify repo** — fixed in `237d886`: canonical is [`rhanka/graphify`](https://github.com/rhanka/graphify) (npm `graphifyy`), NOT `safishamsi/graphify`. Plan 01 + LEARNINGS-trafficgame links updated.
  - `.claude/skills/graphify-disabled/` blocked by sandbox; placeholder at `skills/graphify-disabled/README.md`. Operator can rename on wake.
  - The deterministic walker emits in the `graphifyy` schema (`GraphNode` + `GraphEdge`). An operator with `ANTHROPIC_API_KEY` set can run `npx graphify update brain/ --backend anthropic --all` to overlay LLM-derived semantic edges at the same path — schema compatible, no consumer changes needed.

## Verification

After all 4 merges + the S1.1 follow-up:

- `npx tsc --noEmit` — **clean**
- `npm test` — **569/569** (547 from merged branches + 22 from operator wip restoration of daemon/pr-verdict tests)
- Conflicts resolved cleanly on merge: `package.json` (3 deps), `package-lock.json` (regenerated), `orchestrator/cli.ts` (3 subcommand-handler additions coexist), `brain/log.md` (sequential entries), `brain/INDEX.md` (regenerated truth kept)

## What's on `main` now

- **Commits since S0 (`d61e258`):**
  - `1a3645d` — iteration-2 contracts (C20-C28, trafficGame learnings doc, plan 08)
  - `4161de1` — merge S1.3
  - `08b7a34` (via merge of s1.1-init-ids) — S1.1 init-IDs
  - `707db3c` (via merge of s1.2-brain-hygiene) — S1.2 brain hygiene
  - `00ffd87` — merge S1.4 graphify (with conflict resolutions)
  - `237d886` — S1.1 + plan-01 follow-up (slash-command argument-hints + graphify repo ref)
- **Operator WIP restored** (pre-S1 uncommitted work — daemon infra, pr-verdict, scheduler tweaks): present in working tree, not committed. Operator continues this on wake.

## Open operator items on wake

1. Run `npm run bench:brain` — confirm ≥ 94.4% on the new 21-question set.
2. Review `S1.2-TIER-B-PROPOSALS.md` and apply the 6 frontmatter remappings (sed-ready commands inside).
3. Optionally: run `npx graphify update brain/ --backend anthropic --all` (with `ANTHROPIC_API_KEY` set) to upgrade the deterministic graph to LLM-derived semantic edges.
4. Pending operator WIP (daemon infrastructure for `forge start/stop/pause/resume`) is restored uncommitted in the working tree — continue that work or commit it as you see fit.

## Next stage

S2 (architect — split A then B). After S1's `forge brain graph` is live, S2's architect can consume the graph for richer brain-context queries.
