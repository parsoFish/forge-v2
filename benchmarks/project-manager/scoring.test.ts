/**
 * Tests for benchmarks/project-manager/scoring.ts. Each criterion verified in
 * isolation against fabricated work-item sets.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  caseScore,
  workItemCountInRange,
  everyItemHasGwt,
  everyItemListsScope,
  parallelFraction,
  parallelFractionMeets,
  noHiddenCoupling,
  graphEmittedValid,
  featureIdInManifest,
  oneCreatorPerFile,
  qualityGateCmdPresent,
  filesRealOrExplicitlyNew,
  PASS_THRESHOLD,
  type PmExpected,
} from './scoring.ts';
import type { WorkItem } from '../../orchestrator/work-item.ts';

function wi(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    work_item_id: 'WI-1',
    feature_id: 'FEAT-1',
    initiative_id: 'INIT-2026-05-08-x',
    status: 'pending',
    depends_on: [],
    acceptance_criteria: [{ given: 'g', when: 'w', then: 't' }],
    files_in_scope: ['src/a.ts'],
    estimated_iterations: 1,
    body: 'rationale',
    ...overrides,
  };
}

const expected: PmExpected = {
  min_work_items: 2,
  max_work_items: 6,
  parallel_fraction_at_least: 0.3,
  known_feature_ids: ['FEAT-1', 'FEAT-2', 'FEAT-3'],
};

test('workItemCountInRange: in range → 1, out → 0', () => {
  assert.equal(workItemCountInRange(3, expected), 1);
  assert.equal(workItemCountInRange(2, expected), 1);
  assert.equal(workItemCountInRange(6, expected), 1);
  assert.equal(workItemCountInRange(1, expected), 0);
  assert.equal(workItemCountInRange(7, expected), 0);
});

test('everyItemHasGwt: all complete triads → 1', () => {
  const items = [wi({ work_item_id: 'WI-1' }), wi({ work_item_id: 'WI-2' })];
  assert.equal(everyItemHasGwt(items), 1);
});

test('everyItemHasGwt: one item with empty when → 0', () => {
  const items = [
    wi({ work_item_id: 'WI-1' }),
    wi({ work_item_id: 'WI-2', acceptance_criteria: [{ given: 'g', when: '', then: 't' }] }),
  ];
  assert.equal(everyItemHasGwt(items), 0);
});

test('everyItemHasGwt: zero items → 0', () => {
  assert.equal(everyItemHasGwt([]), 0);
});

test('everyItemListsScope: all populated → 1', () => {
  const items = [wi({ work_item_id: 'WI-1' }), wi({ work_item_id: 'WI-2', files_in_scope: ['src/b.ts'] })];
  assert.equal(everyItemListsScope(items), 1);
});

test('everyItemListsScope: empty array → 0', () => {
  const items = [wi({ work_item_id: 'WI-1', files_in_scope: [] })];
  assert.equal(everyItemListsScope(items), 0);
});

test('parallelFraction: 2 of 4 independent → 0.5', () => {
  const items = [
    wi({ work_item_id: 'WI-1' }),
    wi({ work_item_id: 'WI-2' }),
    wi({ work_item_id: 'WI-3', depends_on: ['WI-1'] }),
    wi({ work_item_id: 'WI-4', depends_on: ['WI-2'] }),
  ];
  assert.equal(parallelFraction(items), 0.5);
});

test('parallelFractionMeets: meets default 0.3 threshold', () => {
  const items = [
    wi({ work_item_id: 'WI-1' }),
    wi({ work_item_id: 'WI-2', depends_on: ['WI-1'] }),
    wi({ work_item_id: 'WI-3', depends_on: ['WI-1'] }),
  ];
  // 1/3 = 0.33 >= 0.3
  assert.equal(parallelFractionMeets(items, { min_work_items: 1, max_work_items: 5 }), 1);
});

test('parallelFractionMeets: linear chain fails', () => {
  const items = [
    wi({ work_item_id: 'WI-1' }),
    wi({ work_item_id: 'WI-2', depends_on: ['WI-1'] }),
    wi({ work_item_id: 'WI-3', depends_on: ['WI-2'] }),
    wi({ work_item_id: 'WI-4', depends_on: ['WI-3'] }),
  ];
  // 1/4 = 0.25 < 0.3
  assert.equal(parallelFractionMeets(items, { min_work_items: 1, max_work_items: 5, parallel_fraction_at_least: 0.3 }), 0);
});

test('noHiddenCoupling: no shared files → 1', () => {
  const items = [
    wi({ work_item_id: 'WI-1', files_in_scope: ['src/a.ts'] }),
    wi({ work_item_id: 'WI-2', files_in_scope: ['src/b.ts'] }),
  ];
  assert.equal(noHiddenCoupling(items), 1);
});

test('noHiddenCoupling: shared file with no edge → 0', () => {
  const items = [
    wi({ work_item_id: 'WI-1', files_in_scope: ['src/shared.ts'] }),
    wi({ work_item_id: 'WI-2', files_in_scope: ['src/shared.ts'] }),
  ];
  assert.equal(noHiddenCoupling(items), 0);
});

test('graphEmittedValid: missing graph → 0', () => {
  assert.equal(graphEmittedValid(null, [wi()]), 0);
});

test('graphEmittedValid: empty items → 0', () => {
  assert.equal(graphEmittedValid('graph TD\n  WI-1', []), 0);
});

test('graphEmittedValid: missing `graph TD` → 0', () => {
  const items = [wi({ work_item_id: 'WI-1' })];
  assert.equal(graphEmittedValid('flowchart LR\n  WI-1', items), 0);
});

test('graphEmittedValid: every WI mentioned → 1', () => {
  const items = [wi({ work_item_id: 'WI-1' }), wi({ work_item_id: 'WI-2' })];
  const text = '```mermaid\ngraph TD\n  WI-1["one"]\n  WI-2["two"]\n  WI-1 --> WI-2\n```';
  assert.equal(graphEmittedValid(text, items), 1);
});

test('graphEmittedValid: WI mentioned only as substring → 0', () => {
  const items = [wi({ work_item_id: 'WI-1' }), wi({ work_item_id: 'WI-2' })];
  // WI-12 contains WI-1 as a prefix; word-boundary should reject it
  const text = 'graph TD\n  WI-12["only"]';
  assert.equal(graphEmittedValid(text, items), 0);
});

// ----- S3 refinement: new criteria + gate -----

test('featureIdInManifest: all WIs draw from manifest set → 1', () => {
  const items = [
    wi({ work_item_id: 'WI-1', feature_id: 'FEAT-1' }),
    wi({ work_item_id: 'WI-2', feature_id: 'FEAT-2' }),
  ];
  assert.equal(featureIdInManifest(items, new Set(['FEAT-1', 'FEAT-2', 'FEAT-3'])), 1);
});

test('featureIdInManifest: one WI invents FEAT-5 → 0', () => {
  const items = [
    wi({ work_item_id: 'WI-1', feature_id: 'FEAT-1' }),
    wi({ work_item_id: 'WI-2', feature_id: 'FEAT-5' }),
  ];
  assert.equal(featureIdInManifest(items, new Set(['FEAT-1', 'FEAT-2', 'FEAT-3', 'FEAT-4'])), 0);
});

test('featureIdInManifest: missing knownFeatureIds → 1 (gate inactive)', () => {
  const items = [wi({ work_item_id: 'WI-1', feature_id: 'FEAT-99' })];
  assert.equal(featureIdInManifest(items, undefined), 1);
});

test('oneCreatorPerFile: each file claimed by ≤ 1 creator → 1', () => {
  const items = [
    wi({
      work_item_id: 'WI-1',
      files_in_scope: ['src/a.ts'],
      creates: ['src/a.ts'],
    }),
    wi({
      work_item_id: 'WI-2',
      files_in_scope: ['src/b.ts'],
      creates: ['src/b.ts'],
    }),
  ];
  assert.equal(oneCreatorPerFile(items), 1);
});

test('oneCreatorPerFile: two WIs claim the same file in `creates` → 0', () => {
  const items = [
    wi({
      work_item_id: 'WI-1',
      files_in_scope: ['src/shared.ts'],
      creates: ['src/shared.ts'],
    }),
    wi({
      work_item_id: 'WI-2',
      files_in_scope: ['src/shared.ts'],
      creates: ['src/shared.ts'],
    }),
  ];
  assert.equal(oneCreatorPerFile(items), 0);
});

test('oneCreatorPerFile: WI extends an existing file without claiming `creates` → 1', () => {
  const items = [
    wi({
      work_item_id: 'WI-1',
      files_in_scope: ['src/a.ts'],
      creates: ['src/a.ts'],
    }),
    wi({
      work_item_id: 'WI-2',
      files_in_scope: ['src/a.ts'],
      depends_on: ['WI-1'],
    }),
  ];
  assert.equal(oneCreatorPerFile(items), 1);
});

test('qualityGateCmdPresent: iteration_budget ≤ 5 → relaxed (1)', () => {
  const items = [wi({ work_item_id: 'WI-1' }), wi({ work_item_id: 'WI-2' })];
  assert.equal(qualityGateCmdPresent(items, 4), 1);
  assert.equal(qualityGateCmdPresent(items, 5), 1);
});

test('qualityGateCmdPresent: iteration_budget > 5, all WIs carry gate → 1', () => {
  const items = [
    wi({ work_item_id: 'WI-1', quality_gate_cmd: ['npm', 'test', '--', 'tests/a.test.ts'] }),
    wi({ work_item_id: 'WI-2', quality_gate_cmd: ['npm', 'test', '--', 'tests/b.test.ts'] }),
  ];
  assert.equal(qualityGateCmdPresent(items, 8), 1);
});

test('qualityGateCmdPresent: iteration_budget > 5, one WI bare → 0', () => {
  const items = [
    wi({ work_item_id: 'WI-1', quality_gate_cmd: ['npm', 'test', '--', 'tests/a.test.ts'] }),
    wi({ work_item_id: 'WI-2' }),
  ];
  assert.equal(qualityGateCmdPresent(items, 8), 0);
});

test('qualityGateCmdPresent: iteration_budget > 5, body declares manifest-gate-suffices → 1', () => {
  const items = [
    wi({
      work_item_id: 'WI-1',
      quality_gate_cmd: ['npm', 'test'],
    }),
    wi({
      work_item_id: 'WI-2',
      body: 'Trivial WI; the manifest-level gate suffices for this work — no per-WI override needed.',
    }),
  ];
  assert.equal(qualityGateCmdPresent(items, 8), 1);
});

test('filesRealOrExplicitlyNew: every files_in_scope path exists on disk → 1', () => {
  const items = [
    wi({
      work_item_id: 'WI-1',
      files_in_scope: ['src/handler.ts', 'tests/handler.test.ts'],
    }),
  ];
  const projectTree = new Set(['src/handler.ts', 'tests/handler.test.ts', 'package.json']);
  assert.equal(filesRealOrExplicitlyNew(items, projectTree), 1);
});

test('filesRealOrExplicitlyNew: missing path is OK iff WI lists it in `creates` → 1', () => {
  const items = [
    wi({
      work_item_id: 'WI-1',
      files_in_scope: ['src/new.ts'],
      creates: ['src/new.ts'],
    }),
  ];
  const projectTree = new Set(['package.json']);
  assert.equal(filesRealOrExplicitlyNew(items, projectTree), 1);
});

test('filesRealOrExplicitlyNew: phantom path not in tree and not in `creates` → 0', () => {
  const items = [
    wi({
      work_item_id: 'WI-1',
      files_in_scope: ['src/imaginary.ts'],
    }),
  ];
  const projectTree = new Set(['src/real.ts']);
  assert.equal(filesRealOrExplicitlyNew(items, projectTree), 0);
});

test('filesRealOrExplicitlyNew: no project tree supplied → 1 (criterion inactive)', () => {
  const items = [wi({ work_item_id: 'WI-1', files_in_scope: ['anything.ts'] })];
  assert.equal(filesRealOrExplicitlyNew(items, undefined), 1);
});

// ----- caseScore-level regression tests -----

test('caseScore: zero work items → 0 score, gate trips', () => {
  const score = caseScore({ workItems: [], graphText: null, expected });
  assert.equal(score.score, 0);
  assert.equal(score.passed, false);
  assert.equal(score.criteria.work_items_present, 0);
});

test('caseScore: perfect set → score 1, passed', () => {
  const items = [
    wi({ work_item_id: 'WI-1', files_in_scope: ['src/a.ts'] }),
    wi({ work_item_id: 'WI-2', files_in_scope: ['src/b.ts'] }),
    wi({ work_item_id: 'WI-3', depends_on: ['WI-1'], files_in_scope: ['src/c.ts'] }),
  ];
  const graph = 'graph TD\n  WI-1["a"]\n  WI-2["b"]\n  WI-3["c"]\n  WI-1 --> WI-3';
  const score = caseScore({ workItems: items, graphText: graph, expected });
  assert.equal(score.criteria.every_item_has_gwt, 1);
  assert.equal(score.criteria.no_hidden_coupling, 1);
  assert.equal(score.criteria.work_item_count_in_range, 1);
  assert.equal(score.criteria.every_item_lists_scope, 1);
  assert.equal(score.criteria.parallel_fraction_meets, 1);
  assert.equal(score.criteria.graph_emitted_valid, 1);
  assert.ok(Math.abs(score.score - 1) < 1e-9, `expected ~1, got ${score.score}`);
  assert.equal(score.passed, true);
});

test('caseScore: missing graph drops score below threshold? (verify weighting)', () => {
  // Perfect everything except graph: 1 - 0.05 = 0.95, still passes (>= 0.7).
  // Weight rebalance per S3 refinement: graph went from 0.10 → 0.05.
  const items = [
    wi({ work_item_id: 'WI-1', files_in_scope: ['src/a.ts'] }),
    wi({ work_item_id: 'WI-2', files_in_scope: ['src/b.ts'] }),
  ];
  const score = caseScore({ workItems: items, graphText: null, expected });
  assert.equal(score.criteria.graph_emitted_valid, 0);
  assert.ok(Math.abs(score.score - 0.95) < 1e-9, `expected 0.95, got ${score.score}`);
  assert.equal(score.passed, true);
});

test('caseScore: vague criteria + bad count + bad parallel fails the bench', () => {
  // Under the S3 weights, lose GWT (0.18) + count (0.10) + parallel (0.10)
  // + graph (0.05) = 0.43 lost ⇒ 0.57 < 0.7. The first three are
  // realistically-correlated failures (one WI with vague AC, out of count
  // range, no parallel slack), so the case is plausible — not a
  // contrived weight-puzzle.
  const items = [
    wi({
      work_item_id: 'WI-1',
      acceptance_criteria: [{ given: 'g', when: '', then: 't' }],
      files_in_scope: ['src/a.ts'],
    }),
  ];
  const score = caseScore({ workItems: items, graphText: null, expected });
  assert.equal(score.criteria.every_item_has_gwt, 0);
  assert.equal(score.criteria.work_item_count_in_range, 0);
  assert.ok(score.score < PASS_THRESHOLD, `expected < ${PASS_THRESHOLD}, got ${score.score}`);
  assert.equal(score.passed, false);
});

// ----- Regression-detection test: the intersection-backpressure FEAT-5
// snapshot must score < 0.7 under the new rubric (the case the old
// 6-criterion rubric let through at 100%). -----

test('caseScore: intersection-backpressure-style 8 WIs incl. FEAT-5 hallucination → fails (gate)', () => {
  // Synthetic replay of the documented 2026-05-18 intersection-backpressure
  // cycle (8 WIs from a 4-feature manifest, WI-8 invents FEAT-5). The
  // feature_id_in_manifest gate trips ⇒ score = 0 regardless of the
  // structural goodness of WI-1..7.
  const manifestFeatures = new Set(['FEAT-1', 'FEAT-2', 'FEAT-3', 'FEAT-4']);
  const items: WorkItem[] = [];
  for (let n = 1; n <= 7; n++) {
    items.push(
      wi({
        work_item_id: `WI-${n}`,
        feature_id: `FEAT-${((n - 1) % 4) + 1}`,
        files_in_scope: [`src/m${n}.ts`],
        depends_on: n > 4 ? [`WI-${n - 4}`] : [],
      }),
    );
  }
  items.push(
    wi({
      work_item_id: 'WI-8',
      feature_id: 'FEAT-5', // hallucinated
      files_in_scope: ['src/m8.ts'],
    }),
  );
  const graph = [
    'graph TD',
    ...items.map((i) => `  ${i.work_item_id}["x"]`),
  ].join('\n');
  const expectedFor8 = {
    min_work_items: 4,
    max_work_items: 8,
    parallel_fraction_at_least: 0.25,
    known_feature_ids: [...manifestFeatures],
  };
  const score = caseScore({ workItems: items, graphText: graph, expected: expectedFor8 });
  assert.equal(score.criteria.feature_id_in_manifest, 0, 'gate must trip on FEAT-5');
  assert.ok(score.score < PASS_THRESHOLD, `expected < ${PASS_THRESHOLD}, got ${score.score}`);
  assert.equal(score.passed, false);
});

test('caseScore: hidden coupling reported in output', () => {
  const items = [
    wi({ work_item_id: 'WI-1', files_in_scope: ['src/shared.ts'] }),
    wi({ work_item_id: 'WI-2', files_in_scope: ['src/shared.ts'] }),
  ];
  const graph = 'graph TD\n  WI-1["a"]\n  WI-2["b"]';
  const score = caseScore({ workItems: items, graphText: graph, expected });
  assert.equal(score.criteria.no_hidden_coupling, 0);
  assert.equal(score.hidden_coupling_pairs.length, 1);
});
