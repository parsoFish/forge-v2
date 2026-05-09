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

const expected: PmExpected = { min_work_items: 2, max_work_items: 6, parallel_fraction_at_least: 0.3 };

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
  assert.equal(score.score, 1);
  assert.equal(score.passed, true);
});

test('caseScore: missing graph drops score below threshold? (verify weighting)', () => {
  // Perfect everything except graph: 1 - 0.10 = 0.90, still passes (0.90 >= 0.7)
  const items = [
    wi({ work_item_id: 'WI-1', files_in_scope: ['src/a.ts'] }),
    wi({ work_item_id: 'WI-2', files_in_scope: ['src/b.ts'] }),
  ];
  const score = caseScore({ workItems: items, graphText: null, expected });
  assert.equal(score.criteria.graph_emitted_valid, 0);
  assert.ok(Math.abs(score.score - 0.90) < 1e-9, `expected 0.90, got ${score.score}`);
  assert.equal(score.passed, true);
});

test('caseScore: vague criteria fails the bench', () => {
  // Lose every_item_has_gwt (0.25) AND no_hidden_coupling? No — only GWT.
  // 1.0 - 0.25 = 0.75 — still passes. Make it lose more to fail.
  // Lose GWT (0.25) + count (0.15) = 0.60 < 0.7 → fails
  const items = [
    wi({ work_item_id: 'WI-1', acceptance_criteria: [{ given: 'g', when: '', then: 't' }], files_in_scope: ['src/a.ts'] }),
  ];
  const graph = 'graph TD\n  WI-1["a"]';
  const score = caseScore({ workItems: items, graphText: graph, expected });
  assert.equal(score.criteria.every_item_has_gwt, 0);
  assert.equal(score.criteria.work_item_count_in_range, 0);
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
