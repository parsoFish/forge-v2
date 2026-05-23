# Phase: Project Manager

> *Unattended.* Breaks initiative features into spec-driven work items the developer loop can execute.

## Purpose

Take the architect's confirmed initiative and decompose its features into **work items** — atomic, dependency-ordered units with acceptance criteria the developer loop can verify. Designed for *iteration* (not one-shotting); designed for *parallelism* (declared dependencies allow safe parallel execution).

## Inputs

- `_queue/in-flight/<initiative-id>.md` (the initiative manifest, claimed by the scheduler).
- `projects/<name>/` (current project state at the worktree's HEAD).
- Brain knowledge (queried via `brain-query`).

## Outputs

- `<worktree>/.forge/work-items/WI-<n>.md` — one file per work item, frontmatter + spec body. **Schema locked in [ADR 015](../decisions/015-work-item-format.md).**
- `<worktree>/.forge/work-items/_graph.md` — dependency graph (mermaid `graph TD`) for human review. **Format locked in [ADR 015](../decisions/015-work-item-format.md).**

Validation enforced by [`orchestrator/work-item.ts:validateWorkItem`](../../orchestrator/work-item.ts) before the orchestrator dispatches work items to the developer loop.

### Optional WI fields (S3 refinement 2026-05-20 / ADR 015 §3a / [CONTRACTS.md C5](../planning/2026-05-20-refinement/CONTRACTS.md))

Four optional fields tighten the dev-loop signal on larger initiatives. All four are omit-on-undefined — a WI without any of them serialises byte-identically to the legacy shape:

| Field | Type | Purpose |
|---|---|---|
| `quality_gate_cmd` | `string[]` | Per-WI gate command override (e.g. `["npm","test","--","tests/x.test.ts"]`). Eliminates the trivially-green pathology on initiatives where the whole-project gate would pass without the WI's work. |
| `non_goals` | `string[]` | Explicit out-of-scope items pulled forward from the manifest's per-feature `non_goals`. Rescues over-eager dev-loop. |
| `verification_artifact` | `string` | Path the dev-loop must produce that the gate exercises. Must appear in `files_in_scope`. |
| `creates` | `string[]` | Structured marker for files this WI creates from scratch. Subset of `files_in_scope`. Bench's `one_creator_per_file` + `files_real_or_explicitly_new` consume this. |

`demo_hook` is **NOT** a WI field — it's initiative-level only ([CONTRACTS.md](../planning/2026-05-20-refinement/CONTRACTS.md) C15b).

## Skills

- [`skills/project-manager/SKILL.md`](../../skills/project-manager/SKILL.md)

## Success signals

- **Atomicity:** each work item touches ≤3 files (target; not absolute).
- **Verifiability:** each work item has at least one Given-When-Then acceptance criterion.
- **Parallelism:** at least 30% of work items can run in parallel (no dependency edge between them).
- **Downstream completion:** work items emitted by the PM have a higher developer-loop completion rate than hand-written ones.
- **No clarification asks:** the developer loop never has to come back to the PM for clarification (self-sufficient specs).

## Sizing band (S3 refinement)

Locked in `orchestrator/pm-invocation.ts` user prompt + `orchestrator/phases/project-manager.ts` derived range:

- **Per feature:** 1-3 WIs. <1 = under-decomposed; >3 = the feature is two features (escalate to architect via a brain-gap note).
- **Per initiative:** `feature_count..2*feature_count+2`, with a ceiling of **8** unless `feature_count > 4` (then `2*fc+2`). Floor is `max(feature_count, 2)`.
- **Per-file rule:** at most one WI **creates** a given file (listed in its `creates` array). Subsequent WIs extend it and `depends_on` the creator.
- **No new features.** PM may not invent a `FEAT-N` not in the manifest — `knownFeatureIds` is wired into both `runProjectManager` and `benchmarks/project-manager/score.ts` ([CONTRACTS.md C5a](../planning/2026-05-20-refinement/CONTRACTS.md)).

## Hallucinated-FEAT recovery flow ([CONTRACTS.md C5b](../planning/2026-05-20-refinement/CONTRACTS.md))

If the PM emits a WI whose `feature_id` is not in the manifest's known set:

1. The validator (`validateWorkItem` with `knownFeatureIds`) hard-errors.
2. `runProjectManager` catches and detects the failure shape — only the hallucination, nothing else broken.
3. Orchestrator wipes the stale `.forge/work-items/` dir and re-invokes the PM **once** with the prompt augmented by `renderPmHallucinationRetryAugment` — names the manifest's feature IDs verbatim and tells the agent to re-map rather than invent.
4. If the retry also hallucinates, the orchestrator emits a terminal `pm.feature-hallucination` event and throws. The cycle's failure-classifier picks up `pm-feature-hallucination` (non-recoverable — needs an architect-side amend, not an auto-retry).

Tested in [`orchestrator/cycle-pm-hallucination.test.ts`](../../orchestrator/cycle-pm-hallucination.test.ts).

## Benchmark suite

[`benchmarks/project-manager/`](../../benchmarks/project-manager/)
- `initiatives.json` — five fixtures, one per managed project, calibrated against project-specific brain themes. See the [bench README](../../benchmarks/project-manager/README.md). Per [CONTRACTS.md C11](../planning/2026-05-20-refinement/CONTRACTS.md), `score.ts` parses both the old `expected.{min,max}_work_items` shape and the new manifest-topology-derived shape for one release.
- `score.ts` — invokes the PM skill against fixtures and scores the 9-criteria rubric + 1 gate; pass threshold 0.7. The gate (`feature_id_in_manifest`) trips → 0 score.
- `scoring.ts` / `sdk.ts` / unit tests — pure scoring functions and the SDK invocation shim, both unit-tested. Three new deterministic criteria: `one_creator_per_file`, `quality_gate_cmd_present`, `files_real_or_explicitly_new` (each consumes a structured field — no NLP).

The bench's invocation contract lives in [`orchestrator/pm-invocation.ts`](../../orchestrator/pm-invocation.ts) and is shared with the live cycle in [`orchestrator/cycle.ts`](../../orchestrator/cycle.ts) — one source of truth for the PM's system prompt + user prompt.

## Locked formats

- Work-item file schema, `_graph.md` mermaid format, work-item-id scheme (`WI-<n>` per-initiative): all locked in [ADR 015](../decisions/015-work-item-format.md).
- Validation: [`orchestrator/work-item.ts`](../../orchestrator/work-item.ts) — `parseWorkItem` / `validateWorkItem` / `validateWorkItemSet` / `detectHiddenCoupling`.

## Known failure modes (to defend against)

- **Over-decomposition** — 50 work items for a 3-day feature. Capped via the bench's `work_item_count_in_range` criterion + sizing-band prompt guidance.
- **Under-decomposition** — one giant work item. Same.
- **Vague acceptance criteria** — passes the buck to the developer loop. `every_item_has_gwt` (0.18) explicitly scores Given-When-Then completeness.
- **Hidden dependencies** — work items collide at merge time. PM's last-step self-check (`detectHiddenCoupling`) drives `no_hidden_coupling` (0.15).
- **Feature hallucination** — PM invents `FEAT-N` not in the manifest. Caught at the validator layer (C5a `knownFeatureIds` wired into both bench and live cycle); retried once with an augmented prompt (C5b); terminal `pm-feature-hallucination` failure mode if persistent.
- **Multiple creators for one file** — two WIs implicitly create the same file ⇒ merge conflict + bench mis-scoring. The `creates` field + bench's `one_creator_per_file` (0.12) make this deterministically scoreable.
- **Trivially-green dev-loops** — initiative-wide gate passes before any WI's work lands ⇒ Ralph exits on iteration 0. `quality_gate_cmd_present` (0.10) requires per-WI gates on larger initiatives (iteration_budget > 5).
