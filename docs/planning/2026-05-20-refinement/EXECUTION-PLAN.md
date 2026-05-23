---
doc: execution-plan
batch: 2026-05-20-refinement
date: 2026-05-21
date_iteration_2: 2026-05-23
status: contracts ratified through C28; S0 landed; S1 unblocked
operator_answers:
  q1_confirm_c1_c18: verbatim
  q2_aggregate_budget_n: "removed entirely (C19 added — no budget mechanisms in refinement scope)"
  q3_contracts_md_location: "next to the plans (this dir), not promoted to ADR"
  q4_dogfooding_project: terraform-provider-betterado
iteration_2_additions:
  - "C20-C22 (graphify additive brain layer)"
  - "C23-C26 (token economy: caching, model routing, output style, memory compression)"
  - "C26-C27 (trafficGame learnings: holistic metrics contract clause, exploration manifest type)"
  - "C28 (project-sweep skill skeleton)"
  - "Plan 08 (token economy) added"
  - "LEARNINGS-trafficgame.md added — canonical reference for what good looks like"
---

# Forge refinement — execution plan

How to take the 7 refinement plans + 7 council reviews in this dir and land
them one-by-one without the cross-plan contradictions the councils flagged
becoming production bugs.

> **Read order before acting:** this doc → the contract decisions section
> (you must ratify each before any slice goes into the architect) → the
> stage you're about to start.

## TL;DR

There are **24 cross-plan inconsistencies** the councils surfaced. About a
third are naming/location collisions, a third are missing contract edges
between plans, and a third are scope-bundling decisions. They cluster into
**18 contract decisions** (C1–C18 below). Ratify those first, in one
sitting, as a cross-plan edit pass — *then* the 7 plans can be sliced into
initiatives in a clean topological order.

After contract lock, execution is **eight stages** (S0–S7). The atomicity
constraint that matters most: **plans 04 (dev-loop) and 05 (review) must
land as one initiative** — splitting them creates a half-state where
either no actor owns PR prep or two do. Everything else is parallelisable
within a stage.

The betterado roadmap is the **dogfooding bench**: after S4 lands, run
INIT-01 (substrate) + INIT-02 (release_folder) through the refined cycle
end-to-end. If those work, the remaining 18 betterado initiatives can
unattend.

## Inconsistencies catalog

Numbered for cross-referencing from contract decisions and stages. Each
links the originating plan / council finding.

### Naming + location collisions

| # | Conflict | Source | Lock |
|---|---|---|---|
| I-01 | `forge.config.json` at project root (plan 04) collides with `forge.config.json.example` per-machine config at forge root (ADR 009) | 04 §"Demo contract"; council 04 F1 | C1 |
| I-02 | `demo.kind: browser\|harness\|cli-diff\|artifact\|none` (plan 04, project-level) overlaps `kind: screenshot\|video\|harness` (`skills/demo/SKILL.md`, checkpoint-level); `harness` means two different things | 04 §"Demo contract"; council 04 F2 | C2 |
| I-03 | Plan 03 links to `04-developer-loop.md`; file is `04-dev-loop.md`. Plan 04 calls PM "plan 02"; PM is plan 03. | council 03 `cross-plan-filename-drift`, `plan-number-mismatch-in-cross-refs` | C3 |
| I-04 | Architect/PM/dev-loop benches each invent their own `benchmarks/_lib/` handoff module name (`bench-handoff.ts` in 02; `architect-handoff.ts` + `pm-handoff.ts` in 03; implied in 04) | plans 02 §"Cross-phase contract"; 03 §"Cross-phase contract" | C10 |
| I-05 | Handle format taste (`traf#7` vs `traf-7` vs `T7` vs `@traf/7`) | 07 §"Dual-ID scheme"; council 07 [design] escalation | C6 |

### Cross-plan contract gaps (functional holes)

| # | Conflict | Source | Lock |
|---|---|---|---|
| I-06 | PM plan 03 needs per-feature `quality_gate_cmd`, `non_goals`, `hard_constraints` in manifests; architect plan 02 promises none of these. | council 03 CEO escalation + plan 03 §"Cross-phase contract" | C4 |
| I-07 | Plan 05 declares `_queue/in-flight/<id>.pr-feedback.md` as the unifier's read-input on send-back; plan 04 has zero references to that file or to a re-entrant-on-feedback mode. | council 05 `eng:plan-04-contract-implicit` | C3 + S4 atomic |
| I-08 | Plan 06 calls `forge brain lint --scope cycle-touched-themes`; plan 01 enumerates scopes (`full / forge-only / project-only / single-file`) without that name. | council 06 `eng:03-lint-scope-contract-missing` | C7 |
| I-09 | Plan 02's `downstream_pm_score` (0.30 weight) chains architect-bench into PM-bench; PM-bench is being refined in plan 03 — coupling two moving rubrics. | council 02 `eng:downstream-pm-score-circularity` | C10 + frozen SHA |
| I-10 | Plan 06 adds `reflection_status: 'lint-flagged'` enum value (breaking); should be sibling `lint_status` field. | council 06 `eng:02-status-enum-expansion` | C8 |
| I-11 | Plan 06's `/forge-reflect` writes `user-feedback.md` **after** reflector exits → operator's answers never reach the brain this cycle without `--rerun` default-on. | council 06 `design:01-slash-command-write-timing` (BIGGEST UX HOLE) | C9 |
| I-12 | Plan 04 `embedDemoInPr` refactor splits one function across two actors (unifier writes; PR phase composes); no flag-day path. CLAUDE.md forbids backward-compat. | council 04 F6 | S4 atomic |
| I-13 | `knownFeatureIds` is already implemented in `work-item.ts:113-115`; bench harness + `runProjectManager` just don't wire it. Plan 03 understates this as "confirm" rather than naming it as the load-bearing fix. | council 03 `eng:knownFeatureIds-already-implemented` | C5 |
| I-14 | `assertLocalRemoteSynced` at current dev-loop close is a bug fix on existing code (the comment at `developer-loop.ts:298-301` admits the assertion is missing). Plan 04 bundles it with the unifier instead of splitting. | council 04 F5 | S1.3 split |
| I-15 | Plan 02 PLAN.md location committed in "Files touched" but unresolved in Open Q2 — contradicting itself. | council 02 `eng:plan-md-location-collision` | C12 |
| I-16 | Plan 03 wants to remove hardcoded `min/max_work_items` from `initiatives.json` without a migration story for historical bench results. | council 03 `eng:initiatives-json-schema-change-undocumented` | C11 |
| I-17 | Plan 03's `files_real_or_explicitly_new` criterion is fuzzy NLP (then-clause text match); other criteria are deterministic. | council 03 `eng:files_real_or_explicitly_new-implementability` | C5 (tighten) |
| I-18 | Plan 05's auto-detect approve-vs-send-back has edge cases (approve-then-comment, stale approve, multiple reviewers) the plan glosses. | council 05 `eng:detect-approve-vs-sendback-race` | C16 |
| I-19 | Plan 05's `review-cursor.json` doesn't specify atomic-write semantics → mid-write crash could silently skip comments. | council 05 `eng:cursor-not-atomic-spec` | C16 (rename combined) → spec |
| I-20 | Plan 07's `cost_tick` makes the logger stateful (rolling sum keyed by cycle/WI) — violates ADR-008's single-writer / refs-not-contents discipline. | council 07 `eng:01-event-writer-contract-drift` | C14 |
| I-21 | Plan 07's `agent_heartbeat` emit site is Ralph runner; runner is async-blocked exactly when liveness matters most (silent SDK call). | council 07 `eng:04-heartbeat-emit-site` | C13 |
| I-22 | Plan 07's `_aliases.json` "atomic writes" don't handle daemon-vs-foreground race; hand-rolled file ops where `proper-lockfile` exists. | council 07 `dx:02-aliases-json-concurrency` | C17 |
| I-23 | `runCouncil()` programmatic SDK call returned `result` with no `structured_output` on every plan in this batch (the script in `scripts/council-refinement-plans.ts` failed end-to-end). This is council infrastructure itself wanting a robustness pass. | this batch's INDEX.md "Known issues" | Into S2 scope |
| I-24 | Recap-as-PR-comment is shared territory between plan 06 (defers it) and plans 04/05 (own PR surface). | plan 06 §"Post-cycle recap surface"; plan 04 §"PR-as-self-contained-review-window" | C15 |

### Scope-bundling decisions

| # | Conflict | Source | Lock |
|---|---|---|---|
| I-25 | Plan 01 bundles hygiene (#1-#5) with bench-growth (#6) + betterado seed (#7) — #6 depends on plan 06's reflector emit; #1-#5 don't. | council 01 CEO escalation | C18 + S1.2 / S5 split |
| I-26 | Plan 02 bundles plan-doc UX + bench reground + cross-phase handoff — different blast radii. | council 02 CEO escalation | S2A / S2B split |
| I-27 | Plan 06 bundles lint trigger + retention tagging (curation infra) with slash UX + recap (operator-facing). | council 06 `ceo:01-scope-cohesion` | S6A / S6B split |
| I-28 | Plan 07 bundles logging UX (multi-day, two new deps) with init IDs (one day, zero deps). | council 07 `ceo:01-bundled-scope` | S1.1 / S7 split |

(Note: items numbered to 28 because some inconsistencies count multiple
distinct sub-issues. Total findings the operator must touch: 28.)

## Contract decisions — ratified

The 19 contract decisions are locked. They live in
[CONTRACTS.md](./CONTRACTS.md) as the canonical source of truth.

Summary of operator overrides from the initial recommendations:

- **C1–C18 confirmed verbatim** (operator Q1).
- **C19 added** (operator Q2): remove budget mechanisms entirely. No
  `aggregate_budget_declared` gate, no auto-escalation, no `N` threshold,
  no $ caps in unifier, existing per-WI $ cap removed. Iteration caps
  stay; the aggregate-footprint line in PLAN.md becomes informational
  only.
- **CONTRACTS.md location** (operator Q3): next to the plans, not
  promoted to ADR.
- **Dogfooding project** (operator Q4): `terraform-provider-betterado`.

The full text of each decision (including rationale, schema, and
"Affects plans" lists) is in [CONTRACTS.md](./CONTRACTS.md). Below: the
one-line headline for each.

### Headlines

For each decision: the simplest-thing-that-could-work honouring the
forge north-star, drawn from the council critiques.

For the full text (rationale, schema, "Affects plans"), see
[CONTRACTS.md](./CONTRACTS.md). One-line lookup below.

| C-id | Decision (one-line) |
|---|---|
| C1 | Per-project config lives at `<project>/.forge/project.json` |
| C2 | Project-level demo field is `demo.shape` (not `demo.kind`) — avoids collision with `skills/demo/SKILL.md` |
| C3 | `pr-feedback.md` schema locked; unifier accepts `--feedback-ref`; cross-plan filename references normalised |
| C4 | Architect emits per-feature `quality_gate_cmd`, `non_goals`, `hard_constraints` (optional, omit-on-undefined) |
| C5 | PM emits per-WI `quality_gate_cmd`, `non_goals`, `verification_artifact`, `creates`; `demo_hook` is initiative-only; `knownFeatureIds` wired into bench + cycle as load-bearing deliverable |
| C6 | Init-ID handle = `<proj4>#<seq>` (e.g. `traf#7`) |
| C7 | Brain-lint supports `--scope cycle-touched-themes --cycle <id>` |
| C8 | Add sibling `lint_status` field; `reflection_status` enum stays ternary |
| C9 | `/forge-reflect` auto-invokes `--rerun` after writing `user-feedback.md` — closes the biggest UX hole |
| C10 | `benchmarks/_lib/handoff.ts` single canonical module; `downstream_pm_score` reads frozen PM rubric snapshot |
| C11 | PM bench `initiatives.json` parses both old + new shape for one release |
| C12 | PLAN.md lives at `projects/<project>/_architect/<session-id>/PLAN.md` |
| C13 | `agent_heartbeat` emits from SDK call wrapper, not Ralph runner |
| C14 | `cost_tick` emits from derived consumer (subscribes to `tee`), not the logger |
| C15 | Recap `_logs/<id>/recap.md` owned by reflect; recap-as-PR-comment owned by unifier (gated by `post_recap_to_pr` manifest field); `demo_hook` is initiative-level |
| C16 | Approve-vs-send-back decision table locked; cursor write is `tmp + rename`, parse-fail = `cursor=0` |
| C17 | `_aliases.json` mints use `proper-lockfile` |
| C18 | Plan splits: 01→01a/01b, 02→S2A/S2B, 06→S6A/S6B, 07→07a/07b |
| C19 | **Remove budget mechanisms entirely** (operator override Q2): no aggregate-budget gate, no $ caps in unifier, existing per-WI $1.0 cap removed, `cost_budget_respected` bench criterion removed. Iteration caps stay; `cost_usd` per-event logging stays. Operator: "We haven't seen instances of runaway spend and churn." |
| C20 | Brain has **two indexes**: Karpathy markdown wiki (narrative) + real `safishamsi/graphify` knowledge graph (structural — Python CLI, tree-sitter local, no API key). `brain-query` consults both. |
| C21 | `brain/graphify-out/graph.json` is canonical structural index (committed). Sibling artefacts (`graph.html`, `GRAPH_REPORT.md`, `cache/`, `manifest.json`) gitignored. `brain-lint` flags stale graph (older commit than HEAD). |
| C22 | Hand-authored `skills/brain-graph/SKILL.md` is the forge runbook over the real graphify CLI. Forge does NOT carry a graph shim (the S1.4 deterministic walker was deleted 2026-05-23 when the real CLI was installed). Forge does NOT install graphify's auto-skill globally. |
| C23 | Prompt caching default-on at every SDK call site (`cache_control: ephemeral`). 5-min default; PM brain index gets 1-hour. |
| C24 | Council uses **Haiku by default**, Sonnet for `eng` critic only. |
| C25 | Output style is **per-phase**: reflector (and pre-deletion reviewer) emit micro-caveman terse; dev-loop / architect / PM speak normally. NOT installed globally. |
| C26 | Holistic metrics + locked baselines onboarding clause: `.forge/project.json` `metrics.command` + `metrics.baselines_dir` + `metrics.tolerance_pct`. Architect reads, PM emits measurement WIs, dev-loop runs at gate time, reviewer cites score-delta. Visual confirmation non-optional for visual projects. |
| C27 | Architect emits `type: 'implementation' \| 'exploration'` discriminator. `exploration` manifests carry `parameter_space` + `hypothesis` + `metric_command` + `locked_baselines`; `iteration_budget` is a hint not contract. PM/dev-loop/reviewer/reflector all branch on `type:`. |
| C28 | `project-sweep` is a forge-provided abstract skill skeleton; per-project plug-ins via `.forge/project.json` `sweep.{start_command, draw_function, measurement_extractor}`. trafficGame's `runSweep.mjs` is the reference. |

## Stage-by-stage execution

Each stage is one operator session of work: ratify the contract, slice into
1-2 initiatives via `/forge-architect`, let the cycle run. Don't start a
stage until the previous stage's **join step** verifies.

### S0. Contract lock (operator only — no architect)

One sitting, ~1 hour. Cross-edit all 7 plans + the council reviews to
reflect ratified C1–C19. Ships as one PR:

```
docs(planning): lock cross-plan contracts for 2026-05-20 batch
```

**Deliverables:**
- Each plan's contradictory sections rewritten to point at the
  corresponding C-decision in `CONTRACTS.md`.
- This `EXECUTION-PLAN.md` updated with operator answers + C19.
- New `CONTRACTS.md` next to the plans containing C1–C19 verbatim,
  linked from every plan's "Dependencies" section.
- Plan 07 split into `07a-logging-ux.md` + `07b-init-ids.md`.

**Join to S1:** all seven plans + `EXECUTION-PLAN.md` + `CONTRACTS.md`
merged on `main`. Grep `04-developer-loop.md` returns zero hits in this
dir. Grep `forge.config.json` returns only ADR 009 + the example file.
Grep `demo.kind` (project-level) returns zero hits. Grep
`aggregate_budget_declared` returns zero hits.

### S1. Foundations (parallelisable — three small initiatives)

**S1.1 — Init-IDs (plan 07b)**
- Architect/PM: 07's "Init IDs" section only.
- Scope: `orchestrator/initiative-id.ts` (resolver), `_queue/_aliases.json`
  (registry + backfill script), `proper-lockfile` integration, integration
  tests, slash-command `argument-hint` rewrites in `.claude/commands/forge-*.md`.
- Tests: `initiative-id.test.ts` covering resolution, prefix collisions,
  atomic writes.
- Acceptance: every operator-facing command accepts the handle and behaves
  identically to the canonical.

**S1.2 — Brain hygiene 01a (plan 01 refinements #1-#5)**
- `orchestrator/brain-lint.ts` (executable), `orchestrator/brain-index.ts`
  (generator), `scripts/brain-scrub-test-contamination.ts` (one-shot), the
  6 lint checks (`checkFrontmatter`, `checkIndexSync`, `checkSourceLinks`,
  `checkStaleness`, `checkOrphans`, `checkLengthSoftCap`, `checkContamination`).
  Downgrade `checkContradictions` to warn-only stretch goal (council 01 flag).
- Bench: pass at 94.4% post-cleanup (no regression on questions.json).
- Acceptance: 126 `__chained_test_proj_*` dirs gone; `brain/INDEX.md` regenerated;
  `brain-lint` exits non-zero against today's corpus and clean after one
  operator pass.

**S1.3 — `assertLocalRemoteSynced` at dev-loop close (split from plan 04)**
- One-line wiring fix to existing bug at `developer-loop.ts:298-301`.
- Test: divergence throws + emits classified event.
- Stand-alone PR; not bundled with the unifier (council 04 F5).

**S1.4 — Graphify additive brain layer (plan 01 refinements #8-#10, per C20-C22)**
- Re-ingest the canonical Karpathy gist; archive the Pass-A synthesis.
- Install graphify, hand-author `skills/brain-graph/SKILL.md`, commit
  `brain/graph.json`, gitignore render artefacts (`graph.html`,
  `GRAPH_REPORT.md`).
- Rewrite `brain-query` to consult graph first, fall back to themes.
- Bench grows ~30% with ≥3 structural questions; existing 18 keep
  passing.
- Independent of S1.2 (additive). Parallelisable.

**Join to S2:**
- `forge review traf#7` resolves to the canonical ID and runs to completion.
- `forge brain lint` returns 0 against the cleaned corpus.
- `npm run bench:brain` ≥ 94.4%.
- `assertLocalRemoteSynced` is called at dev-loop close in HEAD; a synthetic
  divergence test fails as expected.

### S2. Architect (plan 02, split A then B)

**S2A — Plan-doc operator artifact (UX)**
- `orchestrator/architect-plan.ts` (renderer + feedback-comment parser).
- `forge architect commit <session-id>` subcommand (rename per council
  flag `dx:cli-naming-asymmetry`; previously `architect-commit`).
- Plan-doc emitted at `projects/<project>/_architect/<session-id>/PLAN.md`
  (per C12) with council transcript, escalation list, and an
  **informational** aggregate footprint (per C19 — no gate, no
  auto-escalation, no `N`).
- Default surface: local-edit with `<!-- review: -->` annotations;
  `--via-pr` opt-in.
- **Architect emits `type: 'implementation' | 'exploration'` discriminator
  (per C27)** — `implementation` is today's shape; `exploration` carries
  `parameter_space`, `hypothesis`, `metric_command`, `locked_baselines`
  and treats `iteration_budget` as a hint.
- **Architect reads `.forge/project.json` `metrics` block (per C26)** —
  when present, the PLAN.md surfaces the metric command + baselines
  alongside the manifest; the architect can propose exploration
  initiatives when the project has them.
- **Front-of-architect interview step (cwc amendment 1)** — architect
  MUST invoke `AskUserQuestion` ≥1 time, capped at 5 rounds. Captured
  as an "Operator brief + interview" section in PLAN.md. See
  [S2A-CWC-AMENDMENTS.md](./S2A-CWC-AMENDMENTS.md).
- **Sibling `PLAN.html` rich viewer (cwc amendment 2)** —
  `renderPlanHtml(session)` emits zero-dep static HTML next to PLAN.md:
  forge cycle diagram, escalation cards rendered side-by-side, stacked
  aggregate-footprint bar (informational only — C19), manifest
  drawers as `<details>`. PLAN.md remains the only parse target. See
  [S2A-CWC-AMENDMENTS.md](./S2A-CWC-AMENDMENTS.md).
- Acceptance: round-trip on the 8 synthetic fixtures preserves
  manifest parity (no regression); aggregate-footprint line appears in
  PLAN.md for the betterado-style multi-initiative case;
  `type: exploration` round-trips with a sample `metric_command` +
  parameter space; a real `/forge-architect` session emits PLAN.md
  with an `Operator brief + interview` section (≥1 Q/A row) and a
  PLAN.html sibling that opens in a browser.
- **Bundles the council-infrastructure robustness fix (I-23):** make
  `runCouncil()` survive ≥15k-char drafts + 30-turn budget; pin a snapshot
  of council output if SDK structured-output fails on retry.

**S2B — Bench reground + cross-phase handoff**
- New criteria (per C19, **without** `aggregate_budget_declared`):
  `project_context_lifted`, `escalations_resolved`, `downstream_pm_score`
  (with frozen-SHA pin per C10a), `specs_concrete_per_feature` (retained,
  halved weight), `brain_consulted_qualified`.
- B1 + B2 fixtures derived from real betterado manifests.
- `benchmarks/_lib/handoff.ts` written + tested (per C10).
- Acceptance: B1 + B2 FAIL against pre-S2A SKILL.md (proves discrimination);
  PASS against S2A SKILL.md; all 8 synthetic fixtures still PASS.

**Join to S3:**
- A real `/forge-architect terraform-provider-betterado` session emits one
  PLAN.md, zero `_queue/pending/` writes; `architect commit --approve`
  produces the manifests with per-feature `quality_gate_cmd`, `non_goals`,
  `hard_constraints` (per C4) populated.
- `npm run bench:architect` 10/10 (8 synthetic + B1 + B2).
- `benchmarks/_lib/handoff.ts` exports load functions; `loadArchitectHandoff('B1-betterado-substrate-only')`
  returns the manifest + plan-doc + transcript triple.

### S3. PM (plan 03)

- **Schema:** add C5 WI fields (omit-on-undefined). ADR 015 amendment.
- **`knownFeatureIds` wiring** (the load-bearing fix per I-13): wire into
  both the bench and `runProjectManager`.
- **Bench:** add `feature_id_in_manifest` gate, `one_creator_per_file`,
  `quality_gate_cmd_present`. Tighten `files_real_or_explicitly_new` to
  use the `creates: <path>` marker (C5).
- **Sizing band** in `pm-invocation.ts` user prompt: 1-3 WIs per feature;
  `feature_count..2*feature_count+2`; ceiling 8 unless manifest has >4
  features.
- **Hallucinated-FEAT behaviour** (Open Q3): hard error at validator with
  orchestrator catch + one retry against a prompt naming the manifest's
  feature IDs.
- **Bench fixtures:** keep all 5 curated + add 2 architect-handoff cases
  (one from B1 betterado-substrate, one from a trafficGame replay).
  Migrate `initiatives.json` per C11 (both shapes parseable for one
  release).
- Acceptance: 5/5 + 2/2 new = 7/7 on bench; replay of intersection-backpressure
  WI-snapshot scores < 0.7 (regression-detection works).

**Join to S4:**
- Running architect bench → PM bench end-to-end against `B1-betterado-substrate-only`
  produces a 4-5 WI decomposition with all `feature_id ∈ manifest.features`,
  per-WI `quality_gate_cmd` populated.
- `feature_id_in_manifest` gate trips on a synthetic FEAT-5 fixture.

### S4. Dev-loop unifier + Review shrink (atomic — one initiative)

**This is the largest landing**. Plans 04 + 05 ship as one initiative
because the `embedDemoInPr` refactor (I-12) and the reviewer-surface
deletion are inseparable.

**S4.1 — Project-config schema (precursor, small PR)**
- `.forge/project.json` schema (per C1/C2).
- `forge.config.json.example` (per-machine) renamed to clarify or kept
  with a header noting "per-machine only; per-project is `.forge/project.json`".
- Onboarding checklist in `docs/phases/developer-loop.md` (per council 04 F9).
- Five managed-project configs authored: trafficGame (`browser`),
  terraform-provider-betterado (`harness`), slugifier (`artifact`),
  healarr/simplarr/env-optimiser (TBD per F4 enumeration).
- Per-kind worked example in the docs.
- Acceptance: each managed project's `.forge/project.json` validates;
  the unifier (next sub-stage) can load it.

**S4.2 — Unifier sub-phase + demo contract + review router (one big initiative)**
- New `skills/developer-unifier/SKILL.md`.
- Unifier runs after per-WI Ralphs, owns `demo/<initiative-id>/` (tracked,
  born committed — no `.forge/demos/` shadow), authors PR body
  (`.forge/pr-description.md`), pushes, asserts `assertLocalRemoteSynced`.
- Iteration cap 3. **No $ cap** per C19 (removed; iteration cap is the only bound).
- Composed gates: `initiative_gate`, `demo_runs_clean`, `pr_self_contained`,
  `branches_in_sync`. Classified failure modes per council 04 F7:
  `dev-loop-unifier-gate-failed`, `dev-loop-unifier-demo-failed`,
  `dev-loop-unifier-branch-divergence`.
- **Existing per-WI $1.0 cap removed and `cost_budget_respected` bench
  criterion removed in the same initiative** (per C19); existing dev-loop
  bench re-weighted across remaining criteria.
- `embedDemoInPr` refactored to body-composer-only (signature change per
  council 04 F6); old `cpSync` step removed.
- **Review shrink (plan 05):** delete `orchestrator/reviewer-stage2.ts`,
  `reviewer-invocation.ts`, `reviewer-invocation.test.ts`,
  `reviewer-stage2.test.ts`, `skills/reviewer/SKILL.md`,
  `benchmarks/review-loop/`. Reduce `reviewer.ts` to ≤80 lines (thin
  scheduler-callback delegating to router).
- **New `orchestrator/review-router.ts`** (no LLM, ~200 lines): poll PR
  comments via existing `pr-verdict.ts` `gh` seam, dedup via cursor
  (atomic write per C16), write `_queue/in-flight/<id>.pr-feedback.md`
  (per C3 schema), enqueue dev-loop unifier with `--feedback-ref`.
- `/forge-review <id>` slash-command: auto-detect per C16 decision table.
- **Bench:** new `benchmarks/review-router/` (5 deterministic mock-`gh`
  fixtures, zero LLM cost). `benchmarks/developer-loop/` extended with
  `expected_unifier` block + 6 new criteria (council 05 flag
  `ceo:bench-retire-loses-historical-baseline` — those criteria move here).
  Add `artifact` + `harness` fixtures.
- `benchmarks/e2e/` reused unchanged in shape; simulator's send-back round
  now fulfilled by unifier.
- Recap-as-PR-comment hook per C15 (gated by manifest `post_recap_to_pr`).

**Join to S5/S6:**
- `npm run bench:developer-loop` 7/7 (5 existing + `artifact` + `harness`).
- `npm run bench:review-router` 5/5.
- `npm run bench:e2e` 1/1 score 1.0 against `slugifier-basic`.
- Operator completes a real betterado-01 cycle end-to-end with two slash
  invocations (`/forge-review <handle>` and `/forge-reflect <handle>`).
- `tsc --noEmit` clean after the reviewer deletions.

### S5. Brain bench evolution (01b refinements #6 + #7)

- Reflector emits `_logs/<cycle-id>/brain-bench-candidates.jsonl` (per
  C7 contract).
- `forge brain bench:promote --cycle <id>` interactive CLI.
- Gates: ≤1 promotion per cycle, ≤4 per month; bench accuracy must stay
  ≥94.4% post-promotion.
- Betterado seed: add 2 questions covering hard constraints
  (single-branch model, `betterado_` prefix surface).
- Acceptance: 20+/20 bench cases at ≥94.4%; reflector emits ≥1 candidate
  on a real cycle.

**Join to S6:**
- Bench-promote pipeline works on a real cycle's candidates.
- Betterado seed lands without dropping the global bench score.

### S6. Reflect (plan 06, split A then B)

**S6A — Lint trigger + retention tagging** (curation infra; AC1-2)
- `runReflector` calls `forge brain lint --scope cycle-touched-themes
  --cycle <id>` after agent exit; on missing executable, emit
  `reflector.lint-skipped` (per council 06 flag `eng:01`).
- New `lint_status: 'clean' | 'flagged' | 'skipped'` sibling field
  (per C8).
- Retention frontmatter on cycle archives (`load-bearing | interesting |
  routine`) per plan 06 §"Cycle archiving / retention tagging".
- Plan 01's cleanup playbook consumes retention as tier signal.
- Bench: `retention_assigned` + `lint_invoked` gates pass on all 5 fixtures.

**S6B — Slash UX + recap surface** (AC3-4)
- New `orchestrator/forge-reflect-cli.ts` (DI-extracted CLI module — per
  council 06 flag `dx:01` establishes the pattern for all slash-CLIs;
  exports `render(input)` + `writeOutput(input)`).
- `/forge-reflect <id>` renders recap + numbered questions + inline
  answer block; writes `user-feedback.md`; auto-invokes `forge reflect
  <id> --rerun` (per C9 — closes the I-11 UX hole).
- `_logs/<id>/recap.md` written by `runReflector` (orchestrator, not
  agent).
- Bench: `recap_emitted` gate.

**Join to S7:**
- A real cycle completes reflect → `/forge-reflect <handle>` opens with
  inline questions; operator answers; `user-feedback.md` written;
  reflector re-runs; themes updated; lint runs over cycle-touched themes;
  recap embeds via `gh pr comment` (if `post_recap_to_pr: true`).
- Bench reflection 5/5 + 2 new gates.

### S7. Logging UX (plan 07a)

After plans 04 + 05 + 06 have settled — the pretty-printer's
phase→colour map needs the unifier's new phase events stable.

- `pino-pretty` adapter (`orchestrator/logging-pretty.ts`) with the actual
  `messageFormat` string + `customLevels` map specified inline (council 07
  flag `eng:02`).
- Five new event types (`file_change`, `test_run`, `phase_transition`,
  `agent_heartbeat`, `cost_tick`).
- `agent_heartbeat` emitted from `loops/ralph/claude-agent.ts` SDK call
  wrapper (per C13).
- `cost_tick` emitted from derived consumer subscribed to `tee` (per
  C14).
- `file_change` source: tool-use stream (deterministic, per council 07
  flag `eng:03`).
- `blessed-contrib` TUI for `forge watch <id>`. Default no-id: auto-attach
  to single in-flight (per council 07 design escalation).
- `--plain` mode for SSH / pipe.
- `benchmarks/logging-ux/` (deterministic, zero LLM): coverage +
  pretty-printer-snapshot tests; demo replay script.

**Join to S8:**
- Operator watches a live betterado cycle through `forge watch <handle>`
  and articulates without re-reading code: current WI, current phase,
  last file changed, last test result, cycle cost, agent-idle age.
- Bench reflection 5/5; bench review-router 5/5; brain bench ≥ 94.4%.

### S8. Token economy (plan 08, per C23-C26)

Orthogonal to phase ordering — can ship any time after S2 stabilises
(caching against a moving prompt is annoying; let architect surface
settle first). C19 (no budgets) stands; this is the positive counterpart
(lower the natural cost, don't police it).

- **WI-1**: prompt caching across all SDK call sites (per C23). Highest
  single lever. ~1 day.
- **WI-2**: council model routing (per C24) — Haiku for `ceo`/`design`/`dx`,
  Sonnet for `eng`. ~0.5 day.
- **WI-3**: micro-caveman output directive on `skills/reflector/SKILL.md`
  (per C25). ~0.5 day.
- **WI-4**: one-shot caveman-compress of `CLAUDE.md`, `ARCHITECTURE.md`,
  `PRINCIPLES.md`, `brain/INDEX.md` with operator hand-review (per C26
  - the operator's pinned `feedback_destructive_instruction_preserve_intent`
  applies). ~0.5 day + review.
- **WI-5**: `benchmarks/token-economy/` ratcheting A/B harness. Surfaces
  `cache_read_input_tokens` + `cache_creation_input_tokens` in JSONL
  events. ~1 day.

**Join to closure of the refinement batch:**
- Cycle cost on `slugifier-basic` drops ≥40% vs the C19-baseline
  snapshot (today: $2.35).
- All 8 plans' acceptance criteria met.
- Brain at 19+/20 with structural questions; graphify graph fresh.
- Council infrastructure handles 20+k-char drafts.

## Dogfooding via betterado

The betterado roadmap has 20 pending initiatives; all wait on
`INIT-01-release-def-test-substrate` + `INIT-03-task-group-test-substrate`
which gate ~18 dependents.

**Drive the refinement using these two.** As each stage lands, re-run the
betterado work against the new surface:

1. After S2 (architect): run `/forge-architect terraform-provider-betterado`
   with the brief "queue INIT-01 only". Verify PLAN.md UX feels right;
   approve; one manifest queued.
2. After S3 (PM): let PM decompose INIT-01 against the locked manifest;
   verify 4-5 WIs with per-WI `quality_gate_cmd`.
3. After S4 (dev-loop + review): let a full cycle run INIT-01 unattended;
   demo is a `harness` shape; PR opens with `## Demo` showing the
   before/after test-pass table; operator reviews on GitHub;
   `/forge-review bett#1` for send-back if any; merge.
4. After S6 (reflect): close out; reflector writes themes; lint runs over
   cycle-touched themes; recap emerges.
5. After S5 (brain bench): promote any betterado-grounded brain-bench
   candidates; verify bench still ≥94.4%.
6. **Then** queue INIT-03 + INIT-02 + the remaining 17 unattended. By
   construction, if the cycle survived INIT-01 it should chew through the
   rest.
7. After S8 (token economy): re-run a betterado initiative with full
   prompt caching + model routing + memory-file compression live; verify
   cost-per-cycle dropped ≥40% vs the C19 baseline.

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Operator skips Stage 0 contract lock → first cycle hits a missing-contract bug | High | This doc opens with "ratify before slicing"; refuse to start S2 until C1–C19 are in `CONTRACTS.md` |
| Council infrastructure failure (I-23) recurs during S2's plan-doc round-trip | Medium | S2A explicitly bundles the robustness fix; if `runCouncil` fails, fall back to inline agent-driven critic chain (proven path — this batch's own councils used it) |
| S4 dev-loop + review atomic landing too large to land in one PR | Medium | Land as a stacked pair *with* squash-merge ban acknowledged (CLAUDE.md theme); first PR adds unifier + delete reviewer-stage2, second PR removes reviewer.ts shell — coordinated, single review window |
| `proper-lockfile` (C17) brings unwanted transitive deps | Low | Audit `npm install --dry-run`; alternative is in-process `Mutex` since daemon + foreground are same Node process tree |
| Heartbeat emit site (C13) misses silent SDK stretches on certain SDK versions | Low | Acceptance test in S7 plants a synthetic 30s sleep; assert ≥1 heartbeat event |
| PM bench `knownFeatureIds` fix (C5) breaks a currently-passing real cycle that snuck a stray feature in | Low | The four documented wedges all had FEAT-5-style hallucinations; failing fast surfaces the bug instead of paying $1.36 to discover it (per the intersection-backpressure log) |
| Plan-doc local-edit format collides with editor markdown linters | Low | `<!-- review: -->` is a stable HTML comment; verified safe with VS Code + Obsidian + GitHub web editor |
| Betterado walkthrough fails at S4 — refinement assumptions don't hold | Medium | The S4 join step requires a full betterado-01 cycle. If it fails, do not start S5; debug in S4 |

## Quick reference

- **Where the artifacts live:** `docs/planning/2026-05-20-refinement/`
- **Slicing into initiatives:** for each Stage, `/forge-architect forge`
  with the stage's brief copy-pasted as the user prompt.
- **Killing the batch early:** if at any join step the previous stage's
  acceptance criteria aren't met, stop and re-plan that stage rather than
  pushing forward; let the council surface what shifted.

## Operator answers (locked 2026-05-21)

1. **C1–C18 verbatim.** Ratified as-recommended.
2. **Aggregate-budget auto-escalation:** removed entirely. See C19 — no
   budget mechanisms added; existing per-WI $1.0 cap and
   `cost_budget_respected` bench criterion removed as part of S4.
3. **`CONTRACTS.md` location:** next to the plans (this dir). Not
   promoted to ADR.
4. **Dogfooding project:** `terraform-provider-betterado`. INIT-01 +
   INIT-02 walk as each stage lands.
