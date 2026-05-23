## S3 — Project Manager refinement (operator-asleep, 2026-05-23)

Worktree: `_worktrees/s3-pm`. Branch: `s3-pm`. Forked from main at `9585fba`.

This file records best-judgement decisions taken during S3 implementation, especially the four operator-pending taste calls the plan flagged.

---

### 1. Retry prompt augmentation text (C5b)

The PM's retry-pass prompt is rendered by `renderPmHallucinationRetryAugment` in `orchestrator/pm-invocation.ts`. The text is appended verbatim to the standard user prompt; the second pass otherwise inherits the standard system prompt + worktree cwd. Verbatim text:

```
## RETRY pass — your previous work items invented feature IDs

Your previous decomposition declared the following feature IDs that do **not** appear in the manifest: `FEAT-5`. The orchestrator has wiped your previous `.forge/work-items/` output. Re-decompose the initiative from scratch.

Use **only** these feature IDs (manifest declared):

- `FEAT-1`
- `FEAT-2`
- ...

If a WI you wrote previously would have fitted a manifest feature you missed, re-map it to the correct existing FEAT-id. **Do not invent new feature IDs**, even if you believe one is needed — the architect contract is binding; if the manifest is genuinely incomplete, surface the gap in the first WI's body and proceed against the existing features only.
```

Design choices:
- Mentions the actual hallucinated IDs (not generic "you hallucinated something"). High specificity = much better retry success on stochastic generation slips.
- States the wipe explicitly so the agent doesn't waste turns Globbing the (now empty) work-items dir.
- Reinforces "no new feature IDs" because the first instinct is often to re-rationalise the invention.
- The retry pass also gets the standard prompt's `## Known feature IDs (manifest)` block at the top, surfaced via `renderPmUserPrompt`'s new `knownFeatureIds` param — so the agent sees the constraint TWICE (once in the standard prompt, once augmented for the retry). Belt-and-braces, intentional.

### 2. `parallel_fraction_meets` floor adaptation to manifest topology

**Decision: keep the floor as a per-fixture parameter (default 0.3), do NOT yet derive it from manifest topology.** The plan suggested deriving from feature graph (linear chain → relax, sibling-parallel → enforce) but this stage's scope kept the floor static. The four existing fixtures already span the topology spectrum (`P5-healarr-doc-update` at 0.5, `P3-simplarr-bash-pwsh` at 0.4, `P1` and `P2`/`P4` at 0.25-0.3); the C11 migration parses both shapes, so a per-fixture override remains the lever.

A topology-derived floor (`(features_with_no_predecessor / total_features)`) is the right next step but is out-of-scope for this stage — it requires walking `manifest.features[].depends_on` and reasoning about sibling-parallel inheritance. Left as a follow-up; the new `feature_id_in_manifest` gate and `one_creator_per_file` criterion are the higher-signal additions for the FEAT-5 case the plan called out.

### 3. `quality_gate_cmd_present` at iteration_budget ≤ 5

**Decision: criterion is relaxed (defaults to 1) when iteration_budget ≤ 5.**

Rationale: the trivially-green pathology bites larger initiatives where the whole-project gate can pass on a clean main + a few cosmetic edits. On small initiatives (1-5 iterations across the whole cycle) the dev-loop has at most ~3 WIs; the cost of authoring per-WI gates exceeds the benefit. Constant: `QUALITY_GATE_BUDGET_THRESHOLD = 5` in `benchmarks/project-manager/scoring.ts`.

Escape hatch when iteration_budget > 5 but the manifest gate is genuinely tight: PM can write `manifest-level gate suffices` (or one of two close variants) in the WI body and the criterion accepts it. Deterministic — no NLP. Three variants for resilience: `manifest-level gate`, `manifest gate suffices`, `manifest-gate-suffices`.

### 4. `iteration_budget` source for `quality_gate_cmd_present`

Read from the parsed manifest's `iteration_budget` field. Tested: when the fixture's manifest declares `iteration_budget: 3`, the criterion is relaxed; at 8 it's enforced. This makes the criterion correlate with manifest scope, not bench-fixture authoring choices.

### 5. `creates` array vs body-text inference for `files_real_or_explicitly_new`

**Decision: structured marker only (per council 03 dx flag and C5 contract).** A WI's `files_in_scope` path is "real" iff it appears in the fixture's `project_tree`; it's "explicitly new" iff some WI in the set lists it in `creates`. Body-text inference rejected as too fragile (the original plan flagged this — legitimate WIs describe their work in THEN clauses, not by re-listing filenames).

Cost: PM must remember to populate `creates` when authoring new files. The prompt explicitly tells it to; the existing 5 fixtures don't carry `creates` arrays today (they predate the field), so on the next bench run the criterion will likely surface for fixtures whose WIs ship new files. That's the point — the criterion is a forward-looking quality signal.

### 6. `knownFeatureIds` second-source-of-truth check (AC6)

Confirmed: both call sites already pass `knownFeatureIds`:
- `orchestrator/phases/project-manager.ts:218` (in `runOnePmPass`): `const knownFeatureIds = new Set(manifest.features.map((f) => f.feature_id));` then `validateWorkItemSet(items, { ..., knownFeatureIds })`.
- `benchmarks/project-manager/score.ts:124`: `const knownFeatureIds = parsedManifest.features.map((f) => f.feature_id);` then threaded into `caseScore` via `expected.known_feature_ids`.

The wiring pre-existed on this worktree (pre-S3 commit), so the load-bearing fix from C5a was already in place. What S3 adds is the bench-level GATE (`feature_id_in_manifest`) that mirrors it for explicit failure-mode visibility, and the orchestrator-side retry (C5b) so a single hallucination doesn't fail the cycle.

### 7. Brain-gate enforcement on the retry pass

**Decision: brain gate runs on pass 1 only.** The retry pass already received the manifest's feature IDs verbatim in the augmented prompt — that's the orchestrator's distilled "brain-query result" for the retry. Burning fresh brain reads on the retry would double the brain-read cost without adding signal (the model already has the relevant context from pass 1). Documented in the `runOnePmPass` body: `if (pass === 1 && !recordBrainGateResult(...))`.

### 8. Sizing band tightening in production prompt (pm-invocation.ts)

The plan's sizing band — `feature_count..2*feature_count+2`, ceiling 8 unless `feature_count > 4` — is now applied at the production cycle boundary in `runOnePmPass` (not in `pm-invocation.ts` directly — the renderer accepts the resolved values via `minWorkItems`/`maxWorkItems`). The bench's `resolveExpected` helper applies the SAME formula so bench and prod use one source of truth.

Old (pre-S3) formula at the production caller was `min = max(features, 2); max = max(features*4, 6)` — which was looser than the plan target. The new formula tightens the ceiling and prevents over-decomposition (the intersection-backpressure case at 8 WIs from a 4-feature manifest would now sit at the ceiling, not under it).

### 9. C27 type-discriminator branching (exploration vs implementation)

Added optional `manifestType` to `renderPmUserPrompt` (defaults to `implementation`). When `exploration`, the prompt includes a new `## Exploration-mode WI shape (C27 / L2)` section directing PM to emit sweep-batch WIs (coarse → fine → regression → screenshot+doc) rather than feature-decomposition WIs.

Detection: `detectManifestType(manifest)` in `orchestrator/phases/project-manager.ts` reads `manifest.type` defensively (the field lands via S2B; current manifests don't carry it). When absent, defaults to `implementation` — no behaviour change.

Verification — `parameter_space` / `locked_baselines` reads are NOT wired here; they're referenced in the prompt body but PM doesn't yet consume them programmatically. That's because the manifest schema for exploration manifests is still being defined by S2A/S2B. The S3-side hook is the prompt branch.

### 10. `hard_constraints` / `non_goals` / `demo_hook` reads

Per C4, the architect emits per-feature `hard_constraints` + `non_goals` (and initiative-level `demo_hook`). S2B is responsible for landing the per-feature manifest schema; the S3 PM prompt references these in a stub `## Per-WI optional fields (C5)` section that tells the agent the manifest may carry them and PM may pass `non_goals` through to WI bodies. Live read-through requires the manifest schema landing (S2B) — S3 stages the prompt so it's ready to consume when the schema arrives.

### Operator-pending items

None blocking. The four "taste calls" in the plan are recorded above. Two items the operator may want to revisit later:

- **`parallel_fraction_meets` topology-derived floor.** Currently static per-fixture. Deferred (see decision 2).
- **Drop the C11 `initiatives.json` migration old-shape support.** Per C11 the deprecation log fires now; the cleanup PR after the next clean bench pass should drop the `min_work_items`/`max_work_items`/`parallel_fraction_at_least` fields and rely entirely on manifest topology.
