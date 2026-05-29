# Forge v2 — Project Instructions for Claude Code

> Idea machine for one human across many side projects. Six phases backed by a brain. Hand-rolling forbidden; battle-tested tools required.

## North star

Forge v2 is **designed to run primarily unattended between human interaction points** (architect, review, reflection). Every decision is judged against three things:

1. Does it preserve unattended operation?
2. Does it use a battle-tested community tool, or are we re-inventing one?
3. Is it the simplest thing that could work?

If the answer to (1) is no, the change must justify why. If (2) reveals a re-invention, find the existing tool. If (3) reveals complexity, cut.

## The brain is the first source of knowledge

**Before** answering a question about how forge works, before designing, before implementing — **query the brain**. Since the three-brain restructure ([ADR 018](./docs/decisions/018-three-brain-model.md)) the brain is three scoped graphs: **Brain 1** `brain/forge-dev/` (forge engineering), **Brain 2** `brain/cycles/` (cross-cycle patterns + archives), and **Brain 3** `projects/<name>/brain/` (per-project, lives in each project's own repo). Query via the `brain-query` skill with `--scope`. If the brain doesn't know, research further AND log the gap so the next ingest pass can fill it.

Who reads what (see [ADR 010](./docs/decisions/010-brain-first.md) as amended + [`brain/cycles/themes/brain-read-policy.md`](./brain/cycles/themes/brain-read-policy.md)):

- **Planners (architect / project-manager) + reflector** — query Brain 2 + the cycle's Brain 3 (reflector: all three). Mandatory for planners.
- **Dev-loop + reviewer** — do **NOT** read the forge brain (Brains 1+2); the planner already encoded every relevant convention/antipattern into the work items, their single source of *intent*. They **may** consult the cycle's Brain 3 (the project's own `brain/`) for supplemental project context — advisory, not mandatory (amended 2026-05-26, ADR 010).

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
- Forge-level patterns: [`brain/cycles/themes/`](./brain/cycles/themes/).
- Per-project patterns: [`brain/projects/<project>/themes/`](./brain/projects/).
- Operator UI: [`forge-ui/`](./forge-ui/) (launched by `forge watch`).

## graphify

Three knowledge graphs after the Tier 4 brain restructure (2026-05-26):
- **Brain 1 (forge-dev):** `brain/forge-dev/graphify-out/` — forge TypeScript source + ADRs (3,566 nodes).
- **Brain 2 (cycles):** `brain/cycles/graphify-out/` — cycle-derived themes + raw archives (518 nodes).
- **Brain 3 (per-project):** `projects/<name>/brain/graphify-out/` — whole-project knowledge (source code + brain themes). trafficGame: 2,578 nodes; terraform: 6,015 nodes; claude-harness: 553 nodes.

The wrapper script `bash scripts/brain-graphify-all.sh` rebuilds Brain 1 + 2; use `--all` to also rebuild all managed project brains.

**Build commands** (all three brains):
```bash
# Brain 1 — forge source + ADRs (GRAPHIFY_OUT overrides the default graphify-out/ subdir)
GRAPHIFY_OUT=brain/forge-dev/graphify-out GRAPHIFY_FORCE=1 graphify update .

# Brain 2 — cycles themes + raw archives
GRAPHIFY_OUT=graphify-out GRAPHIFY_FORCE=1 graphify update brain/cycles

# Brain 3 — whole project (code + brain themes); output lands at brain/graphify-out/
# Each project needs a .graphifyignore excluding node_modules/, dist/, brain/graphify-out/
GRAPHIFY_OUT=brain/graphify-out graphify update projects/<name>
```

**Query by domain** (use the right graph for the question):
```bash
# Forge code / orchestration architecture
graphify query "<question>" --graph brain/forge-dev/graphify-out/graph.json

# Cycle patterns / antipatterns / archived cycle evidence
graphify query "<question>" --graph brain/cycles/graphify-out/graph.json

# Project-specific architecture
graphify query "<question>" --graph projects/<name>/brain/graphify-out/graph.json
```

The graphs are a **power-tool, not a mandate** (2026-05-24 rebuild-review): brain-query against
markdown themes alone is enough for most lookups. Reach for a graph when grep is too noisy or you
want a cross-cluster relationship — see
[`skills/brain-graph/SKILL.md`](./skills/brain-graph/SKILL.md) for the query / path / explain commands.

The post-commit hook calls `bash scripts/brain-graphify-all.sh` automatically. Manual invocation is only needed if you skip the hook.

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
