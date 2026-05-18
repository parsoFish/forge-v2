---
title: trafficGame — traffic physics, IDM model, and BPR flow prediction
description: How cars accelerate, brake, and follow each other in trafficGame; the IDM-derived constants; the BPR-based flow prediction; and what's known to work and not work today. Includes the leverage points for any "smarter braking + intersection back-pressure" initiative.
category: pattern
keywords: [trafficgame, idm, car-following, braking, bpr, flow-prediction, intersection, back-pressure, calibration, max_speed, time_headway]
created_at: 2026-05-10T15:30:00Z
updated_at: 2026-05-10T15:30:00Z
related_themes: []
---

# trafficGame — traffic physics, IDM model, and BPR flow prediction

## The car-following model (CarFollowing.ts)

Vehicles use an **IDM-inspired follow model** with stuck-aware gap reduction. Acceleration is computed per-tick from the gap to the vehicle ahead, the desired speed, and a time-headway target.

Constants (sourced from `VEHICLE_PHYSICS`, fixed — not time-scaled; simulation speed is controlled by ticks-per-frame, not delta scaling):

| Constant | Value | Notes |
|---|---|---|
| `MAX_SPEED` | 450 px/s | Cruise target. `DESIRED_SPEED = MAX_SPEED × 1.015` (calibration so equilibrium ≈ MAX_SPEED). |
| `MAX_ACCELERATION` | 300 px/s² | |
| `MAX_DECELERATION` | 600 px/s² | Hard cap; emergency braking when `gap < MIN_GAP`. |
| `MIN_GAP` | 40 px | Spatial floor. Cars closer than this hit `-MAX_DECELERATION`. |
| `TIME_HEADWAY` | 0.6 s | Following distance as time. Drives `desiredGap = MIN_GAP + speed × TIME_HEADWAY`. |
| `STUCK_THRESHOLD` | 2 px/s | Below this, `vehicle.stuckTime` ramps. |
| Stuck multiplier | 1.0 → 0.3 over 0.5–5 s | Lets jammed cars crawl through; gradual not binary. |

`updateVehicleSpeed(vehicle, vehicleAhead, deltaTime)` in [`src/traffic/CarFollowing.ts`](../../../../projects/trafficGame/src/traffic/CarFollowing.ts):53–119 is the only branch in the codebase that decides per-tick acceleration. Two branches:

- `vehicleAhead === null` — free-flow IDM term: `MAX_ACCELERATION × (1 - (v/v_desired)^4)`.
- `vehicleAhead !== null` — gap-aware IDM: emergency stop if too close, else IDM with `desiredGap` and `gapRatio` term.

## What the brain knows about braking and intersections

- **Cars don't see far enough at intersections in v1** — fixed by raising `lookAhead` 100→200 px and checking 2 roads ahead instead of 1 in `IntersectionPolicy.ts`. See LEARNINGS.md §"Roundabout gridlock from insufficient headway/awareness". This is the closest precedent for any "intersection back-pressure" work.
- **No cross-intersection awareness exists today.** The `vehicleAhead === null` branch falls back to free-flow IDM regardless of what's happening at the next intersection. A "traffic spill" / back-pressure initiative would slot in *before* this branch returns null.
- **Internal roundabout connection points were FIFO-deadlocking** — closed by adding `isInternalPresetIntersection()` skip in `IntersectionPolicy.ts`. Roundabout one-way roads merge by design and should never block on FIFO.
- **Ramp elevation transitions used to drop visibility** — fixed by `couldRoutesCollide()` returning true for vehicles on the same `currentRoadId` regardless of elevation.

## BPR-based prediction and the UnifiedScore model

- Predictive heatmap and pre-sim throughput both use the BPR (Bureau of Public Roads) volume-delay function: `congestion = α × (volume/capacity)^β` with `α=0.15, β=4`.
- Demand comes from `analyzeNetworkDemand()` — the single A* loop now shared across PredictiveHeatmap, FlowCapacityNetwork, and TrafficMap.
- Capacity comes from one formula in `FlowCapacitySegment.ts`: `1 / (TIME_HEADWAY + (MIN_GAP + VEHICLE_LENGTH) / MAX_SPEED) ≈ 1.29 v/s`.
- `UnifiedScore.flowEfficiency = freeFlowTravelTime / avgTravelTime × completionRate × connectivityFactor`. Prediction and simulation use the *same* formula — within 0.7% on `crossroads`.
- Letter grades: S≥80%, A≥65%, B≥50%, C≥35%, D≥20%, F.
- Calibration limit: BPR is excellent at high V/C (1% error at V/C≈2.32) and optimistic at low V/C (32% error at V/C≈0.39). The gap is unmodeled `MAX_SPEED / (2 × MAX_ACCELERATION) = 0.75s` of acceleration overhead. Documented but not corrected — current model is accurate where it matters.

## Calibration facts

- `timeScale=5` is the documented sweet spot (2.44% divergence vs reference, ~60s wall-clock for 150 vehicles).
- Default flow rate is **0.5 v/s per traffic location**; theoretical max is ~1.29 v/s.
- Scoring runs spawn 150 vehicles and wait for completion or timeout.

## Leverage points for the "smarter braking + intersection back-pressure" initiative

1. **`updateVehicleSpeed` (`CarFollowing.ts:53`)** is the single hot loop. New "approach intersection slowly" logic must integrate here, not as a parallel system.
2. **`IntersectionPolicy.ts`** already has 2-road look-ahead and `isCongested()` (35% MAX_SPEED). A back-pressure signal pushed *back down* approaching roads is a natural extension of `isCongested()` — propagate "downstream is congested" upstream so the IDM `vehicleAhead === null` branch can synthesise a virtual brake.
3. **`RoadSegmentMetrics`** owns JAM threshold (20%) and `isCongested()` (35%). Spill thresholds live here.
4. **`UnifiedScore` integration** — any change to braking/spill must keep prediction and simulation in agreement, or BPR calibration drifts.
5. **Visual regression on `four-way-hub` and `crossroads`** is the canonical proof — these maps catch braking/jam regressions immediately.

## Sources

- [`src/traffic/CarFollowing.ts`](../../../../projects/trafficGame/src/traffic/CarFollowing.ts) — model + constants (lines 16–119).
- Project [`docs/LEARNINGS.md`](../../../../projects/trafficGame/docs/LEARNINGS.md) §"Known Failure Modes", §"Physics & Calibration Facts", §"Architecture Decisions".
- Project [`CLAUDE.md`](../../../../projects/trafficGame/CLAUDE.md) §"Physics (fixed values)" — locked constants table.

## Related

- [`mvp-architecture-snapshot`](2026-05-10-mvp-architecture-snapshot.md) — where these modules live.
- [`canvas-bpr-flow-tests`](canvas-bpr-flow-tests.md) — visual regressions catch flow changes.
- [`algorithm-heavy-items`](algorithm-heavy-items.md) — back-pressure spans many files; decompose carefully.
