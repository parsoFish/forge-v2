---
initiative_id: INIT-2026-05-18-betterado-01-release-def-test-substrate
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
  - ./azuredevops/internal/service/release/...
features:
  - feature_id: FEAT-1
    title: >-
      release_sdk_mock unit-test harness for resource_release_definition (CRUD +
      expand/flatten)
    depends_on: []
  - feature_id: FEAT-2
    title: pre_deployment_gates schema block + expand/flatten + mock tests
    depends_on:
      - FEAT-1
  - feature_id: FEAT-3
    title: post_deployment_gates block (executionOrder/options parity) + mock tests
    depends_on:
      - FEAT-2
  - feature_id: FEAT-4
    title: Docs + example for deployment gates
    depends_on:
      - FEAT-3
---

# betterado release_definition: test substrate + deployment gates

## Why

Classic release pipelines are the fork's reason to exist, yet
`azuredevops/internal/service/release/resource_release_definition.go` has
**zero unit tests**. Laying the mock test substrate here pays double: it is
required for unattended verification AND becomes the demo harness for every
later release initiative.

See [`brain/projects/terraform-provider-betterado/themes/release-substrate-context.md`](../../../../../../brain/projects/terraform-provider-betterado/themes/release-substrate-context.md) for the documented release-pipelines gap analysis.

## Scope

- Add `azdosdkmocks`/gomock unit tests for the existing release_definition
  resource (characterization tests — no behaviour change in FEAT-1).
- Add `pre_deployment_gates` and `post_deployment_gates` schema blocks.

## Project-level constraints (binding)

Shared council constraints + PM scope-guard for this project live in
[`brain/projects/terraform-provider-betterado/themes/council-constraints.md`](../../../../../../brain/projects/terraform-provider-betterado/themes/council-constraints.md).

## Acceptance criteria

- FEAT-1 — **Given** a gomock release client returning a fixture
  `ReleaseDefinition`, **when** Read/Create/Update/Delete run, **then** the
  SDK is called with expected args and state matches the flattened fixture;
  `go test ./azuredevops/internal/service/release/...` passes; `go build ./...`
  exits 0.
- FEAT-2/3 — **Given** a config with `pre_deployment_gates`/`post_deployment_gates`,
  **when** expand runs, **then** the produced SDK struct round-trips through
  flatten with no drift and `executionOrder` differs correctly; mock tests
  cover both blocks.
- FEAT-4 — `docs/resources/release_definition.md` documents the new blocks;
  an `examples/` snippet plans clean.
