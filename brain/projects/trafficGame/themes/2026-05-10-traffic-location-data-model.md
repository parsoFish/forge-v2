---
title: trafficGame — TrafficLocation has paired entry/exit ConnectionPoints with edge orientation
description: TrafficPoint.ts defines TrafficLocation as a single map-edge anchor with separate entryPoint and exitPoint ConnectionPoints offset by edge direction (top/bottom/left/right). This is the natural seam for any "link maps at entry/exit" non-linear campaign work.
category: snapshot
keywords: [trafficgame, traffic-location, connection-point, entry, exit, edge, top, bottom, left, right, map-linking, data-model]
created_at: 2026-05-10T15:30:00Z
updated_at: 2026-05-10T15:30:00Z
related_themes: []
---

# trafficGame — TrafficLocation data model

## What a TrafficLocation is

[`src/traffic/TrafficPoint.ts`](../../../../projects/trafficGame/src/traffic/TrafficPoint.ts):9–95.

```typescript
export interface TrafficLocation {
  id: string;
  position: Vector2;       // Anchor point on a map edge
  edge: Edge;              // 'top' | 'bottom' | 'left' | 'right'
  entryPoint: ConnectionPoint;  // Vehicles spawn here and enter the network
  exitPoint: ConnectionPoint;   // Vehicles leave the network and despawn here
  flowRate?: number;            // Defaults to 0.5 v/s per FlowConfig
}
```

`createTrafficLocation(id, position, edge)`:

- Picks `entryOffset` / `exitOffset` based on `edge`:
  - `left`:  entry at `(-offset, 0)`, exit at `(+offset, 0)`
  - `right`: entry at `(+offset, 0)`, exit at `(-offset, 0)`
  - `top`:   entry at `(0, -offset)`, exit at `(0, +offset)`
  - `bottom`:entry at `(0, +offset)`, exit at `(0, -offset)`
- Synthesises two `ConnectionPoint`s with stable IDs `${id}-entry` and `${id}-exit`, typed `'entry'` / `'exit'`.
- `isTrafficPoint(p)`, `isEntryPoint(p)`, `isExitPoint(p)` are the guard helpers.

## Why this matters for non-linear campaign work

The data model **already separates entry from exit and tags them with edge orientation**. That's the seam any "map-of-maps" work plugs into — pairing the `right` exits on map A with the `left` entries on map B is a graph edge between two existing data structures, not a new concept.

What's *missing* for inter-map linking:

- A graph data structure expressing `(mapId_A, locationId_A, exit) ↔ (mapId_B, locationId_B, entry)`.
- A way to make map B's entry **flow rate** a function of map A's measured exit throughput in the player's current solution (today flow is fixed `0.5 v/s` per `FlowConfig`).
- A way for the simulator (or a higher-level `WorldSimulator`) to step both maps and propagate flow.
- UI affordance to render the cross-map edge — non-trivial because the maps are separate canvases today (each level instantiates its own `Game`).

## What's load-bearing — don't break it

- **`type: 'entry' | 'exit'` on ConnectionPoint** is used by the spawn loop and the despawn loop. New entry/exit point types (e.g. `'world-entry'`) need to be additive and visible to those loops.
- **The entry/exit offset pattern keeps spawn-clearance logic simple.** `VehicleSpawner.isEntryPointClear()` checks at the entry offset; arbitrary-position entries break that assumption.
- **Stable `${id}-entry` / `${id}-exit` IDs** are referenced in routing and metrics. Don't rename.

## Sources

- [`src/traffic/TrafficPoint.ts`](../../../../projects/trafficGame/src/traffic/TrafficPoint.ts):1–95 (interface, factory, guards).
- [`src/traffic/FlowConfig.ts`](../../../../projects/trafficGame/src/traffic/FlowConfig.ts) — where the default 0.5 v/s lives.
- Project [`docs/MVP_ARCHITECTURE.md`](../../../../projects/trafficGame/docs/MVP_ARCHITECTURE.md) §"Connection Points as Source of Truth".

## Related

- [`campaign-mode-state`](2026-05-10-campaign-mode-state.md) — the linear campaign that lives on top of this data model.
- [`traffic-physics-and-flow`](2026-05-10-traffic-physics-and-flow.md) — flow rate is per-location and the natural cross-map signal.
- [`mvp-architecture-snapshot`](2026-05-10-mvp-architecture-snapshot.md) — how `traffic/` fits into the broader src/.
