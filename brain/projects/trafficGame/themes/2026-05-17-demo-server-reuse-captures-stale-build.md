---
title: trafficGame — demo Playwright config reuseExistingServer:true captures stale main-repo build
description: The Playwright demo config used reuseExistingServer:true and latched onto a pre-existing vite dev server from the main repo rather than the worktree build. Every screenshot in the demo bundle showed the pre-change hub (3-node linear chain), making the demo actively misleading. Per-worktree server isolation is required.
category: antipattern
keywords: [trafficgame, demo, playwright, reuseExistingServer, vite, worktree, stale-build, demo-isolation]
created_at: 2026-05-17T14:30:00Z
updated_at: 2026-05-17T14:30:00Z
related_themes: []
---

# trafficGame — demo Playwright config `reuseExistingServer:true` captures stale main-repo build

## What happened

In cycle `2026-05-17T13-36-43_INIT-2026-05-17-world-graph-connectivity` the reviewer wrote a Playwright demo spec and config with `webServer.reuseExistingServer: true`. At review time a vite dev server from the main repo was already running on the default port. The Playwright runner attached to that server instead of starting a new one. That server served the **pre-change** source tree, so all five demo screenshots showed the old 3-node linear hub, not the new 6-node connected world.

The demo bundle embedded in the PR description was actively misleading. The operator had to run the build locally to verify correctness.

## Correct pattern

The demo server must be isolated per worktree. Options (in preference order):

1. **Serve the built `dist/`** via a static file server at a determined port: no vite process required, no conflict with a running dev server.
2. **Assign a per-worktree port** (e.g. hash-of-branch-name) and set `reuseExistingServer: false`.
3. **Kill and restart** the vite server from the worktree directory before running the Playwright spec.

`reuseExistingServer: true` is safe only when the reviewer can guarantee no other server is running on the same port — which is not the case in a forge worktree environment where the operator may have a dev server running from the main project.

## Sources

- `_logs/2026-05-17T13-36-43_INIT-2026-05-17-world-graph-connectivity/events.jsonl` — reviewer iteration 1 event, tools_used showing Playwright demo execution and the resulting misleading screenshots.
- `_logs/2026-05-17T13-36-43_INIT-2026-05-17-world-graph-connectivity/user-feedback.md` — §"Secondary findings #2".
- `/home/parso/forge/brain/_raw/cycles/2026-05-17T13-36-43_INIT-2026-05-17-world-graph-connectivity.md` — cycle archive §"Finding 3".
