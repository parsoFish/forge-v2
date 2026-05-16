#!/usr/bin/env node
/**
 * Benchmark — Review Loop (stage 1, review-prep). Real runner.
 *
 * Reads cases.json, invokes the reviewer skill via the SDK once per fixture
 * (each in its own tempdir), runs the orchestrator-side quality-gate command
 * after the agent finishes, scores the resulting demo bundle + PR description,
 * writes results/<iso>.json. Bounded concurrency + session cost cap mirror the
 * developer-loop bench.
 *
 * Each fixture supplies a seed worktree (`fixtures/<id>/branch-state/`) that
 * represents the post-developer-loop state — every WI at status: complete,
 * commits in place, quality gates green. The bench:
 *   1. Sets up an isolated tempdir (symlinks brain/skills/docs, copies seed,
 *      drops manifest, writes gh PATH-stub).
 *   2. Invokes the reviewer skill via the SDK with the contract from
 *      orchestrator/reviewer-invocation.ts.
 *   3. Runs `expected.quality_gate_cmd` itself (orchestrator-verified, never
 *      trusts the agent's claim).
 *   4. Scores the rubric per benchmarks/review-loop/scoring.ts.
 */

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { writeResults } from '../_lib/results.ts';
import { p95 } from '../_lib/percentile.ts';
import { mapConcurrent } from '../_lib/concurrent.ts';

import {
  cleanupTempdir,
  runReviewer,
  type RunReviewerResult,
} from './sdk.ts';
import {
  caseScore,
  PASS_THRESHOLD,
  type ReviewerCriteria,
  type ReviewerExpected,
} from './scoring.ts';
import type { ReviewerToolUseSummary } from '../../orchestrator/reviewer-invocation.ts';
import { parseSource, emitChainedSliceAndExit } from '../_lib/source-switch.ts';

// --source=chained: print this phase's slice of the latest chained run
// (scored by the SAME caseScore below) and exit. Default golden path
// (isolated bench against cases.json fixtures) is unchanged. No SDK call.
if (parseSource() === 'chained') emitChainedSliceAndExit('review_loop', 'review-loop');

type Case = {
  id: string;
  project: string;
  /** Relative to this dir. Points at fixtures/<id>/branch-state/. */
  seed_tree: string;
  /** Relative to this dir. Points at fixtures/<id>/manifest.md. */
  manifest_path: string;
  initiative_id: string;
  expected: ReviewerExpected;
  /** Per-fixture max budget USD. Default 0.6. */
  max_cost_usd?: number;
};

type CaseResult = {
  id: string;
  score: number;
  passed: boolean;
  criteria: ReviewerCriteria;
  cost_usd: number;
  pr_body_chars: number;
  why_chars: number;
  demo_recording_path: string | null;
  demo_recording_bytes: number;
  demo_source_path: string | null;
  ac_keywords_missing: string[];
  pr_description_present: boolean;
  quality_gates_passed: boolean;
  result_subtype?: string;
  tool_use: ReviewerToolUseSummary;
  elapsed_ms: number;
  runner_error?: { kind: string; message: string };
};

const SESSION_BUDGET_USD = 5;
const CONCURRENCY = 2;

const here = import.meta.dirname;
const casesPath = join(here, 'cases.json');
const cases: Case[] = JSON.parse(readFileSync(casesPath, 'utf8'));
const ranAt = new Date().toISOString();

let totalCostUsd = 0;
let aborted = false;

function emptyCriteria(): ReviewerCriteria {
  return {
    quality_gates_pass: 0,
    pr_only_when_green: 0,
    demo_recording_present: 0,
    demo_exercises_acceptance_criteria: 0,
    pr_description_why_not_what: 0,
    pr_description_length_floor: 0,
    pr_links_demo: 0,
    merge_strategy_respected: 0,
  };
}

function emptyToolUse(): ReviewerToolUseSummary {
  return { brainReads: 0, writes: 0, bashCalls: 0, recorderInvocations: 0 };
}

const results = await mapConcurrent(cases, CONCURRENCY, async (c): Promise<CaseResult> => {
  if (aborted || totalCostUsd >= SESSION_BUDGET_USD) {
    aborted = true;
    return {
      id: c.id,
      score: 0,
      passed: false,
      criteria: emptyCriteria(),
      cost_usd: 0,
      pr_body_chars: 0,
      why_chars: 0,
      demo_recording_path: null,
      demo_recording_bytes: 0,
      demo_source_path: null,
      ac_keywords_missing: [],
      pr_description_present: false,
      quality_gates_passed: false,
      tool_use: emptyToolUse(),
      elapsed_ms: 0,
      runner_error: {
        kind: 'session_budget_exhausted',
        message: `>= ${SESSION_BUDGET_USD} USD`,
      },
    };
  }

  const seedTreePath = resolve(here, c.seed_tree);
  const manifestPath = resolve(here, c.manifest_path);

  let runOut: RunReviewerResult | undefined;
  let outerError: { kind: string; message: string } | undefined;
  try {
    runOut = await runReviewer({
      fixtureId: c.id,
      initiativeId: c.initiative_id,
      seedTreePath,
      manifestPath,
      projectName: c.project,
      projectType: c.expected.project_type,
      qualityGateCmd: c.expected.quality_gate_cmd,
      isStackedPr: c.expected.is_stacked_pr,
      reviewIterationBudgetUsd: c.max_cost_usd ?? 0.6,
    });
  } catch (err) {
    outerError = {
      kind: 'unhandled_throw',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (!runOut) {
    return {
      id: c.id,
      score: 0,
      passed: false,
      criteria: emptyCriteria(),
      cost_usd: 0,
      pr_body_chars: 0,
      why_chars: 0,
      demo_recording_path: null,
      demo_recording_bytes: 0,
      demo_source_path: null,
      ac_keywords_missing: [],
      pr_description_present: false,
      quality_gates_passed: false,
      tool_use: emptyToolUse(),
      elapsed_ms: 0,
      runner_error: outerError,
    };
  }

  totalCostUsd += runOut.costUsd;

  if (runOut.runnerError) {
    cleanupTempdir(runOut.tempdir);
    return {
      id: c.id,
      score: 0,
      passed: false,
      criteria: emptyCriteria(),
      cost_usd: runOut.costUsd,
      pr_body_chars: 0,
      why_chars: 0,
      demo_recording_path: null,
      demo_recording_bytes: 0,
      demo_source_path: null,
      ac_keywords_missing: [],
      pr_description_present: false,
      quality_gates_passed: runOut.qualityGatesPassed,
      result_subtype: runOut.resultSubtype,
      tool_use: runOut.toolUseSummary,
      elapsed_ms: runOut.durationMs,
      runner_error: runOut.runnerError,
    };
  }

  const score = caseScore({
    worktreePath: runOut.worktreePath,
    initiativeId: c.initiative_id,
    workItems: runOut.workItems,
    expected: c.expected,
    qualityGatesPassed: runOut.qualityGatesPassed,
  });

  cleanupTempdir(runOut.tempdir);

  return {
    id: c.id,
    score: score.score,
    passed: score.passed,
    criteria: score.criteria,
    cost_usd: runOut.costUsd,
    pr_body_chars: score.pr_body_chars,
    why_chars: score.why_chars,
    demo_recording_path: score.demo_recording_path,
    demo_recording_bytes: score.demo_recording_bytes,
    demo_source_path: score.demo_source_path,
    ac_keywords_missing: score.ac_keywords_missing,
    pr_description_present: score.pr_description_present,
    quality_gates_passed: runOut.qualityGatesPassed,
    result_subtype: runOut.resultSubtype,
    tool_use: runOut.toolUseSummary,
    elapsed_ms: runOut.durationMs,
  };
});

const passedCount = results.filter((r) => r.passed).length;
const totalCost = results.reduce((acc, r) => acc + r.cost_usd, 0);

const criteriaPassRates: Record<keyof ReviewerCriteria, number> = {
  quality_gates_pass: 0,
  pr_only_when_green: 0,
  demo_recording_present: 0,
  demo_exercises_acceptance_criteria: 0,
  pr_description_why_not_what: 0,
  pr_description_length_floor: 0,
  pr_links_demo: 0,
  merge_strategy_respected: 0,
};
for (const r of results) {
  for (const key of Object.keys(criteriaPassRates) as Array<keyof ReviewerCriteria>) {
    criteriaPassRates[key] += r.criteria[key];
  }
}
for (const key of Object.keys(criteriaPassRates) as Array<keyof ReviewerCriteria>) {
  criteriaPassRates[key] = results.length === 0 ? 0 : criteriaPassRates[key] / results.length;
}

const summary = {
  phase: 'review-loop',
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
    p95_cost_usd: round3(p95(results.map((r) => r.cost_usd))),
    p95_elapsed_ms: p95(results.map((r) => r.elapsed_ms)),
    criteria_pass_rates: criteriaPassRates,
  },
};

const writtenTo = writeResults(here, summary);

console.log(JSON.stringify(summary, null, 2));
console.log('');
console.log(`review-loop bench: ${passedCount}/${results.length} passed @ pass-threshold ${PASS_THRESHOLD}`);
console.log(`session cost: $${round3(totalCost)} / $${SESSION_BUDGET_USD}`);
console.log(`results: ${writtenTo}`);

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
