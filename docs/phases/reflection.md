# Phase: Reflection

> *Unattended on stages 1 + 4; file-based handoff for stages 2 + 3.* Closes the learning loop by feeding cycle outcomes back into the brain.

## Purpose

After an initiative is merged, run a four-stage retrospective:

1. **Agentic self-reflection (unattended)** — the agent reviews its own performance from the JSONL event log.
2. **Agent-prompted user questions (file-based handoff)** — the agent writes structured questions into `_logs/<cycle-id>/user-questions.md`.
3. **Pure user feedback (file-based handoff)** — the agent reads `_logs/<cycle-id>/user-feedback.md` (populated by a human in production; was formerly pre-populated by the bench simulator, removed 2026-05-25).
4. **Brain writes (unattended)** — direct file writes of theme markdown + cycle archive.

All four feed the brain by direct file writes, which is what makes forge improve cycle-over-cycle. The `brain-ingest` sub-skill is not invoked in this closure pass; a future closure may switch to it.

## Inputs

- `_logs/<cycle-id>/events.jsonl` (the full cycle log).
- `_logs/<cycle-id>/brain-gaps.jsonl` (questions the brain couldn't answer during the cycle; may be empty).
- `_logs/<cycle-id>/user-feedback.md` (pre-populated; missing in unattended-only runs).
- The merged project tree (`projects/<name>/`).
- Brain knowledge (prior retros, established patterns).

## Outputs

- `_logs/<cycle-id>/retro.md` — three sections: `## Self-reflection`, `## User questions`, `## User feedback`.
- `_logs/<cycle-id>/user-questions.md` — structured stage-2 questions (optional; skip if no question warranted).
- New theme pages in `brain/projects/<project>/themes/<YYYY-MM-DD>-<slug>.md` — one per significant pattern, each with required frontmatter and a `## Sources` section listing ≥ 1 evidence path.
- `brain/_raw/cycles/<cycle-id>.md` — cycle log archived with full provenance frontmatter.
- Append to `brain/log.md`.

The reflector does NOT move the manifest to `_queue/done/`. The reviewer already moved it on merge. Reflection is post-merge log-and-continue: a thrown reflector does not change the cycle's `status` (already `merged`); only `reflection_status: 'failed'` is surfaced in `CycleResult`.

## Skills

- [`skills/reflector/SKILL.md`](../../skills/reflector/SKILL.md) — runs the four-stage retro.
- [`skills/brain-ingest/SKILL.md`](../../skills/brain-ingest/SKILL.md) — sub-skill, NOT invoked in the current closure pass.
- [`skills/brain-lint/SKILL.md`](../../skills/brain-lint/SKILL.md) — sub-skill, NOT invoked in the current closure pass; the bench enforces a subset of `brain/LINT.md` rules inline via `no_brain_corruption` gate.

## Success signals

- **Brain-gap closure:** `brain-gaps.jsonl` items from the cycle are referenced in `retro.md` or in a new theme.
- **Theme deltas:** retros result in concrete theme-page additions (not just text "we should improve X").
- **Evidence grounding:** every emitted theme cites at least one source path that resolves to the cycle log or the cycle archive.
- **Iteration trend:** median iterations / cost / wedge-rate trend down across consecutive cycles (judged across multiple cycles, not within one).
- **Antipattern capture:** any cycle with a wedge or send-back produces ≥ 1 theme with `category: antipattern`.

## Benchmark suite

> Note (2026-05-25): the `benchmarks/` harnesses were removed; this section is historical. Phase quality is now judged on real merged cycles. (Reflection's `no_brain_corruption` lint subset survives as `forge brain lint`.)

`benchmarks/reflection/` (removed)
- `cases.json` — 5 fixture catalogue.
- `fixtures/<id>/` — each fixture supplies manifest, events.jsonl, brain-gaps.jsonl, merged-tree/, user-feedback.md, expected.json.
- `scoring.ts` — pure rubric: 5 gates (`manifest_provided`, `log_parseable`, `retro_emitted`, `brain_consulted`, `no_brain_corruption`) + 6 weighted criteria (themes_emitted 0.25, themes_evidence_grounded 0.25, theme_categories_balanced 0.10, cycle_archived 0.15, retro_three_sections 0.15, brain_gaps_addressed 0.10) summing to 1.0; pass threshold 0.7.
- `sdk.ts` — DI harness: tempdir + layered brain (theme writes land in tempdir, not the live brain); pre-writes `user-feedback.md` via simulator.
- `simulator.ts` — file-based human-feedback shim.
- `score.ts` — fixture loop + aggregator + results writer.

## Known failure modes (to defend against)

> Note (2026-05-25): the `benchmarks/` harnesses were removed; the "bench's `<criterion>`" references below are historical. The orchestrator-side verification (evidence-path `existsSync`, the `no_brain_corruption` lint subset) remains live; phase quality is now judged on real merged cycles.

- **Vague retros** — "we could do better at X." The bench's `themes_evidence_grounded` criterion is orchestrator-verified (`existsSync` against the listed `## Sources` paths), so unsourced themes fail.
- **Reflection bypass** — cycle marked done without retro. Detected via `reflection_status` in `CycleResult` telemetry; not gated (log-and-continue).
- **Brain growth without curation** — the bench's `no_brain_corruption` gate enforces a subset of `brain/LINT.md` rules (frontmatter present, valid `category`, at least one resolvable evidence link).
- **Themes labelled `pattern` despite send-backs** — `theme_categories_balanced` requires ≥ 1 `category: antipattern` theme when the events.jsonl contains any wedge or send-back signal.

## TODO (post-scaffold)

- [x] Define the retro.md template (three structural sections; rendered via `renderReflectorUserPrompt`).
- [x] Populate `benchmarks/reflection/fixtures/` with 5 fixture cycles + expected deltas.
- [x] Wire `orchestrator/cycle.ts:runReflector()` end-to-end (real SDK invocation; log-and-continue failure mode).
- [ ] Future: orchestrator gate that blocks scheduler from queueing new initiatives for a project whose last N reflections failed.
- [ ] Future: stdin / CLI transport for stages 2 + 3 in production (currently file-based only).
- [ ] Future: switch theme writes from direct-write to `brain-ingest` sub-skill round-trip once that path is production-validated.
- [ ] Future: production CLI `forge reflect <cycle-id>` to re-run reflection on demand.
