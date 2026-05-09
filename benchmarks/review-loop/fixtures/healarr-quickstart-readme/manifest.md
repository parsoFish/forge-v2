---
initiative_id: INIT-2026-05-09-healarr-quickstart-readme
project: healarr
project_repo_path: /tmp/healarr
created_at: 2026-05-09T10:00:00Z
iteration_budget: 50
cost_budget_usd: 25
phase: in-flight
features:
  - feature_id: FEAT-1
    title: Quick start docs
    depends_on: []
---

# Initiative: Quick start section in README

The healarr README documents Auth and Features but has no install / run instructions for first-time
users. Add a `## Quick start` section that walks through `go install` + `healarr serve` and a sample
`curl` call against the local server.

## Why now

First-impression friction. Multiple users have tried to clone the repo and bounce off because there's
nowhere obvious to start.
