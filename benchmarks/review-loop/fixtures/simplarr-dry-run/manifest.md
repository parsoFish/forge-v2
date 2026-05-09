---
initiative_id: INIT-2026-05-09-simplarr-dry-run
project: simplarr
project_repo_path: /tmp/simplarr
created_at: 2026-05-09T10:00:00Z
iteration_budget: 50
cost_budget_usd: 25
phase: in-flight
features:
  - feature_id: FEAT-1
    title: Add --dry-run to apply
    depends_on: []
---

# Initiative: `--dry-run` for `simplarr apply`

`simplarr apply` previously had no preview mode — running it mutates state with no chance for the
operator to inspect what was about to happen. Add a `--dry-run` flag that prints the would-be
actions and exits cleanly.

## Why now

The `local-dry-run-required` theme codifies the operator policy: apply must always be previewed first.
Without a `--dry-run` flag the policy is unenforceable.
