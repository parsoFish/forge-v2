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

**Status clarification (council flag status-inconsistency):** `resource_release_definition.go` EXISTS and is feature-complete (`docs/feature-plan.md` marks its phases ✅) but has **ZERO unit tests**. FEAT-1 is *characterization* tests — assert current behaviour, NO behaviour change.

Classic release pipelines (`vsrm.dev.azure.com`) are the fork's reason to
exist, yet `azuredevops/internal/service/release/resource_release_definition.go`
has **zero unit tests** and `docs/feature-plan.md` §2.2 (pre/post deployment
gates) is the last open P1 correctness gap. Laying the mock test substrate
here pays double: it is required for unattended verification AND becomes the
demo harness for every later release initiative.

## Scope

- Add `azdosdkmocks`/gomock unit tests for the existing release_definition
  resource (no behaviour change in FEAT-1 — characterization tests).
- Add `pre_deployment_gates` and `post_deployment_gates` schema blocks
  (`gates_options { is_enabled, timeout, sampling_interval, stabilization_time,
  minimum_success_duration }` + repeatable `gate` task blocks) to the
  environment, with expand/flatten and tests.

## Verification mandate (load-bearing)

Unattended forge has no live ADO creds. Quality gate + demo substrate is
`go test ./azuredevops/internal/service/release/...` using `release_sdk_mock`.
No acceptance-only verification.

## Acceptance criteria

- FEAT-1 — **Given** a gomock release client returning a fixture
  `ReleaseDefinition`, **when** Read/Create/Update/Delete run, **then** the
  SDK is called with expected args and state matches the flattened fixture;
  `go test ./azuredevops/internal/service/release/...` passes; `go build ./...`
  exits 0.
- FEAT-2/3 — **Given** a config with `pre_deployment_gates`/`post_deployment_gates`,
  **when** expand runs, **then** the produced SDK struct round-trips through
  flatten with no drift and `executionOrder` differs correctly (pre=`beforeGates`,
  post=`afterSuccessfulGates` per docs/api-reference/api-validation-findings.md);
  mock tests cover both blocks.
- FEAT-4 — `docs/resources/release_definition.md` documents the new blocks;
  an `examples/` snippet plans clean.

## Constraints

Additive only (no invasive edits to inherited code); `betterado_` surface;
vendored offline build stays green. Rollback: blocks are Optional — absent
config reproduces today's behaviour exactly.

## Council constraints (binding — LLM-Council 2026-05-18)

- Gate: `go test ./azuredevops/internal/service/release/...` passes + `go build -mod=vendor ./...` exits 0 + each new `betterado_*` registered in `azuredevops/provider.go`. A test pkg that compiles but asserts nothing is a FAIL.
- Per resource: 5 mock unit tests — expand↔flatten roundtrip, create API-error, read-404-clears-state, update-calls-SDK-with-args, delete API-error — mirroring upstream `resource_environment_test.go`.
- Docs (comprehensive): `docs/resources/<name>.md` (description, basic + complex example, argument & attribute reference, import) + runnable `examples/<name>/`. Edit `docs/resources/` + `examples/` only, never `website/`.
- Fixtures: inline if <20 lines else `testdata/*.json`. Never hand-edit `azdosdkmocks/` (regenerate + commit if an SDK signature changes).
- Additive & atomic: absent config reproduces prior behaviour; a quality-gate failure marks the initiative BLOCKED (no cascade to independents).

## Scope — PM: stay inside this, do NOT explore the rest of the repo

terraform-provider-betterado is a large vendored Go monorepo (286+ `*_test.go`, a huge `vendor/`). Plan work-items ONLY against:
- `azuredevops/internal/service/release/` — the resource + test code for this initiative (create the dir if it is new).
- `azuredevops/provider.go` — register each new `betterado_*` name here.
- The matching mock `azdosdkmocks/<area>_sdk_mock.go` (read, never edit).
- ONE existing upstream `*_test.go` in a sibling `azuredevops/internal/service/*` package as the gomock pattern to mirror.

Do NOT `Glob`/scan `vendor/`, the repo root, `website/`, or `docs/` trees — every WI's `files_in_scope` lives under the paths above. Brain-query is mandatory but bounded: 1–2 targeted queries, not broad exploration.
