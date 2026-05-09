/**
 * Stage runner — schedules per-PR work, retries, persists results, and
 * merges in dependency-order. Merge logic is being extracted into a
 * MergeStrategy interface (active initiative).
 */

import { persistResult } from './persistence.ts';

export type StageInput = {
  prNumbers: number[];
  retryLimit: number;
};

export async function runStages(input: StageInput): Promise<void> {
  for (const pr of input.prNumbers) {
    await runOne(pr, input.retryLimit);
    persistResult(pr, 'merged');
  }
}

async function runOne(_pr: number, _retries: number): Promise<void> {
  // Scheduler + retry + (currently inlined) merge.
}
