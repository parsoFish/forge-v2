/**
 * Vehicle flow distribution across intersection lanes.
 *
 * `distributeFlow(total, lanes)` splits a flow value across N lanes, biased
 * towards the first lane (the canonical "main" lane in the game's geometry).
 * Used by the BPR latency function to compute per-lane congestion.
 */

export function distributeFlow(total: number, lanes: number): number[] {
  if (lanes < 1) throw new Error('lanes must be >= 1');
  if (total < 0) throw new Error('total flow must be >= 0');
  if (lanes === 1) return [total];

  // Bias towards the main lane: 50% to lane 0, remainder split evenly.
  const main = total * 0.5;
  const rest = total - main;
  const perOther = rest / (lanes - 1);
  const out = new Array<number>(lanes);
  out[0] = main;
  for (let i = 1; i < lanes; i += 1) out[i] = perOther;
  return out;
}
