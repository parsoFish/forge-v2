---
title: Stack & test layout (Go, vendored, make test vs make testacc)
description: Go 1.24.1 + Terraform Plugin SDK v2, vendored offline build; make test = unit, make testacc = live ADO.
category: reference
keywords: [go, terraform, sdk, vendor, make test, testacc, ci, azure devops, PAT]
created_at: 2026-05-18T10:43:08Z
updated_at: 2026-05-18T10:43:08Z
related_themes: [2026-05-18-go-test-harness-demos, 2026-05-18-branch-model-consolidated]
---

# Stack & test layout

- **Language:** Go, Terraform Plugin SDK v2. `go.mod` → `go 1.24.1`.
- **Module:** `github.com/parsoFish/terraform-provider-betterado`.
  Provider name `betterado`, resource prefix `betterado_*`, ADO REST API
  7.1, auth via `AZDO_PERSONAL_ACCESS_TOKEN`.
- **Deps vendored** (`vendor/`): `go build`/`go test` run fully offline.
- **Net-new value** lives in `azuredevops/internal/service/release/`
  (classic release pipelines, `vsrm.dev.azure.com`) + task_group; the rest
  is inherited upstream structure.

## Commands

- `make build` → `fmtcheck depscheck` then build.
- `make test` → `fmtcheck` + `go test -v ./...`. Unit suite; acceptance
  tests self-skip without `TF_ACC`. This is the safe unattended command.
- `make testacc` → `TF_ACC=1 go test … -timeout 120m`, sources `.env`;
  needs a **live Azure DevOps org + PAT** — not available to unattended
  cycles.
- 286 `*_test.go` files (excluding `vendor/`).
- CI: `.github/workflows/unit-test.yml` runs `make test` on PRs to `main`
  (Go 1.24); also depscheck / golint / oidc-test / terrafmt workflows.

## Environment note

Go 1.24.1 is installed at `~/.local/go` and exported on PATH via
`~/.profile` and `~/.bashrc`, so forge's `bash -lc` invocations (dev-loop,
harness demos) resolve `go`. If a cycle reports `go: command not found`,
re-check those profile exports.

## Sources

- [`_raw/projects/terraform-provider-betterado/2026-05-18-onboarding.repo.md`](../../../_raw/projects/terraform-provider-betterado/2026-05-18-onboarding.repo.md) — full repo extract: identity, stack, test layout, CI, onboarding actions.

## Related

- [Theme: go-test-harness-demos](./2026-05-18-go-test-harness-demos.md)
- [Theme: branch-model-consolidated](./2026-05-18-branch-model-consolidated.md)
