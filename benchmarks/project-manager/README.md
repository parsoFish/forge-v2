# Benchmarks — Project Manager

> Scores the project-manager skill's work-item decomposition against ADR 015 (work-item format) and the success signals in [docs/phases/project-manager.md](../../docs/phases/project-manager.md). Deterministic-input bench: each fixture supplies a fully-specified initiative manifest plus a minimal project tree, and we score the artifacts the PM emits.

## Cases

`initiatives.json` — array of fixtures:

```json
{
  "id": "P1-env-optimiser-cli-flag",
  "initiative_manifest": "fixtures/init-env-optimiser-cli-flag.md",
  "project": "env-optimiser",
  "project_tree": "fixtures/projects/env-optimiser",
  "expected": {
    "min_work_items": 3,
    "max_work_items": 6,
    "parallel_fraction_at_least": 0.3
  }
}
```

Five starter fixtures, one per managed project, each calibrated against a specific brain theme:

| Fixture | Project | Brain calibration | What it stresses |
|---------|---------|-------------------|------------------|
| `P1-env-optimiser-cli-flag` | env-optimiser | `brain/projects/env-optimiser/profile.md` (gold standard, 3.6 min avg, 100% completion v1) | Clean Python case — bench passes here proves PM works on the easy path |
| `P2-trafficGame-algorithm` | trafficGame | `brain/projects/trafficGame/themes/algorithm-heavy-items.md` (decompose ≥3 WIs: data-shape → algorithm → integration → tests) | Forces decomposition discipline; under-decomposition fails the count gate |
| `P3-simplarr-bash-pwsh` | simplarr | `brain/projects/simplarr/decisions.md` (paired-language WIs required) | Forces correct dep-graph structure (Bash WI parallel to PowerShell WI, neither depending on the other) |
| `P4-GitWeave-multipart` | GitWeave | `brain/projects/GitWeave/profile.md` (multi-PR initiatives routine) | Tests `parallel_fraction_meets` on a naturally multi-track initiative |
| `P5-healarr-doc-update` | healarr | `brain/projects/healarr/profile.md` (small-surface case) | Smallest-fixture floor — guards against PM over-decomposing trivial work |

Each fixture pairs a real `InitiativeManifest` (validates against `orchestrator/manifest.ts`) with a 3-to-7-file project scaffold under `fixtures/projects/<name>/` — enough that the PM can read structure and pick `files_in_scope`.

## Scoring

Pure functions in [`scoring.ts`](./scoring.ts); tests in [`scoring.test.ts`](./scoring.test.ts).

Six 0/1 criteria, weighted; gated on `work_items_present`:

| Criterion | Weight | Source |
|-----------|--------|--------|
| `work_items_present` | gate | At least one work-item file written. If 0, total = 0. |
| `every_item_has_gwt` | 0.25 | Every WI has ≥1 acceptance criterion with non-empty given/when/then. Highest weight: vague criteria break the developer loop. |
| `no_hidden_coupling` | 0.20 | No two WIs share a file in `files_in_scope` without a transitive `depends_on` edge connecting them ([`orchestrator/work-item.ts:detectHiddenCoupling`](../../orchestrator/work-item.ts)). |
| `work_item_count_in_range` | 0.15 | WI count ∈ `[expected.min_work_items, expected.max_work_items]`. |
| `every_item_lists_scope` | 0.15 | Every WI has non-empty `files_in_scope`. |
| `parallel_fraction_meets` | 0.15 | Fraction of WIs with empty `depends_on` ≥ `expected.parallel_fraction_at_least`. |
| `graph_emitted_valid` | 0.10 | `_graph.md` exists, contains `graph TD`, and references every WI as a node. |

Pass threshold = **0.7** weighted score (matches the brain + architect bar).

`brain_consulted` is intentionally not a scored criterion — work-item bodies are specs, where citing the brain in every WI is unnatural. We surface brain consultation via `tool_use.brainReads` in the result JSON for inspection and add it as a scored criterion only if the bench plateaus.

## Runtime

[`sdk.ts`](./sdk.ts) — wraps the Claude Agent SDK via the shared invocation contract in [`orchestrator/pm-invocation.ts`](../../orchestrator/pm-invocation.ts). Each fixture runs in its own tempdir with read-only symlinks to `brain/`, `skills/`, `docs/`, `orchestrator/`, the initiative seeded into `_queue/in-flight/<id>.md`, and the `project_tree` copied to `projects/<name>/`. The PM writes work items to `<tempdir>/projects/<name>/.forge/work-items/`. Bench reads them back, scores, and cleans up.

[`score.ts`](./score.ts) — entry point. `npm run bench:project-manager` runs all fixtures with bounded concurrency (4), enforces a session budget cap ($5), and writes `results/<iso>.json`.

## Why these dimensions and weights

- **`every_item_has_gwt` is highest-weighted** because vague acceptance criteria are the failure mode that propagates downstream and breaks the developer loop ([`docs/phases/project-manager.md:58`](../../docs/phases/project-manager.md#L58)) — same justification the architect bench uses for `specs_concrete`.
- **`no_hidden_coupling` is second** because it's the merge-time conflict failure mode v1 cycle 3 surfaced (90 test failures from squash-merging stacked PRs). PM's last-step self-check from `SKILL.md` step 5 directly addresses it.
- **Count, scope, and parallelism each weighted 0.15** — important but not enough to fail a fixture on their own. Out-of-range count and missing scope are easy to fix in a refactor pass; coupling and vague criteria are not.
- **`graph_emitted_valid` is lowest** at 0.10 because the graph is a derived view of `depends_on`. If it's missing, the underlying `depends_on` data is still usable; if `depends_on` is wrong, the graph won't save us.

## Status

✅ Operational. Five fixtures wired against real `InitiativeManifest` instances + minimal project trees. Iteration on SKILL.md prompt happens by re-running the bench and inspecting which criterion regressed.
