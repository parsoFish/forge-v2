---
initiative_id: INIT-2026-05-09-trafficgame-distribute-flow
project: trafficGame
project_repo_path: /tmp/trafficGame
created_at: 2026-05-09T10:00:00Z
iteration_budget: 50
cost_budget_usd: 25
phase: in-flight
features:
  - feature_id: FEAT-1
    title: Per-lane flow distribution
    depends_on: []
---

# Initiative: Per-lane flow distribution

The BPR latency function needs per-lane flow values, but the simulator currently
passes a single aggregate total to the intersection. Add `distributeFlow(total, lanes)`
that splits the total across N lanes biased towards the main lane.

## Why now

Lane-level flow is the input the canvas-rendering visual tests need to draw congestion
gradients. Without per-lane values the canvas paints uniform colour across the intersection,
defeating the purpose of the BPR colouring pass.
