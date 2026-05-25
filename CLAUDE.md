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
- [`docs/phases/`](./docs/phases/) — one doc per phase: purpose, success signals (bench-hook references here are historical — the bench harnesses were removed 2026-05-25)

If a change conflicts with an ADR, **update the ADR first** (with rationale) before changing the code.

## Always do

- Consult the brain before starting work.
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
- Ship a **planner or reflector** skill that doesn't read the brain first. (The dev-loop and reviewer skills correctly do NOT — see the brain-read policy.)
- Add a feature flag, fallback, or "for backwards compatibility" path. v2 has no v1 users to support.
- Squash-merge stacked PRs (we learned this in v1; the lesson lives in the brain after Pass B).

## Build & test

```bash
npm install              # install Claude Agent SDK + minimal deps
npm run build            # compile TypeScript
npm test                 # run scaffold smoke tests
forge --help             # CLI surface
forge brain lint         # structural integrity checks on brain/ (9 checks; exit non-zero on errors)
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
├── orchestrator/       # scheduler, cycle runner, logging (hot path)
├── cli/                # operator utilities + forge subcommand handlers (post-2026-05-24 Move 1)
├── forge-ui/           # Next.js operator UI; launched by `forge watch` (M2-A/B/C; see CWC DOM convention below)
├── _queue/             # initiative queue (gitignored)
├── monitor/            # tmux + Obsidian + log-tail visualisation
├── _logs/              # JSONL event logs (gitignored)
└── projects/           # managed projects (gitignored)
```

## Status of the scaffold

All six phases (brain, architect, project-manager, developer-loop,
review-loop, reflection) are closed and production-running. End-to-end
cycles ship merged PRs against managed projects. The detail of when
each phase closed and the historical iteration arcs live in
[`brain/log.md`](./brain/log.md).

**Note (2026-05-25):** the per-phase + e2e bench harnesses under
`benchmarks/` were removed in this commit. They had grown into a set
of synthetic rubrics and thresholds that were starting to *teach* the
phases toward the bench shape rather than measure real-cycle outcomes
— the opposite of the intent. Phase quality going forward is judged
on real merged cycles (brain themes accumulate the evidence). Benches
will be rebuilt later, anchored on actual past successful cycle
artifacts rather than hand-curated fixtures.

Where to look for as-built detail:

- Code structure: [`ARCHITECTURE.md`](./ARCHITECTURE.md), [`PRINCIPLES.md`](./PRINCIPLES.md), [ADRs](./docs/decisions/).
- Per-phase invocation contracts: `orchestrator/<phase>-invocation.ts` (PM, dev, unifier, reflector).
- Cycle archives: [`brain/_raw/cycles/`](./brain/_raw/cycles/).
- Forge-level patterns: [`brain/forge/themes/`](./brain/forge/themes/).
- Per-project patterns: [`brain/projects/<project>/themes/`](./brain/projects/).
- Operator UI: [`forge-ui/`](./forge-ui/) (launched by `forge watch`).

## graphify

This project has a knowledge graph at `brain/graphify-out/` (canonical
path per C21; `./graphify-out` at the forge root is a symlink to it
per C21a). The graph spans the **whole forge architecture** —
`orchestrator/`, `cli/`, `skills/`, `loops/`, `docs/`, `brain/`.

The graph is a **power-tool, not a mandate** (2026-05-24
rebuild-review): brain-query against markdown themes alone is enough
for most lookups. Reach for the graph when grep is too noisy or you
want a cross-cluster relationship — see
[`skills/brain-graph/SKILL.md`](./skills/brain-graph/SKILL.md) for the
query / path / explain commands.

`GRAPH_REPORT.md` under `brain/graphify-out/` is the broad-architecture
read.

After modifying code, run `cd /home/parso/forge && graphify update .`
to keep the graph current (AST-only, no API cost; the installed
post-commit hook does this in the background — manual invocation only
needed if you skip the hook).

## forge-ui DOM-as-metrics convention

Every load-bearing UI state in `forge-ui/` is mirrored to `data-*`
attributes so any automation (playwright today, LLM-driven UI tests
tomorrow) can drive the page by reading structured DOM state rather
than scraping rendered text. Pattern from
[anthropics/cwc-workshops `how-we-claude-code`](https://github.com/anthropics/cwc-workshops/tree/main/how-we-claude-code).

The root `<main>` carries page-level state:

- `data-conn-state` — `connecting | open | reconnecting | no-bridge`
- `data-live-count`, `data-recent-count` — cycle counts
- `data-active-cycle-id`, `data-active-cycle-status`, `data-active-cycle-events`
- `data-page-ready` — `true` once the bridge connection is open

Section + component anchors:

- `[data-section="cycles-tab"]`, `[data-section="state-machine"]`,
  `[data-section="activity-sidebar"]`, `[data-section="wi-graph"]`,
  `[data-section="event-tail"]`, `[data-section="verdict-form"]`
- Cycle buttons: `[data-cycle-id]`, `[data-cycle-status]`, `[data-cycle-active]`
- State-machine rows: `[data-phase][data-phase-status]`
- Activity rows: `[data-phase][data-phase-events][data-phase-tool-uses]…`
- WI rows: `[data-wi-id][data-wi-deps][data-wi-enables]`
- Event tail rows: `[data-event-id][data-event-phase][data-event-type]`
- Components: `[data-component="verdict-form"][data-form-state]`,
  `[data-component="scheduler-banner"][data-banner-state]`,
  `[data-component="toasts"][data-toast-count]`

When changing component state, **add or update the corresponding
`data-*` attribute** alongside any visual change. The demo script
[`scripts/forge-ui-demo.mjs`](./scripts/forge-ui-demo.mjs) reads these
attributes to wait deterministically (instead of timing-based sleeps)
and to know which state to capture. `npm run forge-ui:demo` produces
chromium-rendered screenshots into `forge-ui/.demo-shots/` plus an
index.html for review without launching a real browser.
