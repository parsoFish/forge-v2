---
work_item_id: WI-1
feature_id: FEAT-1
initiative_id: INIT-2026-05-09-trafficgame-distribute-flow
status: complete
depends_on: []
acceptance_criteria:
  - given: "a single-lane intersection and a total flow of 100"
    when:  "distributeFlow(100, 1) is called"
    then:  "the function returns [100] (the full flow on the only lane)"
  - given: "a 3-lane intersection with total flow 100"
    when:  "distributeFlow(100, 3) is called"
    then:  "the main lane gets 50, the two side lanes split 25 each"
  - given: "a negative total flow"
    when:  "distributeFlow is called with that negative total"
    then:  "the function throws an error mentioning total flow"
files_in_scope:
  - src/flow.ts
estimated_iterations: 2
---

# WI-1: Add `distributeFlow` for lane-level vehicle distribution

The BPR latency function needs per-lane flow values, but the simulator currently passes a single
aggregate total to the intersection. `distributeFlow(total, lanes)` splits the total across N lanes
biased towards the main lane (50% to lane 0, rest evenly across the others).

## Status: complete

- New `distributeFlow` in `src/flow.ts`.
- Six tests in `tests/distribute-flow.test.ts` covering the three ACs plus edge cases (zero flow, zero lanes).

## Brain themes consulted

- `canvas-bpr-flow-tests` — visual regression of canvas flow rendering (project-specific).
