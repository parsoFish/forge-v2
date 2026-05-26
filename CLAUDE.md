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

This rule binds the **planning** phases (architect / project-manager) and the **reflector**. The **dev-loop and reviewer deliberately do NOT read the brain** — the planner already encoded every relevant convention/antipattern into the work items, which are their single source of intent (amended 2026-05-16; see [ADR 010](./docs/decisions/010-brain-first.md) and [`brain/cycles/themes/brain-read-policy.md`](./brain/cycles/themes/brain-read-policy.md)).

## Architecture, principles, decisions

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — narrative architecture
- [`PRINCIPLES.md`](./PRINCIPLES.md) — the five non-negotiable principles
- [`docs/decisions/`](./docs/decisions/) — ADRs for every load-bearing choice
- [`docs/phases/`](./docs/phases/) — one doc per phase: purpose, success signals (bench-hook references here are historical — the bench harnesses were removed 2026-05-25)

If a change conflicts with an ADR, **update the ADR first** (with rationale) before changing the code.

## Always do

- Emit structured events to the JSONL event log on every skill invocation.
- Use markdown artifacts to flow data between phases — every artifact must be greppable.
- Use git worktrees for parallel work units.
- Use conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).
- One concern per PR.

(Brain-querying is mandatory for **planners only** — architect / PM /
reflector. See the brain-first section above + the Never-do bullet
below. The dev-loop and reviewer correctly do NOT read the brain.)

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

Three knowledge graphs after the Tier 4 brain restructure (2026-05-26):
- **Brain 1 (forge-dev):** `brain/forge-dev/graphify-out/` — forge TypeScript source + ADRs.
- **Brain 2 (cycles):** `brain/cycles/graphify-out/` — cycle-derived themes + raw archives.
- **Brain 3 (per-project):** `<project-repo>/brain/graphify-out/` — project-specific knowledge.

Legacy `brain/graphify-out/` (and the `./graphify-out` symlink) remain until Brain 1 + 2 graphs
are confirmed healthy. The wrapper script `bash scripts/brain-graphify-all.sh` rebuilds Brain 1 + 2;
use `--all` flag to also rebuild all managed project brains.

The graphs are a **power-tool, not a mandate** (2026-05-24 rebuild-review): brain-query against
markdown themes alone is enough for most lookups. Reach for a graph when grep is too noisy or you
want a cross-cluster relationship — see
[`skills/brain-graph/SKILL.md`](./skills/brain-graph/SKILL.md) for the query / path / explain commands.

After modifying code, run `cd /home/parso/forge && graphify update .`
to keep the legacy graph current (AST-only, no API cost; the installed
post-commit hook does this in the background — manual invocation only
needed if you skip the hook). Run `bash scripts/brain-graphify-all.sh`
to rebuild the two new targeted graphs.

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

Section + component anchors (post-2026-05-25 cascade-tree layout —
the old state-machine + activity-sidebar + standalone wi-graph
sections were merged into a single hex pipeline):

- `[data-section="cycles-tab"]` — live + recent cycle buttons.
- `[data-section="pipeline-tree"]` — the cascading hex view (phases
  on top, features branching off dev-loop post-PM, WIs branching off
  features) hosted by `[data-component="agent-hex-canvas"]`.
- `[data-section="verdict-form"]` — appears when active cycle is
  `ready-for-review`.
- Cycle buttons: `[data-cycle-id][data-cycle-status][data-cycle-active]`.
- Phase hex mirrors: `[data-phase-hex][data-phase][data-phase-status][data-phase-cost-usd][data-phase-index]`.
- Feature hex mirrors: `[data-feature-hex][data-feature-id][data-feature-deps][data-feature-index]`.
- WI hex mirrors: `[data-wi-hex][data-wi-id][data-wi-feature-id][data-wi-deps]`.
- Artifact badges overlaid on the canvas: `[data-overlay="plan-badge"]` (under architect), `[data-overlay="demo-badge"]` (under review-loop).
- Event tail (ActivityPanel): `[data-section="events-list"]` + `[data-section="event-detail"][data-detail-event-id]`.
- Components: `[data-component="verdict-form"][data-form-state]`,
  `[data-component="scheduler-banner"][data-banner-state]`,
  `[data-component="toasts"][data-toast-count]`.

Phase, feature, and WI statuses share a single 5-state vocabulary
(`pending | active | complete | retrying | failed`). Yellow = retrying
(had a transient error, still recovering); red = full cycle failure
only — sibling units stay in their own state independently. See
[`forge-ui/lib/wi-status.ts`](./forge-ui/lib/wi-status.ts) +
[`forge-ui/lib/phases.ts`](./forge-ui/lib/phases.ts).

When changing component state, **add or update the corresponding
`data-*` attribute** alongside any visual change. The harness
[`scripts/forge-ui-harness.mjs`](./scripts/forge-ui-harness.mjs) +
real-cycle wrapper [`scripts/verify-cycle.mjs`](./scripts/verify-cycle.mjs)
read these attributes to wait deterministically instead of using
timing-based sleeps. `node scripts/forge-ui-harness.mjs --demo`
produces a chromium-recorded synthetic journey under
`forge-ui/.demo-shots/journey/`; `node scripts/verify-cycle.mjs <init>`
runs a real cycle end-to-end with auto-approve + closure + reflection
capture under `forge-ui/.demo-shots/verify/`.
