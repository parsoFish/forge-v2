---
title: Demos for this project use the Go-test harness, not Playwright media
description: No web UI — forge demos this provider via kind:"harness" go test metric scraping; release/task_group are acceptance-only.
category: operation
keywords: [demo, harness, go test, playwright, testacc, TF_ACC, metrics, release]
created_at: 2026-05-18T10:43:08Z
updated_at: 2026-05-18T10:43:08Z
related_themes: [2026-05-18-stack-and-test-layout]
---

# Demos use the Go-test harness path

This is a Go Terraform provider with **no web UI and no dev server**.
Forge's demo-runtime media path (`startServer` → `npm run dev/preview` →
Playwright spec) cannot run here, and a screenshot/video checkpoint would
be fabricated. The demo author must therefore use `kind:"harness"`
checkpoints only.

**How to demo an initiative here:** in `demo-manifest.json` write a
`harness` block whose `command` runs the **project's own** `go test`
covering the changed behaviour (a scoped package, not `./...`), and
`metrics` regexes that scrape that test's printed output (pass counts,
timings, resource-shaped assertions). The orchestrator reruns it in the
baseline and changed trees and renders a before/after table — no spec
file, no capture. Reuse existing tests; never re-derive the measurement.

**Load-bearing caveat:** the fork's net-new code
(`azuredevops/internal/service/release/`, task_group) has **zero unit
tests** — it is acceptance-only (`TF_ACC=1` + a live Azure DevOps org +
PAT, which unattended forge does not have). A unit-only harness cannot
behaviourally exercise release/task_group changes. Initiatives touching
that surface should **add unit tests first** (which then also become the
harness substrate) rather than rely on acceptance tests.

Verified at onboarding: `go build ./...` clean; unit packages pass; Go
1.24.1 on PATH via `~/.profile`/`~/.bashrc` so `bash -lc` harness commands
resolve `go`.

## Sources

- [`_raw/projects/terraform-provider-betterado/2026-05-18-onboarding.repo.md`](../../../_raw/projects/terraform-provider-betterado/2026-05-18-onboarding.repo.md) — test layout, the release-package zero-unit-test finding, substrate verification.

## Related

- [Theme: stack-and-test-layout](./2026-05-18-stack-and-test-layout.md)
