---
initiative_id: INIT-2026-05-18-betterado-03-task-group-test-substrate
project: terraform-provider-betterado
project_repo_path: /home/parso/forge/projects/terraform-provider-betterado
created_at: '2026-05-18T22:35:00.000Z'
iteration_budget: 44
cost_budget_usd: 30
phase: pending
origin: architect
quality_gate_cmd:
  - go
  - test
  - ./azuredevops/internal/service/taskagent/...
features:
  - feature_id: FEAT-1
    title: >-
      taskagent_sdk_mock unit-test harness for resource_task_group (CRUD +
      expand/flatten)
    depends_on: []
  - feature_id: FEAT-2
    title: >-
      Complete createable gaps: task_group parameters/inputs + revision handling
      + tests
    depends_on:
      - FEAT-1
  - feature_id: FEAT-3
    title: Docs + example
    depends_on:
      - FEAT-2
---

# betterado task_group: test substrate + createable completeness

## Why

`task_group` is the fork's other net-new resource and also has **zero unit
tests**. Mock tests are required for unattended verification and become the
harness for future task_group work.

See [`brain/projects/terraform-provider-betterado/themes/release-substrate-context.md`](../../../../../../brain/projects/terraform-provider-betterado/themes/release-substrate-context.md) for the documented release-pipelines / task-group gap analysis.

## Scope

- Characterization mock tests for the existing `resource_task_group.go`.
- Fill createable gaps: full `inputs`/`parameters` schema, revision-conflict
  handling.

## Project-level constraints (binding)

Shared council constraints + PM scope-guard for this project live in
[`brain/projects/terraform-provider-betterado/themes/council-constraints.md`](../../../../../../brain/projects/terraform-provider-betterado/themes/council-constraints.md).

## Acceptance criteria

- FEAT-1 — **Given** a gomock taskagent client returning a fixture
  `TaskGroup`, **when** CRUD runs, **then** SDK args match and state
  round-trips; tests pass; `go build ./...` exits 0.
- FEAT-2 — **Given** a config exercising parameters/inputs, **when** expand
  runs, **then** it round-trips through flatten with no drift; revision-conflict
  retry covered by mock tests.
- FEAT-3 — `docs/resources/task_group.md` updated; `examples/` snippet plans
  clean.
