/**
 * Focused tests for the quality-gate command builder added in F-04.
 * Other stop-conditions logic is covered indirectly by the runner tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkStopConditions,
  makeQualityGateFromCmd,
  type LoopState,
  type StopCondition,
} from './stop-conditions.ts';
import { RALPH_SCRATCH_PATHS } from './runner.ts';

test('makeQualityGateFromCmd: returns true when command exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-qg-'));
  try {
    const gate = makeQualityGateFromCmd(dir, ['true']);
    assert.equal(gate(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeQualityGateFromCmd: returns false when command exits non-zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-qg-'));
  try {
    const gate = makeQualityGateFromCmd(dir, ['false']);
    assert.equal(gate(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeQualityGateFromCmd: returns false when binary is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-qg-'));
  try {
    const gate = makeQualityGateFromCmd(dir, ['this-binary-definitely-does-not-exist-99999']);
    assert.equal(gate(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeQualityGateFromCmd: returns false on empty command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-qg-'));
  try {
    const gate = makeQualityGateFromCmd(dir, []);
    assert.equal(gate(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeQualityGateFromCmd: passes additional args through', () => {
  // `sh -c "exit 7"` exits 7 — a non-zero we can be sure is from our command,
  // not a missing binary. Verifies args are forwarded.
  const dir = mkdtempSync(join(tmpdir(), 'forge-qg-'));
  try {
    const gateFail = makeQualityGateFromCmd(dir, ['sh', '-c', 'exit 1']);
    assert.equal(gateFail(), false);
    const gatePass = makeQualityGateFromCmd(dir, ['sh', '-c', 'exit 0']);
    assert.equal(gatePass(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- F-32: noop-completion stop condition ----

function makeState(overrides: Partial<LoopState>): LoopState {
  return {
    worktreePath: '/tmp/unused',
    iteration: 0,
    costUsdSoFar: 0,
    fixPlanItemsHistory: [0],
    filesChangedHistory: [],
    ...overrides,
  };
}

const PASSING_GATE = (): boolean => true;
const NOOP_COND: StopCondition = {
  kind: 'noop-completion',
  minIterations: 1,
  scratchPaths: RALPH_SCRATCH_PATHS,
};

test('noop-completion: fires when iter≥1 + filesInScope set + only scratch files written', async () => {
  const state = makeState({
    iteration: 1,
    filesInScope: ['src/foo.ts', 'tests/foo.test.ts'],
    filesChangedHistory: [['AGENT.md', 'fix_plan.md']],
  });
  const result = await checkStopConditions(state, [NOOP_COND], PASSING_GATE);
  assert.equal(result.stop, true);
  if (result.stop) assert.equal(result.condition, 'noop-completion');
});

test('noop-completion: does NOT fire when files_in_scope is empty (legitimate no-output WI)', async () => {
  const state = makeState({
    iteration: 5,
    filesInScope: [],
    filesChangedHistory: [['AGENT.md']],
  });
  const result = await checkStopConditions(state, [NOOP_COND], PASSING_GATE);
  assert.equal(result.stop, false);
});

test('noop-completion: does NOT fire when at least one useful write exists', async () => {
  const state = makeState({
    iteration: 1,
    filesInScope: ['src/foo.ts'],
    filesChangedHistory: [['AGENT.md', 'src/foo.ts', 'fix_plan.md']],
  });
  const result = await checkStopConditions(state, [NOOP_COND], PASSING_GATE);
  assert.equal(result.stop, false);
});

test('noop-completion: respects minIterations (defers until enough iterations have run)', async () => {
  const state = makeState({
    iteration: 1,
    filesInScope: ['src/foo.ts'],
    filesChangedHistory: [['AGENT.md']],
  });
  const cond: StopCondition = { kind: 'noop-completion', minIterations: 3, scratchPaths: RALPH_SCRATCH_PATHS };
  const result = await checkStopConditions(state, [cond], PASSING_GATE);
  assert.equal(result.stop, false); // iter 1 < minIterations 3 → wait
});

test('noop-completion: ignores .forge/work-items/* writes (PM-emitted scratch)', async () => {
  // The agent edited .forge/work-items/WI-1.md (e.g. updated status frontmatter)
  // but didn't touch any src/ file. Should still count as no-op.
  const state = makeState({
    iteration: 1,
    filesInScope: ['src/foo.ts'],
    filesChangedHistory: [['.forge/work-items/WI-1.md']],
  });
  const result = await checkStopConditions(state, [NOOP_COND], PASSING_GATE);
  assert.equal(result.stop, true);
  if (result.stop) assert.equal(result.condition, 'noop-completion');
});

test('noop-completion: aggregates across iterations (write in iter1, scratch in iter2 → still progress)', async () => {
  const state = makeState({
    iteration: 2,
    filesInScope: ['src/foo.ts'],
    filesChangedHistory: [['src/foo.ts'], ['AGENT.md']],
  });
  const result = await checkStopConditions(state, [NOOP_COND], PASSING_GATE);
  assert.equal(result.stop, false);
});
