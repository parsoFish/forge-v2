---
initiative_id: INIT-2026-05-18-betterado-04-test-plan-core
project: terraform-provider-betterado
project_repo_path: /home/parso/forge/projects/terraform-provider-betterado
created_at: '2026-05-18T22:35:00.000Z'
iteration_budget: 48
cost_budget_usd: 34
phase: pending
origin: architect
quality_gate_cmd:
  - go
  - test
  - ./azuredevops/internal/service/test/...
depends_on_initiatives:
  - INIT-2026-05-18-betterado-01-release-def-test-substrate
  - INIT-2026-05-18-betterado-03-task-group-test-substrate
features:
  - feature_id: FEAT-1
    title: >-
      New test service package + betterado_test_plan resource + mock tests +
      provider registration
    depends_on: []
  - feature_id: FEAT-2
    title: betterado_test_suite (static/requirement/query types) + mock tests
    depends_on:
      - FEAT-1
  - feature_id: FEAT-3
    title: betterado_test_configuration + mock tests
    depends_on:
      - FEAT-1
  - feature_id: FEAT-4
    title: Docs + examples for the test-management trio
    depends_on:
      - FEAT-2
      - FEAT-3
---

# betterado Test Management — core (test plans, suites, configurations)

## Why

Test Management is the single **largest absent createable API area**.
See [`brain/projects/terraform-provider-betterado/themes/release-substrate-context.md`](../../../../../../brain/projects/terraform-provider-betterado/themes/release-substrate-context.md) for the createable-surface gap analysis.

## Scope

- New package `azuredevops/internal/service/test/`.
- `betterado_test_plan`, `betterado_test_suite`, `betterado_test_configuration`.

## Project-level constraints (binding)

Shared council constraints + PM scope-guard for this project live in
[`brain/projects/terraform-provider-betterado/themes/council-constraints.md`](../../../../../../brain/projects/terraform-provider-betterado/themes/council-constraints.md).

## Acceptance criteria

- FEAT-1 — **Given** a gomock test client returning a fixture `TestPlan`,
  **when** CRUD runs, **then** SDK args match and state round-trips.
- FEAT-2 — `betterado_test_suite` supports all three suite types; mock tests
  assert type-specific create payloads.
- FEAT-3 — `betterado_test_configuration` CRUD round-trips under mock.
- FEAT-4 — `docs/resources/test_plan.md`, `test_suite.md`,
  `test_configuration.md` + `examples/` that plan clean.
