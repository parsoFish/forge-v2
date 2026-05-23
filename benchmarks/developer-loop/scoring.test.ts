/**
 * Unit tests for benchmarks/developer-loop/scoring.ts. Pure functions only —
 * no SDK, no shells, no tempdirs.
 *
 * S4 changes per CONTRACTS.md C19: `cost_budget_respected` removed; weights
 * redistributed. The `cost_budget_respected` test is gone; the
 * `cost-overrun` test repurposed to verify the criterion no longer exists.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  caseScore,
  filesInScopeRespected,
  iterationBudgetRespected,
  loopCompleted,
  PASS_THRESHOLD,
  unifierCaseScore,
  WEIGHT_COMPLETED,
  WEIGHT_FILES_IN_SCOPE,
  WEIGHT_ITERATIONS,
  WEIGHT_NO_REGRESSION,
  UNIFIER_WEIGHT_BRANCHES_IN_SYNC,
  UNIFIER_WEIGHT_DEMO_PRESENT,
  UNIFIER_WEIGHT_DEMO_RUNS_CLEAN,
  UNIFIER_WEIGHT_INITIATIVE_GATE,
  UNIFIER_WEIGHT_PR_SELF_CONTAINED,
  type DevExpected,
  type UnifierExpected,
  type UnifierObservations,
} from './scoring.ts';
import type { LoopResult } from '../../loops/ralph/runner.ts';
import type { WorkItem } from '../../orchestrator/work-item.ts';

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    work_item_id: 'WI-1',
    feature_id: 'FEAT-1',
    initiative_id: 'INIT-2026-05-09-test',
    status: 'pending',
    depends_on: [],
    acceptance_criteria: [{ given: 'g', when: 'w', then: 't' }],
    files_in_scope: ['src/foo.ts'],
    estimated_iterations: 2,
    body: '',
    ...overrides,
  };
}

function loopResult(overrides: Partial<LoopResult> = {}): LoopResult {
  return {
    status: 'complete',
    iterations: 2,
    cost_usd: 0.15,
    duration_ms: 1000,
    artifacts: { agentMdPath: '/tmp/a', fixPlanPath: '/tmp/p' },
    filesChanged: ['src/foo.ts'],
    stop_reason: 'quality-gates-pass',
    ...overrides,
  };
}

function expected(overrides: Partial<DevExpected> = {}): DevExpected {
  return {
    max_iterations: 3,
    must_complete: true,
    quality_gate_cmd: ['npm', 'test'],
    files_in_scope_extra: ['tests/foo.test.ts'],
    ...overrides,
  };
}

test('caseScore: ideal run scores 1.0 and passes', () => {
  const score = caseScore({
    result: loopResult(),
    workItem: workItem(),
    expected: expected(),
    regressionPassed: true,
  });
  assert.equal(score.score, 1);
  assert.ok(score.passed);
  assert.deepEqual(score.criteria, {
    terminated_cleanly: 1,
    loop_completed: 1,
    iteration_budget_respected: 1,
    files_in_scope_respected: 1,
    no_regression: 1,
  });
});

test('caseScore: crashed run scores 0 and fails the gate', () => {
  const score = caseScore({
    result: null,
    errorMessage: 'spawn ENOENT',
    workItem: workItem(),
    expected: expected(),
    regressionPassed: true,
  });
  assert.equal(score.score, 0);
  assert.ok(!score.passed);
  assert.equal(score.criteria.terminated_cleanly, 0);
  assert.equal(score.status, 'crashed');
});

test('caseScore: failed run (over iteration budget) loses iteration weight only', () => {
  const score = caseScore({
    result: loopResult({ status: 'failed', iterations: 5, stop_reason: 'iteration-budget' }),
    workItem: workItem(),
    expected: expected({ max_iterations: 3 }),
    regressionPassed: true,
  });
  // loses loop_completed (0.40) AND iteration_budget_respected (0.25)
  const want = WEIGHT_FILES_IN_SCOPE + WEIGHT_NO_REGRESSION;
  assert.equal(round3(score.score), round3(want));
  assert.equal(score.criteria.loop_completed, 0);
  assert.equal(score.criteria.iteration_budget_respected, 0);
});

test('caseScore (S4): no cost criterion — high cost does not affect the score', () => {
  // Per CONTRACTS.md C19 the cost_budget_respected criterion was removed.
  // A run that would have failed cost in the old rubric now scores 1.0.
  const score = caseScore({
    result: loopResult({ cost_usd: 999 }),
    workItem: workItem(),
    expected: expected({ max_cost_usd: 0.30 }),
    regressionPassed: true,
  });
  assert.equal(score.score, 1);
  // The criteria object should not contain a cost_budget_respected field.
  assert.equal((score.criteria as Record<string, unknown>).cost_budget_respected, undefined);
});

test('caseScore: out-of-scope file modification loses scope weight', () => {
  const score = caseScore({
    result: loopResult({ filesChanged: ['src/foo.ts', 'src/secret-config.ts'] }),
    workItem: workItem({ files_in_scope: ['src/foo.ts'] }),
    expected: expected({ files_in_scope_extra: [] }),
    regressionPassed: true,
  });
  const want = 1 - WEIGHT_FILES_IN_SCOPE;
  assert.equal(round3(score.score), round3(want));
  assert.equal(score.criteria.files_in_scope_respected, 0);
  assert.deepEqual(score.out_of_scope_files, ['src/secret-config.ts']);
});

test('caseScore: regression failure loses no_regression weight only', () => {
  const score = caseScore({
    result: loopResult(),
    workItem: workItem(),
    expected: expected(),
    regressionPassed: false,
  });
  const want = 1 - WEIGHT_NO_REGRESSION;
  assert.equal(round3(score.score), round3(want));
  assert.equal(score.criteria.no_regression, 0);
});

test('filesInScopeRespected: Ralph workspace artifacts are not counted as out-of-scope', () => {
  const r = filesInScopeRespected(
    loopResult({
      filesChanged: [
        'src/foo.ts',
        'AGENT.md',
        'fix_plan.md',
        'PROMPT.md',
        '.forge/work-items/WI-1.md',
      ],
    }),
    workItem({ files_in_scope: ['src/foo.ts'] }),
    expected({ files_in_scope_extra: [] }),
  );
  assert.equal(r.value, 1);
  assert.deepEqual(r.outOfScope, []);
});

test('filesInScopeRespected (S4): tracked demo/<id>/ paths are exempt (unifier owns them)', () => {
  const r = filesInScopeRespected(
    loopResult({
      filesChanged: ['src/foo.ts', 'demo/INIT-x/DEMO.md', 'demo/INIT-x/screenshot.png'],
    }),
    workItem({ files_in_scope: ['src/foo.ts'] }),
    expected({ files_in_scope_extra: [] }),
  );
  assert.equal(r.value, 1);
  assert.deepEqual(r.outOfScope, []);
});

test('filesInScopeRespected: source files outside scope are still flagged', () => {
  const r = filesInScopeRespected(
    loopResult({ filesChanged: ['src/foo.ts', 'src/secret.ts', 'AGENT.md'] }),
    workItem({ files_in_scope: ['src/foo.ts'] }),
    expected({ files_in_scope_extra: [] }),
  );
  assert.equal(r.value, 0);
  assert.deepEqual(r.outOfScope, ['src/secret.ts']);
});

test('individual criterion helpers handle null result', () => {
  assert.equal(loopCompleted(null), 0);
  assert.equal(iterationBudgetRespected(null, expected()), 0);
  const r = filesInScopeRespected(null, workItem(), expected());
  assert.equal(r.value, 0);
  assert.deepEqual(r.outOfScope, []);
});

test('weights sum to 1 (S4 redistributed: 0.40 + 0.25 + 0.20 + 0.15)', () => {
  const sum = WEIGHT_COMPLETED + WEIGHT_ITERATIONS + WEIGHT_FILES_IN_SCOPE + WEIGHT_NO_REGRESSION;
  assert.equal(round3(sum), 1);
});

test('caseScore: PASS_THRESHOLD 0.7 is the gate (post-S4 redistribution)', () => {
  // Loop completed + iterations + scope = 0.40 + 0.25 + 0.20 = 0.85 — still passes.
  const partial = caseScore({
    result: loopResult(),
    workItem: workItem(),
    expected: expected(),
    regressionPassed: false,
  });
  assert.ok(partial.score >= PASS_THRESHOLD, `${partial.score} >= ${PASS_THRESHOLD}`);

  // Drop loop_completed (heaviest at 0.40) → 0.60, fails.
  const dropCompleted = caseScore({
    result: loopResult({ status: 'failed', stop_reason: 'iteration-budget' }),
    workItem: workItem(),
    expected: expected(),
    regressionPassed: true,
  });
  assert.ok(dropCompleted.score < PASS_THRESHOLD, `${dropCompleted.score} < ${PASS_THRESHOLD}`);
});

// ---------------------------------------------------------------------------
// unifierCaseScore
// ---------------------------------------------------------------------------

function unifierExpected(overrides: Partial<UnifierExpected> = {}): UnifierExpected {
  return {
    max_iterations: 3,
    demo_shape: 'browser',
    demo_command: ['npx', 'playwright', 'test', '--reporter=list'],
    demo_artifact_glob: 'demo/INIT-*/*.{png,webm,md}',
    ...overrides,
  };
}

function unifierObs(overrides: Partial<UnifierObservations> = {}): UnifierObservations {
  return {
    terminated_cleanly: true,
    initiative_gate_passed: true,
    demo_present: true,
    demo_runs_clean: true,
    pr_self_contained: true,
    branches_in_sync: true,
    iterations: 2,
    ...overrides,
  };
}

test('unifierCaseScore: ideal observations score 1.0 and pass', () => {
  const s = unifierCaseScore(unifierObs(), unifierExpected());
  assert.equal(s.score, 1);
  assert.ok(s.passed);
});

test('unifierCaseScore: terminated_cleanly false → score 0, gate failed', () => {
  const s = unifierCaseScore(unifierObs({ terminated_cleanly: false }), unifierExpected());
  assert.equal(s.score, 0);
  assert.ok(!s.passed);
  assert.equal(s.criteria.unifier_terminated_cleanly, 0);
});

test('unifierCaseScore: shape "none" excuses demo_runs_clean (criterion forced to 1)', () => {
  // demo_runs_clean would be false in obs, but shape: "none" excuses it.
  const s = unifierCaseScore(
    unifierObs({ demo_runs_clean: false }),
    unifierExpected({ demo_shape: 'none' }),
  );
  assert.equal(s.criteria.demo_runs_clean, 1);
  assert.equal(s.score, 1);
});

test('unifierCaseScore: shape != "none" honours demo_runs_clean falsy', () => {
  const s = unifierCaseScore(
    unifierObs({ demo_runs_clean: false }),
    unifierExpected({ demo_shape: 'harness' }),
  );
  assert.equal(s.criteria.demo_runs_clean, 0);
  assert.equal(round3(s.score), round3(1 - UNIFIER_WEIGHT_DEMO_RUNS_CLEAN));
});

test('unifierCaseScore: initiative gate failure dominates score', () => {
  const s = unifierCaseScore(
    unifierObs({ initiative_gate_passed: false }),
    unifierExpected(),
  );
  assert.equal(s.criteria.initiative_gate_passed, 0);
  assert.equal(round3(s.score), round3(1 - UNIFIER_WEIGHT_INITIATIVE_GATE));
});

test('unifierCaseScore: NO cost criterion per CONTRACTS.md C19', () => {
  // No `cost_within_unifier_budget` field exists.
  const s = unifierCaseScore(unifierObs(), unifierExpected());
  assert.equal((s.criteria as Record<string, unknown>).cost_within_unifier_budget, undefined);
});

test('unifierCaseScore weights sum to 1', () => {
  const sum =
    UNIFIER_WEIGHT_INITIATIVE_GATE +
    UNIFIER_WEIGHT_DEMO_PRESENT +
    UNIFIER_WEIGHT_DEMO_RUNS_CLEAN +
    UNIFIER_WEIGHT_PR_SELF_CONTAINED +
    UNIFIER_WEIGHT_BRANCHES_IN_SYNC;
  assert.equal(round3(sum), 1);
});

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
