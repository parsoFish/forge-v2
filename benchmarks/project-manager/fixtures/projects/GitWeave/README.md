# GitWeave

Multi-PR orchestration for stacked feature work. Coordinates layered-merge cycles across dependent PRs.

## Layout

- `src/runner.ts` — main stage runner (currently mixes scheduling, retry, persistence, **and merge logic** — being refactored).
- `src/cli.ts` — CLI entry point.
- `src/persistence.ts` — result persistence.
- `tests/` — per-module unit + integration tests.

## Constraint

**Layered-merge order is non-negotiable.** v1 Cycle 3: squash-merging stacked PRs produced 90 test failures. The default merge strategy must respect the dependency order; new strategies must be opt-in.
