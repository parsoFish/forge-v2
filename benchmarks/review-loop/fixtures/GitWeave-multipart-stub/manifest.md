---
initiative_id: INIT-2026-05-09-gitweave-multipart-stub
project: GitWeave
project_repo_path: /tmp/GitWeave
created_at: 2026-05-09T10:00:00Z
iteration_budget: 50
cost_budget_usd: 25
phase: in-flight
features:
  - feature_id: FEAT-1
    title: Multipart body splitter
    depends_on: []
---

# Initiative: Multipart body splitter

Some GitHub webhook payloads arrive as `multipart/related`. The runner needs a small helper to
split such bodies on a boundary marker and return the inner parts.

## Why now

The aggregation pipeline currently mishandles multipart bodies, throwing on the first chunk. A
narrow boundary-splitter is the smallest unblocking change.
