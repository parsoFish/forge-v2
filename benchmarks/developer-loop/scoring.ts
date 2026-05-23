/**
 * Pure scoring functions for the developer-loop benchmark. Kept separate from
 * score.ts (the runner) so they are trivially unit-testable without mocking
 * the SDK or shelling out to test runners.
 *
 * S4 changes (CONTRACTS.md C19): `cost_budget_respected` REMOVED.
 * Its 0.15 weight is redistributed across the remaining four criteria:
 *
 *   gate: terminated_cleanly
 *       If run() threw, no quality dimension matters — the loop crashed.
 *
 *   loop_completed (0.40)        — was 0.35
 *       result.status === 'complete'. The loop's whole purpose is to drive
 *       a work item green. Anything else is efficiency around that.
 *
 *   iteration_budget_respected (0.25) — was 0.20
 *       result.iterations <= expected.max_iterations.
 *
 *   files_in_scope_respected (0.20) — unchanged
 *       Every modified path ∈ workItem.files_in_scope ∪ files_in_scope_extra.
 *
 *   no_regression (0.15) — was 0.10
 *       Pre-existing tests still pass at the end.
 *
 * Per C19 there is no $-budget criterion. `DevExpected.max_cost_usd` is
 * retained as a JSON-schema field so existing cases.json files don't break
 * to parse, but the scorer ignores it.
 *
 * Plus: S4 adds an optional `expected_unifier` criteria layer. When a fixture
 * declares `expected_unifier`, the runner additionally evaluates the
 * unifier-specific criteria (`unifier_terminated_cleanly` gate,
 * `initiative_gate_passed`, `demo_present`, `demo_runs_clean`,
 * `pr_self_contained`, `branches_in_sync`). See `unifierCaseScore` below.
 *
 * PASS_THRESHOLD = 0.7 (unchanged).
 */

import type { LoopResult } from '../../loops/ralph/runner.ts';
import type { WorkItem } from '../../orchestrator/work-item.ts';
import type { DemoShape } from '../../orchestrator/project-config.ts';

export type DevExpected = {
  max_iterations: number;
  /** Retained for cases.json back-compat; the scorer no longer uses it (C19). */
  max_cost_usd?: number;
  must_complete: boolean;
  /** Argv-style command run by the bench to verify acceptance criteria. */
  quality_gate_cmd: string[];
  /** Optional argv-style command for the regression check. If undefined, regression criterion = 1. */
  pre_existing_tests_cmd?: string[];
  /** Test files that are allowed beyond `WorkItem.files_in_scope`. */
  files_in_scope_extra?: string[];
};

export type DevCriteria = {
  terminated_cleanly: 0 | 1;
  loop_completed: 0 | 1;
  iteration_budget_respected: 0 | 1;
  files_in_scope_respected: 0 | 1;
  no_regression: 0 | 1;
};

export type DevScore = {
  score: number;
  passed: boolean;
  criteria: DevCriteria;
  iterations: number;
  cost_usd: number;
  files_changed: string[];
  out_of_scope_files: string[];
  status: LoopResult['status'] | 'crashed';
  stop_reason: LoopResult['stop_reason'] | 'crashed';
};

export const PASS_THRESHOLD = 0.7;

// Weights — must sum to 1 (S4: redistributed after removing cost_budget per C19).
export const WEIGHT_COMPLETED = 0.40;
export const WEIGHT_ITERATIONS = 0.25;
export const WEIGHT_FILES_IN_SCOPE = 0.20;
export const WEIGHT_NO_REGRESSION = 0.15;

export function loopCompleted(result: LoopResult | null): number {
  return result !== null && result.status === 'complete' ? 1 : 0;
}

export function iterationBudgetRespected(result: LoopResult | null, expected: DevExpected): number {
  if (result === null) return 0;
  return result.iterations <= expected.max_iterations ? 1 : 0;
}

/**
 * Ralph loop bookkeeping artifacts — never count as scope creep.
 *
 * The Ralph runner stamps these into the worktree before the agent runs and
 * the agent is expected to update them across iterations.
 *
 * S4 addition: tracked `demo/<initiative-id>/` paths are also exempted —
 * the unifier writes there as part of its mandate.
 */
const RALPH_WORKSPACE_ARTIFACTS: ReadonlySet<string> = new Set([
  'PROMPT.md',
  'AGENT.md',
  'fix_plan.md',
]);

function isRalphArtifact(path: string): boolean {
  if (RALPH_WORKSPACE_ARTIFACTS.has(path)) return true;
  if (path.startsWith('.forge/work-items/')) return true;
  if (path.startsWith('demo/')) return true; // S4: unifier-owned tracked path
  return false;
}

export function filesInScopeRespected(
  result: LoopResult | null,
  workItem: WorkItem,
  expected: DevExpected,
): { value: 0 | 1; outOfScope: string[] } {
  if (result === null) return { value: 0, outOfScope: [] };
  const allowed = new Set<string>([
    ...workItem.files_in_scope,
    ...(expected.files_in_scope_extra ?? []),
  ]);
  const outOfScope = result.filesChanged
    .map(normalisePath)
    .filter((f) => !allowed.has(f) && !isRalphArtifact(f));
  return { value: outOfScope.length === 0 ? 1 : 0, outOfScope };
}

function normalisePath(p: string): string {
  return p.replace(/^\.\//, '');
}

export type CaseScoreInput = {
  result: LoopResult | null;
  /** When result is null, the run threw. errorMessage carries the crash detail. */
  errorMessage?: string;
  workItem: WorkItem;
  expected: DevExpected;
  /** Did the regression command pass at the end of the run? Defaults to true if no command was supplied. */
  regressionPassed: boolean;
};

export function caseScore(input: CaseScoreInput): DevScore {
  const { result, workItem, expected, regressionPassed } = input;

  if (result === null) {
    return {
      score: 0,
      passed: false,
      criteria: emptyCriteria(),
      iterations: 0,
      cost_usd: 0,
      files_changed: [],
      out_of_scope_files: [],
      status: 'crashed',
      stop_reason: 'crashed',
    };
  }

  const completed = loopCompleted(result) as 0 | 1;
  const iterationsOk = iterationBudgetRespected(result, expected) as 0 | 1;
  const scope = filesInScopeRespected(result, workItem, expected);
  const noRegression = (regressionPassed ? 1 : 0) as 0 | 1;

  const criteria: DevCriteria = {
    terminated_cleanly: 1,
    loop_completed: completed,
    iteration_budget_respected: iterationsOk,
    files_in_scope_respected: scope.value,
    no_regression: noRegression,
  };

  const score =
    WEIGHT_COMPLETED * criteria.loop_completed +
    WEIGHT_ITERATIONS * criteria.iteration_budget_respected +
    WEIGHT_FILES_IN_SCOPE * criteria.files_in_scope_respected +
    WEIGHT_NO_REGRESSION * criteria.no_regression;

  return {
    score,
    passed: score >= PASS_THRESHOLD,
    criteria,
    iterations: result.iterations,
    cost_usd: result.cost_usd,
    files_changed: result.filesChanged,
    out_of_scope_files: scope.outOfScope,
    status: result.status,
    stop_reason: result.stop_reason,
  };
}

function emptyCriteria(): DevCriteria {
  return {
    terminated_cleanly: 0,
    loop_completed: 0,
    iteration_budget_respected: 0,
    files_in_scope_respected: 0,
    no_regression: 0,
  };
}

// ---------------------------------------------------------------------------
// S4 — unifier scoring layer (runs when a fixture declares `expected_unifier`)
// ---------------------------------------------------------------------------

/**
 * Expected unifier outcomes per fixture. Pass shape into `unifierCaseScore`
 * alongside the actual observations (gathered by the bench runner) to score.
 *
 * Per CONTRACTS.md C19 there is NO `max_cost_usd` — iteration cap is the only
 * bound. Per CONTRACTS.md C2 the field name is `demo_shape`, not `kind`.
 */
export type UnifierExpected = {
  max_iterations: number;
  demo_shape: DemoShape;
  /** Argv-style command the bench runs to verify demo_runs_clean. */
  demo_command: string[];
  /** Glob the bench checks for demo artefact presence (e.g. `demo/<id>/*.{png,webm,md}`). */
  demo_artifact_glob: string;
};

export type UnifierObservations = {
  /** Did `runUnifier` return without throwing? */
  terminated_cleanly: boolean;
  /** Did the project quality-gate command pass against branch tip? */
  initiative_gate_passed: boolean;
  /** Does a DEMO.md (and ≥1 artefact when shape != "none") exist under demo/<id>/? */
  demo_present: boolean;
  /** Did the project's demo.command exit 0 (skip for shape "none")? */
  demo_runs_clean: boolean;
  /** PR body draft ≥ 300 chars with `## Demo` block AND demo dir tracked. */
  pr_self_contained: boolean;
  /** assertLocalRemoteSynced OK at unifier close. */
  branches_in_sync: boolean;
  iterations: number;
};

export type UnifierCriteria = {
  unifier_terminated_cleanly: 0 | 1;
  initiative_gate_passed: 0 | 1;
  demo_present: 0 | 1;
  demo_runs_clean: 0 | 1;
  pr_self_contained: 0 | 1;
  branches_in_sync: 0 | 1;
};

export type UnifierScore = {
  score: number;
  passed: boolean;
  criteria: UnifierCriteria;
  iterations: number;
};

// Weights — must sum to 1. Per CONTRACTS.md C19, NO cost_within_unifier_budget.
export const UNIFIER_WEIGHT_INITIATIVE_GATE = 0.30;
export const UNIFIER_WEIGHT_DEMO_PRESENT = 0.25;
export const UNIFIER_WEIGHT_DEMO_RUNS_CLEAN = 0.20;
export const UNIFIER_WEIGHT_PR_SELF_CONTAINED = 0.15;
export const UNIFIER_WEIGHT_BRANCHES_IN_SYNC = 0.10;

export function unifierCaseScore(
  observations: UnifierObservations,
  expected: UnifierExpected,
): UnifierScore {
  // Gate: unifier_terminated_cleanly. If the runner threw, no quality
  // dimension applies.
  if (!observations.terminated_cleanly) {
    return {
      score: 0,
      passed: false,
      criteria: {
        unifier_terminated_cleanly: 0,
        initiative_gate_passed: 0,
        demo_present: 0,
        demo_runs_clean: 0,
        pr_self_contained: 0,
        branches_in_sync: 0,
      },
      iterations: observations.iterations,
    };
  }

  // For shape "none" the demo_runs_clean criterion is excused (forced to 1).
  const demoRunsClean: 0 | 1 =
    expected.demo_shape === 'none' ? 1 : observations.demo_runs_clean ? 1 : 0;

  const criteria: UnifierCriteria = {
    unifier_terminated_cleanly: 1,
    initiative_gate_passed: observations.initiative_gate_passed ? 1 : 0,
    demo_present: observations.demo_present ? 1 : 0,
    demo_runs_clean: demoRunsClean,
    pr_self_contained: observations.pr_self_contained ? 1 : 0,
    branches_in_sync: observations.branches_in_sync ? 1 : 0,
  };

  const score =
    UNIFIER_WEIGHT_INITIATIVE_GATE * criteria.initiative_gate_passed +
    UNIFIER_WEIGHT_DEMO_PRESENT * criteria.demo_present +
    UNIFIER_WEIGHT_DEMO_RUNS_CLEAN * criteria.demo_runs_clean +
    UNIFIER_WEIGHT_PR_SELF_CONTAINED * criteria.pr_self_contained +
    UNIFIER_WEIGHT_BRANCHES_IN_SYNC * criteria.branches_in_sync;

  return {
    score,
    passed: score >= PASS_THRESHOLD,
    criteria,
    iterations: observations.iterations,
  };
}
