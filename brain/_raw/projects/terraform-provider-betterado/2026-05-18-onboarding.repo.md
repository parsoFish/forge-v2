---
source_type: repo
source_url: https://github.com/parsoFish/terraform-provider-betterado
source_title: terraform-provider-betterado — onboarding extract (repo @ 0822657)
ingested_at: 2026-05-18T10:43:08Z
ingested_by: brain-ingest (operator-run, out-of-cycle onboarding)
---

# terraform-provider-betterado — onboarding ground truth

Ground-truth extract captured when the repo was onboarded into forge on
2026-05-18. Repo HEAD at ingest: `0822657092906c13d146758530ab9d3044a1fdc6`.

## Identity & purpose

- GitHub fork of `microsoft/terraform-provider-azuredevops`. Inherits the
  full official provider (100+ resources) and adds resources Microsoft has
  not implemented — chiefly **classic release pipelines** (REST API at
  `vsrm.dev.azure.com`, which the official provider has zero support for)
  and **task groups**.
- Go module: `github.com/parsoFish/terraform-provider-betterado`.
- Provider name: `betterado`; resource prefix `betterado_*`. API version
  7.1. Auth: Personal Access Token via `AZDO_PERSONAL_ACCESS_TOKEN`.
- The fork's net delta over upstream is 4 commits: `397b9b67` fork setup +
  module rename to parsoFish + release definition resource; `3b2a0eb8`
  task_group resource + release_definition improvements; `b90e7dbb` docs;
  `08226570` security (removed `scripts/gogetcookie.sh`, a leaked Google
  Source cookie credential).

## Stack & toolchain

- Go (Terraform Plugin SDK v2). `go.mod` declares `go 1.24.1`.
- Dependencies are **vendored** (`vendor/` present) → `go build`/`go test`
  work fully offline.
- Build is clean: `go build ./...` exits 0 at HEAD `0822657`.

## Test layout (verified at ingest)

- `make test` → `fmtcheck` then `go test -v ./...`. Unit suite. Acceptance
  tests in `azuredevops/internal/acceptancetests/` self-skip when `TF_ACC`
  is unset (standard terraform-provider behaviour).
- `make testacc` → `TF_ACC=1 go test … -timeout 120m`; sources `.env` if
  present; needs a **live Azure DevOps org + PAT**.
- 286 `*_test.go` files (excluding `vendor/`).
- CI: `.github/workflows/unit-test.yml` runs `make test` on PRs to `main`
  (Go 1.24). Other workflows: depscheck, golint, oidc-test, terrafmt.
- **The new fork resources have ZERO unit tests.**
  `azuredevops/internal/service/release/` contains 0 `*_test.go` files;
  task_group is likewise acceptance-only. A unit-only run does not
  behaviourally exercise the release/task_group code.

## Onboarding actions taken (2026-05-18)

- Cloned to `projects/terraform-provider-betterado`.
- **Branch consolidation.** The repo's own `CLAUDE.md` documented a
  two-branch model (`main` tracks upstream microsoft; `betterado` holds all
  fork work; sync via `git merge upstream/main` → `betterado`). Operator
  decision: forge's project model is single-branch, so `main` was
  fast-forwarded onto `betterado`'s tip (`main` was a strict ancestor — 0
  commits ahead, 4 behind — so a clean fast-forward, no merge commit, no
  history rewrite, zero data loss), pushed, and `betterado` deleted local +
  remote. `main` now IS the fork at `0822657`. The repo's `CLAUDE.md`
  branch-model section is now stale/superseded.
- **Demo method:** Go-test harness (`kind:"harness"`). No web UI exists, so
  forge's Playwright media path (which requires a local npm dev server via
  `demo-runtime.startServer`) does not apply.
- Go 1.24.1 installed at `~/.local/go`; PATH exported in `~/.profile` and
  `~/.bashrc` so forge's `bash -lc` harness invocations resolve `go`.

## Source files of record (in-repo)

- `CLAUDE.md` — project overview, architecture, fork workflow (branch
  section now superseded by the consolidation above).
- `GNUmakefile` — `test` / `testacc` / `build` / `lint` targets.
- `docs/official-provider-codemap.md`, `docs/api-reference/` — release API
  reference & validation findings.
