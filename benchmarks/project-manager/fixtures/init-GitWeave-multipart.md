---
initiative_id: INIT-2026-05-08-gw-multi-strategy
project: GitWeave
project_repo_path: projects/GitWeave
created_at: 2026-05-08T10:00:00Z
iteration_budget: 30
cost_budget_usd: 12
phase: in-flight
features:
  - feature_id: FEAT-1
    title: Define MergeStrategy interface
    depends_on: []
  - feature_id: FEAT-2
    title: Port existing layered-merge logic to MergeStrategy
    depends_on:
      - FEAT-1
  - feature_id: FEAT-3
    title: Add stacked-PR strategy implementation
    depends_on:
      - FEAT-1
  - feature_id: FEAT-4
    title: CLI flag to select strategy
    depends_on:
      - FEAT-2
      - FEAT-3
---

# Pluggable merge-strategy interface for GitWeave

## Why

GitWeave's merge logic is hard-coded to the layered-merge approach (PR #21 → #22 + #23 → #24). v1 cycle 3 demonstrated that this is the right default — squash-merging stacked PRs produced 90 test failures — but external users have started asking about stacked-PR workflows where each PR represents a logical commit and the bottom-of-stack lands first.

This initiative refactors the merge logic behind a `MergeStrategy` interface and ships two implementations: layered-merge (existing behaviour, the default) and stacked-PR (new). The CLI gets a `--merge-strategy` flag.

**Per the brain's `GitWeave` profile, this is exactly the kind of multi-PR initiative the project handles routinely.** The PM should reflect that: extract the interface first (FEAT-1), then layered-merge port and stacked-PR can land in parallel (FEAT-2 and FEAT-3 do not depend on each other), and the CLI integration lands last (FEAT-4 depends on both implementations).

## Scope

- `src/merge/index.ts` — new `MergeStrategy` interface.
- `src/merge/layered.ts` — port existing logic from `src/runner.ts`.
- `src/merge/stacked.ts` — new implementation.
- `src/runner.ts` — strip merge logic, route through strategy.
- `src/cli.ts` — `--merge-strategy=<name>` flag.
- `tests/merge/{layered,stacked}.test.ts` — per-strategy unit tests.
- `tests/runner.test.ts` — integration test that runner correctly delegates.

## Out of scope

- Other strategies (octopus, semi-linear). One pluggable + one new is enough surface for v0.
- Changing the GitHub API client.
- Migration of users currently relying on implicit layered-merge behaviour (it remains the default; no breaking change).

## Acceptance

- `MergeStrategy` is the only thing `runner.ts` knows about for merge logic.
- Layered-merge tests still pass with no behavior change.
- Stacked-PR strategy correctly orders merges bottom-to-top and rebases as it goes.
- CLI flag is documented in `--help` and in the README.
- Layered-merge and stacked-PR implementations live in separate files and have no cross-imports — they parallelise cleanly across the developer loop.
