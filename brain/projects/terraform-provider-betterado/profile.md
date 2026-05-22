---
project: terraform-provider-betterado
created_at: 2026-05-18T10:43:08Z
updated_at: 2026-05-18T10:43:08Z
status: active
domain: infrastructure tooling (Terraform provider for Azure DevOps)
stack: [Go, Terraform Plugin SDK v2, Azure DevOps REST API 7.1]
taste_decay: 0.05
---

# terraform-provider-betterado

A GitHub fork of `microsoft/terraform-provider-azuredevops` ("better ADO
provider"). It inherits the full official provider (100+ resources) and adds
what Microsoft has not implemented — chiefly **classic release pipelines**
(`vsrm.dev.azure.com` REST API) and **task groups**. Success = the new
`betterado_*` resources manage real Azure DevOps release/task-group state
correctly, cleanly track upstream, and stay mergeable back toward upstream.

## Taste signals

- Stay faithful to upstream's package structure and idioms — this is a
  fork meant to (potentially) contribute back, not a rewrite.
- New surface lives behind the `betterado_` prefix; the `release/` service
  package is the home of the net-new value.
- Prefer additive resources/attributes over invasive changes to inherited
  code (keeps upstream merges tractable).

## Hard constraints

- **Acceptance tests need live Azure DevOps** (`TF_ACC=1` + a PAT via
  `AZDO_PERSONAL_ACCESS_TOKEN`). Unattended forge cycles have no ADO creds,
  so behavioural verification of release/task_group resources is limited to
  what unit tests cover — and **the new fork resources currently have no
  unit tests** ([[2026-05-18-go-test-harness-demos]]).
- Go 1.24.1; deps are vendored — do not break offline `go build`/`go test`.
- Single-branch model: `main` is the fork. The repo's own `CLAUDE.md`
  describes a now-superseded two-branch workflow — do not trust it
  ([[2026-05-18-branch-model-consolidated]]).

## Active focus

- Onboarded 2026-05-18; no initiatives run yet. First initiatives pending
  architect. Highest-value area: the release-pipeline / task_group
  resources (the fork's reason to exist) — which also have the weakest test
  coverage, so test-first work there pays double.

## Cycles

_None yet — onboarded 2026-05-18, awaiting first architect pass._
