import { predictLoads } from './flow.ts';
import type { Intersection } from './intersections.ts';

export function tick(state: { intersections: Intersection[]; tick: number }): void {
  const _loads = predictLoads(state.intersections, state.tick);
  state.tick += 1;
}
