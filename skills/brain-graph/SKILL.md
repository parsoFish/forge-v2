---
name: brain-graph
description: Three separate structural indexes over the brain via real `safishamsi/graphify` — one per brain (forge-dev, cycles, project). Nodes/edges over themes/profiles/raw sources with local tree-sitter extraction (no API key needed) and an interactive HTML view. Sits alongside the narrative wiki (C20 dual-index).
phase: brain
surface: unattended
model: claude-haiku-4-5
---

# Brain — Graph

## Single responsibility

Maintain **three** scope-clean structural indexes, one per brain, each
built by the real **graphify** CLI (`safishamsi/graphify`, Python,
MIT, YC S26):

| Brain | Graph path | Corpus |
|---|---|---|
| forge-dev (Brain 1) | `brain/forge-dev/graphify-out/graph.json` | `orchestrator/`, `cli/`, `skills/`, `loops/`, `docs/`, `ARCHITECTURE.md`, `CLAUDE.md`, `PRINCIPLES.md`, `brain/forge-dev/` |
| cycles (Brain 2) | `brain/cycles/graphify-out/graph.json` | `brain/cycles/` |
| project (Brain 3) | `<project-repo>/brain/graphify-out/graph.json` | `<project-repo>/brain/` + `<project-repo>/` source tree |

Sits **alongside** the narrative wiki, not replacing it. Per C20:

- The Karpathy markdown wiki (themes + categories + INDEX.md) holds
  narrative knowledge.
- These graphs hold structural relationships (god nodes, communities,
  shortest paths, surprising cross-file connections) within their scope.

`brain-query` consults the right graph(s) **first** for structural
questions, keyed by the `scope` parameter.

## Inputs

- A subcommand mapped to a graphify build/maintenance operation:
  `update | report | hook-install | diagnose`.
- (Query operations — `query | path | explain | affected` — are owned by
  the `brain-query` skill, not this one.)

## Outputs

- `brain/forge-dev/graphify-out/graph.json` — **committed**, Brain 1 structural index.
- `brain/cycles/graphify-out/graph.json` — **committed**, Brain 2 structural index.
- `<project-repo>/brain/graphify-out/graph.json` — **committed inside the project repo**, Brain 3 per project.
- Each directory also contains `graph.html` (gitignored), `GRAPH_REPORT.md` (gitignored), `manifest.json` (gitignored).
- Appends a one-line entry to `brain/forge-dev/log.md` after `update`.

## Event-log entries to emit

- `brain-graph.update.start` — corpus root.
- `brain-graph.update.end` — node + edge counts, communities, elapsed.
- `brain-graph.stale` — when freshness check fails.
- (Query events are emitted by `brain-query`, not this skill.)

## Benchmark suite

> Note (2026-05-25): the `benchmarks/` harnesses were removed; this section is historical. Phase quality is now judged on real merged cycles.

Formerly shared with `brain-query` under `benchmarks/brain/`.
The three structural questions (Q19–Q21 in `questions.json`) exercised
this skill's contribution — they were answerable from the graph but not
from keyword scan alone.

## Installation prerequisite (one-time, per machine)

```bash
uv tool install graphifyy             # canonical install (per safishamsi/graphify README)
# OR: pipx install graphifyy
# OR: pip install graphifyy
graphify --help                       # verify
```

Code/markdown extraction is **local-only via tree-sitter** — no API key
required. (LLM backends for richer semantic edges over docs/images are
optional: `--backend anthropic|gemini|ollama|...` if `ANTHROPIC_API_KEY`
etc. is set.)

## The operations

### `update` — rebuild the graphs

All three graphs are rebuilt by `scripts/brain-graphify-all.sh`
(the post-commit hook calls this automatically):

```bash
cd /home/parso/forge && bash scripts/brain-graphify-all.sh
```

To rebuild a single brain manually:

**Brain 1 (forge-dev) —** forge code + ADRs + engineering notes:
```bash
cd /home/parso/forge && GRAPHIFY_OUT=brain/forge-dev/graphify-out graphify update .
```
_(Brain 1 scope is controlled by `/home/parso/forge/.graphifyignore`)_

**Brain 2 (cycles) —** cycle themes and archives:
```bash
cd /home/parso/forge && GRAPHIFY_OUT=graphify-out graphify update brain/cycles
```

**Brain 3 (project) —** project root → covers source code + brain themes together:
```bash
GRAPHIFY_OUT=brain/graphify-out graphify update <project-repo>
```
_(Project exclusions are declared in `<project-repo>/.graphifyignore`, which should exclude `node_modules/`, `dist/`, `demo/`, and `brain/graphify-out/` to prevent self-recursion.)_

Extracts AST + frontmatter + markdown links via tree-sitter, writes
`{graph.json, graph.html, GRAPH_REPORT.md, manifest.json}`. Idempotent. No API cost.

Use `graphify update ... --force` after a refactor that DELETES content
(otherwise graphify guards against shrinking the graph).

**Exclusions** (declared via `.graphifyignore` files):

- `brain/forge-dev/graphify-out/.graphifyignore` — graphify's own output (no self-recursion).
- `brain/cycles/graphify-out/.graphifyignore` — same.
- `brain/cycles/_raw/.graphifyignore` — raw cycle archives are inputs to synthesis, not indexed.
- `<project-repo>/.graphifyignore` — project-level exclusions: `node_modules/`, `dist/`, `demo/`, `brain/graphify-out/` (prevents self-recursion), plus project-specific noise (vendored deps, generated docs, etc.).

> **Query operations live in `brain-query`.** This skill owns BUILD +
> MAINTENANCE; querying the resulting `graph.json` files (`graphify query` /
> `path` / `explain` / `affected`) is the `brain-query` skill's
> responsibility. See [`../brain-query/SKILL.md`](../brain-query/SKILL.md).

### `report` — regenerate the markdown report

`graphify update` regenerates `GRAPH_REPORT.md` every run. To regenerate
ONLY the report (e.g. after editing community labels):

```bash
cd brain && graphify cluster-only .
```

### `hook-install` — auto-rebuild on git commit

```bash
cd /home/parso/forge && graphify hook install
```

Installs post-commit + post-checkout hooks so the graph stays fresh on
every commit. The post-commit hook is **background (nohup)** — no
commit-time latency. Both are idempotent (marker-guarded) and respect
`core.hooksPath` for Husky-compatible setups. Per-clone setup; the
hooks themselves are not version-controlled.

Confirm installation: `graphify hook status`. Output lives at
`~/.cache/graphify-rebuild.log`.

### Merge driver — kill conflicts on committed `graph.json` files

Each committed `graph.json` changes on every content edit. The graphify
merge driver union-merges the two sides. Per-clone setup:

```bash
git config merge.graphify.name "graphify graph.json union-merger"
git config merge.graphify.driver "graphify merge-driver %O %A %B"
```

`.gitattributes` routes each `*/graphify-out/graph.json` through
`merge=graphify` — only the local `.git/config` install is needed per
clone. Run this in both the forge repo and each project repo.

### Freshness check

The build records the commit SHA at graph-build time. Run
`git rev-parse HEAD` and compare to the value in `graph.json` (or in
`GRAPH_REPORT.md` § "Graph Freshness") to detect staleness. The
`brain-lint` `checkGraphFreshness` rule (per C21) automates this.

## Operator escalation: LLM backends

For richer semantic edges over docs/images/PDFs that pure tree-sitter
extraction can't infer, set an API key and run from forge root:

```bash
export ANTHROPIC_API_KEY=...    # or GOOGLE_API_KEY, OPENAI_API_KEY, etc.
cd /home/parso/forge && graphify update . --backend anthropic --all
```

The output schema is identical — `brain-query` works unchanged.
Operator-triggered only (not in hooks); ~$5-15 over the forge-root
corpus. Run after major restructures or when structural queries
return thin results.

## Process

1. **`update`** is the default; emits a node + edge + community summary.
2. **Idempotency:** running `update` twice in a row reproduces the same
   `graph.json` save for the `generated_at` line.
3. **No reinvention.** forge does NOT carry its own graph walker. The
   real `graphify` CLI is the single source of truth. The S1.4
   deterministic walker (`orchestrator/brain-graph.ts`) is REMOVED —
   the archived output lived at `brain/_archive/2026-05-23/` (deleted
   in the Tier 4 restructure; recoverable at git tag
   `brain-pre-restructure`).

## Constraints

- **Additive, not replacing.** The narrative wiki (themes + indexes) is
  the source of truth for *what* the brain knows. The graphs are the
  source of truth for *how* the brain's knowledge is connected.
- **Cite, don't paraphrase.** Graph queries return node ids (paths);
  the caller reads the linked theme for the actual content.
- **Local-by-default.** Tree-sitter extraction needs no network.
  LLM-backed extraction is an opt-in upgrade.
- **Three graphs, three scopes.** Each graph is rebuilt independently;
  a cycles-brain commit rebuilds only `brain/cycles/graphify-out/`.
  The `scripts/brain-graphify-all.sh` wrapper rebuilds all forge-side
  graphs together; project graphs are rebuilt by the project's own
  post-commit hook.
- **Per C21**, each `*/graphify-out/graph.json` is committed
  (canonical); `graph.html`, `GRAPH_REPORT.md`, `cache/`, and
  `manifest.json` are gitignored.

## Why graphify-the-tool sits underneath this skill

Per the forge discipline of "use a battle-tested tool, don't reinvent
one" (CLAUDE.md "Never re-invent"),
[`safishamsi/graphify`](https://github.com/safishamsi/graphify)
(51K★, MIT, YC S26) is the canonical knowledge-graph tool. Its
auto-installable Claude Code skill is intentionally broader than forge
needs — it spans code + docs + papers + images + video and exposes
~30 operations. Per **C22**, forge does not adopt the auto-skill
as-is; this hand-authored skill exposes the operations forge actually
uses against the brain.
