#!/usr/bin/env node
/**
 * Benchmark — Reflection. Real runner.
 *
 * Reads cases.json, invokes the reflector skill via the SDK once per fixture
 * (each in its own tempdir), scores the resulting brain theme writes + retro
 * + cycle archive, writes results/<iso>.json.
 *
 * Each fixture supplies a closed-cycle bundle (manifest, events.jsonl, optional
 * brain-gaps.jsonl, merged-tree snapshot, simulator-canned user-feedback). The
 * bench:
 *   1. Sets up an isolated tempdir (symlinks for forge tree; brain layered so
 *      writes to the target project's themes/ + _raw/cycles/ land in the
 *      tempdir, not the live brain).
 *   2. Pre-writes user-feedback.md via the file-based simulator.
 *   3. Invokes the reflector skill via the SDK with the contract from
 *      orchestrator/reflector-invocation.ts.
 *   4. Scores the rubric per benchmarks/reflection/scoring.ts.
 */

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { writeResults } from '../_lib/results.ts';
import { p95 } from '../_lib/percentile.ts';
import { mapConcurrent } from '../_lib/concurrent.ts';

import {
  cleanupTempdir,
  runReflector,
  type RunReflectorResult,
} from './sdk.ts';
import {
  caseScore,
  PASS_THRESHOLD,
  type ReflectionCriteria,
  type ReflectionExpected,
} from './scoring.ts';
import type { ReflectorToolUseSummary } from '../../orchestrator/reflector-invocation.ts';
import { parseSource, emitChainedSliceAndExit } from '../_lib/source-switch.ts';

// --source=chained: print this phase's slice of the latest chained run
// (scored by the SAME caseScore below) and exit. Default golden path
// (isolated bench against cases.json fixtures) is unchanged. No SDK call.
if (parseSource() === 'chained') emitChainedSliceAndExit('reflection', 'reflection');

type Case = {
  id: string;
  initiative_id: string;
  cycle_id: string;
  project: string;
  /** Fixture directory relative to this dir. Contains manifest.md, events.jsonl,
   *  brain-gaps.jsonl (may be empty), merged-tree/, user-feedback.md, expected.json. */
  fixture_dir: string;
  expected: ReflectionExpected;
  /** Per-fixture max budget USD. Default 0.6. */
  max_cost_usd?: number;
};

type CaseResult = {
  id: string;
  score: number;
  passed: boolean;
  criteria: ReflectionCriteria;
  cost_usd: number;
  themes_found: string[];
  themes_missing_evidence: string[];
  themes_invalid_category: string[];
  retro_path: string | null;
  cycle_archive_path: string | null;
  brain_gaps_unaddressed: string[];
  lint_errors: string[];
  result_subtype?: string;
  tool_use: ReflectorToolUseSummary;
  elapsed_ms: number;
  /** Diagnostic snapshot of artifacts the agent emitted (pre-cleanup). */
  artifacts?: {
    tempdir?: string;
    log_dir_files: string[];
    themes_dir_files: string[];
    raw_cycles_dir_files: string[];
  };
  runner_error?: { kind: string; message: string };
};

const KEEP_TEMPDIR = process.env.FORGE_BENCH_KEEP_TEMPDIR === '1';

import { readdirSync as _readdirSync, existsSync as _existsSync } from 'node:fs';
function snapshotDir(dir: string): string[] {
  if (!_existsSync(dir)) return [];
  try {
    return _readdirSync(dir);
  } catch {
    return [];
  }
}

const SESSION_BUDGET_USD = 8;
const CONCURRENCY = 2;

const here = import.meta.dirname;
const casesPath = join(here, 'cases.json');
const cases: Case[] = JSON.parse(readFileSync(casesPath, 'utf8'));
const ranAt = new Date().toISOString();

let totalCostUsd = 0;
let aborted = false;

function emptyCriteria(): ReflectionCriteria {
  return {
    manifest_provided: 0,
    log_parseable: 0,
    retro_emitted: 0,
    brain_consulted: 0,
    no_brain_corruption: 0,
    themes_emitted: 0,
    themes_evidence_grounded: 0,
    theme_categories_balanced: 0,
    cycle_archived: 0,
    retro_three_sections: 0,
    brain_gaps_addressed: 0,
  };
}

function emptyToolUse(): ReflectorToolUseSummary {
  return { brainReads: 0, themeWrites: 0, retroWrites: 0, bashCalls: 0 };
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
      themes_found: [],
      themes_missing_evidence: [],
      themes_invalid_category: [],
      retro_path: null,
      cycle_archive_path: null,
      brain_gaps_unaddressed: [],
      lint_errors: [],
      tool_use: emptyToolUse(),
      elapsed_ms: 0,
      runner_error: {
        kind: 'session_budget_exhausted',
        message: `>= ${SESSION_BUDGET_USD} USD`,
      },
    };
  }

  const fixtureDir = resolve(here, c.fixture_dir);
  const manifestPath = resolve(fixtureDir, 'manifest.md');
  const eventLogPath = resolve(fixtureDir, 'events.jsonl');
  const brainGapsPath = resolve(fixtureDir, 'brain-gaps.jsonl');
  const mergedTreePath = resolve(fixtureDir, 'merged-tree');
  const userFeedbackPath = resolve(fixtureDir, 'user-feedback.md');
  const userFeedbackContent = readFileSync(userFeedbackPath, 'utf8');

  let runOut: RunReflectorResult | undefined;
  let outerError: { kind: string; message: string } | undefined;
  try {
    runOut = await runReflector({
      fixtureId: c.id,
      initiativeId: c.initiative_id,
      cycleId: c.cycle_id,
      projectName: c.project,
      manifestPath,
      eventLogPath,
      brainGapsPath,
      mergedTreePath,
      userFeedbackContent,
      maxBudgetUsd: c.max_cost_usd ?? 0.6,
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
      themes_found: [],
      themes_missing_evidence: [],
      themes_invalid_category: [],
      retro_path: null,
      cycle_archive_path: null,
      brain_gaps_unaddressed: [],
      lint_errors: [],
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
      themes_found: [],
      themes_missing_evidence: [],
      themes_invalid_category: [],
      retro_path: null,
      cycle_archive_path: null,
      brain_gaps_unaddressed: [],
      lint_errors: [],
      result_subtype: runOut.resultSubtype,
      tool_use: runOut.toolUseSummary,
      elapsed_ms: runOut.durationMs,
      runner_error: runOut.runnerError,
    };
  }

  const score = caseScore({
    cycleId: c.cycle_id,
    benchRoot: runOut.tempdir,
    manifestPath: resolve(runOut.tempdir, '_queue', 'done', `${c.initiative_id}.md`),
    eventLogPath: resolve(runOut.tempdir, '_logs', c.cycle_id, 'events.jsonl'),
    toolUse: runOut.toolUseSummary,
    expected: c.expected,
  });

  // Pre-cleanup snapshot — useful when the agent wrote to unexpected paths.
  const artifacts = {
    tempdir: KEEP_TEMPDIR ? runOut.tempdir : undefined,
    log_dir_files: snapshotDir(resolve(runOut.tempdir, '_logs', c.cycle_id)),
    themes_dir_files: snapshotDir(
      resolve(runOut.tempdir, 'brain', 'projects', c.project, 'themes'),
    ),
    raw_cycles_dir_files: snapshotDir(
      resolve(runOut.tempdir, 'brain', '_raw', 'cycles'),
    ),
  };

  if (!KEEP_TEMPDIR) cleanupTempdir(runOut.tempdir);

  return {
    id: c.id,
    score: score.score,
    passed: score.passed,
    criteria: score.criteria,
    cost_usd: runOut.costUsd,
    themes_found: score.themes_found.map((p) =>
      // Strip the tempdir prefix for readability in the results JSON.
      p.replace(runOut!.tempdir, '<tempdir>'),
    ),
    themes_missing_evidence: score.themes_missing_evidence.map((p) =>
      p.replace(runOut!.tempdir, '<tempdir>'),
    ),
    themes_invalid_category: score.themes_invalid_category.map((p) =>
      p.replace(runOut!.tempdir, '<tempdir>'),
    ),
    retro_path: score.retro_path?.replace(runOut.tempdir, '<tempdir>') ?? null,
    cycle_archive_path:
      score.cycle_archive_path?.replace(runOut.tempdir, '<tempdir>') ?? null,
    brain_gaps_unaddressed: score.brain_gaps_unaddressed,
    lint_errors: score.lint_errors.map((e) => e.replace(runOut!.tempdir, '<tempdir>')),
    result_subtype: runOut.resultSubtype,
    tool_use: runOut.toolUseSummary,
    elapsed_ms: runOut.durationMs,
    artifacts,
  };
});

const passedCount = results.filter((r) => r.passed).length;
const totalCost = results.reduce((acc, r) => acc + r.cost_usd, 0);

const criteriaPassRates: Record<keyof ReflectionCriteria, number> = {
  manifest_provided: 0,
  log_parseable: 0,
  retro_emitted: 0,
  brain_consulted: 0,
  no_brain_corruption: 0,
  themes_emitted: 0,
  themes_evidence_grounded: 0,
  theme_categories_balanced: 0,
  cycle_archived: 0,
  retro_three_sections: 0,
  brain_gaps_addressed: 0,
};
for (const r of results) {
  for (const key of Object.keys(criteriaPassRates) as Array<keyof ReflectionCriteria>) {
    criteriaPassRates[key] += r.criteria[key];
  }
}
for (const key of Object.keys(criteriaPassRates) as Array<keyof ReflectionCriteria>) {
  criteriaPassRates[key] =
    results.length === 0 ? 0 : criteriaPassRates[key] / results.length;
}

const summary = {
  phase: 'reflection',
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
console.log(
  `reflection bench: ${passedCount}/${results.length} passed @ pass-threshold ${PASS_THRESHOLD}`,
);
console.log(`session cost: $${round3(totalCost)} / $${SESSION_BUDGET_USD}`);
console.log(`results: ${writtenTo}`);

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
