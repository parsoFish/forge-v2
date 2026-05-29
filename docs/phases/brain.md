# Phase: Brain

> The brain is the system's persistent memory. Every other phase queries it first; reflection writes to it.

## Purpose

Hold the durable, queryable knowledge that lets every other phase make better decisions than its base model would. Three layers: immutable raw sources, navigable theme pages, category indexes — see [ADR 004](../decisions/004-obsidian-wiki.md).

## Inputs

- **Raw research** — web fetches, doc downloads, paper PDFs, code from reference projects.
- **Cycle artifacts** — completed initiative manifests, retros, work-item specs, PR descriptions.
- **Reflection output** — `_logs/<cycle-id>/retro.md` and `brain-gaps.jsonl` after each cycle.

## Outputs

- `brain/_raw/<source>.md` — appended raw source.
- `brain/forge/themes/<theme>.md` — new or updated theme page.
- `brain/projects/<name>/themes/<theme>.md` — project-specific theme page.
- Updated category indexes (`patterns.md`, `antipatterns.md`, `decisions.md`, `operations.md`, per-project `profile.md`).
- Append to `brain/log.md` for significant operations.

## Skills

- [`skills/brain-ingest/SKILL.md`](../../skills/brain-ingest/SKILL.md) — appends to `_raw/`, creates new theme pages.
- [`skills/brain-lint/SKILL.md`](../../skills/brain-lint/SKILL.md) — orphan detection, conflict surfacing, structural integrity.
- [`skills/brain-query/SKILL.md`](../../skills/brain-query/SKILL.md) — efficient lookup; mandated as the first action of every other skill.

## Success signals

> Note (2026-05-25): the `benchmarks/` harnesses were removed; the deterministic-metric / LLM-judge thresholds below are historical. Phase quality is now judged on real merged cycles. (`brain-lint` integrity checks remain live.)

The brain phase is judged on **two axes** — a cheap deterministic metric (per-cycle) plus a periodic LLM-judge validation (every N cycles).

**Deterministic metric** (cheap, run every cycle):

- **Recall:** `benchmarks/brain/questions.json` accuracy ≥80% under the recall-weighted rubric (`0.4 × source_recall + 0.6 × keyword_match`, threshold 0.65, hallucinated paths force 0). (See the former `benchmarks/brain/README.md`, removed 2026-05-25.)
- **Hallucination rate:** ≤ 5% of cases cite a path that doesn't exist on disk.
- **Gap detection:** `benchmarks/brain/negatives.json` pass rate ≥ 80% — out-of-scope and forge-adjacent-bait questions correctly flagged with `gap: true` and bounded citations.
- **Integrity:** `brain-lint` reports zero structural issues (orphans, malformed frontmatter, duplicate themes).
- **Latency:** `brain-query` p95 response time ≤ 15s with the default model (Haiku) under the agentic SKILL.md. The original 5s target was incompatible with the documented grep-and-read process; revised after May 2026 measurement.

**LLM-judge metric** (validating, run every cycle worthwhile or on rubric drift):

- **Judge agreement:** Opus judge (`bench:brain:judge`) agrees with the deterministic metric on ≥ 85% of cases. Disagreement flags either rubric drift (deterministic too harsh / lenient) or a content-grounding failure the deterministic metric can't see (Q15-shape).
- **Judge pass rate:** ≥ 90% of cases pass the judge's "factually correct + grounded + complete + reasonable citations" criteria.

**Coverage signal:**

- `brain-gaps.jsonl` rate-of-new-gaps decreases over consecutive cycles. The gap-flagging rule in [`skills/brain-query/SKILL.md`](../../skills/brain-query/SKILL.md) is load-bearing here — answers that name an absence MUST set `gap: true`.

## Benchmark suite

> Note (2026-05-25): the `benchmarks/` harnesses were removed; this section is historical. Phase quality is now judged on real merged cycles.

`benchmarks/brain/` (removed)
- `questions.json` — Q→expected-source-pages (primary recall suite, 18 cases)
- `negatives.json` — gap-detection suite (out-of-scope / forge-adjacent-bait / partial-match, 10 cases)
- `score.ts` — primary runner (recall + keyword + hallucination check)
- `score-negatives.ts` — gap-detection runner
- `score-judged.ts` — Opus LLM-judge over the latest primary result (validates the deterministic metric)
- `judge.ts` — judge invocation logic (reusable for other phases)
- Run via: `npm run bench:brain`, `npm run bench:brain:negatives`, `npm run bench:brain:judge`

## Known failure modes (to defend against)

- **Episodic learning** — repeating insights every session because nothing's persisted. The brain exists to fix this; mandatory `brain-query` enforces it.
- **Wiki bloat** — `_raw/` grows unbounded. `brain-lint` flags this; periodic archival is part of operations.
- **Stale themes** — content carried from earlier cycles no longer matches reality. `brain-lint` surfaces; `brain-ingest` re-themes.

## TODO (post-scaffold)

- [ ] Run brain seeding Pass A (general best practices) — see [`docs/seeding-plan.md`](../seeding-plan.md).
- [ ] Run brain seeding Pass B (v1 wiki + existing projects).
- [ ] Populate `benchmarks/brain/questions.json` with Pass A success-signal questions.
- [ ] Wire Obsidian vault config (per-user, gitignored).
