#!/usr/bin/env node
/**
 * Benchmark — Developer Loop. Real runner.
 *
 * Reads cases.json, invokes the Ralph loop via the SDK once per fixture (each
 * in its own tempdir), scores the result, writes results/<iso>.json. Bounded
 * concurrency + session cost cap mirror the project-manager bench.
 *
 * Each fixture supplies a seed worktree (`fixtures/<id>/`) containing a WI
 * spec at `.forge/work-items/WI-1.md`, a failing acceptance test, and any
 * pre-existing tests that must keep passing. The bench injects per-fixture
 * `quality_gate_cmd` (pytest / bats / node:test / grep) into the runner.
 */

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { writeResults } from '../_lib/results.ts';
import { p95 } from '../_lib/percentile.ts';
import { mapConcurrent } from '../_lib/concurrent.ts';

import {
  cleanupTempdir,
  runDevLoop,
  type RunDevResult,
} from './sdk.ts';
import {
  caseScore,
  PASS_THRESHOLD,
  type DevCriteria,
  type DevExpected,
} from './scoring.ts';
import type { DevToolUseSummary } from '../../orchestrator/dev-invocation.ts';
import { parseSource, emitChainedSliceAndExit } from '../_lib/source-switch.ts';

// --source=chained: print this phase's slice of the latest chained run
// (scored by the SAME caseScore below) and exit. Default golden path
// (isolated bench against cases.json fixtures) is unchanged. No SDK call.
if (parseSource() === 'chained') emitChainedSliceAndExit('developer_loop', 'developer-loop');

type Case = {
  id: string;
  project: string;
  seed_tree: string;                  // relative to this dir
  initiative_id: string;
  work_item_spec_rel_path: string;    // worktree-relative
  expected: DevExpected;
  /**
   * S4 — optional unifier expectations. Present when the fixture exercises
   * the dev-loop unifier sub-phase. Scoring layer is in
   * scoring.ts:unifierCaseScore (run after the per-WI rubric).
   */
  expected_unifier?: import('./scoring.ts').UnifierExpected;
};

type CaseResult = {
  id: string;
  score: number;
  passed: boolean;
  criteria: DevCriteria;
  iterations: number;
  cost_usd: number;
  files_changed: string[];
  out_of_scope_files: string[];
  status: string;
  stop_reason: string;
  tool_use: DevToolUseSummary;
  elapsed_ms: number;
  runner_error?: { kind: string; message: string };
};

const SESSION_BUDGET_USD = 4;
const CONCURRENCY = 2;

const here = import.meta.dirname;
const casesPath = join(here, 'cases.json');
const cases: Case[] = JSON.parse(readFileSync(casesPath, 'utf8'));
const ranAt = new Date().toISOString();

let totalCostUsd = 0;
let aborted = false;

function emptyCriteria(): DevCriteria {
  return {
    terminated_cleanly: 0,
    loop_completed: 0,
    iteration_budget_respected: 0,
    files_in_scope_respected: 0,
    no_regression: 0,
  };
}

const results = await mapConcurrent(cases, CONCURRENCY, async (c): Promise<CaseResult> => {
  if (aborted || totalCostUsd >= SESSION_BUDGET_USD) {
    aborted = true;
    return {
      id: c.id,
      score: 0,
      passed: false,
      criteria: emptyCriteria(),
      iterations: 0,
      cost_usd: 0,
      files_changed: [],
      out_of_scope_files: [],
      status: 'aborted',
      stop_reason: 'aborted',
      tool_use: { reads: 0, brainReads: 0, writes: 0, bashCalls: 0, testRuns: 0 },
      elapsed_ms: 0,
      runner_error: { kind: 'session_budget_exhausted', message: `>= ${SESSION_BUDGET_USD} USD` },
    };
  }

  const seedTreePath = resolve(here, c.seed_tree);

  let runOut: RunDevResult | undefined;
  let outerError: { kind: string; message: string } | undefined;
  try {
    runOut = await runDevLoop({
      fixtureId: c.id,
      initiativeId: c.initiative_id,
      seedTreePath,
      projectName: c.project,
      workItemSpecRelPath: c.work_item_spec_rel_path,
      expected: c.expected,
    });
  } catch (err) {
    outerError = { kind: 'unhandled_throw', message: err instanceof Error ? err.message : String(err) };
  }

  if (!runOut) {
    return {
      id: c.id,
      score: 0,
      passed: false,
      criteria: emptyCriteria(),
      iterations: 0,
      cost_usd: 0,
      files_changed: [],
      out_of_scope_files: [],
      status: 'crashed',
      stop_reason: 'crashed',
      tool_use: { reads: 0, brainReads: 0, writes: 0, bashCalls: 0, testRuns: 0 },
      elapsed_ms: 0,
      runner_error: outerError,
    };
  }

  totalCostUsd += runOut.costUsd;

  if (runOut.runnerError || !runOut.workItem) {
    cleanupTempdir(runOut.tempdir);
    return {
      id: c.id,
      score: 0,
      passed: false,
      criteria: emptyCriteria(),
      iterations: 0,
      cost_usd: runOut.costUsd,
      files_changed: [],
      out_of_scope_files: [],
      status: 'crashed',
      stop_reason: 'crashed',
      tool_use: runOut.toolUseSummary,
      elapsed_ms: runOut.durationMs,
      runner_error: runOut.runnerError ?? { kind: 'unknown_error', message: 'no work item' },
    };
  }

  const score = caseScore({
    result: runOut.result,
    workItem: runOut.workItem,
    expected: c.expected,
    regressionPassed: runOut.regressionPassed,
  });

  cleanupTempdir(runOut.tempdir);

  return {
    id: c.id,
    score: score.score,
    passed: score.passed,
    criteria: score.criteria,
    iterations: score.iterations,
    cost_usd: score.cost_usd,
    files_changed: score.files_changed,
    out_of_scope_files: score.out_of_scope_files,
    status: score.status,
    stop_reason: score.stop_reason,
    tool_use: runOut.toolUseSummary,
    elapsed_ms: runOut.durationMs,
  };
});

const passedCount = results.filter((r) => r.passed).length;
const totalCost = results.reduce((acc, r) => acc + r.cost_usd, 0);

const criteriaPassRates: Record<keyof DevCriteria, number> = {
  terminated_cleanly: 0,
  loop_completed: 0,
  iteration_budget_respected: 0,
  files_in_scope_respected: 0,
  no_regression: 0,
};
for (const r of results) {
  for (const key of Object.keys(criteriaPassRates) as Array<keyof DevCriteria>) {
    criteriaPassRates[key] += r.criteria[key];
  }
}
for (const key of Object.keys(criteriaPassRates) as Array<keyof DevCriteria>) {
  criteriaPassRates[key] = results.length === 0 ? 0 : criteriaPassRates[key] / results.length;
}

const summary = {
  phase: 'developer-loop',
  ran_at: ranAt,
  cases: results,
  summary: {
    total: results.length,
    passed: passedCount,
    failed: results.length - passedCount,
    accuracy: results.length === 0 ? 0 : passedCount / results.length,
    pass_threshold: PASS_THRESHOLD,
    total_cost_usd: round3(totalCost),
    session_budget_usd: SESSION_BUDGET_USD,
    aborted_for_budget: aborted,
    p95_iterations: p95(results.map((r) => r.iterations)),
    p95_elapsed_ms: p95(results.map((r) => r.elapsed_ms)),
    criteria_pass_rates: criteriaPassRates,
  },
};

const writtenTo = writeResults(here, summary);

console.log(JSON.stringify(summary, null, 2));
console.log('');
console.log(`developer-loop bench: ${passedCount}/${results.length} passed @ pass-threshold ${PASS_THRESHOLD}`);
console.log(`session cost: $${round3(totalCost)} / $${SESSION_BUDGET_USD}`);
console.log(`results: ${writtenTo}`);

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
