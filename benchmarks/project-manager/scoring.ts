/**
 * Pure scoring functions for the project-manager benchmark. Kept separate
 * from score.ts (the runner) so they're trivially unit-testable without
 * mocking the SDK.
 *
 * S3 refinement (2026-05-20, plan 03 §"Bench redesign"): the old 6-criterion
 * rubric scored 5/5 fixtures at 100% while real cycles still exhibited
 * downstream-breaking decomposition failures the rubric couldn't catch
 * (FEAT-5 hallucination in intersection-backpressure; PM-thrash on stale
 * brain). The new rubric adds:
 *
 *   gate: feature_id_in_manifest
 *       Belt-and-braces for the validator-side knownFeatureIds fix (C5a);
 *       trips → score = 0.
 *
 *   one_creator_per_file (0.12)
 *       At most one WI lists a given path in its `creates` array.
 *       Subsequent WIs `depends_on` the creator. Tightens file-isolation
 *       discipline beyond the existing no_hidden_coupling.
 *
 *   quality_gate_cmd_present (0.10)
 *       When the initiative declares an iteration_budget > 5 (i.e. larger
 *       than the trivially-green range), every WI carries quality_gate_cmd
 *       OR its body explicitly states why the manifest-level gate suffices.
 *       At ≤ 5 iterations the criterion is relaxed.
 *
 *   files_real_or_explicitly_new (0.10)
 *       Every files_in_scope path either exists in the fixture's
 *       project_tree OR appears in the WI's `creates` array. Deterministic,
 *       not NLP-based (council 03 dx flag).
 *
 * Weights rebalanced so structural criteria stay valuable but quality leads:
 *
 *   every_item_has_gwt        0.18  (was 0.25)
 *   no_hidden_coupling        0.15  (was 0.20)
 *   one_creator_per_file      0.12  (new)
 *   quality_gate_cmd_present  0.10  (new)
 *   files_real_or_explicitly_new 0.10 (new)
 *   parallel_fraction_meets   0.10  (was 0.15)
 *   work_item_count_in_range  0.10  (was 0.15)
 *   every_item_lists_scope    0.10  (was 0.15)
 *   graph_emitted_valid       0.05  (was 0.10)
 *
 * Sum = 1.00. Pass threshold 0.7 unchanged. brain_consulted stays
 * unscored (surfaced via toolUseSummary.brainReads).
 */

import {
  detectHiddenCoupling,
  validateWorkItemSet,
  type WorkItem,
} from '../../orchestrator/work-item.ts';

export type PmExpected = {
  /** Inclusive lower bound on work-item count. */
  min_work_items: number;
  /** Inclusive upper bound on work-item count. */
  max_work_items: number;
  /** Minimum fraction (0-1) of work items with empty depends_on. Default 0.3. */
  parallel_fraction_at_least?: number;
  /** Feature IDs known to exist in the parent manifest, for cross-validation. */
  known_feature_ids?: string[];
  /**
   * Initiative's declared iteration_budget. Drives the `quality_gate_cmd_present`
   * criterion: when > 5, every WI must carry a gate OR an explicit
   * manifest-gate-suffices note in its body. ≤ 5 (default) relaxes the criterion.
   */
  iteration_budget?: number;
  /**
   * Set of paths that exist in the fixture's `project_tree`. Drives the
   * `files_real_or_explicitly_new` criterion. When absent (e.g. tests with no
   * tree supplied), the criterion is inactive (defaults to 1).
   */
  project_tree?: Set<string>;
};

export type PmCriteria = {
  /** Gate. 0 ⇒ total score = 0. Absent knownFeatureIds = 1 (inactive). */
  feature_id_in_manifest: number;
  /** Gate. 0 ⇒ total score = 0. */
  work_items_present: number;
  work_item_count_in_range: number;
  every_item_has_gwt: number;
  every_item_lists_scope: number;
  parallel_fraction_meets: number;
  no_hidden_coupling: number;
  one_creator_per_file: number;
  quality_gate_cmd_present: number;
  files_real_or_explicitly_new: number;
  graph_emitted_valid: number;
};

export type PmScore = {
  score: number;
  passed: boolean;
  criteria: PmCriteria;
  set_errors: string[];
  per_item_errors: Record<string, string[]>;
  hidden_coupling_pairs: Array<{ a: string; b: string; sharedFiles: string[] }>;
  work_item_count: number;
  parallel_fraction: number;
};

export const PASS_THRESHOLD = 0.7;

// Weights — must sum to 1.
export const WEIGHT_GWT = 0.18;
export const WEIGHT_NO_COUPLING = 0.15;
export const WEIGHT_ONE_CREATOR = 0.12;
export const WEIGHT_GATE_CMD = 0.10;
export const WEIGHT_FILES_REAL = 0.10;
export const WEIGHT_PARALLEL = 0.10;
export const WEIGHT_COUNT = 0.10;
export const WEIGHT_SCOPE = 0.10;
export const WEIGHT_GRAPH = 0.05;

const DEFAULT_PARALLEL_FRACTION = 0.3;

/**
 * Iteration-budget threshold above which `quality_gate_cmd_present`
 * activates. Decision recorded in S3-DECISIONS.md: tiny initiatives
 * (≤ 5 iterations) don't benefit from per-WI gates — the cost of
 * authoring them outweighs the trivially-green pathology they prevent.
 */
const QUALITY_GATE_BUDGET_THRESHOLD = 5;

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
 * present in the items list.
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

/**
 * GATE — feature_id_in_manifest. Every WI's `feature_id` must appear in
 * the manifest's declared set. Belt-and-braces for the validator-side
 * `knownFeatureIds` fix from C5a. When the fixture didn't supply
 * `known_feature_ids`, the gate is inactive (returns 1).
 */
export function featureIdInManifest(
  items: WorkItem[],
  knownFeatureIds: ReadonlySet<string> | undefined,
): number {
  if (!knownFeatureIds || knownFeatureIds.size === 0) return 1;
  if (items.length === 0) return 0;
  return items.every((i) => knownFeatureIds.has(i.feature_id)) ? 1 : 0;
}

/**
 * one_creator_per_file (0.12). At most one WI per file lists it in
 * `creates`. Subsequent WIs `depends_on` the creator and extend it.
 *
 * Implementation: the `creates` array is the structured marker (C5);
 * absence of an entry in `creates` means the WI extends an existing file
 * (not a violation). The criterion fires only when ≥ 2 WIs list the same
 * file in `creates`.
 */
export function oneCreatorPerFile(items: WorkItem[]): number {
  const creatorCounts = new Map<string, number>();
  for (const item of items) {
    if (!item.creates) continue;
    for (const path of item.creates) {
      creatorCounts.set(path, (creatorCounts.get(path) ?? 0) + 1);
    }
  }
  for (const count of creatorCounts.values()) {
    if (count > 1) return 0;
  }
  return 1;
}

/**
 * quality_gate_cmd_present (0.10). When iteration_budget > 5, every WI
 * must carry `quality_gate_cmd` OR have a body that explicitly states
 * the manifest-level gate suffices. At ≤ 5 the criterion is relaxed.
 *
 * The body-text escape hatch uses a deterministic substring match
 * (`manifest-level gate` / `manifest-gate-suffices`) — no NLP. PM is
 * instructed via the prompt to spell exactly this phrase when it wants
 * to opt out.
 */
export function qualityGateCmdPresent(
  items: WorkItem[],
  iterationBudget: number | undefined,
): number {
  const budget = iterationBudget ?? 0;
  if (budget <= QUALITY_GATE_BUDGET_THRESHOLD) return 1;
  if (items.length === 0) return 0;
  for (const item of items) {
    if (item.quality_gate_cmd && item.quality_gate_cmd.length > 0) continue;
    const bodyLower = item.body.toLowerCase();
    if (
      bodyLower.includes('manifest-level gate') ||
      bodyLower.includes('manifest gate suffices') ||
      bodyLower.includes('manifest-gate-suffices')
    ) {
      continue;
    }
    return 0;
  }
  return 1;
}

/**
 * files_real_or_explicitly_new (0.10). Every `files_in_scope` path on
 * every WI must either (a) exist in the fixture's `project_tree`, OR
 * (b) appear in some WI's `creates` array (the file is new — created by
 * the cycle). Deterministic per C5 — no body-text inference.
 *
 * When no `project_tree` is supplied (e.g. unit tests that don't model
 * a tree), the criterion is inactive and returns 1.
 */
export function filesRealOrExplicitlyNew(
  items: WorkItem[],
  projectTree: ReadonlySet<string> | undefined,
): number {
  if (!projectTree) return 1;
  if (items.length === 0) return 0;
  const creates = new Set<string>();
  for (const item of items) {
    if (!item.creates) continue;
    for (const path of item.creates) creates.add(path);
  }
  for (const item of items) {
    for (const path of item.files_in_scope) {
      if (projectTree.has(path)) continue;
      if (creates.has(path)) continue;
      return 0;
    }
  }
  return 1;
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
  const featureGate = featureIdInManifest(workItems, knownFeatureIds);

  const { perItem, setErrors } = validateWorkItemSet(workItems, { knownFeatureIds });
  const couplingPairs = detectHiddenCoupling(workItems);

  const criteria: PmCriteria = {
    feature_id_in_manifest: featureGate,
    work_items_present: 1,
    work_item_count_in_range: workItemCountInRange(workItems.length, expected),
    every_item_has_gwt: everyItemHasGwt(workItems),
    every_item_lists_scope: everyItemListsScope(workItems),
    parallel_fraction_meets: parallelFractionMeets(workItems, expected),
    no_hidden_coupling: couplingPairs.length === 0 ? 1 : 0,
    one_creator_per_file: oneCreatorPerFile(workItems),
    quality_gate_cmd_present: qualityGateCmdPresent(workItems, expected.iteration_budget),
    files_real_or_explicitly_new: filesRealOrExplicitlyNew(workItems, expected.project_tree),
    graph_emitted_valid: graphEmittedValid(graphText, workItems),
  };

  // GATE: feature_id_in_manifest. If a WI invented a feature_id, the
  // whole score is 0 (mirrors work_items_present and the architect bench's
  // manifest_valid gate).
  if (featureGate === 0) {
    return {
      score: 0,
      passed: false,
      criteria,
      set_errors: setErrors,
      per_item_errors: perItem,
      hidden_coupling_pairs: couplingPairs,
      work_item_count: workItems.length,
      parallel_fraction: parallelFraction(workItems),
    };
  }

  const score =
    WEIGHT_GWT * criteria.every_item_has_gwt +
    WEIGHT_NO_COUPLING * criteria.no_hidden_coupling +
    WEIGHT_ONE_CREATOR * criteria.one_creator_per_file +
    WEIGHT_GATE_CMD * criteria.quality_gate_cmd_present +
    WEIGHT_FILES_REAL * criteria.files_real_or_explicitly_new +
    WEIGHT_PARALLEL * criteria.parallel_fraction_meets +
    WEIGHT_COUNT * criteria.work_item_count_in_range +
    WEIGHT_SCOPE * criteria.every_item_lists_scope +
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
