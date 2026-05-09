# trafficGame

Browser-based traffic simulation game. Players build intersections; the engine simulates flow.

## Layout

- `src/loop.ts` — per-tick game loop (drives flow predictor + UI).
- `src/flow.ts` — flow predictor (current: per-intersection scoped).
- `src/intersections.ts` — intersection model + edge graph.
- `tests/flow.test.ts` — flow predictor unit tests.

## Stack

TypeScript, vitest, no framework (DOM-direct rendering on canvas).

## v1 lessons

Algorithm-heavy items (Steiner topology, graph colouring) caused 48% job-failure rate in Cycle 3 when scoped as single work items. **Decompose any algorithmic feature into ≥3 WIs**: data-shape → algorithm → integration → tests.
