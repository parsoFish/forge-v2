---
area: architect
date: 2026-05-20
date_contracts_locked: 2026-05-21
date_trafficgame_amended: 2026-05-23
date_cwc_amended: 2026-05-24
status: contracts locked — see CONTRACTS.md; cwc amendments — see S2A-CWC-AMENDMENTS.md
contract_deps: [C4, C10, C10a, C12, C18b, C19, C26, C27]
---

# Architect refinement plan

> **Contracts locked.** This plan honours [CONTRACTS.md](./CONTRACTS.md).
> Where this plan and `CONTRACTS.md` disagree, `CONTRACTS.md` wins.
> Specifically: C12 (PLAN.md lives at `projects/<project>/_architect/<session-id>/PLAN.md`,
> Open Q2 closed), C19 (no `aggregate_budget_declared` gate, no Open Q4
> auto-escalation — aggregate footprint is **informational only**), C4
> (architect emits per-feature `quality_gate_cmd` / `non_goals` /
> `hard_constraints`), C10/C10a (`benchmarks/_lib/handoff.ts` +
> frozen-SHA PM-bench snapshot for `downstream_pm_score`), C18b (split
> into S2A operator UX, then S2B bench reground). Also incorporates
> I-23 (council infrastructure robustness fix — bundled into S2A).
> **Amended 2026-05-23 (trafficGame post-S0 learnings):** C26 (manifest
> carries `metric_command` + `locked_baselines` + `baselines_dir` when
> the project has them — per L1 holistic-metrics); C27 (architect emits
> `type: 'implementation' | 'exploration'` discriminator — `exploration`
> manifests carry `parameter_space` + `hypothesis` + `metric_command` +
> `locked_baselines` per L2 and treat `iteration_budget` as a hint not
> a contract per L9). See [LEARNINGS-trafficgame.md](./LEARNINGS-trafficgame.md).
> **Amended 2026-05-24 (cwc-workshops):** front-of-architect structured
> interview step (`AskUserQuestion`, ≤5 rounds, ≥1 mandatory) and a
> sibling `PLAN.html` rich viewer alongside `PLAN.md`. Both refinements
> are additive — S2A's locked surface (single operator artefact +
> annotation parse loop) is unchanged. See [S2A-CWC-AMENDMENTS.md](./S2A-CWC-AMENDMENTS.md)
> for the full text of the two amendments + operator decisions.

## Problem (grounded in cycles thus far)

The architect's 8/8 bench is **mechanical** ([`benchmarks/architect/scoring.ts:60-66`](../../../benchmarks/architect/scoring.ts)): `manifest_valid` (gate) + `specs_concrete` (0.4) + `scope_right_sized` (0.3) + `brain_consulted` (0.3). It says nothing about whether downstream cycles actually converge. Concrete misses observed:

- **betterado initiative drop (2026-05-18).** The architect (run unattended for a Go provider) emitted **20 initiatives in one shot** (`_queue/pending/INIT-2026-05-18-betterado-*`, INIT-01 … INIT-19). All 20 pass the bench. But the roadmap notes worst-case aggregate spend of **≈$534** (`projects/terraform-provider-betterado/roadmap.md:54`) — the operator has no plan-doc moment between "council ran" and "queue accepted everything". The bench's `scope_right_sized` only guards per-initiative size (≤5 features); it does not guard **per-session initiative count** or **aggregate budget**.
- **Council critiques aren't visible.** `council.ts` returns `{flags, escalations, perCritic, totalCostUsd}` but no event/log mechanism surfaces the per-critic reasoning to the operator for inspection. The escalation list is whispered in-conversation and lost the moment the session ends. The closest analogue we got working — PR-as-sole-review-window ([`brain/forge/themes/pr-as-sole-review-window.md`](../../../brain/forge/themes/pr-as-sole-review-window.md)) — proved exactly this point for the review phase: an artifact-on-disk is required for an iteration loop.
- **Project-specific constraints get copy-pasted in by hand.** Every betterado manifest body re-states identical "Council constraints (binding)" and "Scope — PM: stay inside this" blocks ([`INIT-2026-05-18-betterado-01-...md:83-99`](../../../_queue/pending/INIT-2026-05-18-betterado-01-release-def-test-substrate.md), and the same blocks in 02 and every other one). This is a strong signal these are **project-level** facts (belong in the brain, not 20× in manifests) — the architect failed to lift them.
- **Stale brain bites later phases, not the architect.** The trafficGame world-map arc ([`brain/_raw/cycles/2026-05-18_trafficgame-world-map-review-arc.md:51-55`](../../../brain/_raw/cycles/2026-05-18_trafficgame-world-map-review-arc.md)) had the architect run cleanly, but PM thrashed because brain themes contradicted current code. We added a preflight BRAIN-freshness warn, but the architect itself doesn't enforce or feed back when its premise is stale.
- **Bench fixtures are synthetic.** `benchmarks/architect/prompts.json` is eight hypothetical projects (`A1-oauth` for "simplarr", `A3-ci` for trafficGame, …). None replays the actual betterado / trafficGame ideation that we know shipped in production. The user feedback is explicit: "ground benchmarks in reality and reflect on cycles thus far."

## Current state

- [`skills/architect/SKILL.md`](../../../skills/architect/SKILL.md) — interactive skill. Mandates brain-query, calls `runCouncil()`, writes one or more `_queue/pending/INIT-*.md`, updates `projects/<n>/roadmap.md` per ADR 014.
- [`skills/architect-llm-council/SKILL.md`](../../../skills/architect-llm-council/SKILL.md) + [`council.ts`](../../../skills/architect-llm-council/council.ts) — CEO/eng/design/DX critics; returns `{flags, escalations}` to the calling architect. Console-only output today.
- [`benchmarks/architect/`](../../../benchmarks/architect/) — `prompts.json` (8 synthetic fixtures), `scoring.ts` (four-criterion deterministic rubric), `sdk.ts` (tempdir + read-only symlinks; non-interactive single-shot).
- [`.claude/commands/forge-architect.md`](../../../.claude/commands/forge-architect.md) — slash command, thin invoker.
- [`docs/decisions/014-roadmap-format.md`](../../../docs/decisions/014-roadmap-format.md) — locked roadmap schema; the architect appends rows.
- [`docs/phases/architect.md`](../../../docs/phases/architect.md) — phase doc, deliberately out-of-cycle.

## Proposed refinement

### Plan-doc operator artifact

**The architect emits a single, reviewable `PLAN.md`-shaped artifact before any manifests hit `_queue/pending/`.**

- **Format.** Markdown at `projects/<project>/_architect/<session-id>/PLAN.md` (`session-id = YYYY-MM-DDTHH-mm-ss`). Sections:
  - **Vision recap** — operator's brief, paraphrased back.
  - **Brain context** — every brain path read + one-line evidence summary (greppable trail).
  - **Council transcript** — one fenced block per critic (CEO / Eng / Design / DX) with raw `flags` + `escalations` from `runCouncil()`. Auto-resolutions are diffed inline (`~~before~~` → after).
  - **Proposed initiatives** — table mirroring [ADR 014](../../../docs/decisions/014-roadmap-format.md) columns + a **per-initiative drawer** with the full manifest body in a fenced code block (NOT yet written to `_queue/`).
  - **Aggregate footprint** — total iteration budget, total cost ceiling, expected cycle count, longest dependency chain. The 20-initiative betterado drop should produce a glaring "≈$534" line here.
  - **Open escalations** — taste decisions the council surfaced that the operator must resolve before any manifest is queued.
- **Location.** Tracked at `projects/<project>/_architect/` (currently ungitignored; the project repo owns it). Alternative considered: post as a draft PR on the *project* repo. Rejected for v1 — projects without a remote (early-stage) would fail; a local file is universal.
- **Comment loop.** Two acceptance modes:
  1. **Local-edit mode (default).** Operator opens `PLAN.md` in their editor, leaves `<!-- review: ... -->` HTML-comment annotations beside any line, plus a top-of-file `<!-- verdict: approve | revise | reject -->`. A `forge architect commit <session-id>` CLI ingests the file: on `approve`, manifests are written to `_queue/pending/` and roadmap rows appended; on `revise`, the inline review comments are bundled into `feedback.md`, the architect skill re-runs (re-invoking the council with that feedback as additional system context), and a new `PLAN.md` is emitted in the same session dir; on `reject`, the session is archived under `_architect/_archived/`.
  2. **PR-on-project mode (opt-in via `--via-pr`).** For projects with a remote, the plan-doc is opened as a draft PR on a `forge/architect/<session-id>` branch. Operator leaves PR review comments. `forge architect commit` reads `gh pr view --comments` and treats them as `feedback.md`. This is the **same shape** as the merged-and-proven [pr-as-sole-review-window](../../../brain/forge/themes/pr-as-sole-review-window.md) loop — closing the asymmetry where review iterates on a PR but architecture iterates in a transient chat.
- **Deliverable.** New CLI subcommand `forge architect commit <session-id> [--via-pr]`; new `orchestrator/architect-plan.ts` (plan-doc renderer + feedback-comment parser, ~250 LOC); SKILL.md updated so the architect's terminal step is **write `PLAN.md`, not write manifests**.
- **Files touched.** `skills/architect/SKILL.md`, `orchestrator/architect-plan.ts` (new), `orchestrator/cli.ts` (new subcommand), `.claude/commands/forge-architect.md` (update terminal step), `skills/architect-llm-council/SKILL.md` (return structured transcript blob, not just flags/escalations).
- **Acceptance test.** Round-trip: a synthetic plan-doc with two `<!-- review: -->` annotations and `<!-- verdict: revise -->` produces a `feedback.md` whose council re-run is observable in events; `<!-- verdict: approve -->` produces the same `_queue/pending/INIT-*.md` files the current architect does (parity gate).

### Council infrastructure robustness (I-23)

Bundled into S2A. The 2026-05-20 batch attempted to run all 7 refinement
plans through `runCouncil()` programmatically; every plan failed with
`council critic <name>: result message had no structured_output` under
the SDK structured-output contract for drafts ≥ 13k chars at 30-turn
budget. The councils were re-produced via an inline Agent-tool fallback
(same 4-critic chain shape, different transport).

- **Deliverable:** `skills/architect-llm-council/council.ts:runCouncil()`
  survives draft length ≥ 20k chars and a 60-turn budget without
  structured-output drops; on detection of an empty `structured_output`,
  the runner retries once with a tighter `messageFormat` (asking the
  critic to repeat its verdict as a fenced JSON block, then parses that
  fenced block); on second failure, the runner emits a
  `council.fallback-required` event with the raw last assistant
  message and routes the calling architect to the inline-Agent fallback
  path.
- **Files touched:** `skills/architect-llm-council/council.ts`,
  `skills/architect-llm-council/council.test.ts`, and a new
  `scripts/council-refinement-plans.ts` cleanup or removal (the failed
  one-off from the batch).
- **Acceptance:** running the refined `runCouncil` against this batch's
  EXECUTION-PLAN.md as a synthetic draft produces a verdict from each
  critic without falling back to inline-Agent.

### Benchmark regrounding

**Replace synthetic fixtures with real cycle replays + score the outcome, not the artifact shape.**

- **New criteria** (replace specs_concrete / scope_right_sized / brain_consulted with downstream-grounded ones; manifest_valid stays a gate). **Per C19, no `aggregate_budget_declared` gate**: the PLAN.md aggregate-footprint line remains as informational text, but it is not bench-scored and there is no auto-escalation threshold.
  - `project_context_lifted` (0.30) — for repeated boilerplate across ≥3 proposed initiatives in one session (council-constraints block, scope-guard block), at least one is referenced via a brain link rather than copy-pasted. Counts inline duplication and penalises.
  - `escalations_resolved` (0.25) — every council-surfaced escalation appears in `PLAN.md` AND has either a `<!-- review: -->` resolution OR is explicitly deferred ("Backlog phase 2"). No silent drops.
  - `downstream_pm_score` (0.30) — feeds the first manifest in the session into a **frozen-SHA snapshot of the PM bench rubric** at `benchmarks/project-manager/scoring.frozen.ts` (per C10a); takes its score as a sub-metric. The pin is updated explicitly when PM-bench shape changes — never incidentally.
  - `specs_concrete_per_feature` (0.10) — retained from current bench, weight halved (it's necessary but no longer sufficient).
  - `brain_consulted_qualified` (0.05) — current `brain/...` regex but additionally requires ≥1 cited path resolves to an existing file (existsSync check). Stops the architect from name-checking a path that doesn't exist.
- **Fixtures from betterado.** Two cycle-grounded fixtures derived from real `_queue/pending/INIT-2026-05-18-betterado-*.md` + the [betterado roadmap](../../../projects/terraform-provider-betterado/roadmap.md):
  - `B1-betterado-substrate-only` — fixture user_prompt = the real betterado brief; expected = ONE initiative (INIT-01 release-def-test-substrate) with FEAT-1..4 matching the as-shipped shape. Tests "the architect resists the 20-initiative drop when the operator's brief is narrow."
  - `B2-betterado-full-program` — fixture user_prompt = "queue the entire ADO 7.1 createable surface"; expected = the same 20 initiatives BUT `PLAN.md` must surface aggregate cost as informational text + must group the boilerplate council-constraints block into a project brain reference. Tests the new `project_context_lifted` + `escalations_resolved` criteria on the exact shape that motivated this refinement. (Per C19, aggregate-cost surfacing is informational only — no bench gate.)
- **Deliverable.** `benchmarks/architect/prompts.json` adds B1 + B2; `scoring.ts` extended with the new criteria + unit tests; new `benchmarks/architect/fixtures/betterado/` snapshot of the as-shipped manifests for diff-based scoring.
- **Acceptance test.** Re-running the bench on the current architect (no SKILL changes) must FAIL B1 + B2 — proving the new criteria actually measure something the old one missed. After SKILL refinement, B1 + B2 + the original 8 fixtures all pass. **Parity-gate fixture** (named per council 02 flag): one of the original 8 synthetic fixtures (e.g. `A3-ci`) is the explicit regression anchor — its expected manifest text is byte-identical pre/post refinement. B1/B2 are explicitly NOT parity gates.

### Cross-phase contract

**Architect-bench output → PM-bench input.** Today they're independent test suites with no shared artifact.

- **Contract shape** (markdown + accompanying JSON sidecar):
  - `benchmarks/architect/results/<iso>.json` already records per-fixture manifest paths.
  - Extension: add `bench_handoff: { fixture_id, manifest_path, plan_doc_path, council_transcript_path }` to each result entry.
  - New `benchmarks/_lib/bench-handoff.ts` exposes `loadArchitectHandoff(fixtureId)` → `{manifestText, planDoc, councilTranscript}` consumable by the PM bench's fixture loader.
- **PM-bench accepts handoff.** `benchmarks/project-manager/cases.json` gains an optional `from_architect: <fixture_id>` field; when set, the PM bench's fixture body is loaded from the architect bench's last successful run instead of a static fixture. The B1 betterado-substrate fixture becomes the canonical "architect → PM" round-trip case.
- **What's preserved.** Manifest body verbatim; the PLAN.md aggregate-budget summary (PM may want it as planning context); the council escalations *that were marked resolved* (so PM can't trip over an ambiguity the operator already settled).
- **Files touched.** `benchmarks/_lib/bench-handoff.ts` (new), `benchmarks/architect/score.ts` (write handoff JSON), `benchmarks/project-manager/cases.json` (optional `from_architect` field), `benchmarks/project-manager/sdk.ts` (resolve handoff if present).
- **Acceptance test.** Running `npm run bench:architect && npm run bench:pm` end-to-end with `from_architect: B1-betterado-substrate-only` produces a PM bench result for the real betterado-01 initiative shape. Score must be ≥0.7 (same threshold as the synthetic PM fixtures).

### Operator UX

**Slash-command flow today:** `/forge-architect <project>` → interactive Claude session → SKILL.md drives ideation → council runs in-session → manifests written direct to `_queue/pending/`. Operator's only chance to inspect is mid-conversation; afterwards the only artifact is N manifests.

**Proposed flow:**

1. Operator runs `/forge-architect <project>`.
2. Architect skill runs brain-query + council exactly as today.
3. **NEW:** skill writes `projects/<project>/_architect/<session-id>/PLAN.md` (+ `council-transcript.md`) — NOT to `_queue/pending/`.
4. Skill prints to the operator: "PLAN.md is ready at <path>. Review, leave `<!-- review: -->` comments inline, set top-of-file `<!-- verdict: approve | revise | reject -->`, then run `forge architect commit <session-id>` (or pass `--via-pr` to open it as a draft PR for richer comment threading)."
5. Operator reviews (in editor or PR UI). Annotates. Sets verdict.
6. `forge architect commit` reads the file, dispatches: `approve` → write manifests + update roadmap (today's behaviour); `revise` → bundle comments to `feedback.md`, re-run council with feedback, regenerate PLAN.md; `reject` → archive session.
7. Each `architect-commit` invocation emits `architect.plan-emitted` / `architect.plan-approved` / `architect.plan-revised` events to the JSONL log.

**Success looks like:** for the 20-initiative betterado drop, the operator gets a single PLAN.md showing the ≈$534 aggregate **before** any manifest hits the queue; can comment "split this — only queue 01 + 03 today, backlog the rest" inline; revise round produces a 2-initiative PLAN.md; approve writes only those two manifests. Total operator keyboard time: ~5 min.

**Files touched.** `.claude/commands/forge-architect.md` (terminal step now points at PLAN.md, not the queue), `skills/architect/SKILL.md` (terminal Outputs change), `orchestrator/cli.ts` (`architect-commit` subcommand), `docs/phases/architect.md` (flow diagram).

**Acceptance test.** Replay the betterado session interactively against a fresh checkout: the architect produces exactly one PLAN.md, zero manifests; after a synthetic approve, exactly the expected manifests appear; after a synthetic revise with two annotations, the council re-runs and a second PLAN.md exists in the same session dir.

## Use of betterado roadmap

The two refinement test cases are **INIT-2026-05-18-betterado-01-release-def-test-substrate** and **INIT-2026-05-18-betterado-03-task-group-test-substrate**.

- Why 01 and 03: they're the substrate initiatives (zero `depends_on_initiatives`) — every other betterado initiative gates on at least one of them. Refining on the substrate exercises the most-load-bearing slice of the queue, and a clean cycle on 01 unblocks 18 dependents for free.
- Why not just one: 01 is a *new test substrate for an existing resource* (release_definition has the code, lacks tests); 03 is *new test substrate for an existing resource* (task_group) but for a different package. Together they prove the architect's plan-doc + new bench criteria across the two distinct "substrate" shapes that bracket the rest of the program.
- The B1 + B2 architect-bench fixtures derive directly from these manifests (B1 = 01-only narrow brief; B2 = 20-initiative aggregate brief). The PM-bench handoff test consumes B1's emitted manifest to validate the cross-phase contract.
- These two are also the initiatives the operator wants to **actually run through a refined cycle next** — so any UX problem found in the refinement test cases is found before scaling to the other 18.

## Open questions for the operator

1. **Local-edit annotations vs PR comments as the default surface.** PR-comment review won big for the review phase ([`pr-as-sole-review-window`](../../../brain/forge/themes/pr-as-sole-review-window.md)). But the architect runs *out of cycle*, often before any project remote is configured. Default to local-edit with `--via-pr` opt-in (current plan choice) — revisit after one real cycle.
2. ~~Where does PLAN.md live?~~ **Decided (C12):** `projects/<project>/_architect/<session-id>/PLAN.md`.
3. **Should `revise` invalidate or amend?** When the operator says "revise", does the new PLAN.md fully replace the prior (clean slate, council re-runs free) or amend (council only addresses the diff, cheaper)? Amend is cheaper but risks drift; replace is honest but pricey on rich plans.
4. ~~Aggregate-budget threshold for auto-escalation.~~ **Decided (C19):** removed entirely. Aggregate footprint is informational only; no `N`, no auto-escalation.
5. **PLAN.md retention.** Keep all sessions forever under `_architect/`, or auto-archive on next session? They're a useful audit trail but also accumulate.
6. **Council critic count vs taste-decision quality.** Current four critics (CEO/eng/design/DX) auto-resolved every escalation in the betterado run (per `_queue/pending` boilerplate). Add critics if a real cycle surfaces blind spots — out of scope for the initial slice.

## Dependencies on other refinement plans

- **PM refinement plan** must accept the new `from_architect: <fixture_id>` handoff field in its bench's `cases.json` and resolve it via `benchmarks/_lib/bench-handoff.ts`. Without that, the cross-phase contract is half-wired and `downstream_pm_score` can't be computed.
- **Council output visibility via PR.** If the operator picks `--via-pr` as the default (open question #1), this depends on the [`pr-as-sole-review-window`](../../../brain/forge/themes/pr-as-sole-review-window.md) pattern being reusable as a library — currently it lives in `orchestrator/pr.ts` for the reviewer; we'd need to extract `embedDemoInPr`-style helpers to a shared `orchestrator/pr-as-window.ts`.
- **Brain-freshness preflight.** Architect's input quality depends on brain themes being current; the recently-landed `forge preflight` BRAIN-WARN (`brain/_raw/cycles/2026-05-18_trafficgame-world-map-review-arc.md:51-53`) must run **before** the architect's brain-query step, not just before a cycle. Soft dependency on a brain-refinement plan if one is being drafted.

## Acceptance criteria for THIS refinement

- **UX measurable.** Replaying the betterado session against the refined architect: operator-keyboard-time-to-queued-manifests drops below 5 minutes for a single-initiative case; for a 20-initiative case, the aggregate-spend line forces a `revise` round before anything hits `_queue/pending/`.
- **Bench discriminating.** Running the bench against the *current* (unrefined) SKILL.md produces a B1 + B2 score below 0.7 (proves new criteria measure new things); after refinement, all 10 fixtures (8 synthetic + B1 + B2) pass ≥ 0.7.
- **Round-trip artifact.** A `PLAN.md` with `<!-- verdict: approve -->` produces the same `_queue/pending/INIT-*.md` content the current architect produces for the same fixture (parity, no silent regression on what we already get right).
- **Cross-phase wire.** `npm run bench:architect && npm run bench:pm` with `from_architect: B1-betterado-substrate-only` chains successfully end-to-end and produces a PM-bench score ≥ 0.7 on the real betterado-01 shape.
- **Visibility.** Every council critic's `flags` + `escalations` appear verbatim in `PLAN.md` — `grep -c '### CEO critic' projects/*/​_architect/*/PLAN.md` returns 1 per session; the operator can audit any past architect run by reading a single file (no session-replay needed).
- **No new external deps.** Refinement uses git, the editor of operator choice, and (optionally) `gh` — all already required by forge. No new package added.
