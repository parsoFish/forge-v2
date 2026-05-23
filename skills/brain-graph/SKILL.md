---
name: brain-graph
description: Structural index over the brain via real `safishamsi/graphify` — nodes/edges over themes/profiles/raw sources with local tree-sitter extraction (no API key needed) and an interactive HTML view. Sits alongside the narrative wiki (C20 dual-index).
phase: brain
surface: unattended
model: claude-haiku-4-5
---

# Brain — Graph

## Single responsibility

Maintain `brain/graphify-out/graph.json` — the canonical structural
index of the brain wiki (C21) — using the real **graphify** CLI
(`safishamsi/graphify`, Python, MIT, YC S26). Answer structural
queries against it.

Sits **alongside** the narrative wiki, not replacing it. Per C20:

- The Karpathy markdown wiki (themes + categories + INDEX.md) holds
  narrative knowledge.
- This graph holds structural relationships (god nodes, communities,
  shortest paths, surprising cross-file connections).

`brain-query` consults the graph **first** for structural questions
and falls back to keyword scan over themes.

## Inputs

- A subcommand mapped to a graphify operation:
  `update | query | path | explain | report | hook-install`.
- For `query` and friends: the question/node id (see below).

## Outputs

- `brain/graphify-out/graph.json` — **committed**, canonical structural
  index (C21).
- `brain/graphify-out/graph.html` — interactive view (gitignored).
- `brain/graphify-out/GRAPH_REPORT.md` — text report (gitignored).
- Appends a one-line entry to `brain/log.md` after `update`.

## Event-log entries to emit

- `brain-graph.update.start` — corpus root.
- `brain-graph.update.end` — node + edge counts, communities, elapsed.
- `brain-graph.query` — one event per query with op + result count.
- `brain-graph.stale` — when freshness check fails.

## Benchmark suite

Shared with `brain-query` under [`benchmarks/brain/`](../../benchmarks/brain/).
The three structural questions (Q19–Q21 in `questions.json`) exercise
this skill's contribution — they're answerable from the graph but not
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

### `update` — rebuild the graph

```bash
cd /home/parso/forge/brain && graphify update .
```

Walks the brain corpus, extracts AST + frontmatter + markdown links via
tree-sitter, writes `graphify-out/{graph.json, graph.html,
GRAPH_REPORT.md, manifest.json}`. Idempotent. No API cost.

Use `graphify update . --force` after a refactor that DELETES content
(otherwise graphify guards against shrinking the graph).

### `query` — semantic / structural search

```bash
cd brain && graphify query "what connects pr-as-review-window to reviewer-stage2?"
```

BFS traversal of `graphify-out/graph.json` for the question. Returns a
token-efficient subset of relevant nodes + edges.

### `path` — shortest connection between two nodes

```bash
cd brain && graphify path "pr-as-sole-review-window" "reviewer-stage2"
```

### `explain` — describe a node and its neighbourhood

```bash
cd brain && graphify explain "karpathy-three-layer-wiki"
```

### `report` — regenerate the markdown report

`graphify update` regenerates `GRAPH_REPORT.md` every run. To regenerate
ONLY the report (e.g. after editing community labels):

```bash
cd brain && graphify cluster-only .
```

### `hook-install` — auto-rebuild on git commit

```bash
graphify hook install
```

Installs post-commit / post-checkout hooks so the graph stays fresh
with every commit. Optional but recommended on developer machines.

### Freshness check

The build records the commit SHA at graph-build time. Run
`git rev-parse HEAD` and compare to the value in `graph.json` (or in
`GRAPH_REPORT.md` § "Graph Freshness") to detect staleness. The
`brain-lint` `checkGraphFreshness` rule (per C21) automates this.

## Operator escalation: LLM backends

For richer semantic edges over docs/images/PDFs, set an API key and run:

```bash
export ANTHROPIC_API_KEY=...    # or GOOGLE_API_KEY, OPENAI_API_KEY, etc.
cd brain && graphify update . --backend anthropic --all
```

The output schema is identical — `brain-query` works unchanged.

## Process

1. **`update`** is the default; emits a node + edge + community summary.
2. **`query`** assumes `graphify-out/graph.json` exists; the
   `brain-query` SKILL handles the missing-graph case (falls back to
   keyword scan).
3. **Idempotency:** running `update` twice in a row reproduces the same
   `graph.json` save for the `generated_at` line.
4. **No reinvention.** forge does NOT carry its own graph walker. The
   real `graphify` CLI is the single source of truth. The S1.4
   deterministic walker (`orchestrator/brain-graph.ts`) is REMOVED —
   the archived output lives at `brain/_archive/2026-05-23/graph.json.s1.4-deterministic-walker.json`
   for historical comparison only.

## Constraints

- **Additive, not replacing.** The narrative wiki (themes + indexes) is
  the source of truth for *what* the brain knows. The graph is the
  source of truth for *how* the brain's knowledge is connected.
- **Cite, don't paraphrase.** Graph queries return node ids (paths);
  the caller reads the linked theme for the actual content.
- **Local-by-default.** Tree-sitter extraction needs no network.
  LLM-backed extraction is an opt-in upgrade.
- **Per C21**, `brain/graphify-out/graph.json` is committed
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
