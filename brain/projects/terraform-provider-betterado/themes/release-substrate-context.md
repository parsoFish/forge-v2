---
slug: release-substrate-context
project: terraform-provider-betterado
date_added: 2026-05-22
related_themes:
  - council-constraints.md
  - 2026-05-18-stack-and-test-layout.md
---

# terraform-provider-betterado — release-pipelines / createable-surface gap

Captures the analysis the architect references from substrate initiatives
(INIT-01 release_definition, INIT-03 task_group, INIT-04 test plan core)
so the manifests themselves don't restate the same gap-analysis prose.

## What's missing

The terraform-provider-betterado fork's reason to exist is **classic
release pipelines** (`vsrm.dev.azure.com`) — they're unsupported in the
upstream provider. The substrate initiatives close the test substrate for
the resources the fork ships.

| Area | File | State | Tests | Gap |
|---|---|---|---|---|
| release_definition | `resource_release_definition.go` | exists, registered | zero | needs mock substrate + gates |
| task_group | `resource_task_group.go` | exists, registered | zero | needs mock substrate + createable completeness |
| test management | `service/test/` | absent | n/a | needs new package + 3 resources |

## Why substrate first

INIT-01, INIT-03, and INIT-04 are the **substrate** initiatives — every
other betterado initiative (02, 05-19) gates on at least one of them.
Closing the substrate unblocks 17 dependents for free; running the
substrate as the first three initiatives is the most-load-bearing slice
of the queue.

## Aggregate footprint

20 initiatives total in the 2026-05-18 architect drop; ~840 iteration-units
and ~$534 cost ceiling in aggregate. The operator approves per-PLAN.md;
no hard gate (per CONTRACTS.md C19).
