#!/usr/bin/env node
/**
 * Benchmark — Brain. Real runner.
 *
 * Reads questions.json, invokes brain-query via the SDK once per question,
 * scores each case, and writes results/<iso>.json.
 *
 * Event-log emission is deliberately not wired here — benchmarks run outside
 * cycles per ADR 005. The result JSON is the audit trail.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { writeResults } from '../_lib/results.ts';
import { p95 } from '../_lib/percentile.ts';
import { mapConcurrent } from '../_lib/concurrent.ts';
import { runBrainQuery, type RunBrainQueryResult } from './sdk.ts';
import { caseScore, normalisePath } from './scoring.ts';

type Case = {
  id: string;
  question: string;
  expected_sources: string[];
  expected_keywords: string[];
  scope?: string | null;
  category?: string | null;
  /**
   * S5 / refinement #6 — origin tag carried alongside each case so the
   * promote pipeline (and post-hoc analysis) can split bench accuracy by
   * cohort (e.g. "did the manual-seed betterado questions hold?",
   * "did the promotion from cycle X regress its peers?"). Parsed-but-ignored
   * by the runner; surfaced in the per-cycle breakdown only.
   */
  source_cycle?: string | null;
};

type CaseResult = {
  id: string;
  score: number;
  source_recall: number;
  source_f1: number;
  keyword_match: number;
  hallucinated_paths: string[];
  expected: { sources: string[]; keywords: string[] };
  actual: { sources: string[]; answer: string; confidence?: string; gap?: boolean } | null;
  elapsed_ms: number;
  cost_usd: number;
  runner_error?: { kind: string; message: string };
  source_cycle?: string | null;
};

const PASS_THRESHOLD = 0.65;
const SESSION_BUDGET_USD = 5;
const CONCURRENCY = 4;

const here = import.meta.dirname;
const forgeRoot = resolve(here, '..', '..');
const questionsPath = join(here, 'questions.json');
const cases: Case[] = JSON.parse(readFileSync(questionsPath, 'utf8'));
const ranAt = new Date().toISOString();

let totalCostUsd = 0;
let aborted = false;

const results = await mapConcurrent(cases, CONCURRENCY, async (c): Promise<CaseResult> => {
  if (aborted || totalCostUsd >= SESSION_BUDGET_USD) {
    aborted = true;
    return {
      id: c.id,
      score: 0,
      source_recall: 0,
      source_f1: 0,
      keyword_match: 0,
      hallucinated_paths: [],
      expected: { sources: c.expected_sources, keywords: c.expected_keywords },
      source_cycle: c.source_cycle ?? null,
      actual: null,
      elapsed_ms: 0,
      cost_usd: 0,
      runner_error: {
        kind: 'session_budget_exceeded',
        message: `Aborted before running ${c.id}: total $${totalCostUsd.toFixed(4)} crossed cap $${SESSION_BUDGET_USD}`,
      },
    };
  }

  let r: RunBrainQueryResult;
  try {
    r = await runBrainQuery({ question: c.question, scope: c.scope ?? null, category: c.category ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: c.id,
      score: 0,
      source_recall: 0,
      source_f1: 0,
      keyword_match: 0,
      hallucinated_paths: [],
      expected: { sources: c.expected_sources, keywords: c.expected_keywords },
      source_cycle: c.source_cycle ?? null,
      actual: null,
      elapsed_ms: 0,
      cost_usd: 0,
      runner_error: { kind: 'thrown', message },
    };
  }

  totalCostUsd += r.costUsd;

  const answer = r.structured?.answers[0] ?? null;
  if (!answer) {
    return {
      id: c.id,
      score: 0,
      source_recall: 0,
      source_f1: 0,
      keyword_match: 0,
      hallucinated_paths: [],
      expected: { sources: c.expected_sources, keywords: c.expected_keywords },
      source_cycle: c.source_cycle ?? null,
      actual: null,
      elapsed_ms: r.durationMs,
      cost_usd: r.costUsd,
      ...(r.runnerError ? { runner_error: r.runnerError } : {}),
    };
  }

  const scored = caseScore({
    expectedSources: c.expected_sources,
    expectedKeywords: c.expected_keywords,
    actualSources: answer.sources,
    actualAnswer: answer.answer,
    forgeRoot,
  });

  return {
    id: c.id,
    score: scored.score,
    source_recall: scored.source_recall,
    source_f1: scored.source_f1,
    keyword_match: scored.keyword_match,
    hallucinated_paths: scored.hallucinated_paths,
    expected: { sources: c.expected_sources, keywords: c.expected_keywords },
    actual: {
      sources: answer.sources.map(normalisePath),
      answer: answer.answer,
      confidence: answer.confidence,
      gap: answer.gap,
    },
    elapsed_ms: r.durationMs,
    cost_usd: r.costUsd,
    ...(r.runnerError ? { runner_error: r.runnerError } : {}),
  };
});

const passed = results.filter((r) => r.score >= PASS_THRESHOLD).length;
const elapsed = results.map((r) => r.elapsed_ms).filter((n) => n > 0);
const gaps = results.filter((r) => r.actual?.gap === true).length;
const halls = results.filter((r) => r.hallucinated_paths.length > 0).length;

/**
 * S5 / refinement #6: aggregate accuracy per source_cycle. `null` and absent
 * map to `"original"` (the pre-bench-growth question set). Manual seeds use
 * the `manual-seed-<date>` prefix; promoted candidates carry the cycle id.
 */
function byCycleBreakdown(): Record<string, { total: number; passed: number; accuracy: number }> {
  const buckets: Record<string, { total: number; passed: number }> = {};
  for (const r of results) {
    const key = r.source_cycle ?? 'original';
    if (!buckets[key]) buckets[key] = { total: 0, passed: 0 };
    buckets[key].total += 1;
    if (r.score >= PASS_THRESHOLD) buckets[key].passed += 1;
  }
  const out: Record<string, { total: number; passed: number; accuracy: number }> = {};
  for (const [key, v] of Object.entries(buckets)) {
    out[key] = { ...v, accuracy: v.total === 0 ? 1 : v.passed / v.total };
  }
  return out;
}

const summary = {
  phase: 'brain',
  ran_at: ranAt,
  pass_threshold: PASS_THRESHOLD,
  cases: results,
  summary: {
    total: cases.length,
    passed,
    failed: cases.length - passed,
    accuracy: cases.length === 0 ? 1 : passed / cases.length,
    p95_ms: p95(elapsed),
    gap_rate: cases.length === 0 ? 0 : gaps / cases.length,
    hallucination_rate: cases.length === 0 ? 0 : halls / cases.length,
    total_cost_usd: totalCostUsd,
    aborted_on_budget: aborted,
    by_source_cycle: byCycleBreakdown(),
  },
};

const outPath = writeResults(resolve(here), summary);
process.stdout.write(JSON.stringify(summary, null, 2));
process.stdout.write(`\n\n${passed}/${cases.length} cases passed (accuracy ${(summary.summary.accuracy * 100).toFixed(1)}%, threshold ${PASS_THRESHOLD})\n`);
process.stdout.write(`p95 latency: ${summary.summary.p95_ms.toFixed(0)}ms — gap rate: ${(summary.summary.gap_rate * 100).toFixed(1)}% — hallucination rate: ${(summary.summary.hallucination_rate * 100).toFixed(1)}% — cost $${totalCostUsd.toFixed(4)}\n`);
process.stdout.write(`results: ${outPath}\n`);
