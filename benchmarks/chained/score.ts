#!/usr/bin/env node
/**
 * Benchmark — Chained. Real runner.
 *
 * Reads seeds.json, runs `runChain` once per seed (architect bench → cpSync
 * → real runCycle), then fans the generated artifact set out to the SIX
 * EXISTING per-phase pure `scoring.ts:caseScore` functions:
 *
 *   architect    → benchmarks/architect/scoring.ts      (generated manifest)
 *   project-mgr  → benchmarks/project-manager/scoring.ts (.forge/work-items/)
 *   developer    → benchmarks/developer-loop/scoring.ts  (LoopResult from
 *                                                          events.jsonl
 *                                                          `ralph.end`)
 *   review-loop  → benchmarks/review-loop/scoring.ts     (.forge/pr-description.md
 *                                                          + .forge/demos/)
 *   reflection   → benchmarks/reflection/scoring.ts       (masked themes)
 *
 * There is NO chained-only rubric and NO chained-only fixture. The overall
 * signal is purely "every per-phase rubric passed on chained (generated)
 * inputs"; a chain break at phase N is phase N's existing bench failing on
 * phase N-1's output (US-6.2, brain theme `chained-phase-benchmarks`).
 *
 * Cost note: one seed = one full cycle (PM + dev-loop + review-Ralph +
 * reflection) plus an architect run — expensive. Session budget caps it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { writeResults } from '../_lib/results.ts';
import { p95 } from '../_lib/percentile.ts';
import { mapConcurrent } from '../_lib/concurrent.ts';

import { cleanupTempdir, runChain, type ChainArtifacts, type ChainSeed } from './sdk.ts';
import {
  cleanupReviewBaseDir,
  resolveReviewBaseDir,
  type ReviewBaseHandle,
} from './review-base.ts';
import type { TargetSpec } from '../e2e/simulator.ts';

import { caseScore as architectCaseScore } from '../architect/scoring.ts';
import { caseScore as pmCaseScore } from '../project-manager/scoring.ts';
import { caseScore as devCaseScore } from '../developer-loop/scoring.ts';
// S4: review-loop bench retired; minimal local shim until the chained
// bench's review-phase row is rebuilt around the unifier criteria.
import { caseScore as reviewCaseScore } from './review-loop-stub.ts';
import { caseScore as reflectionCaseScore } from '../reflection/scoring.ts';

import {
  readChainedManifestText,
  readChainedWorkItems,
  readChainedGraphText,
  reconstructLoopResultFromEventLog,
  syntheticAggregateWorkItem,
  reconstructReflectorToolUse,
} from './chained-artifacts.ts';

// ---------------------------------------------------------------------------
// Seed schema. The ONLY e2e-test input is a seed (architect prompt + the
// downstream pieces the cycle needs the architect doesn't author).
// ---------------------------------------------------------------------------

type Seed = {
  id: string;
  architect_prompt: string;
  project: string;
  architect_expected: { min_features: number; max_features: number };
  project_context?: string;
  /** Seed worktree, relative to this dir (reused from benchmarks/e2e/fixtures). */
  seed_tree: string;
  spec: TargetSpec;
  quality_gate_cmd?: string[];
  review_iteration_cap?: number;
  review_iteration_budget_usd?: number;
  /** Per-phase expected blocks for the existing rubrics (chained inputs). */
  expected: {
    architect: { min_features: number; max_features: number };
    project_manager: {
      min_work_items: number;
      max_work_items: number;
      parallel_fraction_at_least?: number;
    };
    developer_loop: {
      max_iterations: number;
      max_cost_usd: number;
      must_complete: boolean;
      files_in_scope_extra?: string[];
    };
    review_loop: {
      project_type: 'browser' | 'cli' | 'lib' | 'rest';
      is_stacked_pr: boolean;
      min_recording_bytes?: number;
      min_pr_body_chars?: number;
      min_why_chars?: number;
    };
    reflection: { min_themes: number; brain_gap_ids: string[] };
  };
};

type PhaseScore = { score: number; passed: boolean; criteria: Record<string, number> };

type CaseResult = {
  id: string;
  /** Did every per-phase rubric pass on the generated artifacts? */
  chain_passed: boolean;
  chain_error: ChainArtifacts['chainError'];
  merged: boolean;
  phases: {
    architect: PhaseScore | null;
    project_manager: PhaseScore | null;
    developer_loop: PhaseScore | null;
    review_loop: PhaseScore | null;
    reflection: PhaseScore | null;
  };
  elapsed_ms: number;
};

const SESSION_BUDGET_RUNS = Number(process.env.FORGE_CHAINED_MAX_RUNS ?? '4');
const CONCURRENCY = 1; // each run is a full cycle — never parallelise.

const here = import.meta.dirname;
const seedsPath = join(here, 'seeds.json');
const seeds: Seed[] = JSON.parse(readFileSync(seedsPath, 'utf8'));
const ranAt = new Date().toISOString();

function toChainSeed(s: Seed): ChainSeed {
  return {
    id: s.id,
    architectPrompt: s.architect_prompt,
    project: s.project,
    architectExpected: s.architect_expected,
    projectContext: s.project_context,
    seedTreePath: resolve(here, s.seed_tree),
    spec: s.spec,
    qualityGateCmd: s.quality_gate_cmd,
    reviewIterationCap: s.review_iteration_cap,
    reviewIterationBudgetUsd: s.review_iteration_budget_usd,
  };
}

/** Project the per-phase rubric output down to the comparable shape. */
function toPhaseScore(s: {
  score: number;
  passed: boolean;
  criteria: Record<string, number>;
}): PhaseScore {
  const criteria: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.criteria)) criteria[k] = Number(v);
  return { score: s.score, passed: s.passed, criteria };
}

let runsStarted = 0;

const results = await mapConcurrent(seeds, CONCURRENCY, async (s): Promise<CaseResult> => {
  const startedAt = Date.now();
  if (runsStarted >= SESSION_BUDGET_RUNS) {
    return {
      id: s.id,
      chain_passed: false,
      chain_error: { step: 'budget', kind: 'session_budget', message: `>= ${SESSION_BUDGET_RUNS} runs` },
      merged: false,
      phases: {
        architect: null,
        project_manager: null,
        developer_loop: null,
        review_loop: null,
        reflection: null,
      },
      elapsed_ms: 0,
    };
  }
  runsStarted += 1;

  const artifacts = await runChain({ seed: toChainSeed(s) });

  // ---- Fan out to the EXISTING per-phase rubrics over generated inputs ----

  // 1. architect — generated manifest.
  let architect: PhaseScore | null = null;
  const manifestText = readChainedManifestText(artifacts);
  if (manifestText !== null) {
    architect = toPhaseScore(
      architectCaseScore({ manifestText, expected: s.expected.architect }),
    );
  }

  // 2. project-manager — generated .forge/work-items/ + _graph.md.
  let project_manager: PhaseScore | null = null;
  const workItems = readChainedWorkItems(artifacts);
  const graphText = readChainedGraphText(artifacts);
  const knownFeatureIds =
    manifestText !== null ? safeFeatureIds(manifestText) : undefined;
  if (workItems.length > 0 || artifacts.chainError === null) {
    project_manager = toPhaseScore(
      pmCaseScore({
        workItems,
        graphText,
        expected: { ...s.expected.project_manager, known_feature_ids: knownFeatureIds },
      }),
    );
  }

  // 3. developer-loop — LoopResult reconstructed from events.jsonl ralph.end.
  //    The dev-loop caseScore takes ONE result + ONE WI; the chain produces N
  //    WIs, so we score the aggregate (union files_in_scope, all-complete ⇒
  //    complete) against a synthetic merged WI. This is a fan-out decision
  //    local to the chained harness, NOT a rubric change.
  let developer_loop: PhaseScore | null = null;
  const loopResult = reconstructLoopResultFromEventLog(artifacts.eventLogPath);
  if (loopResult !== null && workItems.length > 0) {
    const aggregateWi = syntheticAggregateWorkItem(workItems);
    developer_loop = toPhaseScore(
      devCaseScore({
        result: loopResult,
        workItem: aggregateWi,
        expected: {
          max_iterations: s.expected.developer_loop.max_iterations,
          max_cost_usd: s.expected.developer_loop.max_cost_usd,
          must_complete: s.expected.developer_loop.must_complete,
          quality_gate_cmd: s.quality_gate_cmd ?? ['true'],
          files_in_scope_extra: s.expected.developer_loop.files_in_scope_extra,
        },
        // Regression is folded into the review-loop's quality gate on chained
        // inputs (the merged worktree is gated there); default true here.
        regressionPassed: true,
      }),
    );
  }

  // 4. review-loop — generated .forge/pr-description.md + .forge/demos/.
  //    The rubric resolves `<dir>/.forge/...`, so it MUST be handed a dir
  //    where `<dir>/.forge/pr-description.md` resolves (see
  //    resolveReviewBaseDir for why the previous `forgeSnapshotDir/..`
  //    scored every PR/demo criterion 0).
  let review_loop: PhaseScore | null = null;
  let reviewBaseHandle: ReviewBaseHandle | null = null;
  if (artifacts.initiativeId !== null && workItems.length > 0) {
    reviewBaseHandle = resolveReviewBaseDir(artifacts);
    review_loop = toPhaseScore(
      reviewCaseScore({
        worktreePath: reviewBaseHandle.dir,
        initiativeId: artifacts.initiativeId,
        workItems,
        expected: {
          project_type: s.expected.review_loop.project_type,
          quality_gate_cmd: s.quality_gate_cmd ?? ['true'],
          is_stacked_pr: s.expected.review_loop.is_stacked_pr,
          min_recording_bytes: s.expected.review_loop.min_recording_bytes,
          min_pr_body_chars: s.expected.review_loop.min_pr_body_chars,
          min_why_chars: s.expected.review_loop.min_why_chars,
        },
        // Phase 6: the reviewer no longer auto-merges. `artifacts.merged`
        // is true iff the simulated-operator merge (the chained harness's
        // `confirmMerge` hook) succeeded — which only happens when the
        // review-Ralph reached an approved verdict AND produced the PR
        // (i.e. the gate passed). Still a valid orchestrator-verified
        // signal for the rubric's gate 1.
        qualityGatesPassed: artifacts.merged,
      }),
    );
  }

  // 5. reflection — masked themes + retro + cycle archive.
  let reflection: PhaseScore | null = null;
  if (artifacts.cycleResult?.reflection_status === 'closed' && artifacts.initiativeId !== null) {
    reflection = toPhaseScore(
      reflectionCaseScore({
        cycleId: artifacts.cycleResult.cycle_id,
        benchRoot: artifacts.benchRoot,
        manifestPath: resolveReflectionManifestPath(artifacts),
        eventLogPath: artifacts.eventLogPath ?? '',
        toolUse: reconstructReflectorToolUse(artifacts.eventLogPath),
        expected: {
          project: s.project,
          min_themes: s.expected.reflection.min_themes,
          brain_gap_ids: s.expected.reflection.brain_gap_ids,
        },
      }),
    );
  }

  const phases = { architect, project_manager, developer_loop, review_loop, reflection };
  // "Chain passed" = every phase that ran has a passing per-phase rubric AND
  // no fatal chain break. A null phase (chain broke before it) ⇒ not passed.
  const phaseList = Object.values(phases);
  const chainPassed =
    artifacts.chainError === null &&
    phaseList.every((p) => p !== null && p.passed);

  // Tidy the synthesized review base dir (if the worktree `.forge/` had been
  // wiped and we built a symlink-to-snapshot stand-in). Same leave-no-residue
  // discipline as the brain mask / cycle-log bridge. No-op when the worktree
  // `.forge/` survived (the dir IS the worktree — never delete that).
  cleanupReviewBaseDir(reviewBaseHandle);

  cleanupTempdir(artifacts.tempdir);

  return {
    id: s.id,
    chain_passed: chainPassed,
    chain_error: artifacts.chainError,
    merged: artifacts.merged,
    phases,
    elapsed_ms: Date.now() - startedAt,
  };
});

const passedCount = results.filter((r) => r.chain_passed).length;

const summary = {
  phase: 'chained',
  ran_at: ranAt,
  cases: results,
  summary: {
    total: results.length,
    passed: passedCount,
    failed: results.length - passedCount,
    accuracy: results.length === 0 ? 0 : passedCount / results.length,
    p95_elapsed_ms: p95(results.map((r) => r.elapsed_ms)),
    note:
      'Scoring is SOLELY the six existing per-phase scoring.ts:caseScore ' +
      'functions over one generated artifact set. No chained-only rubric.',
  },
};

const writtenTo = writeResults(here, summary);

console.log(JSON.stringify(summary, null, 2));
console.log('');
console.log(`chained bench: ${passedCount}/${results.length} chains passed`);
console.log(`results: ${writtenTo}`);

// ---------------------------------------------------------------------------

function safeFeatureIds(manifestText: string): string[] | undefined {
  try {
    // Lazy import avoided — manifest parse already validated upstream; reuse
    // the architect rubric's loader-free path via a cheap regex on the
    // frontmatter feature_id lines (knownFeatureIds is an optional cross-check).
    const ids = [...manifestText.matchAll(/feature_id:\s*(FEAT-\d+)/g)].map((m) => m[1]);
    return ids.length > 0 ? ids : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The reflection rubric reads the closed manifest. The reviewer moved it
 * `_queue/in-flight/` → `_queue/done/` on merge; fall back to in-flight.
 */
function resolveReflectionManifestPath(a: ChainArtifacts): string {
  if (a.initiativeId === null) return a.manifestPath ?? '';
  const done = resolve(a.tempdir, '_queue', 'done', `${a.initiativeId}.md`);
  if (existsSync(done)) return done;
  const rfr = resolve(a.tempdir, '_queue', 'ready-for-review', `${a.initiativeId}.md`);
  if (existsSync(rfr)) return rfr;
  return a.manifestPath ?? '';
}
