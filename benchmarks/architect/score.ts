#!/usr/bin/env node
/**
 * Benchmark — Architect. Real runner.
 *
 * Reads prompts.json, invokes the architect skill via the SDK once per
 * fixture (each in its own tempdir), scores the manifest each fixture
 * produced, writes results/<iso>.json. Bounded concurrency + session cost
 * cap mirror the brain bench.
 *
 * Event-log emission is deliberately not wired here — benchmarks run outside
 * cycles per ADR 005. The result JSON is the audit trail.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { writeResults } from '../_lib/results.ts';
import { p95 } from '../_lib/percentile.ts';
import { mapConcurrent } from '../_lib/concurrent.ts';
import { parseSource, emitChainedSliceAndExit } from '../_lib/source-switch.ts';
import { cleanupTempdir, runArchitect, type RunArchitectResult, type ToolUseSummary } from './sdk.ts';
import { caseScore, PASS_THRESHOLD, type ArchitectExpected, type ArchitectCriteria } from './scoring.ts';

// --source=chained: print this phase's slice of the latest chained run
// (scored by the SAME caseScore below) and exit. Default golden path
// (isolated bench against prompts.json) is unchanged. No SDK call here.
if (parseSource() === 'chained') emitChainedSliceAndExit('architect', 'architect');

type Case = {
  id: string;
  user_prompt: string;
  project: string;
  project_context?: string;
  expected: ArchitectExpected;
};

type CaseResult = {
  id: string;
  score: number;
  passed: boolean;
  criteria: ArchitectCriteria;
  manifest_errors: string[];
  feature_count: number;
  manifest_text: string | null;
  manifest_path: string | null;
  tool_use: ToolUseSummary;
  elapsed_ms: number;
  cost_usd: number;
  runner_error?: { kind: string; message: string };
};

const SESSION_BUDGET_USD = 5;
const CONCURRENCY = 4;

const here = import.meta.dirname;
const promptsPath = join(here, 'prompts.json');
const cases: Case[] = JSON.parse(readFileSync(promptsPath, 'utf8'));
const ranAt = new Date().toISOString();

let totalCostUsd = 0;
let aborted = false;

const results = await mapConcurrent(cases, CONCURRENCY, async (c): Promise<CaseResult> => {
  if (aborted || totalCostUsd >= SESSION_BUDGET_USD) {
    aborted = true;
    return {
      id: c.id,
      score: 0,
      passed: false,
      criteria: { manifest_valid: 0, scope_right_sized: 0, specs_concrete: 0, brain_consulted: 0 },
      manifest_errors: [],
      feature_count: 0,
      manifest_text: null,
      manifest_path: null,
      tool_use: { brainReads: 0, writes: 0, bashCalls: 0 },
      elapsed_ms: 0,
      cost_usd: 0,
      runner_error: {
        kind: 'session_budget_exceeded',
        message: `Aborted before running ${c.id}: total $${totalCostUsd.toFixed(4)} crossed cap $${SESSION_BUDGET_USD}`,
      },
    };
  }

  let r: RunArchitectResult;
  try {
    r = await runArchitect({
      fixtureId: c.id,
      userPrompt: c.user_prompt,
      projectName: c.project,
      projectContext: c.project_context,
      expected: { min_features: c.expected.min_features ?? 1, max_features: c.expected.max_features ?? 5 },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: c.id,
      score: 0,
      passed: false,
      criteria: { manifest_valid: 0, scope_right_sized: 0, specs_concrete: 0, brain_consulted: 0 },
      manifest_errors: [],
      feature_count: 0,
      manifest_text: null,
      manifest_path: null,
      tool_use: { brainReads: 0, writes: 0, bashCalls: 0 },
      elapsed_ms: 0,
      cost_usd: 0,
      runner_error: { kind: 'thrown', message },
    };
  }

  totalCostUsd += r.costUsd;

  const scored = r.manifestText === null
    ? {
        score: 0,
        passed: false,
        criteria: { manifest_valid: 0, scope_right_sized: 0, specs_concrete: 0, brain_consulted: 0 },
        manifest_errors: [] as string[],
        feature_count: 0,
      }
    : caseScore({ manifestText: r.manifestText, expected: c.expected });

  const result: CaseResult = {
    id: c.id,
    score: scored.score,
    passed: scored.passed,
    criteria: scored.criteria,
    manifest_errors: scored.manifest_errors,
    feature_count: scored.feature_count,
    manifest_text: r.manifestText,
    manifest_path: r.manifestPath,
    tool_use: r.toolUseSummary,
    elapsed_ms: r.durationMs,
    cost_usd: r.costUsd,
    ...(r.runnerError ? { runner_error: r.runnerError } : {}),
  };

  cleanupTempdir(r.tempdir);
  return result;
});

const passed = results.filter((r) => r.passed).length;
const elapsed = results.map((r) => r.elapsed_ms).filter((n) => n > 0);
const noManifest = results.filter((r) => r.manifest_text === null).length;

const summary = {
  phase: 'architect',
  ran_at: ranAt,
  pass_threshold: PASS_THRESHOLD,
  cases: results,
  summary: {
    total: cases.length,
    passed,
    failed: cases.length - passed,
    accuracy: cases.length === 0 ? 1 : passed / cases.length,
    p95_ms: p95(elapsed),
    no_manifest_rate: cases.length === 0 ? 0 : noManifest / cases.length,
    total_cost_usd: totalCostUsd,
    aborted_on_budget: aborted,
    criterion_pass_rates: {
      manifest_valid: cases.length === 0 ? 0 : results.filter((r) => r.criteria.manifest_valid === 1).length / cases.length,
      scope_right_sized: cases.length === 0 ? 0 : results.filter((r) => r.criteria.scope_right_sized === 1).length / cases.length,
      specs_concrete: cases.length === 0 ? 0 : results.filter((r) => r.criteria.specs_concrete === 1).length / cases.length,
      brain_consulted: cases.length === 0 ? 0 : results.filter((r) => r.criteria.brain_consulted === 1).length / cases.length,
    },
  },
};

const outPath = writeResults(resolve(here), summary);
process.stdout.write(JSON.stringify(summary, null, 2));
process.stdout.write(`\n\n${passed}/${cases.length} cases passed (accuracy ${(summary.summary.accuracy * 100).toFixed(1)}%, threshold ${PASS_THRESHOLD})\n`);
process.stdout.write(`p95 latency: ${summary.summary.p95_ms.toFixed(0)}ms — no-manifest rate: ${(summary.summary.no_manifest_rate * 100).toFixed(1)}% — cost $${totalCostUsd.toFixed(4)}\n`);
const cpr = summary.summary.criterion_pass_rates;
process.stdout.write(`criteria: valid=${(cpr.manifest_valid * 100).toFixed(0)}% scope=${(cpr.scope_right_sized * 100).toFixed(0)}% specs=${(cpr.specs_concrete * 100).toFixed(0)}% brain=${(cpr.brain_consulted * 100).toFixed(0)}%\n`);
process.stdout.write(`results: ${outPath}\n`);
