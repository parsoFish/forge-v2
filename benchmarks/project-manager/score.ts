#!/usr/bin/env node
/**
 * Benchmark — Project Manager. Real runner.
 *
 * Reads initiatives.json, invokes the PM skill via the SDK once per fixture
 * (each in its own tempdir), scores the work items + graph each fixture
 * produced, writes results/<iso>.json. Bounded concurrency + session cost
 * cap mirror the architect bench.
 *
 * Each fixture supplies an initiative manifest path (relative to this dir) and
 * optionally a project_tree directory the bench copies into the tempdir to
 * give the PM a real worktree to read.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { writeResults } from '../_lib/results.ts';
import { p95 } from '../_lib/percentile.ts';
import { mapConcurrent } from '../_lib/concurrent.ts';
import {
  cleanupTempdir,
  runProjectManager,
  type RunPmResult,
} from './sdk.ts';
import {
  caseScore,
  PASS_THRESHOLD,
  type PmCriteria,
} from './scoring.ts';
import { parseManifest } from '../../orchestrator/manifest.ts';
import type { PmToolUseSummary } from '../../orchestrator/pm-invocation.ts';
import { parseSource, emitChainedSliceAndExit } from '../_lib/source-switch.ts';

// --source=chained: print this phase's slice of the latest chained run
// (scored by the SAME caseScore below) and exit. Default golden path
// (isolated bench against initiatives.json) is unchanged. No SDK call here.
if (parseSource() === 'chained') emitChainedSliceAndExit('project_manager', 'project-manager');

/**
 * Per-fixture bench case shape. `expected` carries the old hand-tuned
 * range fields (min_work_items / max_work_items / parallel_fraction_at_least);
 * per C11 these MAY be absent in newer fixtures, in which case the range
 * is derived from the manifest topology (feature_count..2*fc+2, ceiling
 * 8 unless fc > 4).
 */
type CaseExpected = {
  min_work_items?: number;
  max_work_items?: number;
  parallel_fraction_at_least?: number;
};

type Case = {
  id: string;
  initiative_manifest: string;        // relative to this dir
  project: string;
  project_tree?: string;              // relative to this dir
  expected: CaseExpected;
};

type CaseResult = {
  id: string;
  score: number;
  passed: boolean;
  criteria: PmCriteria;
  set_errors: string[];
  per_item_errors: Record<string, string[]>;
  hidden_coupling_pairs: Array<{ a: string; b: string; sharedFiles: string[] }>;
  work_item_count: number;
  parallel_fraction: number;
  work_items_dir_rel: string | null;
  parse_errors: Record<string, string>;
  tool_use: PmToolUseSummary;
  elapsed_ms: number;
  cost_usd: number;
  runner_error?: { kind: string; message: string };
};

const SESSION_BUDGET_USD = 5;
const CONCURRENCY = 4;

const here = import.meta.dirname;
const casesPath = join(here, 'initiatives.json');
const cases: Case[] = JSON.parse(readFileSync(casesPath, 'utf8'));
const ranAt = new Date().toISOString();

let totalCostUsd = 0;
let aborted = false;

function emptyCriteria(): PmCriteria {
  return {
    feature_id_in_manifest: 0,
    work_items_present: 0,
    work_item_count_in_range: 0,
    every_item_has_gwt: 0,
    every_item_lists_scope: 0,
    parallel_fraction_meets: 0,
    no_hidden_coupling: 0,
    one_creator_per_file: 0,
    quality_gate_cmd_present: 0,
    files_real_or_explicitly_new: 0,
    graph_emitted_valid: 0,
  };
}

/**
 * S3 / C11 migration helper. Derive the (min_work_items, max_work_items,
 * parallel_fraction_at_least) tuple from the manifest topology when the
 * fixture's `expected` block omits them. When `expected` carries the old
 * shape, use it verbatim and emit a deprecation log line so the next
 * bench pass can drop the hardcoded values.
 *
 * Sizing band (plan 03 + C5): per initiative
 *   feature_count..2*feature_count+2, ceiling 8 unless feature_count > 4.
 */
function resolveExpected(
  caseExpected: CaseExpected,
  featureCount: number,
  caseId: string,
): { minWorkItems: number; maxWorkItems: number; parallelFractionAtLeast: number } {
  const usingOldShape =
    caseExpected.min_work_items !== undefined ||
    caseExpected.max_work_items !== undefined ||
    caseExpected.parallel_fraction_at_least !== undefined;
  if (usingOldShape) {
    process.stderr.write(
      `[bench:pm] DEPRECATED: case ${caseId} uses hardcoded expected.min_work_items / max_work_items / parallel_fraction_at_least; per C11 these will be derived from manifest topology in the next release.\n`,
    );
  }
  const derivedMin = Math.max(featureCount, 2);
  const derivedMax = featureCount > 4
    ? 2 * featureCount + 2
    : Math.min(2 * featureCount + 2, 8);
  return {
    minWorkItems: caseExpected.min_work_items ?? derivedMin,
    maxWorkItems: caseExpected.max_work_items ?? derivedMax,
    parallelFractionAtLeast: caseExpected.parallel_fraction_at_least ?? 0.3,
  };
}

/**
 * Walk a fixture's project_tree directory and collect every relative file
 * path. Drives the `files_real_or_explicitly_new` criterion: a WI's
 * `files_in_scope` entry is "real" if it appears in this set, "new" if the
 * WI lists it in `creates`. Symlinks are not followed (the fixture trees
 * are flat repo copies — no need).
 */
function listProjectTree(rootPath: string): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs);
      } else if (st.isFile()) {
        out.add(relative(rootPath, abs));
      }
    }
  };
  walk(rootPath);
  return out;
}

const results = await mapConcurrent(cases, CONCURRENCY, async (c): Promise<CaseResult> => {
  if (aborted || totalCostUsd >= SESSION_BUDGET_USD) {
    aborted = true;
    return {
      id: c.id,
      score: 0,
      passed: false,
      criteria: emptyCriteria(),
      set_errors: [],
      per_item_errors: {},
      hidden_coupling_pairs: [],
      work_item_count: 0,
      parallel_fraction: 0,
      work_items_dir_rel: null,
      parse_errors: {},
      tool_use: { brainReads: 0, writes: 0, bashCalls: 0 },
      elapsed_ms: 0,
      cost_usd: 0,
      runner_error: {
        kind: 'session_budget_exceeded',
        message: `Aborted before running ${c.id}: total $${totalCostUsd.toFixed(4)} crossed cap $${SESSION_BUDGET_USD}`,
      },
    };
  }

  const manifestAbsPath = resolve(here, c.initiative_manifest);
  const initiativeManifest = readFileSync(manifestAbsPath, 'utf8');
  const parsedManifest = parseManifest(initiativeManifest);
  const initiativeId = parsedManifest.initiative_id;
  const knownFeatureIds = parsedManifest.features.map((f) => f.feature_id);
  const featureCount = knownFeatureIds.length;
  const sizing = resolveExpected(c.expected, featureCount, c.id);

  const projectTreePath = c.project_tree ? resolve(here, c.project_tree) : undefined;
  const projectTreeSet = projectTreePath ? listProjectTree(projectTreePath) : undefined;

  let r: RunPmResult;
  try {
    r = await runProjectManager({
      fixtureId: c.id,
      initiativeId,
      initiativeManifest,
      projectTreePath,
      projectName: c.project,
      expected: {
        min_work_items: sizing.minWorkItems,
        max_work_items: sizing.maxWorkItems,
        parallel_fraction_at_least: sizing.parallelFractionAtLeast,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: c.id,
      score: 0,
      passed: false,
      criteria: emptyCriteria(),
      set_errors: [],
      per_item_errors: {},
      hidden_coupling_pairs: [],
      work_item_count: 0,
      parallel_fraction: 0,
      work_items_dir_rel: null,
      parse_errors: {},
      tool_use: { brainReads: 0, writes: 0, bashCalls: 0 },
      elapsed_ms: 0,
      cost_usd: 0,
      runner_error: { kind: 'thrown', message },
    };
  }

  totalCostUsd += r.costUsd;

  const scored = caseScore({
    workItems: r.workItems,
    graphText: r.graphText,
    expected: {
      min_work_items: sizing.minWorkItems,
      max_work_items: sizing.maxWorkItems,
      parallel_fraction_at_least: sizing.parallelFractionAtLeast,
      known_feature_ids: knownFeatureIds,
      iteration_budget: parsedManifest.iteration_budget,
      project_tree: projectTreeSet,
    },
  });

  const result: CaseResult = {
    id: c.id,
    score: scored.score,
    passed: scored.passed,
    criteria: scored.criteria,
    set_errors: scored.set_errors,
    per_item_errors: scored.per_item_errors,
    hidden_coupling_pairs: scored.hidden_coupling_pairs,
    work_item_count: scored.work_item_count,
    parallel_fraction: scored.parallel_fraction,
    work_items_dir_rel: r.workItemsDirRel,
    parse_errors: r.parseErrors,
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
const noWorkItems = results.filter((r) => r.work_item_count === 0).length;

const summary = {
  phase: 'project-manager',
  ran_at: ranAt,
  pass_threshold: PASS_THRESHOLD,
  cases: results,
  summary: {
    total: cases.length,
    passed,
    failed: cases.length - passed,
    accuracy: cases.length === 0 ? 1 : passed / cases.length,
    p95_ms: p95(elapsed),
    no_work_items_rate: cases.length === 0 ? 0 : noWorkItems / cases.length,
    total_cost_usd: totalCostUsd,
    aborted_on_budget: aborted,
    criterion_pass_rates: {
      feature_id_in_manifest:
        cases.length === 0 ? 0 : results.filter((r) => r.criteria.feature_id_in_manifest === 1).length / cases.length,
      work_item_count_in_range:
        cases.length === 0 ? 0 : results.filter((r) => r.criteria.work_item_count_in_range === 1).length / cases.length,
      every_item_has_gwt:
        cases.length === 0 ? 0 : results.filter((r) => r.criteria.every_item_has_gwt === 1).length / cases.length,
      every_item_lists_scope:
        cases.length === 0 ? 0 : results.filter((r) => r.criteria.every_item_lists_scope === 1).length / cases.length,
      parallel_fraction_meets:
        cases.length === 0 ? 0 : results.filter((r) => r.criteria.parallel_fraction_meets === 1).length / cases.length,
      no_hidden_coupling:
        cases.length === 0 ? 0 : results.filter((r) => r.criteria.no_hidden_coupling === 1).length / cases.length,
      one_creator_per_file:
        cases.length === 0 ? 0 : results.filter((r) => r.criteria.one_creator_per_file === 1).length / cases.length,
      quality_gate_cmd_present:
        cases.length === 0 ? 0 : results.filter((r) => r.criteria.quality_gate_cmd_present === 1).length / cases.length,
      files_real_or_explicitly_new:
        cases.length === 0 ? 0 : results.filter((r) => r.criteria.files_real_or_explicitly_new === 1).length / cases.length,
      graph_emitted_valid:
        cases.length === 0 ? 0 : results.filter((r) => r.criteria.graph_emitted_valid === 1).length / cases.length,
    },
  },
};

const outPath = writeResults(resolve(here), summary);
process.stdout.write(JSON.stringify(summary, null, 2));
process.stdout.write(`\n\n${passed}/${cases.length} cases passed (accuracy ${(summary.summary.accuracy * 100).toFixed(1)}%, threshold ${PASS_THRESHOLD})\n`);
process.stdout.write(`p95 latency: ${summary.summary.p95_ms.toFixed(0)}ms — no-work-items rate: ${(summary.summary.no_work_items_rate * 100).toFixed(1)}% — cost $${totalCostUsd.toFixed(4)}\n`);
const cpr = summary.summary.criterion_pass_rates;
process.stdout.write(
  `criteria: gate=${(cpr.feature_id_in_manifest * 100).toFixed(0)}% gwt=${(cpr.every_item_has_gwt * 100).toFixed(0)}% no-coupling=${(cpr.no_hidden_coupling * 100).toFixed(0)}% one-creator=${(cpr.one_creator_per_file * 100).toFixed(0)}% gate-cmd=${(cpr.quality_gate_cmd_present * 100).toFixed(0)}% files-real=${(cpr.files_real_or_explicitly_new * 100).toFixed(0)}% parallel=${(cpr.parallel_fraction_meets * 100).toFixed(0)}% count=${(cpr.work_item_count_in_range * 100).toFixed(0)}% scope=${(cpr.every_item_lists_scope * 100).toFixed(0)}% graph=${(cpr.graph_emitted_valid * 100).toFixed(0)}%\n`,
);
process.stdout.write(`results: ${outPath}\n`);
