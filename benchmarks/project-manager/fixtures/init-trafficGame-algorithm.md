---
initiative_id: INIT-2026-05-08-tg-flow-rebalance
project: trafficGame
project_repo_path: projects/trafficGame
created_at: 2026-05-08T10:00:00Z
iteration_budget: 30
cost_budget_usd: 12
phase: in-flight
features:
  - feature_id: FEAT-1
    title: Refactor flow predictor data shape to expose per-edge load
    depends_on: []
  - feature_id: FEAT-2
    title: Implement Steiner-tree-based rebalancer
    depends_on:
      - FEAT-1
  - feature_id: FEAT-3
    title: Wire rebalancer into the per-tick game loop with a feature flag
    depends_on:
      - FEAT-2
---

# Per-edge flow rebalancing for congested intersections

## Why

The current flow predictor (`src/flow.ts`) returns predicted flow per *intersection*, but the bottleneck under heavy load is per-*edge* (which lane out of which intersection). Players see traffic jams pile up on the inbound side while the outbound side is empty, even when the intersection-level prediction says load is balanced.

This initiative reshapes the predictor to expose per-edge load, then introduces a Steiner-tree-based rebalancer that picks edges to throttle/boost on each tick to keep edge load within a target window. **Per the brain's `algorithm-heavy-items` theme for trafficGame, this is exactly the kind of feature where decomposing into a single work item produces v1's 26.9-minute develop-time worst case.** The PM should split data-shape change from algorithm from integration.

## Scope

- `src/flow.ts` — predictor return shape changes from intersection-scoped to edge-scoped.
- `src/rebalancer.ts` (new) — Steiner-tree-based throttle/boost picker. Reference impl: networkx steiner_tree.
- `src/loop.ts` — wire rebalancer into the tick loop behind a `enable_rebalance` flag (default off).
- `tests/flow.test.ts`, `tests/rebalancer.test.ts` — unit tests including a regression case for the existing per-intersection consumers.

## Out of scope

- Visualisation changes (the new edge-load data is stored but not rendered yet — separate initiative).
- Any AI/ML predictor changes.
- Save-game format migration (the data shape is in-memory only on this branch).

## Acceptance

- Per-edge load is observable via the predictor's typed return.
- Rebalancer keeps edge load within ±20% of target on the canonical 8-intersection test map.
- Existing per-intersection consumers continue to work (backward-compat shim acceptable for one release).
- Rebalancer is off by default; enabling it via flag does not break any existing test.
