# Brain — Operations Log

> Append-only log of significant brain operations: ingestions, theme-page creations, lint passes, structural changes.

Format:

```markdown
## [<YYYY-MM-DD>] <type> | <description>

<Optional 1-3 line context.>
```

Types: `ingest`, `create-theme`, `update-theme`, `lint`, `structural`, `seed`.

---

## [2026-05-10] structural | reflection phase closed — bench 5/5 in one pass; pass-1 closure of all six phases

**Outcome:** the reflection phase is closed end-to-end. Bench at **5/5 (100%)** on the **first** real run, every gate (`manifest_provided` / `log_parseable` / `retro_emitted` / `brain_consulted` / `no_brain_corruption`) and every weighted criterion (`themes_emitted` / `themes_evidence_grounded` / `theme_categories_balanced` / `cycle_archived` / `retro_three_sections` / `brain_gaps_addressed`) passing at 100%. Total spend **$3.68/run**; p95 cost $1.04, p95 elapsed 442s. With this closure, **all six phases of forge v2 (brain → architect → project-manager → developer-loop → review-loop → reflection) are closed for pass 1.**

**Suites & runners:**

- [`benchmarks/reflection/score.ts`](../benchmarks/reflection/score.ts) — 5 cases, concurrency 2, per-case cap $1.0–$1.5, session cap $8. ~$3.68/run. Diagnostic snapshot of emitted artifacts on each case (`log_dir_files`, `themes_dir_files`, `raw_cycles_dir_files`); `FORGE_BENCH_KEEP_TEMPDIR=1` retains tempdirs for inspection.
- [`benchmarks/reflection/scoring.ts`](../benchmarks/reflection/scoring.ts) — pure rubric. **Five** gates, **six** weighted criteria summing to 1.0, pass threshold 0.7. 41 unit tests in `scoring.test.ts` cover every gate + criterion + threshold edge case.
- [`benchmarks/reflection/sdk.ts`](../benchmarks/reflection/sdk.ts) — DI harness: tempdir + layered brain (mask `brain/projects/<project>/themes/` + `brain/_raw/cycles/` + `brain/log.md` as fresh writable; symlink everything else). 11 unit tests in `sdk.test.ts`.
- [`benchmarks/reflection/simulator.ts`](../benchmarks/reflection/simulator.ts) — file-based human-feedback shim (writes `user-feedback.md` from fixture canon; reads `user-questions.md` for diagnostic telemetry). 11 unit tests in `simulator.test.ts`.
- [`orchestrator/reflector-invocation.ts`](../orchestrator/reflector-invocation.ts) — shared system + user prompt builders, tool whitelist, `tallyToolUse`. Single source of truth for both bench and live cycle.
- [`orchestrator/cycle.ts:runReflector()`](../orchestrator/cycle.ts) — real SDK invocation. Fires after `runReviewer` returns `'merged'`; **log-and-continue** failure mode (a thrown reflector returns `'failed'` but does not change cycle's `status`; `CycleResult.reflection_status: 'closed' | 'failed' | 'skipped'` surfaces the outcome separately).
- [`skills/reflector/SKILL.md`](../skills/reflector/SKILL.md) — rewritten for direct-write brain (replaces the "via brain-ingest" language), event-name fixes (`user-question-emitted`, `theme-emitted`), file-based stage-2/3 handoff, and explicit "no queue mutation" constraint (the reviewer already moved the manifest).
- 63 new unit tests across this phase (41 scoring + 11 sdk + 11 simulator).

**Result on pass 1** (`benchmarks/reflection/results/2026-05-09T15-20-56-338Z.json`):

| Fixture | Score | Cost | Elapsed | Themes emitted | Notes |
|---|---|---|---|---|---|
| `slugifier-merged` | 1.0 | $0.71 | 226s | 3 (1 antipattern, 2 patterns) | Real e2e cycle log replayed; multi-feature with 1 send-back. |
| `send-back-loop-bash` | 1.0 | – | – | ≥1 antipattern under `simplarr/themes/` | Cross-project path resolution (non-TS). |
| `wedge-recovery` | 1.0 | – | – | ≥2 (antipattern + pattern) | Dev-loop wedge then fresh-context recovery. |
| `brain-gap-heavy` | 1.0 | – | – | ≥2 covering 4 gap-ids | Every gap-id resolved. |
| `clean-single-feature` | 1.0 | – | – | ≥1 pattern under `healarr/themes/` | Baseline healthy-cycle reference. |

(Per-case cost split not surfaced in the summary; total $3.68 across all five with concurrency 2.)

**Iteration trajectory** (1 pass; $3.68 total):

| Run | Pass rate | Criteria | What changed |
|---|---|---|---|
| 1 | **5/5** | every gate + criterion at 100% | First run after cases.json finalised. No iteration needed. |

(Pre-pass-1 development: one fixture-1-only smoke run at $0.69 hit `error_max_budget_usd` at $0.6 cap; bumped per-case cap to $1.0–$1.5 and re-ran with all five fixtures. Single-fixture smoke also exposed an early-cleanup-of-tempdir issue — added `FORGE_BENCH_KEEP_TEMPDIR=1` env flag for diagnostic runs.)

**Architectural decisions locked during this closure:**

- **Reflection runs only after `runReviewer` returns `'merged'`.** Skipping on `'ready-for-review'` or `'send-back-cap-exhausted'` means the cycle's `reflection_status` stays `'skipped'`. Reflection has nothing to reflect on without a merge.
- **Log-and-continue failure mode.** A thrown reflector cannot un-merge — the reviewer already moved the manifest to `_queue/done/`. Surfacing `reflection_status` separately keeps `CycleResult.status` load-bearing on the merge outcome (which operator alerting trees key on); reflection is observable telemetry, not a cycle gate.
- **The reviewer owns the queue move; the reflector does NOT.** Earlier SKILL.md said the reflector moves the manifest to `_queue/done/`; that was wrong. By the time reflection fires the manifest is already there. SKILL.md updated.
- **File-based handoff for stages 2 + 3.** The reflector writes structured questions to `_logs/<cycle-id>/user-questions.md`, then reads pre-populated `user-feedback.md`. Bench: simulator pre-writes feedback; production: human writes feedback before next cycle. No `AskUserQuestion`, no stdin transport — both are deferred to a future closure.
- **Direct file writes, not `brain-ingest` round-trip.** Reflector writes theme markdown directly with required frontmatter. The bench's `no_brain_corruption` gate enforces a subset of `brain/LINT.md` rules inline (frontmatter present + valid `category` + ≥ 1 resolvable evidence path). A future closure may switch to `brain-ingest` once that path is production-validated.
- **Evidence grounding is `existsSync`-verified, not keyword-grep.** Every theme's `## Sources` section must list ≥ 1 path that resolves to either `_logs/<cycle-id>/...` or `brain/_raw/cycles/<cycle-id>.md`. This is the load-bearing anti-vague-retro defence. Themes that can't cite resolvable evidence fail.
- **`theme_categories_balanced` enforces an antipattern when warranted, not always.** If `events.jsonl` contains a wedge or send-back signal, ≥ 1 theme must carry `category: antipattern`. Clean cycles auto-pass. Catches "everything labelled `pattern`" failure mode without punishing topic discovery on healthy cycles.
- **`brain_gaps_addressed` auto-passes empty gaps.** Fixtures with `brain-gaps.jsonl: []` don't get penalised for a non-existent gap-id. Only the brain-gap-heavy fixture has the criterion bite.
- **Brain isolation in the bench: layered tempdir.** Live `brain/` is symlinked into the tempdir read-through; the target project's `themes/` directory and `brain/_raw/cycles/` and `brain/log.md` are masked as fresh writable copies. Theme writes land in the tempdir; reads of unchanged files (INDEX, navigation indexes, prior themes for context) pass through. Fixed mid-closure: `brain/log.md` was initially symlinked through, so an early bench run leaked an entry into the live log. Now masked.
- **5-fixture diversity.** Real-cycle replay (`slugifier-merged`) + cross-project (bash via `simplarr`) + wedge signal (`wedge-recovery`) + gap stress (`brain-gap-heavy`) + healthy baseline (`clean-single-feature`). Each exercises a different rubric path; the rubric being green on all five is the discriminator that the bench measures distinct things.

**Why this phase landed in one bench pass when others took 2–7:** the rubric was specified upfront with the lessons of the prior closures (orchestrator-verified evidence checks, gate-then-criteria split, bench-vs-live shared invocation contract). The reflector's task — read events, write themes — is also the cleanest one-shot agent work in the pipeline (no Ralph loop, no quality gate, no PR mechanics). The agent's first-pass output was high-quality (concrete event-line citations, evidence-grounded themes, valid frontmatter).

**Cost summary across all six phase benches (pass 1):**

| Phase | Total iteration spend | Per-run cost | Notes |
|---|---|---|---|
| Brain | – | – | Seeding-driven, not cycle-driven. |
| Architect | – | – | 8/8 first run; small budget. |
| Project Manager | $6.30 | – | 3 passes. |
| Developer Loop | $2.67 | – | 2 passes; p95 iterations = 1. |
| Review Loop (per-phase) | $3.92 | $2.03 | 2 passes. |
| E2E integration | ~$30 | $2.35 | 14 passes (multi-feature expansion). |
| **Reflection** | **$3.68** | **$3.68** | **1 pass.** |

**What's next:** the closure of all six phases marks the end of pass 1. Future workstreams identified during the closure:

- **Stdin / CLI transport for stages 2 + 3.** Currently file-based only; production users must write `user-feedback.md` between cycles. A `forge reflect <cycle-id>` CLI with stdin prompts (mirror of the deferred reviewer-verdict CLI) would close the interactive loop.
- **`brain-ingest` sub-skill round-trip.** Switch direct-write to a nested `brain-ingest` invocation per theme. More architecturally pure (matches the original SKILL.md spec); requires `brain-ingest` to be production-validated and a way to invoke nested skills via the Agent SDK.
- **`brain-lint` script.** A real CLI for `brain-lint` (currently a SKILL only). The reflection bench's `no_brain_corruption` gate would shell out to it instead of inlining a subset of LINT rules.
- **More fixtures.** Browser/canvas project, multi-cycle continuity (does theme N+1 reinforce or contradict theme N?), pure-failure cycle (reviewer rejected, no merge → reflection skipped — exercise that path explicitly).
- **Cross-cycle pattern reuse.** With 5 phases × N cycles producing themes, validate that subsequent cycles' brain-queries find and cite prior themes. This is the core hypothesis of the project: pass-2 cycles should be cheaper / fewer iterations / fewer wedges than pass-1 cycles. The metric is the brain itself getting smarter.
- **Production pipeline.** Pass 1 is closed; pass 2 starts when a real (non-bench) initiative runs through all six phases unattended end-to-end. The pipeline is ready.

---

## [2026-05-10] structural | e2e bench expanded to multi-feature scope — full initiative shape (3 features, 6 WIs)

**Outcome:** the e2e bench's `slugifier-basic` fixture now exercises a complete initiative shape — 3 features, 6 work items spanning a real DAG (FEAT-1 core → FEAT-2 batch helpers + FEAT-3 options as parallel branches). Pass at score **1.0**, 1/1, $2.35, 2 rounds (1 send-back + approve). Prior closure had only single-feature decomposition; this expansion validates the full architect→PM→dev-loop→reviewer contract with realistic multi-feature parallelism.

**Why expand:** the prior closure's `slugifier-basic` declared a single `FEAT-1` and PM decomposed it into 3 WIs all under one feature. That covered multi-WI-within-a-feature but not the architect/PM contract's multi-feature-within-an-initiative shape. Real initiatives have ≥2 features each with several WIs.

**Suites & runners (delta from prior closure):**
- [`benchmarks/e2e/fixtures/slugifier-basic/manifest.md`](../benchmarks/e2e/fixtures/slugifier-basic/manifest.md) — expanded from 1 feature to 3 (FEAT-1 core slugify, FEAT-2 batch helpers, FEAT-3 configurable options). FEAT-2 and FEAT-3 each `depends_on: [FEAT-1]` but are independent of each other (sibling-parallel).
- [`benchmarks/e2e/cases.json`](../benchmarks/e2e/cases.json) — spec checks fanned out per-feature (4 FEAT-1 + 3 FEAT-2 + 3 FEAT-3 = 10 non-functional checks). PR signals expanded to include feature-tag mentions (`feat-1`, `feat-2`, `feat-3`). `max_rounds` raised from 2 → 3 (allows 1 prep + up to 2 send-back rounds for richer initiatives).
- [`benchmarks/e2e/fixtures/slugifier-basic/branch-state/.gitignore`](../benchmarks/e2e/fixtures/slugifier-basic/branch-state/.gitignore) — Ralph scratch (`PROMPT.md`, `AGENT.md`, `fix_plan.md`, `node_modules`) ignored so `git add -A` skips them and `git clean -fdX` only removes ignored files.
- [`benchmarks/e2e/fixtures/slugifier-basic/branch-state/tests/placeholder.test.ts`](../benchmarks/e2e/fixtures/slugifier-basic/branch-state/tests/placeholder.test.ts) — smoke test that **fails** until `src/slugify.ts` exists with a working `slugify` export. Drives the dev-loop's first WI to actually do work (without this, every WI exits Ralph on iter 0 because the gate trivially passes).
- [`tsconfig.json`](../tsconfig.json) — excluded `benchmarks/review-loop/fixtures` and `benchmarks/e2e/fixtures` from project typecheck (fixtures are intentionally incomplete seed code).
- [`orchestrator/cycle.ts`](../orchestrator/cycle.ts) — added `commitDevLoopBoundary()` safety net between `runDeveloperLoop` and `runReviewer`. Catches uncommitted dev-loop work that the agent skipped committing per-iteration. Also relaxed the dev-loop's "throw on any WI failed" check to "throw only on total failure" — partial dev-loop output is the reviewer's send-back loop's job to fill.
- [`benchmarks/e2e/sdk.ts`](../benchmarks/e2e/sdk.ts) — gh shim's pre-merge step changed from `git reset --hard HEAD && git clean -fdx` to `git add -A && git commit && git clean -fdX`. The reset was wiping the reviewer agent's uncommitted source files written during send-back rounds. Commit-not-reset preserves the work; `-fdX` (uppercase) only removes gitignored files (Ralph scratch), not all untracked.
- [`benchmarks/e2e/sdk.ts`](../benchmarks/e2e/sdk.ts) — round telemetry: `reconstructGateStateFromArtifacts` (read AGENT.md after merge) → `reconstructGateStateFromEventLog` (read durable JSONL events). The gh-shim's `git clean` removes `.gitignored` AGENT.md before bench scoring runs, so the worktree-based reconstruction always returned 0. Event-log-based reconstruction is durable.
- [`benchmarks/e2e/score.ts`](../benchmarks/e2e/score.ts) — `rounds` redefined as `verdicts.length` (actual simulator verdicts) instead of `invocations` (gate calls). Gate invocations include bailouts (gates red, artifacts missing) which shouldn't count as "send-back rounds" against the user-stated cap.

**Result on pass 7** (`benchmarks/e2e/results/2026-05-09T14-02-17-037Z.json`):
- 1/1 passed at score **1.0** (every criterion at 1.0).
- `rounds: 2` (1 prep + 1 send-back + approve = the simulator approved on round 2).
- Cost: $2.35; elapsed: 10.6 min.
- gh shim: `created: true, merged: true`. 26 tests pass per PR description.
- Post-merge spec: 10/10 non-functional checks pass; manifest_acs_pass true; all 5 PR signals present (`why`, `feat-1`, `feat-2`, `feat-3`, `demo`).

**Iteration trajectory** (7 multi-feature passes, ~$18 across all runs):

| Pass | Score | Outcome | Root cause / fix |
|---|---|---|---|
| 1 | 0.55 | merged, spec_satisfied=0 | First multi-feature run. Cycle merged but post-merge spec checks all failed. PM decomposed into 6 WIs but dev-loop didn't write src/ — placeholder.test.ts made `npm test` pass trivially, so every WI exited Ralph on iter 0. Boundary commit captured nothing. |
| 2 | 0.55 | same as pass 1 | Same root cause. Confirmed the placeholder-makes-gate-trivially-pass pathology. |
| 3 | 0 (failed) | dev-loop threw 1/7 | Replaced placeholder with **failing** smoke test (imports `slugify`, asserts `slugify('') === ''`). WI-1 (scaffold-only, doesn't write slugify) hit iteration budget → failed. Strict orchestrator threshold "throw on any WI failure" tanked the whole cycle. |
| 4 | 0.55 | merged, spec partial | Relaxed dev-loop's strict gate to "throw only on total failure". Cycle merged. But the gh shim's `git reset --hard HEAD` was wiping the reviewer agent's uncommitted source files. |
| 5 | 0.75 | merged, all specs pass, rounds=0 (false neg) | gh shim now does `git add -A && git commit` before checkout (preserves reviewer work). Real spec satisfaction passed. But `rounds=0` was a measurement bug — AGENT.md (gitignored) gets removed by `git clean` before the bench reconstructs round count. |
| 6 | 0.75 | same observability bug | Switched reconstruction to read from event log (durable JSONL). Result said `rounds=4` but verdicts in metadata = 1. Realised gate invocations include bailouts (gates red, artifacts missing) which shouldn't count toward user's "send-back rounds" cap. |
| 7 | **1.0** | clean | `rounds = verdicts.length`. `max_rounds: 3` (allows up to 2 send-backs before approve). Cycle merged on round 2 (1 send-back). All criteria green. |

**Architectural decisions taken during the iteration set:**
- **The smoke test must fail until WI-1 lands.** A passing placeholder means `npm test` (the dev-loop's gate) is trivially green, every WI exits Ralph on iteration 0, and zero work gets done. The fixing pattern: smoke test imports the WI-1 deliverable and asserts a minimal contract; until that deliverable lands, the gate stays red. Once WI-1 succeeds, all subsequent WIs trivially pass the project-wide gate — but that's OK because the reviewer's spec checks (and send-back loop) catch any missing per-WI work.
- **Dev-loop is allowed to ship partial output.** The reviewer's send-back loop is the gap-filler. Throwing on any WI failure was too strict — kills cycles where 1/N WIs fails (e.g., the scaffold WI when the seed already has scaffolding). Now `runDeveloperLoop` only throws on total failure (0/N completed); partial completion flows to the reviewer.
- **Commit pending work, don't reset, before the merge.** The gh shim's old behaviour (`git reset --hard HEAD`) was discarding the reviewer agent's uncommitted source files written during send-back rounds. New behaviour: `git add -A && git commit --allow-empty` preserves the work, then `git clean -fdX` (uppercase X = ignored-only) removes only Ralph scratch.
- **Round count = simulator verdicts, not gate invocations.** Gate invocations include bailouts (project gates red, demo bundle missing) — those aren't "send-back rounds" in the user's sense. `verdicts.length` measures the actual review interactions.
- **Telemetry must survive the merge.** `git clean -fdX` removes gitignored AGENT.md. Reading round count from worktree artefacts post-merge fails. Solution: orchestrator emits gate state to the durable JSONL event log; bench reads from there.
- **`max_rounds: 3` matches user intent of "2 send-back rounds".** 1 prep verdict + up to 2 send-back rounds + 1 approve verdict ≤ 3 actual verdicts (some prep verdicts are themselves the approve when the dev-loop nailed it).

**Per-fixture WI breakdown (pass 7):**
- PM emitted 6 WIs:
  - WI-1: Core slugify implementation (FEAT-1, no deps)
  - WI-2: SlugifyOptions type definition (FEAT-3, no deps)
  - WI-3: Core slugify test suite (FEAT-1, deps: WI-1)
  - WI-4: Batch helpers implementation (FEAT-2, deps: WI-1)
  - WI-5: Batch helpers test suite (FEAT-2, deps: WI-4)
  - WI-6: Options test suite + extended slugify (FEAT-3, deps: WI-1, WI-2)
- 33% of WIs runnable in parallel from the start (WI-1 and WI-2). FEAT-2 and FEAT-3 are sibling-parallel, honouring manifest's depends_on graph.

**What the bench still doesn't catch:**
- **Single-fixture coverage.** Still only `slugifier-basic`. Adding fixtures with different project shapes (Python lib, bash CLI, browser/canvas) is future work.
- **Dev-loop trivially-completes phenomenon.** With per-WI gates absent, only the WI that drives the smoke test green does real work; siblings exit on iteration 0. The reviewer's send-back loop catches missing work, but this is a workaround, not the right architecture. Future work: per-WI quality_gate_cmd in the WI schema.
- **Hallucinated PR descriptions.** PR descriptions sometimes claim more than the diff shows; the simulator's PR-signal check catches obvious cases but not subtle misrepresentation. Caveat acknowledged.

**Discriminator note (multi-feature edition).** Pass 7 is all-1.0, which would normally suggest leniency. Validated by the iteration trajectory: passes 1–6 each had specific failure modes the rubric correctly surfaced (`spec_satisfied=0` for missing files, `merged=0` for failed gh-merge, `converged_within_budget=0` for over-budget rounds). The rubric works.

**Total bench spend (multi-feature iteration set):** ~$17 across 7 e2e runs. Combined with the prior closure's $13.12 = ~$30 session total.

**What's next:** the **reflector** phase. Same closure shape — SKILL.md rewrite + invocation contract + `cycle.ts:runReflector()` + `benchmarks/reflection/` fixtures. Future e2e expansion: more fixtures (Python lib, bash CLI, browser/canvas), per-WI quality_gate_cmd in WI schema (eliminates the trivially-completes phenomenon), production CLI (`forge review <id>` for human-driven verdicts).

---

## [2026-05-09] structural | review-loop closed end-to-end (Ralph-shaped) + e2e bench landed (1/1 pass)

**Outcome:** stages 1+2 of the review-loop now run as a single Ralph loop on the initiative branch, with a verdict-gate-based stop condition. The autonomous portion of the pipeline (PM → developer-loop → review-Ralph → merge) has its first integration bench, scored 1/1 on a `slugifier-basic` fixture. Total iteration spend: **~$10.57** across 7 passes (+ a per-phase review-loop re-run at $2.55 to verify no regression).

**Architecture shift:** the prior closure shipped review stage 1 as a one-shot SDK call. Per the user's reframe, stage 1 + stage 2 collapse into a single review-Ralph runner — same generic `loops/ralph/runner.ts` that the dev-loop uses, parameterised by:
- **System prompt** = reviewer SKILL.md + Ralph-discipline notes
- **Iteration body** = "if `fix_plan.md` has unchecked send-back items, fix code & re-record demo & refresh PR; else (iter 1) prepare initial demo + PR draft"
- **Quality gate** = orchestrator-verified project gate **+** a verdict-provider call (`getVerdict`)
- **Iteration cap** = 3 (1 prep + ≤2 send-back rounds)

The verdict-provider is an injectable function — production: stdin prompt (deferred CLI); bench: simulator agent. Send-back feedback lands in `fix_plan.md` (Ralph-style state), NOT appended to WI specs (those are the dev-loop's contract from PM time).

**Suites & runners:**
- [`orchestrator/reviewer-stage2.ts`](../orchestrator/reviewer-stage2.ts) — stage-2 building blocks. `Verdict` / `VerdictContext` / `GetVerdict` types, `appendSendBackFeedback()` (writes Round-N blocks to fix_plan.md), `makeReviewerQualityGate()` (gate factory; runs project gate, asks getVerdict, dispatches feedback). 11 unit tests.
- [`orchestrator/reviewer-invocation.ts`](../orchestrator/reviewer-invocation.ts) — extended with `prepareReviewerWorkspace()` (mirror of `prepareDevWorkspace`), Ralph-aware iteration prompt, system-prompt notes about iteration discipline.
- [`skills/reviewer/SKILL.md`](../skills/reviewer/SKILL.md) — rewritten from "stage 1 only" to Ralph-loop reviewer.
- [`orchestrator/cycle.ts:runReviewer()`](../orchestrator/cycle.ts) — replaced one-shot SDK call with `runRalph` invocation. Wipes leftover dev-loop PROMPT.md/AGENT.md/fix_plan.md before stamping reviewer's (the dev-loop and review-Ralph share the same workspace files; without the wipe, the reviewer reads stale dev-loop content).
- [`benchmarks/_lib/recorder-shims.ts`](../benchmarks/_lib/recorder-shims.ts) — extracted VHS/NPX shim writers from review-loop SDK so the e2e bench reuses them.
- [`benchmarks/e2e/score.ts`](../benchmarks/e2e/score.ts) — fixture runner. Concurrency 1, session budget $25.
- [`benchmarks/e2e/scoring.ts`](../benchmarks/e2e/scoring.ts) — pure rubric. Gate `cycle_completed`; weighted: `merged` 0.40, `converged_within_budget` 0.25, `spec_satisfied` 0.20, `cost_within_budget` 0.10, `no_regression` 0.05. 12 unit tests.
- [`benchmarks/e2e/sdk.ts`](../benchmarks/e2e/sdk.ts) — tempdir setup. Real `git init` of the seed tree (main + initiative branch), recorder shims, **smart `gh` shim** that handles `pr create` (records `_pr-metadata.json`) and `pr merge` (`git reset --hard` + `git clean -fdx --exclude=node_modules` + `git checkout main` + `git merge --ff-only`). 7 unit tests.
- [`benchmarks/e2e/simulator.ts`](../benchmarks/e2e/simulator.ts) — human-simulator agent. Spec-driven verdict: pre-computed orchestrator-verified spec results are fed into the simulator's prompt, the simulator outputs `approve | send-back: feedback` as fenced JSON. Tools: Read only — never runs commands itself. 12 unit tests.
- [`benchmarks/e2e/cases.json`](../benchmarks/e2e/cases.json) + [`fixtures/slugifier-basic/`](../benchmarks/e2e/fixtures/slugifier-basic/) — single fixture for first pass (TS lib that converts strings to URL-safe slugs).
- 42 new unit tests across this phase (11 stage2 + 12 simulator + 7 e2e-sdk + 12 e2e-scoring). Full suite 284/284 green.

**Result on pass 7** (`benchmarks/e2e/results/2026-05-09T11-34-28-376Z.json`):
- 1/1 passed at score **1.0**.
- Every criterion at 1.0; rounds = 1 (simulator approved on first review).
- Cost: $1.18; elapsed 4.9 min.
- gh shim recorded: `created: true, merged: true, mergedBranch: initiative-INIT-2026-05-09-slugifier-basic`.
- Post-merge spec checks: 4/4 non-functional pass, manifest_acs_pass true, all 3 PR signals present (`why`, `edge case`, `demo`).

**Iteration trajectory** (7 runs, ~$10.57 across all runs):

| Run | Score | Outcome | What changed |
|---|---|---|---|
| 1 | 0.6 | merged-but-not-merged | First bench run with `maxTurns: 30` review-Ralph. Cycle returned `outcome: 'merged'` but gh shim's `merged: false` — orchestrator's outcome-vs-actual-merge was lying. |
| 2 | 0.6 | rounds=2, merge failed | Bumped maxTurns to 50 (no longer; the issue was the orchestrator). `gh pr merge` rejected because the verdict gate appends to AGENT.md after the agent's last commit, leaving a dirty working tree that blocks `git checkout main`. |
| 3 | 0 (early fail) | rounds=0, gh shim gates merge | Fixed gh shim: `git reset --hard HEAD && git clean -fdx --exclude=node_modules` before checkout. Also fixed the orchestrator to surface merge failures in the outcome enum. New failure: PM emitted 0 work items (transient API hiccup). |
| 4 | 0.15 | cap exhausted | PM came back. Dev-loop wrote `src/index.ts` (not `src/slugify.ts`). Spec checks looked for literal `src/slugify.ts` and found nothing — simulator kept sending back. Actual implementation was correct but spec greps were too strict. |
| 5 | 0 (early fail) | spec checks all red | Loosened spec-check globs to `src/` / `tests/` recursive. Dev-loop's quality gate (`npm test` against an empty `tests/` directory) wedged WI-1 because node:test errors when given an empty directory. |
| 6 | 0 (early fail) | dev-loop 3/3 wedged | Same root cause re-confirmed — added a placeholder test to the seed and changed `npm test` to glob `tests/**/*.test.ts` instead of bare `tests/`. |
| 7 | **1.0** | merged on round 1 | Clean run. PM produced 3 WIs, dev-loop completed all three, reviewer approved on first iteration. **All criteria at 1.0**. |

**Architectural decisions taken during the iteration set:**
- **Review-loop as Ralph (locked).** Same `loops/ralph/runner.ts` infrastructure as the dev-loop; the difference is the system prompt, the iteration prompt template (in `reviewer-invocation.ts`), and the gate function (in `reviewer-stage2.ts`). The runner's `qualityGate` was widened from `() => boolean` to `() => boolean | Promise<boolean>` to support async verdict-providers.
- **Send-back feedback lives in fix_plan.md, not WI specs.** WIs are the dev-loop's input contract (PM-time decisions). Review feedback is loop state. Putting it in fix_plan.md is consistent with how Ralph already works (count_open_fix_plan_items drives wedge-detection; the Ralph runner already reads/writes that file across iterations).
- **Verdict-provider abstraction.** `GetVerdict = (ctx) => Promise<Verdict>` separates verdict policy from mechanics. Production: stdin (deferred CLI). Bench: simulator. The orchestrator-side gate factory `makeReviewerQualityGate()` consumes any GetVerdict and handles project-gate-running + AGENT.md/fix_plan.md mutation uniformly.
- **Simulator never runs commands itself.** The bench harness pre-runs every spec check and feeds the structured results into the simulator's prompt. The simulator's job is the verdict (approve | send-back), not the verification — keeps it grounded in orchestrator-verified ground truth, not its own claim. Mirrors the orchestrator-verified-gates pattern.
- **PR create/merge split for bench-vs-live.** The agent never calls `gh`. The orchestrator calls `gh pr create --body-file` and `gh pr merge --merge --delete-branch` after the loop completes. In bench mode, the smart `gh` shim handles both locally (writes `_pr-metadata.json`, fast-forwards initiative branch into main). Bench tests workflow + merge correctness; production hits real GitHub.
- **Workspace-file wipe between phases.** `runReviewer` deletes leftover `PROMPT.md`/`AGENT.md`/`fix_plan.md` from the dev-loop before calling `prepareReviewerWorkspace` (which is idempotent per Ralph convention). Without the wipe, the reviewer reads stale dev-loop content and hallucinates its role — caught in pass 4.
- **Fixture seed must satisfy quality gate from the start.** The dev-loop's first WI runs `npm test` between iterations. If `tests/` is empty, `node --test tests/` errors and the WI wedges before any code is written. Fix: include a placeholder test in the seed; use a glob (`tests/**/*.test.ts`) instead of a bare directory in `package.json`'s test script. Caught in passes 5–6.

**What the bench didn't catch (acknowledged limitations):**
- **Single-fixture coverage.** Only `slugifier-basic` runs in this bench — TS lib, single feature. Adding Python lib / bash CLI / web-canvas fixtures is future work. With one fixture, every-criterion-at-1.0 is suggestive but not proof of rubric calibration.
- **Hallucinated demo content.** Same caveat as the per-phase review-loop bench — the simulator's keyword check is a heuristic, not a proof, and the simulator can be deceived by a plausible-looking PR description that doesn't match the diff.
- **Send-back path under-exercised on the passing run.** The simulator approved on round 1, so the send-back→fix→re-review path (which is the load-bearing addition over stage 1) wasn't exercised in pass 7. Earlier passes (run 2, run 4) DID exercise it: send-back fired, dev-loop fixed, simulator approved on round 2 (run 2) or kept sending back to cap exhaustion (run 4 — caused by spec-check bug). The path works; the rubric correctly handles cap-exhaustion (`converged_within_budget = 0`). Future fixtures should be deliberately tuned to reliably fail-on-round-1 to keep the path exercised.
- **No real GitHub integration tested.** Every `gh` call is shimmed locally. Real `gh` integration is a separate test path (manual, not in CI).

**Discriminator note.** Pass 7 has every criterion at 1.0, which would normally be a flag the rubric is too lenient. The pass-1-through-6 results validate that the rubric *does* discriminate:
- Pass 1: `merged = 0` (orchestrator merge failed) → score 0.6
- Pass 2: `merged = 0` (gh checkout failed) → score 0.6
- Pass 4: `converged_within_budget = 0`, `merged = 0`, `spec_satisfied = 0` → score 0.15
- Each gate/criterion fired correctly when violated. The rubric works.

**Total bench spend across iteration set:** ~$10.57 across 7 e2e runs + $2.55 for the per-phase review-loop re-verification = **~$13.12 total**. Sits below the $15–30 budget.

**Per-phase bench regression check.** The Ralph-loop reviewer rewrite required updating `benchmarks/review-loop/sdk.ts` to use `prepareReviewerWorkspace` + read `PROMPT.md` (instead of inlining `renderReviewerUserPrompt`). Re-ran the per-phase bench: 5/5 still pass at $2.55 with similar criterion pass-rates (one criterion — `pr_links_demo` — dropped to 0.8, an actually-better-discriminating outcome than the prior all-100% pass).

**What's next:** the **reflector** phase. Same closure shape as this one: SKILL.md rewrite + `orchestrator/reflector-invocation.ts` + `cycle.ts:runReflector()` real implementation + `benchmarks/reflection/` bench fixtures + closure log entry. The reflector consumes merged initiative outputs (the `_queue/done/` manifest + the merged main branch + the cycle's event log) and emits brain updates. After reflector lands, we have the full PRINCIPLES.md cycle: ideate → decompose → develop → review-merge → reflect → ingest. Future e2e expansion: more fixtures (Python lib, bash CLI, browser/canvas via Playwright), production CLI (`forge review <id>`), and architect-bench-output → e2e-fixture-manifest piping.

---

## [2026-05-09] structural | review-loop phase (stage 1) closed — bench 5/5 in two passes

**Outcome:** all five fixtures pass at threshold 0.7 with every weighted criterion at 100% on pass 2. Total spend across the iteration set: **$3.92** ($1.89 pass 1 + $2.03 pass 2). The review-prep stage of the review-loop is now wired end-to-end — bench, shared invocation contract, and live cycle integration. Stage 2 (interactive human review + send-back) is deliberately deferred to a separate closure.

**Suites & runners:**
- [`benchmarks/review-loop/score.ts`](../benchmarks/review-loop/score.ts) — fixture suite (5 cases). Concurrency 2, session budget $5, wall ~5 min/run, ~$2.0/run on pass 2.
- [`benchmarks/review-loop/scoring.ts`](../benchmarks/review-loop/scoring.ts) — pure rubric. **Two gates** (`quality_gates_pass`, `pr_only_when_green`) plus seven weighted criteria summing to 1.0: `demo_recording_present` 0.15, `demo_exercises_acceptance_criteria` 0.20, `pr_description_why_not_what` 0.20, `pr_description_length_floor` 0.10, `pr_links_demo` 0.10, `merge_strategy_respected` 0.15, `brain_consulted` 0.10. Pass threshold 0.7. 35 unit tests under `scoring.test.ts` covering each criterion's pass/fail boundary plus the stacked-PR squash-detection unit test.
- [`benchmarks/review-loop/sdk.ts`](../benchmarks/review-loop/sdk.ts) — DI-friendly SDK shim. Each fixture runs in its own tempdir with read-only symlinks to `brain/`, `skills/`, `docs/`, `orchestrator/`, `loops/`. Bench tempdir's `bin/` carries three PATH stubs: a `gh` stub that exits non-zero (defense against accidental real PRs), a `vhs` stub (node script that produces a 60 KB mp4/webm/gif with valid magic bytes), and an `npx` stub that handles `playwright test` (writes a 60 KB `recording.trace.zip` with PK header). 9 unit tests under `sdk.test.ts`.
- [`orchestrator/reviewer-invocation.ts`](../orchestrator/reviewer-invocation.ts) — shared contract. `buildReviewerSystemPrompt(brainCwd)` + `renderReviewerUserPrompt(input)` + `tallyToolUse(msg, summary)` + tool whitelists (`Read`, `Grep`, `Glob`, `Write`, `Edit`, `Bash`; `WebFetch`/`WebSearch` blocked). Single source of truth — bench reflects production exactly.
- [`orchestrator/cycle.ts:runReviewer()`](../orchestrator/cycle.ts) — real implementation (replaced the no-op stub at lines 495-514). Pattern follows `runProjectManager()` (one-shot SDK call, not a Ralph loop). Steps: brain query via system prompt → render user prompt → SDK query → tally tool use → re-run quality gate orchestrator-side → (if green) `gh pr create --body-file`, move manifest to `ready-for-review/`, fire desktop notification per ADR 013. Throws if quality gates red OR `pr-description.md` missing.
- [`docs/decisions/016-demo-recording-tooling.md`](../docs/decisions/016-demo-recording-tooling.md) — ADR locking the tooling decision: **VHS** for terminal/CLI/lib/REST demos, **Playwright** for browser/canvas. Demo bundle layout (`source.<tape|spec.ts>` + `recording.<mp4|webm|gif|trace.zip>` + `README.md`). The source script is itself the manifest — no separate `.demo.yaml`.
- [`skills/reviewer/SKILL.md`](../skills/reviewer/SKILL.md) — rewritten from the 80-line stub. Specifies stage 1 only (stage 2 explicitly deferred), the demo bundle layout, the hard rule "do not write `pr-description.md` until quality gates pass", the AC-keyword-presence requirement for demo source.
- 44 new unit tests across this phase (35 scoring + 9 sdk).

**Result on pass 2** (`benchmarks/review-loop/results/2026-05-09T09-29-50-595Z.json`):
- 5/5 fixtures passed at score **1.0** (perfect on every dimension).
- Criterion pass rates: all 9 (2 gates + 7 weighted) at 100%.
- p95 elapsed ~142s; total cost $2.03; per-fixture cost $0.32–$0.49 (within the $0.6 cap).
- Per-fixture: env-optimiser-redact-argv (Python, 114s, $0.37, PR 2822 ch / why 1023 ch), trafficGame-distribute-flow (TS, 142s, $0.49), simplarr-dry-run (bash, 129s, $0.43), GitWeave-multipart-stub (TS, 137s, $0.42), healarr-quickstart-readme (REST/doc, 142s, $0.32). Brain reads per fixture 7–9.

**Iteration trajectory** (2 runs total, ~$3.92 across all runs):

| Run | Pass rate | Pass criteria | What changed |
|---|---|---|---|
| 1 | 2/5 (40%) | env-optimiser ✅, trafficGame ✅, simplarr ❌, GitWeave ❌, healarr ❌ | First live run with `maxTurns: 30`. Three fixtures hit `error_max_turns` after running brain queries + quality gates + recording but before drafting `pr-description.md`. The two passing fixtures (env-optimiser, trafficGame) finished within turn budget. Cost $1.89 / $5. |
| 2 | **5/5 (100%)** | all ✅ | Bumped `maxTurns` 30 → 50 in `sdk.ts`; raised healarr's per-fixture cap $0.40 → $0.60 (the rest already at $0.60). Every fixture completed in ≤142s well within the new turn budget. Cost $2.03 / $5. |

**Architectural decisions taken during the iteration set:**
- **VHS + Playwright + bundle layout locked** — see [ADR 016](../docs/decisions/016-demo-recording-tooling.md). VHS is the default; Playwright is reserved for actual rendered UI. The source script (`source.tape` or `source.spec.ts`) is its own manifest — no separate `.demo.yaml`.
- **Two gates instead of one.** `quality_gates_pass` is the obvious gate; `pr_only_when_green` is the structural defense against "ship a PR despite red gates" — score = 0 when `pr-description.md` exists but gates failed. The plan agent flagged this as the single most important addition; we kept it.
- **Bench-vs-live PR creation split.** The agent never calls `gh pr create` — it writes its draft to `<worktree>/.forge/pr-description.md`. The orchestrator (`cycle.ts:runReviewer()`) reads the file post-agent and calls `gh pr create --body-file <path>` against the real remote. The bench reads the same file for scoring without ever calling `gh`. Mirrors the dev-loop pattern where the orchestrator owns "outside the worktree" actions (queue movement, notifications, PR creation).
- **Bench-tempdir tool isolation via PATH-shims, not env-var gating.** The bench writes `<tempdir>/bin/{gh, vhs, npx}` and prepends to PATH. The `gh` shim exits non-zero to defend against accidental real PRs (with `GH_TOKEN=invalid` as backup). The `vhs` and `npx` shims produce stub recordings with valid magic bytes (60 KB padded mp4/gif/webm/trace.zip). This separates the agent's *workflow* (write tape, invoke recorder, draft PR) from the *fidelity* of the rendered video — the bench tests workflow; production installs real VHS for fidelity.
- **AC-keyword-presence as a heuristic, not proof.** `demo_exercises_acceptance_criteria` greps the demo source for each WI's `then`-clause keywords (case-insensitive, stopword-stripped, ≥4-char tokens, OR-within-AC, AND-across-WIs). Not a semantic check; the human-review stage handles "demo actually demonstrates the right thing." This is the same shape as PM's `no_hidden_coupling` check.
- **Demo recording tool selection by project_type.** `cases.json` carries `project_type: 'browser' | 'cli' | 'lib' | 'rest'`; the user prompt picks Playwright for `browser` and VHS for everything else. All five fixtures in this bench use VHS (no real Playwright in the bench tempdir; the npx-playwright shim catches any agent that picks it anyway).
- **No sixth stacked-PR fixture.** Stacked PRs are an antipattern, not a normal scenario — `merge_strategy_respected` is a guard, not a feature. The criterion is exercised by a unit test in `scoring.test.ts` that constructs a synthetic PR description with `Parents:` + `Merge strategy: squash` and asserts the criterion fires. Live-Claude budget is preserved for genuinely informative cases.

**What the bench didn't catch (acknowledged limitations; the human-review stage covers these):**
- **Hallucinated demo content** — the agent could write a tape that *looks* like it exercises the WI but doesn't actually demonstrate the observable AC outcome. Keyword presence is a heuristic.
- **PR description with correct sections but lying about the diff** — "This PR adds X" when the diff doesn't add X. Same shape; same fix.
- **Demo recorded against a stale build** — VHS captures the script's commands, but the underlying binary may have been built before the agent's last fix. Defensible only by the bench re-running the agent's commands itself, which is expensive.

**Discriminator note.** Pass 2 has every criterion at 100%, which would normally be a flag that the rubric is too lenient. The pass-1 results validate the rubric *does* discriminate: three fixtures hit `error_max_turns`, wrote no PR draft, and the rubric correctly scored them at 0. The criteria pass-rates on pass 1 were 0.4/0.4/0.4/0.4/0.4/0.4/0.4 (every weighted criterion at 40% = exactly the 2/5 fixtures that completed). The two-gate structure (especially `pr_only_when_green`) plus the AC-keyword check have the most discriminating power — both fired correctly when the agent ran out of turns.

**Total bench spend across iteration set:** $3.92 across 2 runs (cf. PM $6.30 / 3 runs, dev-loop $2.67 / 2 runs). Sits between the two prior phases as expected — heavier rubric than dev-loop, but more constrained per-fixture work than PM.

**What's next:** stage 2 of the review-loop (interactive human review + send-back loop dispatching the developer-loop with new acceptance criteria). User has indicated stage 2 lands in the same session as a separate plan after this closure. After that, the **reflector** phase: `SKILL.md` rewrite + bench fixtures + `cycle.ts:runReflector()` real implementation + closure log entry. Same shape as this closure validates the pattern.

---

## [2026-05-04] seed | Pass A bootstrap — Input #1: forge2.0 architecture (in-repo)

Ingested the v2 self-source: 13 ADRs, 6 phase docs, ARCHITECTURE.md, PRINCIPLES.md.

**Raw appended (21):** `_raw/docs/adr-001..013-*.docs.md`, `_raw/docs/forge-v2-architecture.docs.md`, `_raw/docs/forge-v2-principles.docs.md`, `_raw/docs/forge-v2-phase-{brain,architect,project-manager,developer-loop,review-loop,reflection}.docs.md`.

**Themes created (25):** 21 patterns, 2 reference, 1 decision, 1 antipattern. See `forge/patterns.md`, `forge/antipatterns.md`, `forge/decisions.md` for the full list.

**Indexes updated:** `forge/patterns.md`, `forge/antipatterns.md`, `forge/decisions.md`, `forge/operations.md`, `INDEX.md`.

**Outstanding broken theme links** (will resolve as Pass A inputs #2-7 land): `theme-page-format`, `gstack-conventions`, `alternative-loop-runtimes`, `eval-driven-development`, `cost-aware-model-routing`, `dependency-ordered-work`.

---

## [2026-05-04] seed | Pass A bootstrap — Inputs #2-5: Karpathy + Ralph references + Claude SDK + gstack

Ingested external reference material via WebFetch (Karpathy gist 404'd → synthesised; rest fetched).

**Raw appended (7):** `_raw/web/karpathy-llm-wiki.chat.md`, `_raw/web/ralph-{ghuntley,humanlayer-history,anthropic-plugin,vercel-agent}.web.md`, `_raw/docs/claude-agent-sdk-typescript.docs.md`, `_raw/web/gstack-readme.web.md`.

**Themes created (6):** `theme-page-format` (operation), `gstack-conventions` (reference), `declarative-specs-vs-imperative` (pattern), `ralph-stop-hook-vs-bash-loop` (pattern), `claude-sdk-subagents` (pattern), `claude-sdk-hooks-system` (pattern).

## [2026-05-04] seed | Pass A bootstrap — Input #6: Alternative loop runtimes

Ingested profiles for Aider (fetched), OpenHands (fetched), OpenClaw + Hermes (synthesised — canonical pages not fetched at ingest time).

**Raw appended (3):** `_raw/web/aider-overview.web.md`, `_raw/web/openhands-overview.web.md`, `_raw/web/openclaw-hermes-profiles.chat.md`.

**Themes created (1):** `alternative-loop-runtimes` (reference).

## [2026-05-04] seed | Pass A bootstrap — Input #7: Generic agentic-engineering best practices

Ingested practitioner-consensus patterns (TDD, spec-driven, dependency-ordered, eval-driven, cost-aware routing) — synthesised into one consolidated raw source plus per-pattern theme pages.

**Raw appended (1):** `_raw/web/agentic-engineering-best-practices.chat.md`.

**Themes created (5):** `tdd-with-agents`, `spec-driven-development`, `dependency-ordered-work`, `eval-driven-development`, `cost-aware-model-routing` (all patterns).

## [2026-05-04] structural | Added forge/reference.md category index

Created `forge/reference.md` to index theme pages with `category: reference` (six-phases-of-forge, v1-vs-v2-key-differences, gstack-conventions, alternative-loop-runtimes). LINT rule 2 requires every theme to be indexed in its category once; without `reference.md` the four reference themes were orphaned.

## Pass A — final state

- **Raw layer:** 30 files (`_raw/docs/` × 22, `_raw/web/` × 8).
- **Theme pages:** 33 — 25 patterns, 4 reference, 1 decision, 1 antipattern, 1 operation, plus 1 in-progress that touches multiple categories.
- **Category indexes:** `patterns.md`, `antipatterns.md`, `decisions.md`, `operations.md`, `reference.md` populated.
- **Outstanding broken links:** all resolved.

## [2026-05-04] seed | Pass A — benchmark questions populated

Wrote 10 benchmark questions to `benchmarks/brain/questions.json` covering Ralph + SDK runtime, brain structure, LLM Council, brain-first discipline, scheduler + recovery, squash-merge antipattern, Ralph stop conditions, model routing, alternative loops, and v1 vs v2 differences. Each question names ≥1 expected source theme + keywords.

## [2026-05-04] lint | Pass A — structural validation

Ran ad-hoc structural checks (the brain-lint skill isn't yet wired against the live brain — its `SKILL.md` is the spec, not yet executable):

- ✅ 33 raw files in `_raw/{docs,web}/`.
- ✅ 37 theme files, all with valid frontmatter.
- ✅ All themes ≤ 60 lines (one originally at 62 was trimmed).
- ✅ Zero broken theme cross-links (checked `./<slug>.md` references).
- ✅ Zero orphans — every theme appears in its declared category's index (`patterns.md`, `antipatterns.md`, `decisions.md`, `operations.md`, `reference.md`).
- ✅ `npm run bench:brain` runs cleanly with 10 cases (harness wired; live `brain-query` invocation is a documented TODO in `score.ts`).

## Pass A — done

All seven inputs from `docs/seeding-plan.md` § Pass A are ingested. The brain has substance, structure, and a benchmark question set. Live-evaluation accuracy (the ≥80% success signal) requires `score.ts` to be wired against `brain-query` via the Claude Agent SDK — a separate, post-scaffold piece of work that can be done in any subsequent session.

**Next workstream**: Pass B — ingest v1 wiki at `~/sideProjects/.forge/wiki/` and existing-project state from `~/sideProjects/projects/`. Per the seeding plan, this happens *after* Pass A validates the brain tooling, which it now has at the structural level.

---

## [2026-05-04] seed | Pass B — re-themed v1 wiki + existing projects

Pass B per [`docs/seeding-plan.md`](../docs/seeding-plan.md): durable v1 lessons re-themed under v2's conventions (rejecting v1-specific infrastructure themes); existing managed projects each get a `profile.md` + a small theme set.

**v1 wiki re-theming (input 1):**

- **Snapshotted** durable v1 themes into 4 consolidated raw extracts at `_raw/v1-wiki/v1-themes-{design-and-merge,cost-and-cache,failure-modes,completion-stats}.cycle.md`. The full v1 wiki at `~/sideProjects/.forge/wiki/` remains untouched; these are preserved excerpts with provenance.
- **Created 11 new v2 forge-level themes** from durable v1 lessons: `design-is-the-bottleneck` (pattern), `layered-merge-order` (pattern), `health-check-protocol` (operation), `prompt-caching-strategy` (pattern), `conditional-core-values` (pattern), `wiki-over-truncated-context` (pattern), `work-item-completion-by-domain` (pattern), `roadmap-simplification-convergence` (pattern), `rate-limit-no-backoff` (antipattern), `agent-stuck-no-detection` (antipattern), `review-fix-loop-spinning` (antipattern), `episodic-not-cumulative-learnings` (antipattern), `forge-never-self-modifies` (operation).
- **Updated 4 existing themes** with v1 data points: `squash-merge-stacked-prs` (Cycle 2 trafficGame: 90 test failures + 12 TS errors after 8 squashed PRs), `cost-aware-model-routing` (87% cost-reduction + 92% cache hit-rate evidence), `tdd-with-agents` (109-item Cycle-3 floor + trafficGame's 48% failure rate), `quality-gates-orchestrator-verified` (cross-system Ralph/Goose/AI-Maestro evidence).
- **Rejected v1-specific themes**: `three-agent-model`, `orchestrator-sole-coordinator`, `hierarchical-beats-peer-to-peer`, `file-based-state` (v1's specific shape), `five-stage-pipeline-validation`, `scion-layered-state-model`, `adr-001..005` (v1's ADRs), `north-star-idea-machine`, `event-log-bloat`, `budget-tracking-gap`, `cloud-deps-undetected`, `manual-cycle-closeout`, `resumable-agent-sessions`, `v0.7-post-refactor-review`, `rebuild-from-scratch-memo`, `hierarchical-review-training-model`, `declarative-agent-definitions`, `reflect-is-forge-introspection`. These describe v1's job-queue / stage-pipeline / process-isolation infrastructure that v2 explicitly drops.

**Per-project sub-wikis (input 2):** `brain/projects/<name>/` populated for **all 5 active projects** (`trafficGame`, `env-optimiser`, `simplarr`, `GitWeave`, `healarr`). Each has:

- `profile.md` — domain, stack, taste signals, hard constraints, active focus.
- `themes/<3 themes>.md` — project-specific patterns / antipatterns / decisions.
- Populated category indexes (`patterns.md`, `antipatterns.md`, `decisions.md` as applicable).

Project themes (15 total): `algorithm-heavy-items`, `canvas-bpr-flow-tests`, `per-map-calibrated-thresholds` (trafficGame); `local-first-no-network`, `specify-driven-features`, `redaction-before-storage` (env-optimiser); `dual-language-parity`, `compose-profiles-not-duplicates`, `no-monitoring-bundle` (simplarr); `control-repo-centricity`, `scattered-branches-debt`, `local-dry-run-required` (GitWeave); `triage-deterministic-no-llm`, `tier-coded-tool-boundaries`, `email-approvals-no-web-ui` (healarr).

**Benchmark questions** (`benchmarks/brain/questions.json`): grew from 10 → 18. New questions cover v1 evidence (squash-merge concrete numbers, design-is-the-bottleneck data, model-routing cost evidence) and project-scoped recall (one or more questions per project).

## [2026-05-04] lint | Pass B — structural validation

- ✅ 37 raw files (was 33): added `_raw/v1-wiki/` × 4.
- ✅ 50 forge-level theme pages (was 37): +13 new from v1 lessons.
- ✅ 15 project-level theme pages across 5 sub-wikis (was 0).
- ✅ 5 project `profile.md` files, all with valid frontmatter.
- ✅ All theme files ≤ 60 lines.
- ✅ Zero missing frontmatter.
- ✅ Zero orphans (forge or project category indexes).
- ✅ Zero broken theme cross-links.

## Pass B — done

The seeding plan's Pass B success signal is met: each currently-managed project has `brain/projects/<name>/` populated with a `profile.md` and ≥3 project-specific theme pages; `benchmarks/brain/questions.json` contains additional project-specific questions; lint is clean; no conflict between Pass A's general principles and Pass B's project-specific ones (project themes that contradict a system-level pattern document the *exception*, not the rule).

**The brain is now seeded.** Ongoing population happens via cycle retros (the reflector → brain-ingest path), not via further bootstrap passes.

---

## [2026-05-08] structural | Brain bench wired + dual-axis scoring + Opus-judge validation

Closed out the brain phase to documented success signals across 14 iterations on the benchmark runner. Final state:

**Suites & runners:**

- `benchmarks/brain/score.ts` — primary recall suite (18 cases). Recall + keyword + hallucination check (case-insensitive). Concurrency 4, wall ~90s, $0.90/run.
- `benchmarks/brain/score-negatives.ts` — gap-detection suite (10 cases: out_of_scope / forge_adjacent_bait / partial_match). $0.80/run.
- `benchmarks/brain/score-judged.ts` — Opus LLM-judge over latest primary result, validates the deterministic rubric. ~$5/run.
- `forge brain index [--scope <p>]` — CLI emits brain navigation indexes as a cache-friendly system-prompt prefix. Reusable from any phase.
- 89 unit tests covering scoring, stemmer, SDK glue, judge wiring, negatives rubric, brain-index loader.

**Rubric calibration** (May 2026 Opus-judge validation against May 4–8 iteration runs):

- **F1 was over-penalising correct answers** — judge said 16/17 cases pass; F1+keyword metric said 9/18. The metric was failing 7 cases of "minor citation extras" the judge calls fine.
- **Switched to recall-weighted scoring**: `0.4 × source_recall + 0.6 × keyword_match`, threshold 0.65, hallucinated paths force 0.
- **Layered keyword matcher**: full substring (1.0) → stem-equivalent (1.0 single-word) → token-overlap with stop-word filter (0.7 / 0.4) → no signal (0).
- **Case-insensitive existence check**: `brain/projects/gitweave/...` lowercased citations match real `brain/projects/GitWeave/...` directories without false hallucination flags.
- **Final agreement**: 100% with Opus judge on 17/17 judged cases (Q18 was judge-unavailable on max_turns). Metric pass rate 17/18 (94.4%).

**Architectural decisions taken during the iteration set:**

- **Latency target moved from <5s → ≤15s p95.** The original 5s assumed non-agentic retrieval; the SKILL.md grep-and-read process structurally needs 4–6 tool turns × ~2s each on Haiku. Acknowledged in `docs/phases/brain.md`.
- **Kept the agentic SKILL.md design** (vs load-all-as-context) — brain is small now but expected to grow as cycles compound; agentic search scales, full-context-load doesn't.
- **Cached navigation prefix via shared module** (`orchestrator/brain-index.ts`) — gives the agent the candidate index without per-call grep. Same pattern available to architect / PM / reflection benches.
- **Parallel runner** (concurrency 4) — wall time 5–9 min → ~90s.
- **Dual-axis scoring**: cheap deterministic metric every cycle, periodic Opus judge as the validator. Documented in [`docs/phases/brain.md`](../docs/phases/brain.md) success signals.

**Outstanding work** (not blocking architect phase):

- Negatives suite at 6/10 — N6/N7 were correct content with the model not setting `gap: true`. Tightened the SKILL.md gap-flagging rule; expect to converge over the next 1–2 cycles as brain-query internalises the rule.
- Q18 sits at 0.61 (1/3 source recall, kw 0.80) — content correct, under-cites. The recall-aware bias in the SKILL.md should help; revisit if it persists.
- The architect / PM / developer-loop / review-loop / reflection benches will reuse `benchmarks/_lib/{percentile,results,concurrent}.ts`, `orchestrator/brain-index.ts`, and the `judge.ts` invocation pattern. Phase-specific scoring (manifest-tree shape, demo-script execution, event-log replay) lands when those phases get built.

**Total bench spend across iteration set:** ~$15 across 14 runs. The judge-validation runs (~$5 each) are the dominant cost — recommend running the judge every N cycles, not every cycle.

This closes the brain phase. The next workstream is **architect** — see [`docs/phases/architect.md`](../docs/phases/architect.md).

---

## [2026-05-08] structural | Architect phase wired + bench harness + clean-sweep first run

Closed out the architect phase. Bench passed **8/8 (100%)** on the first live run — no iteration cycles needed (the brain phase took 14). Final state:

**Suites & runners:**

- `benchmarks/architect/score.ts` — fixture suite (8 cases spanning auth, refactor, CI, CLI, perf, ORM migration, tests, docs). Concurrency 4, wall ~2 min, **$1.75/run** (Sonnet 4.6).
- `benchmarks/architect/scoring.ts` — pure rubric. Gate on `validateManifest()`; weighted average of `specs_concrete (0.4) + scope_right_sized (0.3) + brain_consulted (0.3)`. Pass threshold 0.7 (matches brain bar).
- `benchmarks/architect/sdk.ts` — DI-friendly SDK shim. Each fixture runs in its own tempdir with read-only symlinks to `brain/`, `skills/`, `docs/`, `orchestrator/`. Architect writes manifest to `<tempdir>/_queue/pending/`; bench reads back. Tool-use telemetry tracks brain reads, writes, bash calls.
- 34 new unit tests (25 scoring + 9 SDK), 123 total green.

**Result on first run** (`benchmarks/architect/results/2026-05-08T09-13-11-018Z.json`):

- 8/8 fixtures passed at score 1.0 (perfect on every dimension).
- Criterion pass rates: `manifest_valid 100% · scope 100% · specs 100% · brain 100%`.
- p95 latency 116s; total cost $1.75.
- Round-trip validated: an emitted manifest passes `forge enqueue --from-manifest` cleanly.

**Architectural decisions taken:**

- **Deterministic input → manifest bench shape** (vs simulated-user). Each fixture supplies a fully-committed user intent so the bench is reproducible. Plan B (a second LLM playing user) was deferred — not needed.
- **Skip event-log assertions in scoring.** Council-invoked / brain-query-first as separate criteria require runtime instrumentation we don't have without an event log. Artifact-quality proxies (specs concrete, brain path cited in body) cover the same ground at much lower complexity.
- **Tempdir-per-fixture isolation with read-only symlinks** (vs running against the live repo). Lets concurrent fixtures emit manifests without colliding; never pollutes `_queue/`.
- **Roadmap.md v0 schema locked** — see [ADR 014](../docs/decisions/014-roadmap-format.md). Three sections (Current phase / Initiatives table / Backlog) with status keys aligned to `_queue/` directory state. Grounded in brain themes (`markdown-artifact-flow`, `spec-driven-work-items`, `roadmap-simplification-convergence`) plus external research (AGENTS.md emerging standard, solo-dev P-0..P-X conventions, Aider/Cursor agent-readable plans).

**What the bench *didn't* catch** (acknowledged limitations to revisit if quality drifts):

- Doesn't verify the LLM Council subagent actually ran — only that the artifact is council-quality. If the SKILL.md prompt were silently dropping the council step, this bench wouldn't fail. Add event-log instrumentation when cycle.ts gets wired.
- Doesn't test the *interactive* flow (user iteration on escalations). The council was deliberately not exercised as a chained subagent in the bench; the architect applies the critic checklist inline. Adding an interactive bench mode is a future workstream.
- 8 fixtures is small — first regression (e.g. switching to Haiku for cost, or restructuring the council critics) may require expanding the fixture set.

**Total bench spend:** $1.75 first run, $0 in iteration (no cycles needed). Compare brain phase: $15 across 14 runs. The pre-built support code (`council.ts` + `manifest.ts` + `brain-index.ts`) made the difference — the architect skill had nothing to debug because the load-bearing pieces were already proven.

**What's next:** the next workstream is **project-manager** — the first unattended phase. PM consumes initiative manifests from `_queue/pending/`, decomposes features into atomic work items, emits work-item specs. Unblocking PM also unblocks `cycle.ts` end-to-end wiring (PM → developer-loop → review-prep). See [`docs/phases/project-manager.md`](../docs/phases/project-manager.md).

---

## [2026-05-08] structural | Project-manager phase wired + bench harness + 5/5 closure after three iterations

Closed out the project-manager phase — the **first unattended phase** in the pipeline. Bench passed **5/5 (100%)** with every criterion at 100% after three iteration passes. Final state:

**Suites & runners:**

- `benchmarks/project-manager/score.ts` — fixture suite (5 cases, one per managed project: env-optimiser / trafficGame / simplarr / GitWeave / healarr). Concurrency 4, wall ~4 min, **$2.17/run** (Sonnet 4.6).
- `benchmarks/project-manager/scoring.ts` — pure rubric. Gate on `work_items_present`; weighted average of `every_item_has_gwt (0.25) + no_hidden_coupling (0.20) + work_item_count_in_range (0.15) + every_item_lists_scope (0.15) + parallel_fraction_meets (0.15) + graph_emitted_valid (0.10)`. Pass threshold 0.7 (matches brain + architect bar).
- `benchmarks/project-manager/sdk.ts` — DI-friendly SDK shim. Each fixture runs in its own tempdir with read-only symlinks to `brain/`, `skills/`, `docs/`, `orchestrator/`; the initiative manifest is seeded into `_queue/in-flight/<id>.md`; the project tree is copied into `projects/<name>/`. PM writes WIs to `<tempdir>/projects/<name>/.forge/work-items/`. Tool-use telemetry tracks brain reads, writes, bash calls. `maxBudgetUsd: 0.75`, `maxTurns: 40` (raised from 0.5 / 30 after run 1 hit the budget cap on graph emission).
- `orchestrator/work-item.ts` — shared schema (parse / validate / serialize / write / `validateWorkItemSet` / `detectHiddenCoupling`). 25 unit tests. Used by both bench and live cycle.
- `orchestrator/pm-invocation.ts` — shared system + user prompt builders. **Single source of truth** between `benchmarks/project-manager/sdk.ts` and `orchestrator/cycle.ts:runProjectManager()`, so the bench reflects production behaviour exactly.
- `orchestrator/cycle.ts:runProjectManager()` — real implementation (replaced the no-op stub). Reads the manifest, invokes the SDK, validates emitted WIs, emits 6 event-log entries (`pm.start`, `pm.brain-query` × N, `pm.work-item-emitted` × N, `pm.feature-decomposed` × manifest.features.length, `pm.graph-emitted`, `pm.end`).
- 54 new unit tests across this phase (25 work-item + 21 scoring + 8 SDK), 177 total green.

**Result on third run** (`benchmarks/project-manager/results/2026-05-08T11-22-46-969Z.json`):

- 5/5 fixtures passed at score **1.0** (perfect on every dimension).
- Criterion pass rates: `count 100% · gwt 100% · scope 100% · parallel 100% · no-coupling 100% · graph 100%`.
- p95 latency 244s; total cost $2.17.
- Per-fixture: P1 (env-optimiser) 5 WIs, P2 (trafficGame) 5 WIs, P3 (simplarr) 4 WIs, P4 (GitWeave) 7 WIs, P5 (healarr) 2 WIs. Brain reads per fixture 2–6.

**Iteration trajectory** (3 runs total, ~$6.30 across all runs):

| Run | Pass rate | Pass criteria (count/gwt/scope/parallel/coupling/graph) | What changed |
|---|---|---|---|
| 1 | 4/5 (80%) | 40 / 80 / 80 / 60 / 80 / 40 | First live run. P2 wrote nothing; P1+P4 hit budget cap before graph; P3+P5 had YAML parse errors on backtick-prefixed `when:` lines (YAML 1.2 reserves `` ` `` as an indicator). |
| 2 | 4/5 (80%) | 100 / 100 / 100 / 80 / 80 / 100 | Added "MUST write at least one WI" imperative; added YAML quoting rule with worked example; bumped budget 0.5 → 0.75, turns 30 → 40. P2 came alive (1.00); parse errors gone; graphs all emitted. New failure surfaced: P4 collapsed parallel features into a serial chain AND put two impls in the same file (hidden coupling). |
| 3 | **5/5 (100%)** | 100 / 100 / 100 / 100 / 100 / 100 | Added two new prompt rules: **(1) Inherit feature parallelism** — if two manifest features have no edge, their WIs must not either. **(2) File-scope discipline** — when two WIs would touch the same file, prefer splitting the file (one per impl) over chaining. P4 came back with 7 WIs, parallel_fraction 0.29, no coupling. |

**Architectural decisions taken during the iteration set:**

- **Work-item file format locked** — see [ADR 015](../docs/decisions/015-work-item-format.md). Frontmatter schema (work_item_id / feature_id / initiative_id / status / depends_on / acceptance_criteria with given/when/then / files_in_scope / estimated_iterations); `WI-<n>` per-initiative IDs (vs global ULID — chose locality + greppability + commit-message-friendliness over cross-initiative joinability, which the event log already provides); mermaid `graph TD` for `_graph.md`; files live at `<worktree>/.forge/work-items/`.
- **Shared invocation contract.** `pm-invocation.ts` is imported by both the bench SDK shim and `cycle.ts`. Single source of truth for the system prompt + user prompt; the bench reflects production exactly.
- **Hidden-coupling detection is a graph algorithm, not a heuristic.** `detectHiddenCoupling()` walks every pair of WIs sharing a `files_in_scope` entry and checks reachability in both directions across the full `depends_on` graph (DFS). Reachability in either direction satisfies the rule because a `depends_on` edge serialises the two items, eliminating the merge-conflict risk. Drove a clean criterion the bench could score deterministically.
- **YAML quoting rule (load-bearing).** Models trained on un-quoted YAML examples emit unquoted strings starting with backticks (e.g. `` when:  `cargo build` is run ``). YAML 1.2 reserves `` ` `` as an indicator; this fails to parse. The fix is prompt-level — wrap every `given/when/then` value in double quotes. Defended via worked example in both the user prompt and the SKILL.md skill contract.
- **Inherit feature parallelism.** The architect's manifest already encodes feature-level parallelism via `features[].depends_on`; PM's job is to refine that graph into WIs without over-serialising. Made this an explicit rule rather than relying on the model to infer it.
- **File-scope is decomposition, not just declaration.** When two WIs would touch the same file, the right fix is usually to split the file (one impl per file) rather than chain the WIs. Folded this into the prompt as a priority-ordered ladder: split file → merge WIs → add edge.

**Why scoring excludes `brain_consulted`** (in contrast to the architect bench): work-item bodies are specs, not rationale documents — citing the brain in every WI would be unnatural. We surface brain consultation via `tool_use.brainReads` in the result JSON for inspection (every fixture in run 3 had 2–6 brain reads, confirming brain-first discipline). Promote to a scored criterion only if the bench plateaus and we need to disambiguate "PM skipped step 1" from "PM did step 1 badly".

**Outstanding work** (not blocking developer-loop phase):

- The 5 fixtures are deliberately one-per-managed-project, calibrated against project-specific brain themes. As we accumulate cycle data, add fixtures for failure modes the rule-based scorer misses (e.g., subtly vague Given-When-Then where keywords are present but the criterion is unverifiable).
- LLM-judge layer (matching brain's `score-judged.ts`) deferred until rule-based scoring plateaus.
- `estimated_iterations` calibration formula — ADR 015 locks the *field*, but per-project tuning from `brain/forge/themes/work-item-completion-by-domain.md` v1 data is a separate calibration pass once we have real cycle data.

**What the bench *didn't* catch** (acknowledged limitations to revisit if quality drifts):

- Doesn't validate that emitted WIs are *implementable* — only that they're well-formed and structurally sound. A vague-but-structurally-clean WI passes today; only the developer loop will surface that.
- Doesn't test handoff to the developer loop — that's the next bench's job.
- Doesn't exercise crash-recovery (heartbeat, atomic claim) — the live `cycle.ts` invocation will, when the scheduler is real.
- The fixtures are scaffolds (~3-7 files each), not real projects. The PM gets less context than it would in production. Expect bench scores to remain a *floor* on production quality, not a ceiling.

**Total bench spend across iteration set:** ~$6.30 across 3 runs. Compare brain (14 runs, $15) and architect (1 run, $1.75). PM was harder than architect because the output structure is richer (multi-file artifact + graph + cross-WI invariants), but the pre-built support code (`work-item.ts` + `pm-invocation.ts` + the architect bench pattern) made each iteration cheap once the fixture/scoring scaffolding was in place.

**What's next:** the next workstream is **developer-loop** — the second unattended phase, the longest-running, and the highest-cost. The Ralph runner is already wired ([`loops/ralph/claude-agent.ts`](../loops/ralph/claude-agent.ts)); what's missing is the developer skill past `SKILL.md`, the bench fixtures, and the `cycle.ts:runDeveloperLoop()` real implementation. See [`docs/phases/developer-loop.md`](../docs/phases/developer-loop.md).

---

## [2026-05-09] structural | developer-loop phase wired end-to-end (closure pass pending)

Landed everything needed to run a real-Claude bench against the developer loop. The remaining gap is the actual closure pass (5/5 fixtures green at threshold 0.7).

**What landed:**

- **Runner extension** ([`loops/ralph/runner.ts`](../loops/ralph/runner.ts)): `LoopInput` accepts an injectable `qualityGate?: () => boolean` so the bench can shell pytest / bats / node:test / grep instead of the hardcoded `npm test`. `prepareWorkspace` is now an exported helper that returns the three artifact paths. `LoopResult` gains `filesChanged` (deduplicated across iterations) and `stop_reason` so the scorer can grade scope discipline.
- **SDK adapter** ([`loops/ralph/claude-agent.ts`](../loops/ralph/claude-agent.ts)): now accepts `disallowedTools` (NotebookEdit / WebFetch / WebSearch are denied for the dev loop, matching PM's contract).
- **Shared invocation contract** ([`orchestrator/dev-invocation.ts`](../orchestrator/dev-invocation.ts)): `buildDevSystemPrompt(brainCwd)` (brain index + SKILL.md + Ralph-loop discipline notes), `renderDevUserPrompt(input)`, `prepareDevWorkspace(input)` (renders fully-substituted PROMPT.md / AGENT.md / fix_plan.md from a parsed WI), `tallyToolUse(message, summary)` (with a `testRuns` heuristic against Bash command heads). Bash IS allowed (contrast vs PM, which forbids it) — the dev agent must be able to run tests, but the orchestrator-side quality-gate verification is the load-bearing check.
- **Cycle wiring** ([`orchestrator/cycle.ts:runDeveloperLoop`](../orchestrator/cycle.ts)): replaces the start/end stub with a real per-WI loop. Reads WIs from `<worktree>/.forge/work-items/`, validates the set, topologically orders by `depends_on` (new helper `topologicalOrder` in `work-item.ts`), skips dependents of failed prerequisites, runs Ralph per WI, updates `status` frontmatter (new helper `writeWorkItemStatus` in `work-item.ts`), emits `ralph.start` / `ralph.end` per WI plus a phase-level summary event with cost/iteration aggregates.
- **Bench harness** ([`benchmarks/developer-loop/`](../benchmarks/developer-loop/)): five fixtures, one per managed project — Python (env-optimiser/redact-argv via pytest), TypeScript (trafficGame/decay-flow + GitWeave/multipart-stub via node --test --experimental-strip-types), bash (simplarr/dry-run via bats), Markdown (healarr/quickstart-readme via grep). `scoring.ts` defines the pure rubric (gate `terminated_cleanly`; weighted `loop_completed` 0.35, `iteration_budget_respected` 0.20, `files_in_scope_respected` 0.20, `cost_budget_respected` 0.15, `no_regression` 0.10; pass threshold 0.7). `sdk.ts:runDevLoop` is the per-fixture entrypoint (tempdir + symlinks + per-fixture quality-gate command). `score.ts` mirrors PM's runner shape (concurrency 2, session budget $2). 24 new unit tests pass (10 scoring + 7 sdk + existing).

**Why these dimensions and weights:**

- `loop_completed` is the heaviest because the loop's whole purpose is to drive a WI green; everything else is efficiency around that.
- `files_in_scope_respected` is 0.20 because it's the load-bearing PM-handoff invariant — if the loop ignores scope, PM's `no_hidden_coupling` work was wasted.
- `no_regression` (0.10) defends against the wedge-detector escape valve where the agent makes random changes that pass the new test but break others.
- Atomic-commits-per-AC discipline is intentionally NOT scored in v1 — hard to verify reliably across language fixtures, and the existing weight set already discriminates good/bad behaviour. Promote when the rubric plateaus.

**Closure target:** ≥4/5 fixtures pass on first real bench run; 5/5 within two rubric-tightening iteration passes (mirroring PM's three-pass closure at $6.30 total). Per-fixture budgets are tight (3 iterations / $0.30; healarr at 2 / $0.20) precisely so efficiency regressions surface fast.

**Total scaffolding spend across this session:** $0 (all pure code + fixture authoring; real bench run pending and budgeted at ~$1.50 plus headroom for iteration).

**What's next:** run `npm run bench:developer-loop` against real Claude. If the bench surfaces a mismatch between the SKILL.md instructions and what makes the agent succeed (e.g., the agent ignores `files_in_scope`, or burns iterations on `Read` instead of running tests), tighten the SKILL/system prompt and re-run. After closure, the next workstream is **review-loop** — the third unattended phase.

---

## [2026-05-09] structural | developer-loop phase closed — bench 5/5 in two passes

**Outcome:** all five fixtures pass at threshold 0.7 with every criterion at 100%. p95 iterations = 1 — every WI solved in a single Ralph iteration.

**Pass 1 (2/5, $1.50):** all five fixtures completed (loop_completed = 1.0 across the board). The two failures were rubric-shape problems, not loop behaviour:

- **`files_in_scope_respected` at 20%**: every fixture had the agent updating `AGENT.md` and `fix_plan.md` (Ralph workspace artifacts). The scoring counted these as out-of-scope modifications. The healarr fixture additionally had the agent update `.forge/work-items/WI-1.md` because SKILL.md step 8 told it to.
- **`cost_budget_respected` at 40%**: per-fixture cap was $0.30, but realistic first-iteration spend ranged $0.22–$0.42. The phase-doc target is $0.50 / WI; my initial cap was below the bar the phase doc itself sets.

**Pass 2 fixes (5/5, $1.17):**

- [`benchmarks/developer-loop/scoring.ts`](../benchmarks/developer-loop/scoring.ts): `filesInScopeRespected` excludes Ralph workspace artifacts (`PROMPT.md`, `AGENT.md`, `fix_plan.md`, anything under `.forge/work-items/`). These are loop bookkeeping, not source code; the agent must write to them every iteration. Source files outside `files_in_scope` are still flagged (verified via the `secret.ts` test case).
- [`benchmarks/developer-loop/cases.json`](../benchmarks/developer-loop/cases.json): per-fixture `max_cost_usd` raised from $0.30 → $0.50 (healarr from $0.20 → $0.30) to align with phase-doc target. Iteration cap unchanged at 3.
- [`skills/developer-ralph/SKILL.md`](../skills/developer-ralph/SKILL.md): removed step 8 ("agent updates WI frontmatter `status`"). The orchestrator owns status writes via `writeWorkItemStatus()` after `run()` returns; the agent shouldn't touch it. Added a dedicated callout in the Outputs section.

**Key insight (worth a reflection-time theme):** *Ralph workspace artifacts are loop infrastructure, not source code. Any rubric for a Ralph-style loop must treat updates to PROMPT.md / AGENT.md / fix_plan.md / WI spec as bookkeeping, not scope creep, or the rubric will systematically over-penalise normal loop behaviour.* This is the developer-loop equivalent of the PM bench's `no_hidden_coupling` lesson — a rubric blind spot that only surfaces against real agent behaviour, not against synthetic fixture data.

**Per-fixture results (pass 2):**

| Fixture | Iterations | Cost | Status |
|---|---|---|---|
| env-optimiser-redact-argv (Python) | 1 | $0.21 | complete |
| trafficGame-decay-flow (TS) | 1 | $0.32 | complete |
| simplarr-dry-run (bash + bats) | 1 | $0.22 | complete |
| GitWeave-multipart-stub (TS) | 1 | $0.20 | complete |
| healarr-quickstart-readme (Markdown) | 1 | $0.21 | complete |

**Cost discipline:** $1.17 + $1.50 = $2.67 across the closure set. PM was $6.30 across three passes; this closed in two passes for under half the spend, partly because iteration 1 of every fixture happened to be a one-shot win and partly because the rubric-shape fix didn't require re-running already-passing fixtures (the scoring change was a pure post-hoc re-grade).

**Validation of the rubric:** every criterion's pass rate at 1.0 in pass 2 *would* normally be a flag that the rubric is too lenient. In this case the per-fixture breakdown is informative — the cost criterion is the closest to its bound (trafficGame at $0.32 of $0.50, ~64%), so the rubric still discriminates. If a future change makes the agent burn $0.60+ on these fixtures, the rubric will catch it. The criterion to watch in regression: scope respect (now 1.0; would drop to ~0.2 if Ralph-artifact handling regresses).

**What's next:** the **review-loop** phase. Reviewer skill stub + bench fixtures + cycle wiring. Same closure shape: shared invocation contract under `orchestrator/<phase>-invocation.ts`, bench under `benchmarks/<phase>/` with rubric in `scoring.ts`. The developer-loop closure validates the pattern; review-loop should be cheaper.

---

## [2026-05-09] reflection | healarr stub-multipart cycle retro + 3 theme pages created

**Cycle:** `CY-2026-05-09-healarr-stub-multipart` · **Project:** healarr · **Outcome:** merged, PR https://bench.local/pr/5

Retro written to `_logs/CY-2026-05-09-healarr-stub-multipart/retro.md`. Cycle archive at `brain/_raw/cycles/CY-2026-05-09-healarr-stub-multipart.md`. Three theme pages created under `brain/projects/healarr/themes/`:

- `2026-05-09-healarr-healthy-floor.md` (reference) — 1 PM + 1 dev + 1 review iteration at $0.77 with 0 wedges / 0 send-backs / 0 brain-gaps is the lower-bound reference for a correctly-scoped healarr initiative.
- `2026-05-09-single-feature-clean-cycle.md` (pattern) — tight single-feature initiatives with small explicit AC lists (≤5 boundary cases) converge in one round per phase with no send-backs.
- `2026-05-09-stub-scope-prevents-rework.md` (pattern) — limiting a WI to a stub implementation with explicit boundary cases reaches first-pass quality gates without reviewer send-back.

Key metrics: 1 WI / 1 feature / $0.77 total (PM $0.12 + dev $0.22 + review $0.43). Zero wedges, zero send-backs, zero brain gaps. First-ever healarr cycle; establishes the healthy-floor baseline. Review phase was 56% of total cost ($0.43) — the expected dominant cost in single-iteration approval cycles.

---

## [2026-05-09] reflection | reflector closed — slugifier-basic cycle retro + 3 theme pages + slugifier project profile created

**Cycle:** `2026-05-09T12-31-27_INIT-2026-05-09-slugifier-basic` · **Project:** slugifier · **Outcome:** merged, PR https://bench.local/pr/1

Retro written to `_logs/2026-05-09T12-31-27_INIT-2026-05-09-slugifier-basic/retro.md`. Cycle archive at `brain/_raw/cycles/2026-05-09T12-31-27_INIT-2026-05-09-slugifier-basic.md`. Slugifier project profile created at `brain/projects/slugifier/profile.md`. Three theme pages created under `brain/projects/slugifier/themes/`:

- `2026-05-09-tight-acs-zero-iteration-dev-loop.md` (pattern) — tight AC granularity + pure-function domain → 0 Ralph iterations per WI. Calibration baseline for utility-library initiatives.
- `2026-05-09-demo-must-cover-optional-config.md` (antipattern) — demo script omitting optional-config exercises (e.g. `maxLength`) causes reviewer send-back even when code and tests are correct.
- `2026-05-09-pr-description-feature-id-signals.md` (antipattern) — each feature ID (`feat-1`, `feat-2`, etc.) must appear literally in the PR description to pass the reviewer's `pr_signals_present` check.

Key metrics: 6 WIs / 3 features / $1.71 total ($0.44 PM + $0 dev-loop + $1.28 reviewer). One reviewer send-back (PR description + demo gap). `brainReads: 0` in both PM and reviewer — brain-first pattern not exercised by those skills this cycle.

---

## [2026-05-09] structural | developer-loop multi-iteration exploration — Sonnet eats well-decomposed work; loop is a circuit-breaker, not a convergence engine

**Question:** does the developer-loop bench actually exercise the multi-iteration paths (wedge detector, fix_plan progression, AGENT.md state-carrying), or are we just validating single-shot agent skill?

**Method:** ran four bench passes (20 total fixture executions). Iterated fixture complexity progressively, holding the rest constant as control. Used v1 historical data (`v1-themes-failure-modes.cycle.md`, `v1-themes-completion-stats.cycle.md`) to ground the complexity escalations in real-world archetypes — specifically trafficGame's "algorithm-heavy items as a single WI" antipattern (48% v1 failure rate).

**Escalation path on trafficGame** (the others held as control):
- **Run 1–2:** `decayFlow(loads, factor)` — 4 ACs, single file. **1-shot at $0.24–$0.42.**
- **Run 3:** `distributeFlow(intersection, load)` — 8 ACs covering proportional split, capacity caps, redistribution, ordering. **1-shot at $0.49.** Agent did 11 reads / 3 writes / 9 bash calls / 3 test runs all within iteration 1's 25-turn budget.
- **Run 4:** Same function with priority tiebreak + injectable Calibrator across **3 files** (new `src/calibration.ts` with new exported interface, `src/intersections.ts` updated with `priority` field, `src/flow.ts` adding `distributeFlow`). **13 acceptance criteria.** **Still 1-shot at $0.42** — *cheaper than the 8-AC version*. Agent created the new file, updated existing types, implemented priority-tier algorithm, ran tests, all in one iteration.

**Multi-iteration rate across all 20 fixture-runs:** 1 in 20 = **5%**, exactly matching the phase-doc wedge-rate target (`≤5%`). The lone iteration occurred on **GitWeave** (a fixture I did NOT make harder), which spuriously created a `package.json` that wasn't needed; iter 1 quality gate failed; iter 2 corrected. Loop did its job.

**Cost variance for the *same* fixture across runs (no changes):**

| Fixture | min | max | ratio |
|---|---|---|---|
| env-optimiser | $0.23 | $0.51 | 2.2× |
| simplarr | $0.19 | $0.25 | 1.3× |
| GitWeave | $0.22 | $0.57 | 2.6× ← iterated this run |
| healarr | $0.14 | $0.22 | 1.6× |
| trafficGame (across complexity escalations) | $0.24 | $0.49 | 2.0× — **complexity barely matters** |

**The headline finding:** modern Sonnet 4.6 with a 25-turn-per-iteration budget *self-corrects within one query call*. Even 13 ACs across 3 files including a brand-new file with new exported types is well inside its per-query capacity. The agent reads → writes → tests → reads failure → corrects → tests again → done — all without an iteration boundary firing.

**Implication: the Ralph loop's primary value at modern model capability is circuit-breaking, not convergence.**

- **Iteration boundary fires** only on stochastic agent confusion (the GitWeave package.json case), not on inherent problem complexity.
- **Cost cap is the load-bearing safety** — agent variance is 1.3–2.6× per fixture run-to-run. A confused agent might 3× the baseline cost; the cap catches it.
- **Wedge detector hasn't fired** in any run — agents always make *some* observable progress within iterations. The wedge guard is theoretical until we see a true wedge in the wild.

**WI-sizing data points for the PM phase to use:**

| WI shape | Cost envelope | Iteration count |
|---|---|---|
| 1–2 ACs, 1 file | $0.15–0.25 | 1 (very low variance) |
| 4–8 ACs, 1–2 files | $0.20–0.50 | 1 |
| 13 ACs, 3 files (incl. one new file with new exported types) | $0.40–0.55 | 1 |
| Stochastic confusion path (any size) | $0.50–0.60 | 2 (~5% of runs) |

**PM-phase recommendations grounded in this data:**

1. **Default WI envelope: 2–4 ACs, 1–2 files.** Lands at $0.15–0.30, ~100% 1-iteration rate. This is the sweet spot.
2. **Stretch WI envelope: up to ~13 ACs across 3 files when work is genuinely cohesive** (e.g., introducing a new algorithm with rich edge cases plus a supporting types/calibration module). Lands at $0.40–0.60, still 1-iteration. Don't be afraid of bigger WIs *if they're cohesive* — fragmentation has its own overhead (graph construction, sequential execution, cross-WI coupling risk).
3. **Don't decompose to avoid iteration.** The data says iteration risk is stochastic (~5%), not size-driven. Smaller WIs don't materially reduce iteration probability — they just multiply graph overhead.
4. **Where decomposition DOES help: clarify environment setup.** The one organic iteration in 20 runs came from environment confusion (`package.json` thinking). PM should include `setup_notes` or similar in the WI body when the project's test runner has non-obvious requirements ("uses `node --test` directly; no package.json needed"; "pytest expects `conftest.py` at root").
5. **Cost is more useful than iteration count as a quality signal.** A 2.6× run-to-run variance on the *same fixture* means iteration count is a noisy metric. PM should track cost-per-WI as the primary discipline measure; iteration count as a secondary "loop earned its keep" signal.

**What this validates and what it doesn't:**

- ✅ Validated: runner orchestration; per-fixture quality gates (pytest/bats/node:test/grep); topological dispatch; status writeback; event emission; rubric discrimination (caught the GitWeave scope creep correctly).
- ✅ Validated naturally: iteration boundary firing on stochastic agent confusion (GitWeave run 4).
- ❌ Not exercised in 20 runs: wedge detector (no fixture wedged), iteration-budget exhaustion (no fixture hit it), cost-budget exhaustion (no fixture hit it).
- ❓ Bench's hardest fixture (13 ACs / 3 files) is at the *upper bound* of "reliably 1-shot." Pushing further (e.g., 5 files, 20+ ACs, multi-step refactor with hidden constraints) would be possible, but at that point we'd be testing "what happens when PM emits a bad WI" rather than "does the loop work for good WIs."

**Decision: declare developer-loop bench coverage sufficient.** The bench reliably tests:
- Single-iteration completion across language/scoring diversity (the dominant case at modern model capability)
- Stochastic agent confusion paths (~5% rate, matched by phase-doc target)
- Rubric correctness (catches scope creep, regressions, cost overruns)

Pushing harder for forced multi-iteration would require either tightening turn budgets artificially (rejected as inauthentic) or oversizing WIs beyond what good PM should ever emit (testing the wrong thing).

**Total session spend across the multi-iteration exploration:** 4 runs × ~$1.5 = ~$6.50. Combined with prior closure passes ($2.67), **total developer-loop closure spend: ~$9.20** — comparable to PM's $6.30 and well below the brain's $15.

**What this means for the next phase (review-loop):** the same circuit-breaker model applies. Reviewer's Ralph instance will mostly 1-shot under modern Sonnet; the bench's job is to validate the rubric and catch stochastic confusion paths, not to force convergence theatre.

---

## 2026-05-10 — Reflector: cycle 2026-05-10T03-08-21_INIT-2026-05-10-trafficgame-manhattan-v5

**Initiative:** INIT-2026-05-10-trafficgame-manhattan-v5 (trafficGame — add manhattanDistance to Vector2)
**Merged PR:** https://github.com/parsoFish/trafficGame/pull/47

**Brain deltas:**
- New raw source: `brain/_raw/cycles/2026-05-10T03-08-21_INIT-2026-05-10-trafficgame-manhattan-v5.md`
- New theme (antipattern): `brain/projects/trafficGame/themes/2026-05-10-developer-ralph-brain-skip-on-second-wi.md` — WI-2 developer-ralph skipped brain-first mandate (0 brain reads), auto-fail.
- New theme (pattern): `brain/projects/trafficGame/themes/2026-05-10-minimal-utility-single-iteration-pattern.md` — tightly-scoped pure utility WIs complete in 1 iteration.
- New theme (reference): `brain/projects/trafficGame/themes/2026-05-10-review-overhead-dominates-trivial-cycles.md` — review loop = 53% of total cycle cost for trivial initiatives.

**Key numbers:** 2 WIs, 1 complete (WI-1), 1 failed (WI-2 brain-skip), 0 wedge events, 0 brain gaps, total cost ~$2.31 (~15 min).

---

## [2026-05-16] structural | meta-reflection: the trafficGame arc (12 cycles + F-24…F-44)

**Scope:** holistic reflection over the whole trafficGame arc — not one cycle. Consumed `_review/00..04`, 12 `_logs/<cycle>/` dirs, ~20 serve logs, git F-24…F-44, and the 7 hand-authored 2026-05-10 snapshot themes.

**Headline:** loop is reliable PM→dev→reviewer-approve (feature initiatives: 0 send-backs); it breaks at the **merge boundary** — of 12 cycles only PR #47 truly merged; approved feature initiatives stranded unmerged in `_queue/done/`. `done/` ≠ merged.

**Brain deltas:**
- New raw source: `brain/_raw/cycles/2026-05-16_trafficgame-arc-reflection.md`.
- New theme (antipattern): `forge/themes/merge-boundary-stacked-initiative-failure.md`.
- New theme (antipattern): `forge/themes/reactive-constraint-stripback-arc.md`.
- New theme (antipattern): `forge/themes/human-directed-work-as-initiatives.md`.
- New theme (decision): `forge/themes/forge-project-onboarding-contract.md` — the C1–C6 contract; ADR-017 candidate.
- New theme (reference): `forge/themes/forge-current-architecture-as-built.md` — honest as-built snapshot.
- New theme (reference): `projects/trafficGame/themes/2026-05-16-structural-prerequisites-for-autonomy.md`.
- Category indexes updated: `forge/antipatterns.md` (+3), `forge/decisions.md` (+1), `forge/reference.md` (+1).

**Retro + closure goals:** `_logs/2026-05-16_trafficgame-arc-reflection/retro.md` defines findings I1–I6 and testable closure goals G1–G7 (G1/G3/G4/G5/G7 mechanically testable now; G2/G6 need a C1–C5 preflight + a manifest `origin` field).

## [2026-05-16] structural | addendum: deep architecture viz + review-phase redesign

Operator follow-up to the trafficGame-arc meta-reflection.

- New artifact: `_logs/2026-05-16_trafficgame-arc-reflection/architecture.md` — deep as-built visualization (Mermaid: macro flow, subsystem map, per-phase internals, queue state machine, failure-classifier flow, brain topology) + §G the review-phase target redesign with delta table + §H gaps/simplification candidates.
- New theme (decision): `forge/themes/review-phase-target-design.md` — initiative branch synced local↔remote, holistic intent gate that may spawn dev-loops, demo-embedded PR as the human feedback/merge surface, no auto-merge, closure aligns local↔remote. Resolves contract clause C6 + finding I1. Indexed in `forge/decisions.md`.
- retro.md updated: C6 marked RESOLVED, user-question 3 resolved, closure goals G8 (local↔remote invariant), G9 (no auto-merge), G10 (reflection on confirmed merge) added.

## [2026-05-16] structural | addendum 2: project snapshot, user stories, policy decisions, bench design

Second operator follow-up to the trafficGame-arc reflection.

- Project doc: `docs/architecture/as-built-snapshot-2026-05-16.md` — the deep as-built visualization saved into the repo (was only in gitignored `_logs/`); ARCHITECTURE.md remains the narrative/ideal, this is the honest as-built.
- Project doc: `docs/forge-user-stories.md` — holistic minimal user stories (7 epics) capturing forge intent incl. brain-read policy, human-interaction model, contract, review redesign, simplicity-as-constraint.
- New theme (decision): `forge/themes/brain-read-policy.md` — planner reads brain; dev-loop/reviewer don't; index-guarded reads.
- New theme (decision): `forge/themes/human-interaction-via-own-session.md` — 3 human moments as slash commands in the operator's own session; no production simulation.
- New theme (decision): `forge/themes/chained-phase-benchmarks.md` — keep isolated benches + chain them; 3 drift corrections (PM cwd/budget false-red, review brainConsulted false-red, review one-shot false-green).
- Artifact: `_logs/2026-05-16_trafficgame-arc-reflection/benchmark-alignment.md` — full drift table + chained-bench design + closure goals G11/G12.
- `forge/decisions.md` index updated (+3 themes).

## [2026-05-16] update-theme | correction: e2e is a seed, not a standalone benchmark

Operator clarified the chained-bench intent. Correction applied:

- `forge/themes/chained-phase-benchmarks.md` rewritten — an e2e test is a SEED fed into the front of the chain; the chain purely ties the EXISTING per-phase benches together (each phase's generated output → next phase's input, scored by that phase's existing pure rubric). NO standalone e2e fixture/rubric.
- Decision: **delete `benchmarks/e2e/scoring.ts`** and the e2e fixture-as-scored-unit; keep only its plumbing (gh-shim, recorder shims, `reconstructGateStateFromEventLog`, brain-mask) relocated to `benchmarks/_lib/`. `runCycle` is the sequencing engine, contributes no rubric.
- `_logs/2026-05-16_trafficgame-arc-reflection/benchmark-alignment.md` §C/§D rewritten; `docs/forge-user-stories.md` US-6.2 corrected; G12 reworded ("chained = existing benches only").
- Supersedes the prior addendum-2 framing that said "e2e already IS the chain, keep it".

## [2026-05-17] structural | forge self-closure arc — autonomous loop drove Phases 0–9 to a green gate

Confirmed `_meta/iteration/PLAN.md` executed by an in-session loop + fresh-context subagents, gate-every-commit. closure-check fast 2/22→25/25 (GREEN); full 30/31 (only G11, the operator-gated live bench re-run, honestly pending — not gamed). cycle.ts 1753→330; review redesign landed (no auto-merge; G1/G8/G9/G10); forge↔project preflight (ADR-017); brain-read policy reconciled; chained benchmark. Unit suite 388→466, 0 regressions.

**Brain deltas:**
- New raw source: `brain/_raw/cycles/2026-05-17_forge-self-closure-arc.md`.
- New theme (pattern): `forge/themes/objective-gate-autonomous-closure.md` (indexed in `forge/patterns.md`).
- Also commits the foundational 2026-05-16 trafficGame-arc reflection knowledge (themes + cycle archive + category-index updates) that this arc executed against.

## [2026-05-17] structural | G11 validation — full-flow chained runs (2 paid cycles); real harness bug found+fixed

Operator-authorised G11 validation: ran the `slugifier-chain` seed through the full chained flow twice (real SDK, $5.86 + $0.29).
- **Run 1** ($5.86): architect 1.0 → PM 0.85 (6 WIs) → dev-loop 0.80 (real slugify.ts/batch.ts + tests, 6 commits, per-WI `gate.pass`) → **Phase-6 G8 invariant correctly halted the cycle** because the chained bench harness (`initGitRepo`) gave the seed repo no `origin` (branch never pushed). A real cross-phase gap the full-flow run surfaced that per-phase isolation could not.
- **Fix**: `benchmarks/chained/sdk.ts:initGitRepo` now creates a bare `origin` (e2e/review-loop pattern). Gated green (466/466).
- **Run 2** ($0.29, post-fix): architect 1.0 → PM emitted 4 WIs, 1 failed runtime `validateWorkItem` → forge **correctly failed-fast** (classifier `unknown`/non-recoverable). Stochastic agent output; forge's guardrail working.
- **G11 closed on its design-of-record definition** (benchmark-alignment.md §D — the 3 Phase-4 drift fixes in code; runs confirm no false-colour: per-phase rubrics scored faithfully, nothing false-green). **Not claimed**: a green end-to-end chained cycle (0/1 across 2 runs for the documented reasons above). Chained-cycle convergence on a live seed is **stochastic and is NOT a closure gate** — documented characteristic. No 3rd paid run (cost/thrash discipline; honest over forced-green).
- Demonstration built from real run-1 artifacts: `_meta/iteration/demonstration/`.

## [2026-05-17] cycle-reflection | trafficGame — INIT-2026-05-17-world-graph-connectivity (world-graph connectivity + neighbour-unlock)

Cycle merged (PR #53). Dev-loop clean 3/3 WIs in single iterations. Reviewer loop exhausted send-back cap (budget mismatch); manual operator merge.

**Brain deltas (this reflection):**
- New raw source: `brain/_raw/cycles/2026-05-17T13-36-43_INIT-2026-05-17-world-graph-connectivity.md`.
- New theme (antipattern): `projects/trafficGame/themes/2026-05-17-stale-brain-contradicts-code-pm-failure.md` — stale brain themes that contradict the codebase cause PM-phase failure.
- New theme (antipattern): `projects/trafficGame/themes/2026-05-17-reviewer-budget-undersized-medium-initiatives.md` — reviewer per-iteration budget ($0.60) undersized for medium-complexity initiatives.
- New theme (antipattern): `projects/trafficGame/themes/2026-05-17-demo-server-reuse-captures-stale-build.md` — `reuseExistingServer:true` latches onto main-repo vite server.
- New theme (pattern): `projects/trafficGame/themes/2026-05-17-file-isolation-constraint-enables-single-iteration.md` — one-file-per-WI manifest constraint correlated with single-iteration dev-loop success.

---

## [2026-05-17] structural | GREEN end-to-end chained cycle achieved (G11 + E2E validated)

After hardening the chained harness (missing-origin fix, F-45 pm-invalid-work-items recoverable mode, bench-scoped dev-loop-wedge ride, and two deterministic bench false-reds fixed: review caseScore base-dir + reflector post-merge manifest bridge — all proven against preserved real run artifacts, no extra paid runs), a real paid chained run scored **1/1, every phase green** (architect 1.0 / PM 1.0 / dev-loop 0.80 / review 1.0 / reflection 1.0; $7.59). Forge ran one seed through the full product path to a genuine green end-to-end result with the human+remote faithfully stubbed. Demonstration: `_meta/iteration/demonstration/`. Closure-matrix gains `E2E-GREEN`; `closure-check --tier=full` green. Total chained validation spend across the diagnostic arc: ~5 paid runs (each surfaced a real, fixed issue — the full-flow gate doing its job).

## [2026-05-18] reflection | world-map review arc closed + operator-review reliability hardened

trafficGame world-map connectivity refined to close via PR #54 (merged,
origin/main `386e973`): connected 5-map `CampaignGraph` with directed
**convergent-AND** unlock (a map unlocks only when EVERY feeder is
complete; sources always unlocked), real connection points validated for
**count parity** in the production graph (registry from MapDefinitions),
and a spatial map-of-maps hub where every connection is a **two-way road**
(exit+entry on each connected side, mating across borders). Scoring/main.ts
untouched. Project theme `campaign-mode-state` rewritten to the as-built
model (it had gone stale TWICE during the arc — the precise brain-staleness
that thrashed the PM; updating it is the reflection's load-bearing act).

The arc's reusable forge lesson is new pattern theme
`pr-as-sole-review-window`: when the operator is engaged, iterating on the
PR comment thread is the tightest loop, but the PR must be self-contained —
the demo has to live IN the PR. Private repos can't use inline raw-URL
images (GitHub's proxy can't fetch private raw) → commit a relative-link
`DEMO.md`. Implemented as `pr.ts:embedDemoInPr` (visibility-aware). Forge
also gained 5 operator-review reliability fixes from the post-mortem
(alignLocalToRemote no longer strands the project tree; node_modules
symlink can't be committed; reviewer per-iteration budget guards removed;
demo-runtime prefers built preview; brain-staleness preflight WARN +
`pm-thrash-no-converge` classifier). All forge changes are on local branch
`fix/operator-review-reliability` (forge has no remote) — committed, gates
green (tsc, 489 tests, closure 25/25), **awaiting operator review/merge**.

## [2026-05-18] ingest | repo: terraform-provider-betterado (project onboarded)

Onboarded `parsoFish/terraform-provider-betterado` — a Go fork of
`microsoft/terraform-provider-azuredevops` adding classic release
pipelines + task groups — as a new managed project. Cloned to
`projects/terraform-provider-betterado`. **Branch consolidation:** the repo
shipped a deliberate two-branch model (`main` = pristine upstream,
`betterado` = all fork work). Forge is single-branch per project, so `main`
was fast-forwarded onto `betterado`'s tip (clean ff — `main` was a strict
ancestor; no merge commit, no rewrite, zero data loss), pushed, and
`betterado` deleted local + remote. Only `main` exists, local↔remote in
sync at `0822657`. The repo's own `CLAUDE.md` Fork-Workflow section is now
**stale/superseded** — recorded so planners don't trust it. **Demo
method:** Go-test harness (`kind:"harness"`) — no web UI, so the Playwright
media path does not apply; new release/task_group code is acceptance-only
(zero unit tests) so test-first work there is doubly valuable. Substrate
verified: `go build ./...` clean, unit tests pass; Go 1.24.1 installed at
`~/.local/go` + PATH-exported for `bash -lc`. New brain sub-wiki:
`brain/projects/terraform-provider-betterado/` (profile + 3 themes:
branch-model-consolidated [decision], go-test-harness-demos [operation],
stack-and-test-layout [reference]) + raw extract under
`_raw/projects/terraform-provider-betterado/`. INDEX.md updated.

## 2026-05-19 → trafficGame overlay-clear-fix arc (PR #56 merged)

PR #56 (`forge/INIT-2026-05-18-trafficgame-overlay-clear-fix`, merge
`59d1713`) landed two things that took several iterations to get right:

1. **The cumulative-darken bug fix.** Root cause turned out to be
   structural: ONE shared canvas + `Game.stop()` cancels rAF (paused
   game, nothing repaints behind the overlay). The dev-loop's first pass
   routed re-renders through `redraw()` (clear+draw) — stopped the
   stacking but *erased the paused game frame*, so the menu sat on
   blank/black. The landed fix snapshots the canvas in
   `CanvasScreen.start()` (`getImageData`) and restores it on every
   `redraw()` (`putImageData → draw`) so the dim is painted exactly
   once over a STABLE frame. Real-browser luminance measurement
   (Playwright, Crossroads map, 12 hover cycles → constant 17.43)
   was what finally proved it; unit tests (jsdom) had been passing
   for the broken-but-doesn't-stack version because jsdom's
   `getImageData` throws → graceful-degrade path hid the regression.
   Brain theme refreshed: `brain/projects/trafficGame/themes/2026-05-10-ui-canvas-overlay-pattern.md`.

2. **A forge process fix.** The reviewer phase was committing
   `.forge/pr-description.md` (gitignored scratch, FIXED path) onto the
   initiative branch, guaranteeing add/add conflicts between any two
   parallel initiatives after the first merges (exactly the v1 "many
   branches don't merge downward" failure). Fixed in
   `orchestrator/reviewer-invocation.ts` (prompt no longer instructs
   agent to commit `.forge/`) + enforced
   `pr.ts:stripForgeScratchFromBranch` guard in both push paths so
   `.forge/` cannot reach origin regardless of agent behavior.

Side effects of the arc, all reconciled: PR #55 (backpressure
foundation FEAT-1/2) merged at `e3b1da1`; local main was stale at
`#54` until manually fast-forwarded; the dependent `backpressure-wiring`
branch was redundantly built from the stale base → conflicted →
abandoned + re-queued as `INIT-2026-05-19-trafficgame-backpressure-live`
(running on the fixed daemon, FEAT-3 wiring + FEAT-4 invariant). Two
deeper forge defects deferred to a later session (saved as memory
`project_forge_deferred_defects`): (b) reviewer SDK transient crash is
unclassified + strands good work; (c) dependent initiatives branch from
stale local `main` (scheduler doesn't ff before `git worktree add`).


---

## 2026-05-23 — trafficGame collision/elevation + grading-frontier arc closed (PR #57 merged)

Closing-out a multi-session, operator-driven arc that began as
`INIT-2026-05-19-trafficgame-backpressure-live` (wire the backpressure
foundation into the live sim + anti-collision invariant proof) and
expanded into a complete rebuild of trafficGame's collision and
elevation systems plus the introduction of a parametric grading
harness for map-design theories. PR #57 merged 31 + 3 commits at
`47109cd`.

**Landed in trafficGame** (commits on `main` post-merge):
- `7c64b4b feat(traffic): elevation-aware collision avoidance + binary elevation model` — new `CollisionAvoidance.ts` (pairwise geometric route-crossing detection + two-leader IDM + predictive merge + cycle-break), new `OverlapTracker.ts`, `vehicle.currentElevation` as single source of truth with three update rules, IDM elevation-lookahead extended 80→400px, removal of `IntersectionManager` / `IntersectionPolicy` / `NetworkEvaluation` / `PredictiveHeatmap` / `RoadSegmentMetrics` + tests, `ElevationGraphColorizer` capped at 2 levels.
- `146cf5c feat(grading): parametric sweep harness + locked design-frontier baselines` — `scripts/grading/runSweep.mjs` library + 8 per-theory sweep scripts + `capture-notable.mjs` + `docs/baselines/grading-frontier-*.md` + `docs/baselines/screenshots/`.
- `95e0745 chore(tuning): expanded harness + analyze-overlap + per-map variants` — `scripts/tuning/` additions + `docs/TUNING-2026-05-22.md` + `docs/LEARNINGS.md` updates.

**Headline numbers**:
- Locked roundabout baseline preserved EXACTLY at `r=300 = 1.921 v/sim-s, 0 severe`.
- Locked plain-grid baseline preserved within ±1%: `s=60 = 1.236 → 1.232 v/sim-s, 0 severe`.
- **NEW FRONTIER**: `elevated split-grid s=400 = 3.314 v/sim-s, 0 severe` (+72% over roundabout baseline).
- 788 traffic + network + scoring tests passing.

**Brain themes written**:
- **Project (trafficGame)**:
  - `2026-05-23-binary-elevation-model.md` — the elevation model that worked after three failures (3-level, body-aware footprint, route-segment span).
  - `2026-05-23-grading-frontier-infrastructure.md` — `runSweep.mjs` + locked baselines + screenshot index as the project's tight-loop layer.
- **Forge (system-level)**:
  - `holistic-metrics-onboarding.md` — proposes **C7** as a new clause on the forge↔project contract: a project declares a holistic metric command + locked baselines + regression budget. Tests verify "did this break"; metrics verify "did this help". Indexed under [`forge/decisions.md`](./forge/decisions.md).
  - `parametric-design-search.md` — the reusable sweep harness as a forge-wide pattern: ~30 lines per new theory, ~10s wall-clock per sweep, generalises to any project with a parameter space + measurable outcome. Indexed under [`forge/patterns.md`](./forge/patterns.md).
  - `exploration-vs-implementation-initiatives.md` — counterfactual reconstruction of how the trafficGame arc would have run as a forge cycle. Implementation initiatives have closed ACs; exploration initiatives have score-delta + regression-budget closure. Proposes manifest/PM/dev-loop/reviewer shapes for the exploration mode. Indexed under [`forge/decisions.md`](./forge/decisions.md).
- **Cycle archive**: `_raw/cycles/2026-05-23_trafficgame-elevation-grading-arc.md` — trajectory + decision points + counterfactual analysis.

**Operator's framing for the wrap-up** (verbatim):
1. How traffic flow should work → binary elevation model theme captures the as-built.
2. How important holistic metrics are for agentic / forge development, including a potential future onboarding skill that prepares projects with measurements so agentic flows can design testable tight loops and fanout ideation/testing → holistic-metrics-onboarding theme (proposes C7) + parametric-design-search theme (the harness pattern).
3. Theories on initiatives and work that could have gotten us here through forge cycles → exploration-vs-implementation-initiatives theme + the cycle archive's counterfactual section.

**Operational mode of this arc**: hand-directed via conversational
sessions, not forge initiatives. The original initiative manifest's
scope was wildly exceeded. Counts toward the `human-directed-work-as-initiatives`
antipattern: large operator-driven arcs that succeed but produce no
autonomy-signal data. The exploration-vs-implementation theme is the
proposed remediation.

## [2026-05-22] cleanup pass — brain-scrub-test-contamination

- 128 Tier-A deletes (empty, untracked, matching `__chained_test_proj_*` / `__bench_*`)
- scrubber: `scripts/brain-scrub-test-contamination.ts`
