/**
 * Tests for the review-router bench scoring layer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  caseScore,
  emptyCriteria,
  PASS_THRESHOLD,
  WEIGHT_PER_CRITERION,
  type RouterCriteria,
} from './scoring.ts';

function all(value: 0 | 1): RouterCriteria {
  return {
    terminated_cleanly: value,
    send_back_triggers_unifier_reactivation: value,
    approval_triggers_merge_confirm: value,
    cursor_dedup_no_double_send_back: value,
    request_changes_threading_preserved: value,
    fallback_to_file_verdict_when_no_pr: value,
  };
}

test('caseScore: all 1s → score 1.0 passes', () => {
  const s = caseScore(all(1));
  assert.equal(s.score, 1);
  assert.ok(s.passed);
});

test('caseScore: terminated_cleanly = 0 → score 0 fails (gate)', () => {
  const s = caseScore({ ...all(1), terminated_cleanly: 0 });
  assert.equal(s.score, 0);
  assert.ok(!s.passed);
});

test('caseScore: 4/5 passes (0.8 ≥ 0.7)', () => {
  const c = all(1);
  c.fallback_to_file_verdict_when_no_pr = 0;
  const s = caseScore(c);
  assert.equal(Math.round(s.score * 10) / 10, 0.8);
  assert.ok(s.passed);
});

test('caseScore: 3/5 fails (0.6 < 0.7)', () => {
  const c = all(1);
  c.fallback_to_file_verdict_when_no_pr = 0;
  c.cursor_dedup_no_double_send_back = 0;
  const s = caseScore(c);
  assert.ok(!s.passed);
  assert.ok(s.score < PASS_THRESHOLD);
});

test('weights sum to 1 across the 5 criteria', () => {
  assert.equal(WEIGHT_PER_CRITERION * 5, 1);
});

test('emptyCriteria: all 0s', () => {
  const c = emptyCriteria();
  assert.equal(c.terminated_cleanly, 0);
  assert.equal(c.send_back_triggers_unifier_reactivation, 0);
});
