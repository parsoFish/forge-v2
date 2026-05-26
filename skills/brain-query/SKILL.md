---
name: brain-query
description: Efficient lookup against the brain. Mandated as the first action of every other skill. Consults the structural graph first (per-brain graphify-out/, via real safishamsi/graphify), then falls back to keyword scan over themes. Logs gaps so the next ingest pass can fill them. Accepts a scope parameter to target the right brain: forge-dev, cycles, project, or all.
phase: brain
surface: unattended
model: claude-haiku-4-5
---

# Brain — Query

## Single responsibility

Answer a question against the brain wiki, citing source files. Log
unanswered or low-confidence queries as **gaps** for `brain-ingest` to
address.

This skill is invoked **first** by every other skill, per [ADR 010](../../docs/decisions/010-brain-first.md).

Per C20 (dual-index), it consults **two** layers in order:

1. **Structural graph** (owned by `brain-graph`, built by real `safishamsi/graphify` Python CLI) — answers questions about relationships, bridges, and cross-file connections via `graphify query` / `graphify path` / `graphify explain`. Three brains: `brain/forge-dev/graphify-out/graph.json` (Brain 1), `brain/cycles/graphify-out/graph.json` (Brain 2), `<project-repo>/brain/graphify-out/graph.json` (Brain 3).
2. **Narrative wiki** (theme pages + category indexes) — answers questions about *content*. Keyword + frontmatter scan.

The graph fills the gap forge has been carrying manually via `related_themes` frontmatter (low-rigour, error-prone). When a question is structural in nature ("which theme bridges X and Y?", "what are the neighbours of theme Z?", "what's two hops from this antipattern?"), the graph answers it directly. When the question is content-bearing ("how does forge handle stacked PRs?"), the keyword scan over themes is still the load-bearing path; the graph contributes by surfacing additional structurally-related themes the scan would miss.

## Inputs

- A natural-language question or list of questions.
- Optional: `scope` — which brain(s) to search. Values:
  - `forge-dev` — forge code + ADRs + engineering notes (`brain/forge-dev/`, forge source tree). Never read during a cycle.
  - `cycles` — cycle-derived patterns, antipatterns, operations, raw archives (`brain/cycles/`). Read by planners.
  - `project` — project-specific themes and profile (`<project-repo>/brain/`, accessed via the cycle's worktree). Read by planners, dev-loop, reviewer, reflector during a cycle.
  - `all` — union of all three (default when no scope given; emits a single-line warning).
- Optional: `project` name — required when `scope=project`; resolves the project-repo brain path.
- Optional: category filter (`pattern` | `antipattern` | `decision` | `operation` | `reference`).

**Role defaults** (the calling skill or orchestrator should supply these):

| Role | Default scope |
|---|---|
| architect / PM | `cycles,project` (Brain 2 + the cycle's Brain 3) |
| reflector | `all` (loose read access; reflector is operator-coupled) |
| dev-loop / reviewer | `project` (Brain 3 of the cycle's project ONLY) |
| forge-dev session (no cycle) | `forge-dev,cycles` (Brain 1 + Brain 2) |

## Outputs

- A structured response:
  ```ts
  {
    answers: Array<{
      question: string;
      answer: string;             // synthesised answer
      confidence: 'high' | 'medium' | 'low';
      sources: string[];          // brain file paths
      structural_neighbours?: string[]; // theme ids found via graph (informational)
      gap?: boolean;              // true if confidence is low or no source found
    }>;
  }
  ```
- For each `gap: true` answer, append to `_logs/<cycle-id>/brain-gaps.jsonl`.

## Event-log entries to emit

- `brain-query.start` — with the questions.
- `brain-query.graph-hit` — one event per question where the graph contributed at least one source.
- `brain-query.hit` — one event per question that found high/medium-confidence sources.
- `brain-query.gap` — one event per question with low/no confidence.
- `brain-query.end` — summary.

## Benchmark suite

Primary owner of [`benchmarks/brain/`](../../benchmarks/brain/) — `questions.json` + `score.ts`. Accuracy + latency + source-correctness are the scored metrics. The 18 narrative questions exercise keyword scan; the 3 structural questions (`Q19-Q21`) exercise the graph-first path. The combined bench is the proof that adding the graph does not regress narrative answers while adding a new class of answer.

## Process

Three steps. Strict order. No alternation between graphify and grep.

1. **Graph-first identify.** Resolve which graph(s) to consult based on the active scope:

   | Scope | Graph path |
   |---|---|
   | `forge-dev` | `brain/forge-dev/graphify-out/graph.json` |
   | `cycles` | `brain/cycles/graphify-out/graph.json` |
   | `project` | `<project-repo>/brain/graphify-out/graph.json` |
   | `all` | run each in turn; union the candidate sources |

   Run ONE `graphify` call per graph. Pick the operation by question phrasing:
   - structural / "what bridges A and B" → `graphify path "<A>" "<B>" --graph <path>`
   - "describe <X>" / "what's near <X>" → `graphify explain "<X>" --graph <path>`
   - "what implements/uses <X>" → `graphify affected "<X>" --graph <path>`
   - free-form content question → `graphify query "<the-question>" --graph <path>`

   The graph returns a small subgraph of node ids + source files. Those
   files are your candidate sources — typically 2–5 themes. Read them with
   the `Read` tool. No grep, no glob — the graph IS your retrieval index.
   That's the load-bearing token-saving promise of graphify
   (see [[karpathy-three-layer-wiki]] + [[per-project-knowledge-graph]]).

2. **Read identified themes.** Use `Read` on the 2–5 theme files the
   graph surfaced. Verify they match the question (briefly), discard
   off-topic returns. Do NOT grep `brain/_raw/` or expand the scan
   beyond what the graph identified — if the graph missed something
   relevant, that's a brain-completeness gap to log in step 4, not a
   reason to fall back to brute-force search.

3. **Synthesise + cite.** Write a one-paragraph answer that preserves
   exact terminology from the cited themes. Cite by file path. Score
   confidence:
   - **High:** ≥ 2 corroborating themes, all on-topic.
   - **Medium:** 1 source on-topic.
   - **Low / gap:** no good source — set `gap: true`.

4. **Gap-flagging rule (load-bearing).** If your answer contains any of
   "the brain does not contain X", "no documentation on X", "doesn't
   have X", "no specific guidance", "outside the scope" — set
   `gap: true`. Naming-the-absence is a gap; the feedback loop only
   fires on `gap: true`. Returning "we don't have X" without the flag
   is the worst failure mode (gap is real but invisible to ingest).

### Fallback (rare)

If graphify returns an empty subgraph AND the question seems
answerable from the brain, then — and only then — use `Read` on the
INDEX hub or a category index to find candidates. Grep is NOT an
option in this skill — the graph is the index. If after one
`graphify` + one `Read` of an index the brain still has nothing, mark
`gap: true` and return.

## Looking up by graph node id

The graph keys nodes by relative posix path. Node id conventions after the three-brain restructure:

| Brain | Theme node id |
|---|---|
| cycles | `brain/cycles/themes/<slug>.md` |
| forge-dev | `brain/forge-dev/{log,decisions,reference}.md` or `<forge-source-path>` |
| project | `brain/themes/<slug>.md` (relative to the project repo root) |

Category indexes:
- cycles: `brain/cycles/{patterns,antipatterns,decisions,operations}.md`
- forge-dev: `brain/forge-dev/{decisions,reference}.md`
- project: `brain/profile.md` (relative to the project repo root)

If you don't know the exact slug, use the navigation indexes (`forge brain index`) to find candidates, then resolve.

## Constraints

- **Cite, don't paraphrase deeply.** The caller can read the linked file. Synthesis is a one-paragraph answer + source list, not a full essay.
- **Cite theme pages and project profiles only.** Valid `sources` entries are `brain/cycles/themes/<slug>.md`, `brain/forge-dev/{log.md,decisions.md,reference.md}`, and `<project-repo>/brain/{profile.md,themes/<slug>.md}`. Never cite `brain/cycles/_raw/*` (those are inputs to synthesis, not citations) or category indexes (`brain/cycles/{patterns,antipatterns,decisions,operations}.md`, `brain/INDEX.md`) — they're navigation, not knowledge.
- **Be exhaustive on theme coverage.** If a question spans multiple themes (e.g. a pattern + its antipattern + the operation that prevents it), cite all of them. The benchmark scores recall (did you find every expected theme), so under-citing is the failure mode to avoid. Citing 1–2 extras is acceptable; missing the corrective antipattern is not. **The graph is your insurance against this failure mode** — running `neighbours` on a top keyword hit will surface the corrective antipattern via the `related_themes` edge.
- **Graph-first is a routing decision, not a budget.** Do not skip the keyword scan when the graph returned a thin result; combine both. Skipping costs recall and is the more damaging failure mode than over-citing.
- **Fast model by default.** Haiku is the default; per-skill override via the calling skill's frontmatter if a question genuinely needs more.
- **Gaps are logged, not silently failed.** If the brain doesn't know, the brain learns by the next ingest pass.
- **No web fallback in this skill.** Broader research is the *calling* skill's responsibility (after this skill's gap event is logged); separation of concerns.
- **The graph is structural; the themes are content.** Don't try to answer narrative questions from the graph alone; don't try to answer structural questions from grep alone. Use each for what it's for.
- **Trust graphify's own confidence tiers.** Edges are tagged `EXTRACTED` (direct from source, canonical), `INFERRED` (secondary), `AMBIGUOUS` (lowest). Consume them as-is; do NOT build a parallel filter layer (operator principle 2026-05-23 — graphify owns the confidence model). Cite higher-confidence edges first when synthesising.
- **Scope is load-bearing — respect it strictly.** When the caller supplies `scope: project`, your cited sources MUST come from `<project-repo>/brain/profile.md` or `<project-repo>/brain/themes/`. You may reference a cycles-brain theme ONLY IF an in-scope theme explicitly links to it via `related_themes` or a `[[wikilink]]`. Do NOT pull in forge-dev concepts (ADRs, phase code symbols, etc.) that aren't documented inside the project's own brain — that's hallucination by the project's standards even though the concept is real elsewhere. If the project's themes don't ground a claim, omit the claim or flag the gap.
- **Missing scope defaults to `all` + warn.** If no scope is provided and no cycle context is available, search all three brains and emit: `[brain-query] no scope supplied — searching all three brains; supply --scope to reduce noise`. Include a `scope` field in the output showing what was actually searched.

## Sources

- `brain/forge-dev/graphify-out/graph.json` — structural index for forge code + ADRs.
- `brain/cycles/graphify-out/graph.json` — structural index for cycle themes.
- `<project-repo>/brain/graphify-out/graph.json` — structural index for project brain + project source tree.
- See [`skills/brain-graph/SKILL.md`](../brain-graph/SKILL.md) for how each graph is built and maintained (wraps real `safishamsi/graphify` Python CLI).
