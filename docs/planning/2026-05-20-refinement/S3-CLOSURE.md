---
stage: S3 (closure)
date: 2026-05-24
status: closed (schema + scoring + retry + handoff wiring); LLM-driven run operator-pending
contract_deps: [C3c, C4, C5, C5a, C5b, C10, C11, C27]
amends: [03-project-manager.md, EXECUTION-PLAN.md (§S3)]
---

# S3 closure — PM refinement + cross-phase handoff

## What landed (deterministic — passes without API access)

### Across prior commits (2026-05-22 and earlier)

| Area | Status | Where |
|---|---|---|
| **C5 schema** — `quality_gate_cmd`, `non_goals`, `verification_artifact`, `creates` on WI | ✅ | [`orchestrator/work-item.ts:35-103`](../../../orchestrator/work-item.ts) — omit-on-undefined serialisation preserves byte-identical frontmatter for pre-amendment WIs (round-trip test in `work-item.test.ts`). |
| **C5a knownFeatureIds wiring** (load-bearing per I-13) | ✅ | Validator (`validateWorkItem` opts), bench scoring (`scoring.ts`), live cycle (`phases/project-manager.ts:144,239,349-352`). |
| **C5b hallucinated-FEAT recovery** — hard error + one orchestrator retry naming the manifest's feature IDs | ✅ | [`phases/project-manager.ts:80-180`](../../../orchestrator/phases/project-manager.ts): first pass detects via `collectHalLucinatedFeatureIds`, wipes prior output, re-prompts via `pm-invocation.ts:renderPmRetryPrompt`, fails the phase classified if hallucination persists across both passes. |
| **Bench rubric reground** — `feature_id_in_manifest` (gate), `one_creator_per_file` (0.12), `quality_gate_cmd_present` (0.10), `files_real_or_explicitly_new` (0.10) added; legacy weights rebalanced | ✅ | [`benchmarks/project-manager/scoring.ts`](../../../benchmarks/project-manager/scoring.ts) + 11 criteria tracked in `score.ts:criterion_pass_rates`. |
| **C11 initiatives.json migration** — both shapes parseable for one release; manifest-topology-derived range when `expected` omits `min/max/parallel`, with a stderr deprecation log | ✅ | [`benchmarks/project-manager/score.ts:107-139`](../../../benchmarks/project-manager/score.ts) `resolveExpected()`. |
| **Intersection-backpressure regression** — synthetic 8-WI / FEAT-5 replay must fail the gate | ✅ | [`benchmarks/project-manager/scoring.test.ts:367-402`](../../../benchmarks/project-manager/scoring.test.ts). |
| **PM SDK migrated to project worktree cwd** (Phase 4.1 drift correction) | ✅ | [`benchmarks/project-manager/sdk.ts:175-199`](../../../benchmarks/project-manager/sdk.ts) — bench mirrors live `runProjectManager` cwd choice. |

### This session (2026-05-24) — cross-phase handoff wiring

| Change | Files |
|---|---|
| **`from_architect: <fixtureId>` field** on PM bench `Case` (per C10 + plan 03 §"Cross-phase contract") — when set, the case's manifest is resolved via `loadArchitectHandoff(<fixtureId>)` against the architect bench's latest run. `initiative_manifest` becomes optional; cases must declare one OR the other. Missing handoff surfaces as `no_architect_handoff` runner error. | `benchmarks/project-manager/score.ts` |
| **PM handoff write** — after a successful run, `writePmHandoff` emits `results/<iso>/handoff/<fixtureId>/{WI-<n>.md, _graph.md, _quality-gate.json}` consumable by the dev-loop bench via `loadPmHandoff(fixtureId)` (exported from `_lib/handoff.ts`). `_quality-gate.json` is best-effort parsed from the manifest's `quality_gate_cmd:` frontmatter line; empty array when absent. | `benchmarks/project-manager/score.ts` |
| **Two architect-handoff cases** (P6, P7) added to `initiatives.json`: `P6-from-architect-B1-betterado` (substrate) + `P7-from-architect-A3-trafficGame-ci` (Node.js CI). Both use `expected: {}` — the C11 migration helper derives sizing from manifest topology. | `benchmarks/project-manager/initiatives.json` |

### Tests

`npm test`: **747 / 748 pass** (1 deliberate skip). No regressions from the cross-phase wiring. The pre-existing intersection-backpressure regression test still trips the `feature_id_in_manifest` gate.

`npx tsc --noEmit`: clean.

## What's operator-pending (API-blocked + chained-run-blocked)

The S3 acceptance criteria are met deterministically. The remaining join-step items both need API access:

1. **`npm run bench:project-manager` against all 7 cases (5 static + 2 from_architect)** — same API-key blocker as the brain/architect benches. P6/P7 also require the **architect bench to have run first** (so `loadArchitectHandoff` finds a `manifest.md` under `benchmarks/architect/results/<iso>/`). The chained order is documented in [03-project-manager.md §"Cross-phase contract"]; deferred to a single chained-bench run by the operator.

2. **Real betterado-01 cycle through the live PM** — per [EXECUTION-PLAN.md §S3 → S4 join]:
   > "Running architect bench → PM bench end-to-end against `B1-betterado-substrate-only` produces a 4-5 WI decomposition with all `feature_id ∈ manifest.features`, per-WI `quality_gate_cmd` populated."
   The plumbing for this is **wired**; the wire-test is the chained bench run.

## S3 → S4 join

Per [EXECUTION-PLAN.md](./EXECUTION-PLAN.md) §S3 → S4:

> Running architect bench → PM bench end-to-end against `B1-betterado-substrate-only` produces a 4-5 WI decomposition with all `feature_id ∈ manifest.features`, per-WI `quality_gate_cmd` populated.

✅ **Wired.** P6 case in `initiatives.json` consumes `B1-betterado-substrate-only`'s architect-bench output. After running architect bench then PM bench, the PM bench's handoff dir contains the WIs that the dev-loop bench can pick up via `loadPmHandoff('P6-from-architect-B1-betterado')`.

> `feature_id_in_manifest` gate trips on a synthetic FEAT-5 fixture.

✅ **Verified deterministically.** [`scoring.test.ts:367-402`](../../../benchmarks/project-manager/scoring.test.ts) — synthetic 8-WI replay with WI-8 declaring `FEAT-5` against a 4-feature manifest scores 0 (gate trips).

## Risk notes carried into S4

- **Dev-loop bench** ([04-dev-loop.md](./04-dev-loop.md)) consumes the new `quality_gate_cmd`/`verification_artifact` WI fields. S3 emits both via the C5 schema; S4's job is to wire them into the per-WI gate command at dev-loop close.
- **PM handoff `_quality-gate.json` is best-effort.** If the architect omits `quality_gate_cmd:` from the manifest body's frontmatter (per C4), `loadPmHandoff` returns an empty `qualityGateCmd` array. The dev-loop bench's adapter must treat empty as "use the project default gate" — that's an S4 contract clarification.
- **Concurrency safety of `writePmHandoff`**: each case writes to its own `handoff/<fixtureId>/` subdir, so the `mapConcurrent(cases, CONCURRENCY)` loop in `score.ts` is collision-free across cases. Within a single case there's only one writer.
