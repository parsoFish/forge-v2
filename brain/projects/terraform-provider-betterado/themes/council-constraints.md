---
slug: council-constraints
project: terraform-provider-betterado
date_added: 2026-05-22
related_themes:
  - 2026-05-18-stack-and-test-layout.md
  - 2026-05-18-go-test-harness-demos.md
---

# terraform-provider-betterado — binding council constraints

Project-level constraints shared by every betterado initiative (substrate +
createable-surface). The architect references this theme from each manifest
rather than copy-pasting the same five bullets into all 20 initiatives.

## Quality gate

`go test ./azuredevops/internal/service/<area>/...` passes + `go build
-mod=vendor ./...` exits 0 + each new `betterado_*` registered in
`azuredevops/provider.go`. A test pkg that compiles but asserts nothing is
a FAIL.

## Per-resource test substrate

Each createable resource ships five mock unit tests:

1. expand ↔ flatten roundtrip
2. create API-error
3. read-404-clears-state
4. update-calls-SDK-with-args
5. delete API-error

Pattern mirrors upstream `resource_environment_test.go`.

## Docs

`docs/resources/<name>.md` (description, basic + complex example, argument
& attribute reference, import) + runnable `examples/<name>/`. Edit
`docs/resources/` + `examples/` only, never `website/`.

## Fixtures

Inline if <20 lines else `testdata/*.json`. Never hand-edit
`azdosdkmocks/` (regenerate + commit if an SDK signature changes).

## Additive & atomic

Absent config reproduces prior behaviour; a quality-gate failure marks the
initiative BLOCKED (no cascade to independents).

## PM scope-guard

terraform-provider-betterado is a large vendored Go monorepo (286+
`*_test.go`, a huge `vendor/`). PM plans work-items ONLY against:

- `azuredevops/internal/service/<area>/` for the initiative's area.
- `azuredevops/provider.go` to register each new `betterado_*` name.
- The matching mock `azdosdkmocks/<area>_sdk_mock.go` (read, never edit).
- ONE existing upstream `*_test.go` in a sibling package as gomock pattern.

PM does NOT `Glob`/scan `vendor/`, the repo root, `website/`, or `docs/`
trees. Brain-query is mandatory but bounded: 1–2 targeted queries, not
broad exploration.
