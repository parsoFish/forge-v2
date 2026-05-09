/**
 * SDK setup + glue tests for the review-loop bench. Uses a stub `queryFn`
 * that yields a single fake assistant message + a result; no real Claude
 * calls.
 *
 * Asserts:
 *   - tempdir scaffolding (symlinks, project tree copy, manifest copy, gh stub)
 *   - gh stub is executable and exits non-zero (defense against accidental PRs)
 *   - runReviewer reads work items from the seed, runs quality gates after agent,
 *     and tallies tool use across streamed messages
 *   - missing seed / manifest is reported as runnerError
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  cleanupTempdir,
  runQualityGate,
  runReviewer,
  setupTempdir,
  type ReviewerQueryFn,
  type RunReviewerInput,
} from './sdk.ts';

const FIXTURE_WI_COMPLETE = `---
work_item_id: WI-1
feature_id: FEAT-1
initiative_id: INIT-2026-05-09-test
status: complete
depends_on: []
acceptance_criteria:
  - given: "a list of argv strings"
    when:  "redact_argv is called"
    then:  "a new list is returned with each element redacted"
files_in_scope:
  - src/redactor.py
estimated_iterations: 2
---

Implemented redact_argv. Tests pass.
`;

const FIXTURE_MANIFEST = `---
initiative_id: INIT-2026-05-09-test
project: demo
project_repo_path: /tmp/demo
created_at: 2026-05-09T12:00:00Z
iteration_budget: 50
cost_budget_usd: 25
phase: in-flight
features:
  - feature_id: FEAT-1
    title: Add redact_argv
    depends_on: []
---

# Test initiative

Adds redact_argv helper.
`;

function makeSeedAndManifest(): { seed: string; manifestPath: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'forge-bench-review-seed-'));
  const seed = join(root, 'seed');
  mkdirSync(join(seed, '.forge', 'work-items'), { recursive: true });
  writeFileSync(join(seed, '.forge', 'work-items', 'WI-1.md'), FIXTURE_WI_COMPLETE);
  mkdirSync(join(seed, 'src'), { recursive: true });
  writeFileSync(join(seed, 'src', 'redactor.py'), 'def redact_argv(a): return list(a)\n');
  const manifestPath = join(root, 'manifest.md');
  writeFileSync(manifestPath, FIXTURE_MANIFEST);
  return {
    seed,
    manifestPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const PASSING_QUALITY_CMD = ['true'];
const FAILING_QUALITY_CMD = ['false'];

function fakeQueryFn(opts: {
  costUsd?: number;
  toolBlocks?: Array<{ type: 'tool_use'; name: string; input: unknown }>;
  durationMs?: number;
}): ReviewerQueryFn {
  return ({ prompt: _p, options: _o }) =>
    (async function* () {
      if (opts.toolBlocks && opts.toolBlocks.length > 0) {
        yield {
          type: 'assistant',
          message: { content: opts.toolBlocks },
        };
      }
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: opts.costUsd ?? 0.05,
        duration_ms: opts.durationMs ?? 50,
      };
    })();
}

function baseInput(opts: { seed: string; manifestPath: string; queryFn: ReviewerQueryFn }): RunReviewerInput {
  return {
    fixtureId: 'test',
    initiativeId: 'INIT-2026-05-09-test',
    seedTreePath: opts.seed,
    manifestPath: opts.manifestPath,
    projectName: 'demo',
    projectType: 'lib',
    qualityGateCmd: PASSING_QUALITY_CMD,
    isStackedPr: false,
    queryFn: opts.queryFn,
  };
}

test('setupTempdir: symlinks brain/skills/docs/orchestrator/loops, copies seed + manifest', () => {
  const { seed, manifestPath, cleanup } = makeSeedAndManifest();
  try {
    const tempdir = setupTempdir(baseInput({ seed, manifestPath, queryFn: fakeQueryFn({}) }));
    try {
      for (const sub of ['brain', 'skills', 'docs', 'orchestrator', 'loops']) {
        assert.ok(existsSync(resolve(tempdir, sub)), `${sub} symlink present`);
      }
      assert.ok(existsSync(resolve(tempdir, 'projects', 'demo', '.forge', 'work-items', 'WI-1.md')));
      assert.ok(existsSync(resolve(tempdir, 'projects', 'demo', 'src', 'redactor.py')));
      assert.ok(existsSync(resolve(tempdir, '_queue', 'in-flight', 'INIT-2026-05-09-test.md')));
      assert.ok(existsSync(resolve(tempdir, 'bin', 'gh')), 'gh stub written');
    } finally {
      cleanupTempdir(tempdir);
    }
  } finally {
    cleanup();
  }
});

test('setupTempdir: gh stub is executable and exits non-zero', () => {
  const { seed, manifestPath, cleanup } = makeSeedAndManifest();
  try {
    const tempdir = setupTempdir(baseInput({ seed, manifestPath, queryFn: fakeQueryFn({}) }));
    try {
      const ghStub = resolve(tempdir, 'bin', 'gh');
      const stat = statSync(ghStub);
      assert.ok((stat.mode & 0o100) !== 0, 'owner-execute bit set');
      // Confirm it exits non-zero.
      let threw = false;
      try {
        execFileSync(ghStub, ['pr', 'create'], { stdio: 'pipe' });
      } catch {
        threw = true;
      }
      assert.ok(threw, 'gh stub must exit non-zero on any invocation');
    } finally {
      cleanupTempdir(tempdir);
    }
  } finally {
    cleanup();
  }
});

test('setupTempdir: missing seed throws', () => {
  const { seed: _seed, manifestPath, cleanup } = makeSeedAndManifest();
  try {
    assert.throws(() =>
      setupTempdir({
        fixtureId: 'test',
        initiativeId: 'INIT-2026-05-09-test',
        seedTreePath: '/nonexistent/path',
        manifestPath,
        projectName: 'demo',
        projectType: 'lib',
        qualityGateCmd: PASSING_QUALITY_CMD,
        isStackedPr: false,
        queryFn: fakeQueryFn({}),
      }),
    );
  } finally {
    cleanup();
  }
});

test('runQualityGate: passes when cmd exits 0, fails when non-zero', () => {
  assert.equal(runQualityGate('/tmp', PASSING_QUALITY_CMD), true);
  assert.equal(runQualityGate('/tmp', FAILING_QUALITY_CMD), false);
});

test('runQualityGate: empty cmd throws', () => {
  assert.throws(() => runQualityGate('/tmp', []), /at least one argv element/);
});

test('runReviewer: reads completed work items, runs quality gate after agent', async () => {
  const { seed, manifestPath, cleanup } = makeSeedAndManifest();
  try {
    const out = await runReviewer(
      baseInput({
        seed,
        manifestPath,
        queryFn: fakeQueryFn({}),
      }),
    );
    try {
      assert.equal(out.workItems.length, 1);
      assert.equal(out.workItems[0].work_item_id, 'WI-1');
      assert.equal(out.workItems[0].status, 'complete');
      assert.equal(out.qualityGatesPassed, true);
      assert.equal(out.runnerError, undefined);
      assert.equal(out.resultSubtype, 'success');
      assert.equal(out.costUsd, 0.05);
    } finally {
      cleanupTempdir(out.tempdir);
    }
  } finally {
    cleanup();
  }
});

test('runReviewer: tallies tool use across streamed messages', async () => {
  const { seed, manifestPath, cleanup } = makeSeedAndManifest();
  try {
    const out = await runReviewer(
      baseInput({
        seed,
        manifestPath,
        queryFn: fakeQueryFn({
          toolBlocks: [
            { type: 'tool_use', name: 'Read', input: { file_path: 'brain/forge/themes/squash-merge-stacked-prs.md' } },
            { type: 'tool_use', name: 'Read', input: { file_path: 'brain/forge/themes/markdown-artifact-flow.md' } },
            { type: 'tool_use', name: 'Write', input: { file_path: '.forge/pr-description.md' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'vhs source.tape -o recording.mp4' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'pytest -q' } },
          ],
        }),
      }),
    );
    try {
      assert.equal(out.toolUseSummary.brainReads, 2);
      assert.equal(out.toolUseSummary.writes, 1);
      assert.equal(out.toolUseSummary.bashCalls, 2);
      assert.equal(out.toolUseSummary.recorderInvocations, 1, 'vhs counts as recorder');
    } finally {
      cleanupTempdir(out.tempdir);
    }
  } finally {
    cleanup();
  }
});

test('runReviewer: quality gate failure surfaces in result', async () => {
  const { seed, manifestPath, cleanup } = makeSeedAndManifest();
  try {
    const out = await runReviewer({
      ...baseInput({ seed, manifestPath, queryFn: fakeQueryFn({}) }),
      qualityGateCmd: FAILING_QUALITY_CMD,
    });
    try {
      assert.equal(out.qualityGatesPassed, false);
    } finally {
      cleanupTempdir(out.tempdir);
    }
  } finally {
    cleanup();
  }
});

test('runReviewer: missing work-items dir → runnerError, no agent invocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-bench-review-empty-'));
  try {
    const seed = join(root, 'seed');
    mkdirSync(seed, { recursive: true }); // no .forge/work-items inside
    const manifestPath = join(root, 'manifest.md');
    writeFileSync(manifestPath, FIXTURE_MANIFEST);

    let queryFnInvoked = false;
    const queryFn: ReviewerQueryFn = ({ prompt: _p, options: _o }) => {
      queryFnInvoked = true;
      return (async function* () {})();
    };

    const out = await runReviewer({
      fixtureId: 'test',
      initiativeId: 'INIT-2026-05-09-test',
      seedTreePath: seed,
      manifestPath,
      projectName: 'demo',
      projectType: 'lib',
      qualityGateCmd: PASSING_QUALITY_CMD,
      isStackedPr: false,
      queryFn,
    });
    try {
      assert.ok(out.runnerError, 'should report runnerError');
      assert.equal(out.runnerError!.kind, 'work_items_unreadable');
      assert.equal(queryFnInvoked, false, 'agent must not be invoked when work items unreadable');
    } finally {
      cleanupTempdir(out.tempdir);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
