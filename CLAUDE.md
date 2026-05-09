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

This rule is mandatory for every skill, every agent invocation, every cycle. It is enforced by `SKILL.md` instructions in [`skills/`](./skills/).

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
- Ship a skill that doesn't call `brain-query` first.
- Add a feature flag, fallback, or "for backwards compatibility" path. v2 has no v1 users to support.
- Squash-merge stacked PRs (we learned this in v1; the lesson lives in the brain after Pass B).

## Build & test

```bash
npm install              # install Claude Agent SDK + minimal deps
npm run build            # compile TypeScript
npm test                 # run scaffold smoke tests
npm run bench:<phase>    # run a phase's benchmark suite
forge --help             # CLI surface
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
- ⏳ Developer-loop, reviewer, reflector skills past their `SKILL.md` prompt + bench fixtures for each.
