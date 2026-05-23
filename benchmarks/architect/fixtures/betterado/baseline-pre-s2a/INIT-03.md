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

**Status clarification (council flag status-inconsistency):** `resource_task_group.go` EXISTS and is registered (`betterado_task_group`) but has **ZERO unit tests**. FEAT-1 is *characterization* tests (no behaviour change); FEAT-2 then fills createable gaps.

`task_group` is the fork's other net-new resource and also has **zero unit
tests** (acceptance-only). It is registered (`betterado_task_group`) but its
createable surface (parameters/inputs, revision handling) is incomplete.
Mock tests are required for unattended verification and become the harness
for future task_group work.

## Scope

- Characterization mock tests for the existing `resource_task_group.go`.
- Fill createable gaps: full `inputs`/`parameters` schema, `runsOn`,
  revision-conflict handling (mirror release_definition's revision retry
  pattern), version fields — verified against
  `docs/api-reference/task-groups.md`.

## Verification mandate

`go test ./azuredevops/internal/service/taskagent/...` with
`taskagent_sdk_mock`. No acceptance-only verification.

## Acceptance criteria

- FEAT-1 — **Given** a gomock taskagent client returning a fixture
  `TaskGroup`, **when** CRUD runs, **then** SDK args match and state
  round-trips; tests pass; `go build ./...` exits 0.
- FEAT-2 — **Given** a config exercising parameters/inputs, **when** expand
  runs, **then** it round-trips through flatten with no drift; a simulated
  revision-conflict on Update is retried once (re-read → retry) per the
  release_definition pattern — **revision-conflict retry: max 3 attempts, exponential backoff 1s/2s/4s; the surfaced error includes the attempt count and advises manual resolution after exhaustion (ADO 409 Conflict pattern)** — covered by mock tests.
- FEAT-3 — `docs/resources/task_group.md` updated; `examples/` snippet plans
  clean.

## Constraints

Additive; preserve existing state shape (no breaking schema changes — new
fields Optional/Computed). Vendored offline build green.

## Council constraints (binding — LLM-Council 2026-05-18)

- Gate: `go test ./azuredevops/internal/service/taskagent/...` passes + `go build -mod=vendor ./...` exits 0 + each new `betterado_*` registered in `azuredevops/provider.go`. A test pkg that compiles but asserts nothing is a FAIL.
- Per resource: 5 mock unit tests — expand↔flatten roundtrip, create API-error, read-404-clears-state, update-calls-SDK-with-args, delete API-error — mirroring upstream `resource_environment_test.go`.
- Docs (comprehensive): `docs/resources/<name>.md` (description, basic + complex example, argument & attribute reference, import) + runnable `examples/<name>/`. Edit `docs/resources/` + `examples/` only, never `website/`.
- Fixtures: inline if <20 lines else `testdata/*.json`. Never hand-edit `azdosdkmocks/` (regenerate + commit if an SDK signature changes).
- Additive & atomic: absent config reproduces prior behaviour; a quality-gate failure marks the initiative BLOCKED (no cascade to independents).

## Scope — PM: stay inside this, do NOT explore the rest of the repo

terraform-provider-betterado is a large vendored Go monorepo (286+ `*_test.go`, a huge `vendor/`). Plan work-items ONLY against:
- `azuredevops/internal/service/taskagent/` — the resource + test code for this initiative (create the dir if it is new).
- `azuredevops/provider.go` — register each new `betterado_*` name here.
- The matching mock `azdosdkmocks/<area>_sdk_mock.go` (read, never edit).
- ONE existing upstream `*_test.go` in a sibling `azuredevops/internal/service/*` package as the gomock pattern to mirror.

Do NOT `Glob`/scan `vendor/`, the repo root, `website/`, or `docs/` trees — every WI's `files_in_scope` lives under the paths above. Brain-query is mandatory but bounded: 1–2 targeted queries, not broad exploration.
