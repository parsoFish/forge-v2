---
name: brain-query
description: Efficient lookup against the brain. Mandated as the first action of every other skill. Consults the structural graph (brain/graph.json) first, then falls back to keyword scan over themes. Logs gaps so the next ingest pass can fill them.
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

1. **Structural graph** (`brain/graph.json`, owned by `brain-graph`) — answers questions about relationships, bridges, and cross-file connections.
2. **Narrative wiki** (theme pages + category indexes) — answers questions about *content*. Keyword + frontmatter scan.

The graph fills the gap forge has been carrying manually via `related_themes` frontmatter (low-rigour, error-prone). When a question is structural in nature ("which theme bridges X and Y?", "what are the neighbours of theme Z?", "what's two hops from this antipattern?"), the graph answers it directly. When the question is content-bearing ("how does forge handle stacked PRs?"), the keyword scan over themes is still the load-bearing path; the graph contributes by surfacing additional structurally-related themes the scan would miss.

## Inputs

- A natural-language question or list of questions.
- Optional: project scope (constrains query to `brain/projects/<name>/`).
- Optional: category scope (`pattern` | `antipattern` | `decision` | `operation` | `reference`).

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

The question is fielded in two passes; the second is conditional on the first being thin:

1. **Parse the question.** Identify keywords + likely category + whether the phrasing is structural ("which theme bridges …", "what's connected to …", "two hops from …", "what's the longest dependency chain in …"). Record this for the graph-vs-narrative routing.

2. **Graph-first lookup** (`brain/graph.json` via the `brain-graph` skill / `forge brain graph query`).
   - For structural phrasings, pick the operation:
     - bridge questions → `forge brain graph query bridges <a> <b>`
     - "what's near …" → `forge brain graph query neighbours <id>`
     - "what reaches …" → `forge brain graph query reachable <id> <hops>`
     - "tell me about node …" → `forge brain graph query node <id>`
   - For non-structural questions, still extract candidate theme ids by keyword (step 3a) and then run `neighbours` on each top candidate to widen the recall set with structurally-adjacent themes the keyword scan would miss.
   - The graph contributes node ids (paths), not synthesised text. Treat returned ids as additional source candidates for step 4.

3. **Narrative scan** (when graph alone insufficient — almost always, for content-bearing questions):
   - **Theme pages:** grep `brain/forge/themes/` and `brain/projects/<scope>/themes/` for keywords; load matching pages.
   - **Category indexes:** cross-reference theme matches against the index hierarchy.
   - **Raw layer:** only if theme matches are insufficient — grep `brain/_raw/` and load the most relevant.

4. **Merge sources.** Combine the keyword hits and the graph-derived neighbours. Dedupe by path. The graph's structural recall is what catches the "I forgot to mention the corrective antipattern" failure mode.

5. **Synthesise.** Cite sources by file path (not by content quote — the caller can read the source itself).

6. **Score confidence:**
   - **High:** ≥ 2 corroborating sources, all on-topic.
   - **Medium:** 1 source on-topic, or multiple loosely related.
   - **Low / gap:** no good source, or only off-topic matches. Mark `gap: true` and log.

7. **Gap-flagging rule (load-bearing):** if your synthesised answer says **any** of the following — "the brain does not contain X", "no documentation on X", "doesn't have X", "no specific guidance", "X is not in the brain", "outside the scope" — **set `gap: true`**, even if you cited 1–2 themes for context. Naming-the-absence is itself a gap; the brain-gap-feedback-loop only fires on `gap: true`. A correct answer that says "we don't have X" without setting the flag is the most damaging failure mode (the gap is real but invisible to ingest).

8. **Return.** Populate `structural_neighbours` (informational) with the graph-derived node ids that were folded into `sources`. This lets the caller see why a theme was picked even when it wasn't a direct keyword match.

## Looking up by graph node id

The graph keys nodes by relative posix path. To resolve a slug to a node id:

- forge theme: `brain/forge/themes/<slug>.md`
- project theme: `brain/projects/<project>/themes/<slug>.md`
- profile: `brain/projects/<project>/profile.md`
- category index: `brain/forge/<category>.md` (categories: `patterns`, `antipatterns`, `decisions`, `operations`, `reference`).

If you don't know the exact slug, use the navigation indexes (`forge brain index`) to find candidates, then resolve.

## Constraints

- **Cite, don't paraphrase deeply.** The caller can read the linked file. Synthesis is a one-paragraph answer + source list, not a full essay.
- **Cite theme pages and project profiles only.** Valid `sources` entries are `brain/forge/themes/<slug>.md` and `brain/projects/<name>/{profile.md,themes/<slug>.md}`. Never cite `brain/_raw/*` (those are inputs to synthesis, not citations) or category indexes (`brain/forge/{patterns,antipatterns,decisions,operations,reference}.md`, `brain/forge/themes/README.md`, `brain/INDEX.md`) — they're navigation, not knowledge.
- **Be exhaustive on theme coverage.** If a question spans multiple themes (e.g. a pattern + its antipattern + the operation that prevents it), cite all of them. The benchmark scores recall (did you find every expected theme), so under-citing is the failure mode to avoid. Citing 1–2 extras is acceptable; missing the corrective antipattern is not. **The graph is your insurance against this failure mode** — running `neighbours` on a top keyword hit will surface the corrective antipattern via the `related_themes` edge.
- **Graph-first is a routing decision, not a budget.** Do not skip the keyword scan when the graph returned a thin result; combine both. Skipping costs recall and is the more damaging failure mode than over-citing.
- **Fast model by default.** Haiku is the default; per-skill override via the calling skill's frontmatter if a question genuinely needs more.
- **Gaps are logged, not silently failed.** If the brain doesn't know, the brain learns by the next ingest pass.
- **No web fallback in this skill.** Broader research is the *calling* skill's responsibility (after this skill's gap event is logged); separation of concerns.
- **The graph is structural; the themes are content.** Don't try to answer narrative questions from the graph alone; don't try to answer structural questions from grep alone. Use each for what it's for.

## Sources

- See [`brain/graph.json`](../../brain/graph.json) for the structural index this skill consults first.
- See [`skills/brain-graph/SKILL.md`](../brain-graph/SKILL.md) for how the graph is built and queried.
