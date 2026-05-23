// FROZEN SNAPSHOT (C10a) — pinned to commit 9585fba. Update explicitly when PM-bench shape changes; do not edit incidentally.
//
// This is a literal copy of benchmarks/project-manager/scoring.ts as it stood
// at commit 9585fba (post-S0+S1+S2A merges, pre-S3 PM refinement). It is the
// scoring rubric the architect bench's `downstream_pm_score` criterion calls.
// The pin prevents PM-bench iteration from perturbing architect-bench scores
// (per CONTRACTS.md C10a, plan 02 §"Benchmark regrounding"). When the PM
// bench's shape changes intentionally, regenerate this snapshot by re-copying
// scoring.ts and bumping the commit SHA above.

/**
 * Pure scoring functions for the project-manager benchmark. Kept separate
 * from score.ts (the runner) so they're trivially unit-testable without
 * mocking the SDK.
 *
 * Per ADR 015 + docs/phases/project-manager.md + benchmarks/project-manager/README.md:
 *   work_items_present is a gate. If 0, total score = 0 (mirrors the
 *   manifest_valid gate in the architect bench). Otherwise a weighted
 *   average over six rubric criteria.
 *
 * Why these dimensions and weights:
 *
 *   gate: work_items_present
 *       If the agent produced no work items, no quality dimension matters.
 *       Mirrors brain's hallucinated-path gate and architect's manifest_valid.
 *
 *   every_item_has_gwt   (0.25)
 *       Each work item must have ≥1 acceptance_criterion with non-empty
 *       given/when/then. Highest weight: vague criteria are the failure mode
 *       that propagates downstream and breaks the developer loop
 *       (docs/phases/project-manager.md:58).
 *
 *   no_hidden_coupling   (0.20)
 *       Work items touching the same file but not transitively connected by
 *       depends_on are merge-time conflicts waiting to happen. PM's last-step
 *       self-check from the SKILL.md process step 5.
 *
 *   work_item_count_in_range (0.15)
 *       Catches under-decomposition (one giant WI) and over-decomposition
 *       (50 WIs for a 3-day feature). Both failure modes called out in the
 *       phase doc.
 *
 *   every_item_lists_scope (0.15)
 *       Empty files_in_scope means the scope-sprawl protection breaks; the
 *       developer loop won't know what's in or out.
 *
 *   parallel_fraction_meets (0.15)
 *       At least 30% (default) of work items have empty depends_on. Linear
 *       chains kill parallel-cycle throughput; flagged as a pattern in
 *       docs/phases/project-manager.md:44.
 *
 *   graph_emitted_valid (0.10)
 *       _graph.md exists, contains `graph TD`, and references every WI as a
 *       node. Drift from depends_on is a bug; one WI missing from the graph
 *       is the cheapest tell.
 *
 * brain_consulted is intentionally NOT a scored criterion in this first pass.
 * The architect bench surfaces it via "body cites a brain/ path"; PM bodies
 * are work-item specs (where citing the brain in every WI is unnatural). We
 * surface brain consultation via toolUseSummary.brainReads in the result JSON
 * for inspection and add it as a scored criterion only if the bench plateaus
 * and we need to disambiguate "PM skipped step 1" from "PM did step 1 badly".
 */

import { detectHiddenCoupling, validateWorkItemSet, type WorkItem } from '../../orchestrator/work-item.ts';

export type PmExpected = {
  /** Inclusive lower bound on work-item count. */
  min_work_items: number;
  /** Inclusive upper bound on work-item count. */
  max_work_items: number;
  /** Minimum fraction (0-1) of work items with empty depends_on. Default 0.3. */
  parallel_fraction_at_least?: number;
  /** Feature IDs known to exist in the parent manifest, for cross-validation. */
  known_feature_ids?: string[];
};

export type PmCriteria = {
  work_items_present: number;             // gate, 0 or 1
  work_item_count_in_range: number;       // 0 or 1
  every_item_has_gwt: number;             // 0 or 1
  every_item_lists_scope: number;         // 0 or 1
  parallel_fraction_meets: number;        // 0 or 1
  no_hidden_coupling: number;             // 0 or 1
  graph_emitted_valid: number;            // 0 or 1
};

export type PmScore = {
  score: number;                          // weighted in [0, 1]
  passed: boolean;                        // score >= PASS_THRESHOLD
  criteria: PmCriteria;
  set_errors: string[];                   // duplicates / cycles
  per_item_errors: Record<string, string[]>;
  hidden_coupling_pairs: Array<{ a: string; b: string; sharedFiles: string[] }>;
  work_item_count: number;
  parallel_fraction: number;
};

export const PASS_THRESHOLD = 0.7;

// Weights — must sum to 1.
export const WEIGHT_GWT = 0.25;
export const WEIGHT_NO_COUPLING = 0.20;
export const WEIGHT_COUNT = 0.15;
export const WEIGHT_SCOPE = 0.15;
export const WEIGHT_PARALLEL = 0.15;
export const WEIGHT_GRAPH = 0.10;

const DEFAULT_PARALLEL_FRACTION = 0.3;

export function workItemCountInRange(count: number, expected: PmExpected): number {
  return count >= expected.min_work_items && count <= expected.max_work_items ? 1 : 0;
}

export function everyItemHasGwt(items: WorkItem[]): number {
  if (items.length === 0) return 0;
  for (const item of items) {
    if (item.acceptance_criteria.length === 0) return 0;
    const ok = item.acceptance_criteria.every(
      (c) => c.given.trim() !== '' && c.when.trim() !== '' && c.then.trim() !== '',
    );
    if (!ok) return 0;
  }
  return 1;
}

export function everyItemListsScope(items: WorkItem[]): number {
  if (items.length === 0) return 0;
  return items.every((i) => i.files_in_scope.length > 0 && i.files_in_scope.every((f) => f.trim() !== ''))
    ? 1
    : 0;
}

export function parallelFraction(items: WorkItem[]): number {
  if (items.length === 0) return 0;
  const independent = items.filter((i) => i.depends_on.length === 0).length;
  return independent / items.length;
}

export function parallelFractionMeets(items: WorkItem[], expected: PmExpected): number {
  const threshold = expected.parallel_fraction_at_least ?? DEFAULT_PARALLEL_FRACTION;
  return parallelFraction(items) >= threshold ? 1 : 0;
}

export function noHiddenCoupling(items: WorkItem[]): number {
  return detectHiddenCoupling(items).length === 0 ? 1 : 0;
}

/**
 * Graph validity: must contain a `graph TD` directive AND name every WI ID
 * present in the items list. Edge agreement vs depends_on is checked
 * separately so we can report partial credit later if needed; for now,
 * any unmentioned WI fails the criterion.
 */
export function graphEmittedValid(graphText: string | null, items: WorkItem[]): number {
  if (graphText === null) return 0;
  if (items.length === 0) return 0;
  if (!/\bgraph\s+TD\b/i.test(graphText)) return 0;
  for (const item of items) {
    const tokenRe = new RegExp(`\\b${escapeRegex(item.work_item_id)}\\b`);
    if (!tokenRe.test(graphText)) return 0;
  }
  return 1;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type CaseScoreInput = {
  workItems: WorkItem[];
  graphText: string | null;
  expected: PmExpected;
};

export function caseScore(input: CaseScoreInput): PmScore {
  const { workItems, graphText, expected } = input;
  const work_items_present = workItems.length > 0 ? 1 : 0;

  if (work_items_present === 0) {
    return {
      score: 0,
      passed: false,
      criteria: emptyCriteria(),
      set_errors: ['no work items emitted'],
      per_item_errors: {},
      hidden_coupling_pairs: [],
      work_item_count: 0,
      parallel_fraction: 0,
    };
  }

  const knownFeatureIds = expected.known_feature_ids
    ? new Set(expected.known_feature_ids)
    : undefined;
  const { perItem, setErrors } = validateWorkItemSet(workItems, { knownFeatureIds });
  const couplingPairs = detectHiddenCoupling(workItems);

  const criteria: PmCriteria = {
    work_items_present: 1,
    work_item_count_in_range: workItemCountInRange(workItems.length, expected),
    every_item_has_gwt: everyItemHasGwt(workItems),
    every_item_lists_scope: everyItemListsScope(workItems),
    parallel_fraction_meets: parallelFractionMeets(workItems, expected),
    no_hidden_coupling: couplingPairs.length === 0 ? 1 : 0,
    graph_emitted_valid: graphEmittedValid(graphText, workItems),
  };

  const score =
    WEIGHT_GWT * criteria.every_item_has_gwt +
    WEIGHT_NO_COUPLING * criteria.no_hidden_coupling +
    WEIGHT_COUNT * criteria.work_item_count_in_range +
    WEIGHT_SCOPE * criteria.every_item_lists_scope +
    WEIGHT_PARALLEL * criteria.parallel_fraction_meets +
    WEIGHT_GRAPH * criteria.graph_emitted_valid;

  return {
    score,
    passed: score >= PASS_THRESHOLD,
    criteria,
    set_errors: setErrors,
    per_item_errors: perItem,
    hidden_coupling_pairs: couplingPairs,
    work_item_count: workItems.length,
    parallel_fraction: parallelFraction(workItems),
  };
}

function emptyCriteria(): PmCriteria {
  return {
    work_items_present: 0,
    work_item_count_in_range: 0,
    every_item_has_gwt: 0,
    every_item_lists_scope: 0,
    parallel_fraction_meets: 0,
    no_hidden_coupling: 0,
    graph_emitted_valid: 0,
  };
}
