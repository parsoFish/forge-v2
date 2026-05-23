#!/usr/bin/env node
/**
 * Benchmark — Architect. Real runner.
 *
 * Reads prompts.json, invokes the architect skill via the SDK once per
 * fixture (each in its own tempdir), scores the manifest each fixture
 * produced, writes results/<iso>.json. Bounded concurrency + session cost
 * cap mirror the brain bench.
 *
 * S2B additions:
 *   - Each fixture also writes a per-run handoff dir at
 *     `benchmarks/architect/results/<iso>/<fixtureId>/{manifest.md, plan-doc.md,
 *     council-transcript.md}` so the PM bench can consume it via
 *     `benchmarks/_lib/handoff.ts:loadArchitectHandoff` (per CONTRACTS.md C10).
 *   - The per-fixture result entry carries `bench_handoff` paths so callers
 *     can pin to this run.
 *
 * Event-log emission is deliberately not wired here — benchmarks run outside
 * cycles per ADR 005. The result JSON is the audit trail.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

type BenchHandoff = {
  fixture_id: string;
  manifest_path: string;
  plan_doc_path: string;
  council_transcript_path: string;
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
  bench_handoff?: BenchHandoff;
  runner_error?: { kind: string; message: string };
};

const SESSION_BUDGET_USD = 5;
const CONCURRENCY = 4;

const here = import.meta.dirname;
const promptsPath = join(here, 'prompts.json');
const cases: Case[] = JSON.parse(readFileSync(promptsPath, 'utf8'));
const ranAt = new Date().toISOString();
const ranAtSlug = ranAt.replace(/[:.]/g, '-');

let totalCostUsd = 0;
let aborted = false;

function emptyCriteria(): ArchitectCriteria {
  return {
    manifest_valid: 0,
    project_context_lifted: 0,
    escalations_resolved: 0,
    downstream_pm_score: 0,
    specs_concrete_per_feature: 0,
    brain_consulted_qualified: 0,
  };
}

function writeHandoff(fixtureId: string, r: RunArchitectResult): BenchHandoff {
  const handoffDir = resolve(here, 'results', ranAtSlug, fixtureId);
  mkdirSync(handoffDir, { recursive: true });
  if (r.manifestText !== null) {
    writeFileSync(join(handoffDir, 'manifest.md'), r.manifestText);
  }
  writeFileSync(join(handoffDir, 'plan-doc.md'), r.planDoc);
  writeFileSync(join(handoffDir, 'council-transcript.md'), r.councilTranscript);
  return {
    fixture_id: fixtureId,
    manifest_path: join('results', ranAtSlug, fixtureId, 'manifest.md'),
    plan_doc_path: join('results', ranAtSlug, fixtureId, 'plan-doc.md'),
    council_transcript_path: join('results', ranAtSlug, fixtureId, 'council-transcript.md'),
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
      criteria: emptyCriteria(),
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
        criteria: emptyCriteria(),
        manifest_errors: [] as string[],
        feature_count: 0,
      }
    : caseScore({
        manifestText: r.manifestText,
        siblingManifests: r.siblingManifestTexts,
        planDoc: r.planDoc === '' ? undefined : r.planDoc,
        councilTranscript: r.councilTranscript === '' ? undefined : r.councilTranscript,
        expected: c.expected,
      });

  // Always write a handoff dir so the PM bench can consume it — even when
  // the architect produced no manifest, the empty plan-doc/council-transcript
  // surface tells downstream "this fixture failed upstream".
  const bench_handoff = writeHandoff(c.id, r);

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
    bench_handoff,
    ...(r.runnerError ? { runner_error: r.runnerError } : {}),
  };

  cleanupTempdir(r.tempdir);
  return result;
});

const passed = results.filter((r) => r.passed).length;
const elapsed = results.map((r) => r.elapsed_ms).filter((n) => n > 0);
const noManifest = results.filter((r) => r.manifest_text === null).length;

function meanCriterion(key: keyof ArchitectCriteria): number {
  if (results.length === 0) return 0;
  let sum = 0;
  for (const r of results) sum += r.criteria[key];
  return sum / results.length;
}

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
      manifest_valid: meanCriterion('manifest_valid'),
      project_context_lifted: meanCriterion('project_context_lifted'),
      escalations_resolved: meanCriterion('escalations_resolved'),
      downstream_pm_score: meanCriterion('downstream_pm_score'),
      specs_concrete_per_feature: meanCriterion('specs_concrete_per_feature'),
      brain_consulted_qualified: meanCriterion('brain_consulted_qualified'),
    },
  },
};

const outPath = writeResults(resolve(here), summary);
process.stdout.write(JSON.stringify(summary, null, 2));
process.stdout.write(`\n\n${passed}/${cases.length} cases passed (accuracy ${(summary.summary.accuracy * 100).toFixed(1)}%, threshold ${PASS_THRESHOLD})\n`);
process.stdout.write(`p95 latency: ${summary.summary.p95_ms.toFixed(0)}ms — no-manifest rate: ${(summary.summary.no_manifest_rate * 100).toFixed(1)}% — cost $${totalCostUsd.toFixed(4)}\n`);
const cpr = summary.summary.criterion_pass_rates;
process.stdout.write(
  `criteria: valid=${(cpr.manifest_valid * 100).toFixed(0)}% lifted=${(cpr.project_context_lifted * 100).toFixed(0)}% escalations=${(cpr.escalations_resolved * 100).toFixed(0)}% pm=${(cpr.downstream_pm_score * 100).toFixed(0)}% specs=${(cpr.specs_concrete_per_feature * 100).toFixed(0)}% brain=${(cpr.brain_consulted_qualified * 100).toFixed(0)}%\n`,
);
process.stdout.write(`results: ${outPath}\n`);
