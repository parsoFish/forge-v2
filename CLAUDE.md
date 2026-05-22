# Forge v2 — Project Instructions for Claude Code

> Idea machine for one human across many side projects. Six phases backed by a brain. Hand-rolling forbidden; battle-tested tools required.

## North star

Forge v2 is **designed to run primarily unattended between human interaction points** (architect, review, reflection). Every decision is judged against three things:

1. Does it preserve unattended operation?
2. Does it use a battle-tested community tool, or are we re-inventing one?
3. Is it the simplest thing that could work?

If the answer to (1) is no, the change must justify why. If (2) reveals a re-invention, find the existing tool. If (3) reveals complexity, cut.

## The brain is the first source of knowledge

**Before** answering a question about how forge works, before designing, before implementing — **query the brain**. The brain is at [`brain/`](./brain/) and is queryable via the `brain-query` skill. If the brain doesn't know, research further AND log the gap so the next ingest pass can fill it.

This rule binds the **planning** phases (architect / project-manager) and the **reflector**. The **dev-loop and reviewer deliberately do NOT read the brain** — the planner already encoded every relevant convention/antipattern into the work items, which are their single source of intent (amended 2026-05-16; see [ADR 010](./docs/decisions/010-brain-first.md) and [`brain/forge/themes/brain-read-policy.md`](./brain/forge/themes/brain-read-policy.md)).

## Architecture, principles, decisions

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — narrative architecture
- [`PRINCIPLES.md`](./PRINCIPLES.md) — the five non-negotiable principles
- [`docs/decisions/`](./docs/decisions/) — ADRs for every load-bearing choice
- [`docs/phases/`](./docs/phases/) — one doc per phase: purpose, success signals, benchmark hook

If a change conflicts with an ADR, **update the ADR first** (with rationale) before changing the code.

## Always do

- Consult the brain before starting work.
- Run the relevant `benchmarks/<phase>/` before claiming improvement on a phase.
- Emit structured events to the JSONL event log on every skill invocation.
- Use markdown artifacts to flow data between phases — every artifact must be greppable.
- Use git worktrees for parallel work units.
- Use conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).
- One concern per PR.

## Ask first

- Major architectural changes (touch an ADR? ask).
- New external dependencies (every dep is a maintenance liability — justify it).
- Cross-project breaking changes.
- Anything that increases the surface area of `orchestrator/` (we explicitly cap this).

## Never do

- Re-invent a job queue, worker pool, resource controller, or process isolator. (See ADRs 011-013 for the line we hold.)
- Spawn agents as Claude CLI subprocesses. Use Claude Code skills via the SDK.
- Write a phase docstring without a benchmark suite that proves "this phase got better."
- Ship a **planner or reflector** skill that doesn't read the brain first. (The dev-loop and reviewer skills correctly do NOT — see the brain-read policy.)
- Add a feature flag, fallback, or "for backwards compatibility" path. v2 has no v1 users to support.
- Squash-merge stacked PRs (we learned this in v1; the lesson lives in the brain after Pass B).

## Build & test

```bash
npm install              # install Claude Agent SDK + minimal deps
npm run build            # compile TypeScript
npm test                 # run scaffold smoke tests
npm run bench:<phase>    # run a phase's benchmark suite
forge --help             # CLI surface
forge brain lint         # structural integrity checks on brain/ (7 checks; exit non-zero on errors)
forge brain index --write  # regenerate brain/INDEX.md from filesystem (counts + sub-wiki listing)
```

## Architecture (post-scaffold)

```
forge/
├── ARCHITECTURE.md     # narrative version of the diagram
├── PRINCIPLES.md       # five user-stated principles
├── docs/               # decisions (ADRs), phase docs, seeding plan
├── brain/              # the wiki (Karpathy three-layer)
├── skills/             # Claude Code skills (the agent surface)
├── loops/              # agentic loop runtimes (default: Ralph)
├── orchestrator/       # scheduler, cycle runner, logging
├── _queue/             # initiative queue (gitignored)
├── benchmarks/         # per-phase eval harnesses
├── monitor/            # tmux + Obsidian + log-tail visualisation
├── _logs/              # JSONL event logs (gitignored)
└── projects/           # managed projects (gitignored)
```

## Status of the scaffold

- ✅ Directory structure + ADRs + phase docs + skill stubs.
- ✅ **Brain phase** — closed. Pass A+B seeding (50 forge-level themes + 5 project sub-wikis with 15 project themes + 37 raw sources). Bench at 17/18 primary (94.4%), 100% Opus-judge agreement on 17 judged cases. Recall-weighted scoring + layered keyword matcher + case-insensitive existence check. See [`brain/log.md`](./brain/log.md) for the full closure entry.
- ✅ **Architect phase** — closed. Bench at **8/8 (100%)** on first run with criterion pass rates at 100% across `manifest_valid / scope / specs / brain_consulted`. Roadmap.md v0 schema locked in [ADR 014](./docs/decisions/014-roadmap-format.md). LLM Council support code, manifest writer, and `forge enqueue --from-manifest` CLI integration all production-ready. Round-trip validated.
- ✅ Ralph runner wired to Claude Agent SDK via [`loops/ralph/claude-agent.ts`](./loops/ralph/claude-agent.ts) (`createClaudeAgent` factory; SDK `query` injectable for tests).
- ✅ **Project-manager phase** — closed. Bench at **5/5 (100%)** after three iteration passes ($6.30 total) with criterion pass rates at 100% across `count / gwt / scope / parallel / coupling / graph`. Work-item format + `_graph.md` mermaid format + `WI-<n>` per-initiative IDs locked in [ADR 015](./docs/decisions/015-work-item-format.md). Shared schema in [`orchestrator/work-item.ts`](./orchestrator/work-item.ts) (parse / validate / serialize / write / `detectHiddenCoupling`). Bench harness (5 fixtures, one per managed project) under [`benchmarks/project-manager/`](./benchmarks/project-manager/) with six weighted criteria (pass threshold 0.7). PM SDK invocation contract shared between bench and live cycle via [`orchestrator/pm-invocation.ts`](./orchestrator/pm-invocation.ts). `cycle.ts:runProjectManager()` wires the SDK end-to-end with full event-log emission. See [`brain/log.md`](./brain/log.md) for the full closure entry.
- ✅ **Developer-loop phase** — closed. Bench at **5/5 (100%)** after two iteration passes ($2.67 total) with criterion pass rates at 100% across `loop_completed / iteration_budget_respected / files_in_scope_respected / cost_budget_respected / no_regression`. p95 iterations = 1 (every fixture solved in a single Ralph iteration). Ralph loop runner ([`loops/ralph/runner.ts`](./loops/ralph/runner.ts)) accepts injectable `qualityGate` and `agent`; SDK adapter ([`loops/ralph/claude-agent.ts`](./loops/ralph/claude-agent.ts)) supports `disallowedTools` / `systemPrompt`. Shared invocation contract in [`orchestrator/dev-invocation.ts`](./orchestrator/dev-invocation.ts) (`buildDevSystemPrompt`, `prepareDevWorkspace`, `tallyToolUse`). `cycle.ts:runDeveloperLoop()` walks WIs in topological order, skips dependents of failed prerequisites, emits `ralph.start` / `ralph.end` per WI plus a phase-level summary. Bench under [`benchmarks/developer-loop/`](./benchmarks/developer-loop/) with five multi-language fixtures (Python/pytest, TS/node:test, bash/bats, doc/grep) and a five-criteria rubric (`loop_completed` 0.35, `iteration_budget_respected` 0.20, `files_in_scope_respected` 0.20, `cost_budget_respected` 0.15, `no_regression` 0.10; pass threshold 0.7). Per-fixture budgets aligned with phase-doc target: 3 iterations / $0.50 (healarr at 2 / $0.30). See [`brain/log.md`](./brain/log.md) for the full closure entry.
- ✅ **Review-loop phase (stages 1+2 unified as Ralph)** — closed end-to-end. Per-phase bench at **5/5 (100%)** ($2.55/run after refactor); e2e bench at **1/1 (100%)** ($1.18/run, score 1.0, merged on round 1). Stage 1 + stage 2 collapse into a single review-Ralph runner on the initiative branch — same `loops/ralph/runner.ts` infrastructure as the dev-loop, parameterised by reviewer system prompt + verdict-aware quality gate (`makeReviewerQualityGate` in [`orchestrator/reviewer-stage2.ts`](./orchestrator/reviewer-stage2.ts)). Iteration 1 prepares the demo + PR draft; iterations 2+ react to send-back feedback in `fix_plan.md` (Ralph-style state, NOT WI-spec changes). Cap 3 iterations (1 prep + ≤2 send-back rounds); **no per-iteration $/turn budget guard** (removed 2026-05-18). Verdict-provider is injectable (`GetVerdict`) — production: **file-based** (`makeFileVerdict`; the operator writes `_queue/in-flight/<id>.verdict-response.md` via the `forge review <id>` CLI / `/forge-review`), bench: simulator. Ralph runner widened to support async `qualityGate`. SKILL.md ([`skills/reviewer/SKILL.md`](./skills/reviewer/SKILL.md)) rewritten as Ralph-loop reviewer.
- ✅ **End-to-end integration bench** — landed and expanded to full initiative scope. [`benchmarks/e2e/`](./benchmarks/e2e/) drives the full autonomous-loop cycle (PM → developer-loop → review-Ralph → merge) against a sample initiative with a **human-simulator agent** providing verdicts at each review round. Fixture (`slugifier-basic`, TS lib) declares **3 features → 6 work items** with realistic dependency graph (FEAT-1 core → FEAT-2 batch helpers + FEAT-3 options as parallel branches), exercising the architect/PM contract's full multi-feature shape. Pass 7 result: **1/1 score 1.0**, $2.35, 2 rounds (1 send-back + approve), all 10 spec checks + 5 PR signals satisfied. Gate `cycle_completed` + 5 weighted criteria (`merged` 0.40, `converged_within_budget` 0.25, `spec_satisfied` 0.20, `cost_within_budget` 0.10, `no_regression` 0.05; pass threshold 0.7). Smart `gh` shim handles `pr create` + `pr merge` locally (writes `_pr-metadata.json`, **commits pending work then fast-forwards** initiative branch into main — the prior `git reset --hard` was wiping the reviewer's uncommitted send-back fixes); recorder shims (`vhs`, `npx playwright`) extracted to [`benchmarks/_lib/recorder-shims.ts`](./benchmarks/_lib/recorder-shims.ts) and shared with the per-phase review-loop bench. Round count read from durable JSONL event log (the gh-shim's post-merge `git clean` strips gitignored AGENT.md). Bench rounds = simulator verdicts (not gate invocations — bailouts shouldn't count). Cycle's `runDeveloperLoop` only throws on **total** dev-loop failure (0/N completed); partial output flows to the reviewer's send-back loop. Initial closure: 7 iteration passes (~$10.57). Multi-feature expansion: 7 more passes (~$17), trajectory exposed: smoke test must fail until WI-1 lands (otherwise dev-loop trivially exits on iter 0), gh shim must commit-not-reset, telemetry must survive merge. See [`brain/log.md`](./brain/log.md) for the full closure entries. **Future expansion**: more fixtures (Python/bash/web), per-WI `quality_gate_cmd` in WI schema (eliminates trivially-completes phenomenon), production CLI (`forge review <id>`), architect-bench-output → e2e-fixture-manifest piping.
- ✅ **Reflection phase** — closed. Bench at **5/5 (100%)** on first run with criterion pass rates at 100% across all 6 weighted criteria + 5 gates. Total spend $3.68/run; p95 cost $1.04, p95 elapsed 442s. The reflector consumes the merged initiative's manifest + JSONL event log + brain-gaps + merged tree, runs a four-stage retro (self-reflection → file-based user-question handoff → file-based user-feedback handoff → direct brain writes), and emits theme files under `brain/projects/<project>/themes/` plus a cycle archive under `brain/_raw/cycles/<cycle-id>.md`. Shared invocation contract in [`orchestrator/reflector-invocation.ts`](./orchestrator/reflector-invocation.ts). `cycle.ts:runReflector()` fires after a successful merge with **log-and-continue** failure mode — surfaced as `CycleResult.reflection_status: 'closed' | 'failed' | 'skipped'` (does not change `status`). Bench fixtures under [`benchmarks/reflection/fixtures/`](./benchmarks/reflection/fixtures/) span project diversity (TS / bash / Python) and exercise distinct rubric paths (real merged cycle, multi-send-back, dev-loop wedge + recovery, brain-gap-heavy, minimal clean). Stage 2 + 3 use **file-based handoff** (`user-questions.md` written by agent / `user-feedback.md` pre-populated by simulator or human). Brain isolation in the bench: theme writes land in a layered tempdir with the target project's `themes/` and `brain/_raw/cycles/` masked as fresh writable dirs while everything else read-throughs to the live brain. See [`brain/log.md`](./brain/log.md) for the full closure entry.
- ✅ **Operator-review reliability pass (2026-05-18)** — surfaced driving real trafficGame arcs as the operator. Landed on `main`: `alignLocalToRemote` brings the **project working tree** forward (guarded `merge --ff-only`, stash-preserving uncommitted operator state — was a bare ref move that stranded the tree); `node_modules` symlink can no longer be committed (worktree git-exclude + boundary reset + `.gitignore`); reviewer per-iteration $/turn budget guards **removed**; `demo-runtime` prefers built `preview`; `embedDemoInPr` makes the PR the **self-contained review window** (visibility-aware — private repos get a relative-link `DEMO.md`, public inline raw); preflight gains an advisory **BRAIN** freshness clause + classifier gains `pm-thrash-no-converge` (capped+degenerate ⇒ not auto-retried). Patterns/themes: [`brain/forge/themes/pr-as-sole-review-window.md`](./brain/forge/themes/pr-as-sole-review-window.md), [`brain/projects/trafficGame/themes/2026-05-10-campaign-mode-state.md`](./brain/projects/trafficGame/themes/2026-05-10-campaign-mode-state.md) (kept current). As-built detail: [`docs/architecture/as-built-snapshot-2026-05-17.md`](./docs/architecture/as-built-snapshot-2026-05-17.md) (2026-05-18 update).
