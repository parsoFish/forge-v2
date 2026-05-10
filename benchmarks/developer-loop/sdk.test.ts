/**
 * SDK setup + glue tests for the developer-loop bench. Uses a stub `queryFn`
 * that yields a single fake assistant message + a result; no real Claude
 * calls.
 *
 * Asserts:
 *   - tempdir scaffolding (symlinks, project tree copy, WI spec readable)
 *   - per-fixture quality gate function constructs from a list cmd and runs it
 *   - runDevLoop returns a structured RunDevResult with parsed WorkItem
 *   - tool-use telemetry is tallied across the streamed messages
 *   - filesChanged paths are normalised to worktree-relative
 *   - missing WI spec is reported as runnerError
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import {
  cleanupTempdir,
  makeQualityGate,
  runDevLoop,
  setupTempdir,
  worktreeRelative,
  type DevQueryFn,
  type RunDevInput,
} from './sdk.ts';

const FIXTURE_WI = `---
work_item_id: WI-1
feature_id: FEAT-1
initiative_id: INIT-2026-05-09-test
status: pending
depends_on: []
acceptance_criteria:
  - given: "no input"
    when:  "the function is called"
    then:  "it returns 42"
files_in_scope:
  - src/answer.ts
estimated_iterations: 2
---

Implement the answer.
`;

function makeSeed(): string {
  const seed = mkdtempSync(join(tmpdir(), 'forge-bench-dev-seed-'));
  mkdirSync(join(seed, '.forge', 'work-items'), { recursive: true });
  writeFileSync(join(seed, '.forge', 'work-items', 'WI-1.md'), FIXTURE_WI);
  mkdirSync(join(seed, 'src'), { recursive: true });
  writeFileSync(join(seed, 'src', 'answer.ts'), 'export function answer() { return 0; }\n');
  return seed;
}

const PASSING_QUALITY_CMD = ['true']; // exits 0
const FAILING_QUALITY_CMD = ['false']; // exits non-zero

function fakeQueryFn(filesToReport: string[], costUsd = 0.05): DevQueryFn {
  return ({ prompt: _prompt, options: _options }) =>
    (async function* () {
      yield {
        type: 'assistant',
        message: {
          content: filesToReport.map((p) => ({
            type: 'tool_use',
            name: 'Edit',
            input: { file_path: p },
          })),
        },
      };
      yield { type: 'result', subtype: 'success', total_cost_usd: costUsd, duration_ms: 50 };
    })();
}

test('setupTempdir: symlinks brain/skills/docs/orchestrator/loops and copies seed', () => {
  const seed = makeSeed();
  const tempdir = setupTempdir({
    fixtureId: 'test',
    initiativeId: 'INIT-2026-05-09-test',
    seedTreePath: seed,
    projectName: 'demo',
    workItemSpecRelPath: '.forge/work-items/WI-1.md',
    expected: { max_iterations: 2, max_cost_usd: 0.30, quality_gate_cmd: PASSING_QUALITY_CMD },
  });
  try {
    for (const sub of ['brain', 'skills', 'docs', 'orchestrator', 'loops']) {
      assert.ok(existsSync(resolve(tempdir, sub)), `${sub} symlink present`);
    }
    assert.ok(existsSync(resolve(tempdir, 'projects', 'demo', '.forge', 'work-items', 'WI-1.md')));
    assert.ok(existsSync(resolve(tempdir, 'projects', 'demo', 'src', 'answer.ts')));
  } finally {
    cleanupTempdir(tempdir);
    rmSync(seed, { recursive: true, force: true });
  }
});

test('makeQualityGate: returns true when cmd exits 0, false otherwise', () => {
  const gateOk = makeQualityGate('/tmp', PASSING_QUALITY_CMD);
  const gateFail = makeQualityGate('/tmp', FAILING_QUALITY_CMD);
  assert.equal(gateOk(), true);
  assert.equal(gateFail(), false);
});

test('makeQualityGate: empty cmd throws', () => {
  assert.throws(() => makeQualityGate('/tmp', []), /at least one argv element/);
});

test('worktreeRelative: absolute → relative; outside → null', () => {
  const wt = '/work/projects/demo';
  assert.equal(worktreeRelative('/work/projects/demo/src/foo.ts', wt), 'src/foo.ts');
  assert.equal(worktreeRelative('src/foo.ts', wt), 'src/foo.ts');
  assert.equal(worktreeRelative('/tmp/something-else', wt), null);
  assert.equal(worktreeRelative('./src/foo.ts', wt), 'src/foo.ts');
});

test('runDevLoop: completes when quality gate passes, returns parsed WI', async () => {
  const seed = makeSeed();
  const input: RunDevInput = {
    fixtureId: 'demo',
    initiativeId: 'INIT-2026-05-09-test',
    seedTreePath: seed,
    projectName: 'demo',
    workItemSpecRelPath: '.forge/work-items/WI-1.md',
    expected: { max_iterations: 3, max_cost_usd: 0.30, quality_gate_cmd: PASSING_QUALITY_CMD },
    queryFn: fakeQueryFn(['src/answer.ts']),
  };
  const out = await runDevLoop(input);
  try {
    assert.equal(out.runnerError, undefined);
    assert.ok(out.result, 'result returned');
    // F-26: the runner now requires ≥1 agent invocation before checking the
    // `quality-gates-pass` condition — a gate that passes before any work
    // means either the WI is a no-op (agent should still verify) or the
    // gate isn't capturing the WI's acceptance criteria. After running once,
    // the gate passes on iteration 1's check and the loop exits cleanly.
    assert.equal(out.result?.status, 'complete');
    assert.equal(out.result?.iterations, 1);
    assert.equal(out.result?.stop_reason, 'quality-gates-pass');
    assert.equal(out.workItem?.work_item_id, 'WI-1');
    assert.equal(out.regressionPassed, true);
  } finally {
    cleanupTempdir(out.tempdir);
    rmSync(seed, { recursive: true, force: true });
  }
});

test('runDevLoop: with failing quality gate, agent runs and tool-use is tallied', async () => {
  const seed = makeSeed();
  const input: RunDevInput = {
    fixtureId: 'demo',
    initiativeId: 'INIT-2026-05-09-test',
    seedTreePath: seed,
    projectName: 'demo',
    workItemSpecRelPath: '.forge/work-items/WI-1.md',
    expected: { max_iterations: 2, max_cost_usd: 0.30, quality_gate_cmd: FAILING_QUALITY_CMD },
    queryFn: fakeQueryFn(['src/answer.ts'], 0.10),
  };
  const out = await runDevLoop(input);
  try {
    assert.equal(out.runnerError, undefined);
    assert.ok(out.result);
    assert.equal(out.result?.status, 'failed');
    assert.equal(out.result?.stop_reason, 'iteration-budget');
    assert.equal(out.result?.iterations, 2);
    // The fake agent reports one Edit per iteration, both for src/answer.ts.
    assert.deepEqual(out.result?.filesChanged, ['src/answer.ts']);
    assert.ok(out.toolUseSummary.writes >= 1, 'writes counted');
  } finally {
    cleanupTempdir(out.tempdir);
    rmSync(seed, { recursive: true, force: true });
  }
});

test('runDevLoop: missing WI spec → spec_missing runnerError', async () => {
  const seed = mkdtempSync(join(tmpdir(), 'forge-bench-dev-empty-seed-'));
  const input: RunDevInput = {
    fixtureId: 'demo',
    initiativeId: 'INIT-2026-05-09-test',
    seedTreePath: seed,
    projectName: 'demo',
    workItemSpecRelPath: '.forge/work-items/WI-missing.md',
    expected: { max_iterations: 1, max_cost_usd: 0.30, quality_gate_cmd: PASSING_QUALITY_CMD },
    queryFn: fakeQueryFn([]),
  };
  const out = await runDevLoop(input);
  try {
    assert.equal(out.runnerError?.kind, 'spec_missing');
    assert.equal(out.result, null);
  } finally {
    cleanupTempdir(out.tempdir);
    rmSync(seed, { recursive: true, force: true });
  }
});

test('runDevLoop: pre_existing_tests_cmd controls regressionPassed', async () => {
  const seed = makeSeed();
  const inputBaseline: RunDevInput = {
    fixtureId: 'demo',
    initiativeId: 'INIT-2026-05-09-test',
    seedTreePath: seed,
    projectName: 'demo',
    workItemSpecRelPath: '.forge/work-items/WI-1.md',
    expected: {
      max_iterations: 1,
      max_cost_usd: 0.30,
      quality_gate_cmd: PASSING_QUALITY_CMD,
      pre_existing_tests_cmd: FAILING_QUALITY_CMD,
    },
    queryFn: fakeQueryFn([]),
  };
  const out = await runDevLoop(inputBaseline);
  try {
    assert.equal(out.regressionPassed, false);
  } finally {
    cleanupTempdir(out.tempdir);
    rmSync(seed, { recursive: true, force: true });
  }
});
