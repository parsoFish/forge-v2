/**
 * Stop conditions for the Ralph loop. The loop exits when any one fires.
 *
 * Each condition is a pure function over loop state. Wedged-detector and
 * quality-gates each shell out to side effects (file diff, test runner) but
 * report a boolean.
 */

import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type StopCondition =
  | { kind: 'quality-gates-pass' }
  | { kind: 'iteration-budget'; max: number }
  | { kind: 'cost-budget'; maxUsd: number }
  | { kind: 'wedged'; noProgressIterations: number };

export type LoopState = {
  worktreePath: string;
  iteration: number;
  costUsdSoFar: number;
  fixPlanItemsHistory: number[]; // length-of-fix_plan checklist per iteration
  filesChangedHistory: string[][]; // files changed per iteration
};

export type StopResult =
  | { stop: false }
  | { stop: true; reason: string; condition: StopCondition['kind'] };

export async function checkStopConditions(
  state: LoopState,
  conditions: StopCondition[],
  qualityGates: () => boolean | Promise<boolean>,
): Promise<StopResult> {
  for (const condition of conditions) {
    const result = await checkOne(state, condition, qualityGates);
    if (result.stop) return result;
  }
  return { stop: false };
}

async function checkOne(
  state: LoopState,
  condition: StopCondition,
  qualityGates: () => boolean | Promise<boolean>,
): Promise<StopResult> {
  switch (condition.kind) {
    case 'quality-gates-pass':
      if (await qualityGates()) {
        return { stop: true, reason: 'quality gates pass', condition: 'quality-gates-pass' };
      }
      return { stop: false };

    case 'iteration-budget':
      if (state.iteration >= condition.max) {
        return {
          stop: true,
          reason: `iteration budget exhausted (${condition.max})`,
          condition: 'iteration-budget',
        };
      }
      return { stop: false };

    case 'cost-budget':
      if (state.costUsdSoFar >= condition.maxUsd) {
        return {
          stop: true,
          reason: `cost budget exhausted ($${condition.maxUsd})`,
          condition: 'cost-budget',
        };
      }
      return { stop: false };

    case 'wedged': {
      const window = state.fixPlanItemsHistory.slice(-condition.noProgressIterations);
      if (window.length < condition.noProgressIterations) return { stop: false };
      const filesWindow = state.filesChangedHistory.slice(-condition.noProgressIterations);
      const noFixPlanProgress = window.every((n) => n === window[0]);
      const noFileChange = filesWindow.every((files) => files.length === 0);
      if (noFixPlanProgress && noFileChange) {
        return {
          stop: true,
          reason: `wedged: no progress for ${condition.noProgressIterations} iterations`,
          condition: 'wedged',
        };
      }
      return { stop: false };
    }
  }
}

/** Default quality-gates implementation: shells to `npm test` in the worktree. */
export function defaultQualityGates(worktreePath: string): boolean {
  try {
    execSync('npm test --silent', { cwd: worktreePath, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a quality-gate closure from an explicit command vector. Used by
 * cycle.ts:runDeveloperLoop to thread the manifest's per-project
 * `quality_gate_cmd` (Python pytest, bash bats, Rust cargo, etc.) into the
 * Ralph runner — eliminating the F-04 hardcoded `npm test` problem.
 *
 * Returns a sync closure suitable for `LoopInput.qualityGate`. Returns true
 * iff the command exits 0 in the worktree.
 */
export function makeQualityGateFromCmd(
  worktreePath: string,
  cmd: readonly string[],
): () => boolean {
  return () => {
    if (cmd.length === 0) return false;
    try {
      const [head, ...rest] = cmd;
      if (!head) return false;
      execFileSync(head, rest, { cwd: worktreePath, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  };
}

/** Read the fix_plan checklist count (number of unchecked items). */
export function countOpenFixPlanItems(worktreePath: string): number {
  const path = join(worktreePath, 'fix_plan.md');
  if (!existsSync(path)) return 0;
  const content = readFileSync(path, 'utf8');
  const matches = content.match(/^- \[ \]/gm);
  return matches?.length ?? 0;
}
