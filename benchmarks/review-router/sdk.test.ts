/**
 * End-to-end smoke test of the review-router bench harness.
 * Runs all 5 fixtures and asserts the aggregated score is at the pass
 * threshold (deterministic; no LLM).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runRouterBench } from './sdk.ts';
import { PASS_THRESHOLD } from './scoring.ts';

test('review-router bench: all 5 fixtures pass deterministically', async () => {
  const { score, fixtures } = await runRouterBench();
  // Every fixture must pass — the bench is deterministic.
  for (const f of fixtures) {
    assert.ok(f.passed, `fixture ${f.name} failed: ${f.detail}`);
  }
  assert.equal(score.score, 1);
  assert.ok(score.passed);
  assert.ok(score.score >= PASS_THRESHOLD);
});
