#!/usr/bin/env node
/**
 * Benchmark — End-to-End. Real runner.
 *
 * Reads cases.json, invokes runCycle for each fixture (each in its own
 * tempdir), runs target-spec checks against the merged worktree, scores
 * against scoring.ts's rubric, writes results/<iso>.json.
 *
 * Each fixture supplies a seed worktree, an initiative manifest, and a
 * target spec. The bench:
 *   1. Sets up an isolated tempdir with a real git repo (main + initiative
 *      branch).
 *   2. Invokes runCycle with a simulator-driven verdict-provider.
 *   3. Re-runs the target-spec checks against the merged worktree.
 *   4. Calls caseScore to produce the rubric.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

import { writeResults } from '../_lib/results.ts';
import { p95 } from '../_lib/percentile.ts';
import { mapConcurrent } from '../_lib/concurrent.ts';

import {
  cleanupTempdir,
  readGhMetadata,
  runE2e,
  type RunE2eResult,
} from './sdk.ts';
import {
  caseScore,
  PASS_THRESHOLD,
  type E2eCriteria,
  type E2eExpected,
} from './scoring.ts';
import type { TargetSpec } from './simulator.ts';

type Case = {
  id: string;
  project: string;
  /** Relative to this dir. Points at fixtures/<id>/branch-state/. */
  seed_tree: string;
  /** Relative to this dir. Points at fixtures/<id>/manifest.md. */
  manifest_path: string;
  initiative_id: string;
  /** Target spec (manifest AC command + non-functional checks + required PR signals). */
  spec: TargetSpec;
  expected: E2eExpected;
};

type CaseResult = {
  id: string;
  score: number;
  passed: boolean;
  criteria: E2eCriteria;
  rounds: number;
  cost_usd: number;
  outcome: string;
  spec_failures: string[];
  merged: boolean;
  gh_metadata?: unknown;
  cycle_outcome?: string;
  tempdir?: string;
  elapsed_ms: number;
  runner_error?: { kind: string; message: string };
};

const SESSION_BUDGET_USD = 25;
const CONCURRENCY = 1;

const here = import.meta.dirname;
const casesPath = join(here, 'cases.json');
const cases: Case[] = JSON.parse(readFileSync(casesPath, 'utf8'));
const ranAt = new Date().toISOString();

let totalCostUsd = 0;
let aborted = false;

function emptyCriteria(): E2eCriteria {
  return {
    cycle_completed: 0,
    merged: 0,
    converged_within_budget: 0,
    spec_satisfied: 0,
    cost_within_budget: 0,
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
      rounds: 0,
      cost_usd: 0,
      outcome: 'aborted',
      spec_failures: [],
      merged: false,
      elapsed_ms: 0,
      runner_error: {
        kind: 'session_budget_exhausted',
        message: `>= ${SESSION_BUDGET_USD} USD`,
      },
    };
  }

  const seedTreePath = resolve(here, c.seed_tree);
  const manifestPath = resolve(here, c.manifest_path);
  const startedAt = Date.now();

  let runOut: RunE2eResult | undefined;
  let outerError: { kind: string; message: string } | undefined;
  try {
    runOut = await runE2e({
      fixtureId: c.id,
      initiativeId: c.initiative_id,
      seedTreePath,
      manifestPath,
      projectName: c.project,
      spec: c.spec,
      reviewIterationCap: c.expected.max_rounds,
    });
  } catch (err) {
    outerError = {
      kind: 'unhandled_throw',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const elapsed = Date.now() - startedAt;

  if (!runOut) {
    return {
      id: c.id,
      score: 0,
      passed: false,
      criteria: emptyCriteria(),
      rounds: 0,
      cost_usd: 0,
      outcome: 'crashed',
      spec_failures: [],
      merged: false,
      elapsed_ms: elapsed,
      runner_error: outerError,
    };
  }

  const cycleCost = runOut.cycleResult?.duration_ms ? estimateCycleCost(runOut) : 0;
  totalCostUsd += cycleCost;

  // Re-run regression command if supplied.
  let regressionPassed = true;
  if (c.expected.pre_existing_tests_cmd) {
    regressionPassed = runRegressionCmd(runOut.worktreePath, c.expected.pre_existing_tests_cmd);
  }

  // Round count = actual simulator verdicts (not gate-invocations, which
  // include bailouts when project gates were red or artifacts were missing).
  // Falls back to invocations if the verdict list wasn't surfaced.
  const verdictCount = runOut.reviewerGateState.verdicts.length;
  const rounds = verdictCount > 0 ? verdictCount : runOut.reviewerGateState.invocations;

  const score = caseScore({
    cycleResult: runOut.cycleResult,
    cycleThrew: runOut.cycleThrew !== null,
    rounds,
    costUsd: cycleCost,
    merged: runOut.merged,
    postMergeSpecResults: runOut.postMergeSpecResults,
    expected: c.expected,
    regressionPassed,
  });

  const ghMetadata = readGhMetadata(runOut.tempdir);
  if (score.passed) cleanupTempdir(runOut.tempdir);
  else console.error(`[e2e] fixture ${c.id} did not pass — tempdir kept at ${runOut.tempdir}`);

  return {
    id: c.id,
    score: score.score,
    passed: score.passed,
    criteria: score.criteria,
    rounds: score.rounds,
    cost_usd: score.cost_usd,
    outcome: score.outcome,
    spec_failures: score.spec_failures,
    merged: runOut.merged,
    gh_metadata: ghMetadata,
    cycle_outcome: runOut.cycleResult?.status,
    tempdir: score.passed ? undefined : runOut.tempdir,
    elapsed_ms: elapsed,
    runner_error: runOut.cycleThrew ?? undefined,
  };
});

const passedCount = results.filter((r) => r.passed).length;
const totalCost = results.reduce((acc, r) => acc + r.cost_usd, 0);

const criteriaPassRates: Record<keyof E2eCriteria, number> = {
  cycle_completed: 0,
  merged: 0,
  converged_within_budget: 0,
  spec_satisfied: 0,
  cost_within_budget: 0,
  no_regression: 0,
};
for (const r of results) {
  for (const key of Object.keys(criteriaPassRates) as Array<keyof E2eCriteria>) {
    criteriaPassRates[key] += r.criteria[key];
  }
}
for (const key of Object.keys(criteriaPassRates) as Array<keyof E2eCriteria>) {
  criteriaPassRates[key] = results.length === 0 ? 0 : criteriaPassRates[key] / results.length;
}

const summary = {
  phase: 'e2e',
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
    p95_rounds: p95(results.map((r) => r.rounds)),
    p95_cost_usd: round3(p95(results.map((r) => r.cost_usd))),
    p95_elapsed_ms: p95(results.map((r) => r.elapsed_ms)),
    criteria_pass_rates: criteriaPassRates,
  },
};

const writtenTo = writeResults(here, summary);

console.log(JSON.stringify(summary, null, 2));
console.log('');
console.log(`e2e bench: ${passedCount}/${results.length} passed @ pass-threshold ${PASS_THRESHOLD}`);
console.log(`session cost: $${round3(totalCost)} / $${SESSION_BUDGET_USD}`);
console.log(`results: ${writtenTo}`);

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Estimate the cycle's total cost. The cycle's CycleResult doesn't currently
 * surface a cost field, so we approximate by reading the orchestrator event
 * log (best-effort). For first pass this is just an aggregate placeholder
 * sourced from the gate state's verdict cost (which doesn't exist yet either).
 *
 * TODO: thread the cost back through CycleResult.
 */
function estimateCycleCost(runOut: RunE2eResult): number {
  // For now, look up the cost via the cycle result's log_path event log.
  if (!runOut.cycleResult) return 0;
  try {
    const logPath = runOut.cycleResult.log_path;
    if (!logPath || !runOut.cycleResult) return 0;
    const text = readFileSync(logPath, 'utf8');
    // Sum every event with a cost_usd field.
    let total = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line) as { cost_usd?: number };
        if (typeof evt.cost_usd === 'number') total += evt.cost_usd;
      } catch {
        /* skip malformed line */
      }
    }
    return total;
  } catch {
    return 0;
  }
}

function runRegressionCmd(worktreePath: string, cmd: string[]): boolean {
  if (cmd.length === 0) return true;
  const [head, ...rest] = cmd;
  if (!head) return false;
  try {
    execFileSync(head, rest, { cwd: worktreePath, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
