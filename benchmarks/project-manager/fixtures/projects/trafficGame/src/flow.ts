/**
 * Flow predictor — current shape returns load per intersection.
 * (Per-edge support is the active initiative.)
 */

import type { Intersection } from './intersections.ts';

export type IntersectionLoad = {
  intersectionId: string;
  predictedLoad: number;   // [0, 1]; 1 = saturated
};

export function predictLoads(intersections: Intersection[], tick: number): IntersectionLoad[] {
  return intersections.map((i) => ({
    intersectionId: i.id,
    predictedLoad: estimateLoad(i, tick),
  }));
}

function estimateLoad(_i: Intersection, _tick: number): number {
  // Stub. Real impl uses arrival-rate × capacity.
  return 0.5;
}
