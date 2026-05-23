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

Test Management is the single **largest absent createable API area**: there
is no `test` service package at all, yet `test_sdk_mock.go` and the vendored
`test` SDK client both exist. Test plans/suites/configurations are the
foundation other test resources hang off.

## Scope

- New package `azuredevops/internal/service/test/`.
- `betterado_test_plan` (project-scoped: name, area_path, iteration,
  start/end dates, state).
- `betterado_test_suite` (static / requirement-based / query-based; parent
  suite; plan_id).
- `betterado_test_configuration` (name, values, state).
- Register all three in `azuredevops/provider.go`.

## Verification mandate

`go test ./azuredevops/internal/service/test/...` with `test_sdk_mock`. Each
resource MUST ship gomock CRUD + expand/flatten tests — an empty package
passing a no-op gate is rejected at review (provider-registration + build
assertions below prevent a hollow pass).

## Acceptance criteria

- FEAT-1 — **Given** a gomock test client returning a fixture `TestPlan`,
  **when** CRUD runs, **then** SDK args match and state round-trips; the
  package compiles; `betterado_test_plan` is registered; `go build ./...`
  exits 0.
- FEAT-2 — `betterado_test_suite` supports all three suite types; mock tests
  assert type-specific create payloads.
- FEAT-3 — `betterado_test_configuration` CRUD round-trips under mock.
- FEAT-4 — `docs/resources/test_plan.md`, `test_suite.md`,
  `test_configuration.md` + `examples/` that plan clean.

## Constraints

Mirror upstream package idioms; additive; vendored offline build green.
Rollback: brand-new package — no existing state affected.

## Council constraints (binding — LLM-Council 2026-05-18)

- Gate: `go test ./azuredevops/internal/service/test/...` passes + `go build -mod=vendor ./...` exits 0 + each new `betterado_*` registered in `azuredevops/provider.go`. A test pkg that compiles but asserts nothing is a FAIL.
- Per resource: 5 mock unit tests — expand↔flatten roundtrip, create API-error, read-404-clears-state, update-calls-SDK-with-args, delete API-error — mirroring upstream `resource_environment_test.go`.
- Docs (comprehensive): `docs/resources/<name>.md` (description, basic + complex example, argument & attribute reference, import) + runnable `examples/<name>/`. Edit `docs/resources/` + `examples/` only, never `website/`.
- Fixtures: inline if <20 lines else `testdata/*.json`. Never hand-edit `azdosdkmocks/` (regenerate + commit if an SDK signature changes).
- Additive & atomic: absent config reproduces prior behaviour; a quality-gate failure marks the initiative BLOCKED (no cascade to independents).

## Scope — PM: stay inside this, do NOT explore the rest of the repo

terraform-provider-betterado is a large vendored Go monorepo (286+ `*_test.go`, a huge `vendor/`). Plan work-items ONLY against:
- `azuredevops/internal/service/test/` — the resource + test code for this initiative (create the dir if it is new).
- `azuredevops/provider.go` — register each new `betterado_*` name here.
- The matching mock `azdosdkmocks/<area>_sdk_mock.go` (read, never edit).
- ONE existing upstream `*_test.go` in a sibling `azuredevops/internal/service/*` package as the gomock pattern to mirror.

Do NOT `Glob`/scan `vendor/`, the repo root, `website/`, or `docs/` trees — every WI's `files_in_scope` lives under the paths above. Brain-query is mandatory but bounded: 1–2 targeted queries, not broad exploration.
