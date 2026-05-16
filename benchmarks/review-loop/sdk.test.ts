/**
 * Setup tests for benchmarks/review-loop/sdk.ts.
 *
 * Phase 4.2 (drift correction): the bench now drives the **real**
 * `runReviewer` (orchestrator/phases/reviewer.ts) instead of a bespoke
 * one-shot `sdkQuery`, so there is no longer an injectable `queryFn` to fake
 * a Claude stream with. These tests therefore cover the deterministic,
 * SDK-free surface — tempdir layout (symlinks, git init + bare origin,
 * manifest copy, shim wiring), the smart `gh` shim's pr-create/merge flow
 * (no `.forge`-stripping clean), and the `runQualityGate` helper — exactly
 * the way `benchmarks/e2e/sdk.test.ts` tests its real-path harness without
 * making any SDK calls. The real SDK exercise is the bench run itself
 * (deferred — costs real API money).
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
  readGhMetadata,
  runQualityGate,
  runReviewer,
  setupTempdir,
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

function baseInput(opts: { seed: string; manifestPath: string }): RunReviewerInput {
  return {
    fixtureId: 'test',
    initiativeId: 'INIT-2026-05-09-test',
    seedTreePath: opts.seed,
    manifestPath: opts.manifestPath,
    projectName: 'demo',
    projectType: 'lib',
    qualityGateCmd: PASSING_QUALITY_CMD,
    isStackedPr: false,
  };
}

test('setupTempdir: symlinks core dirs, copies seed + manifest, writes shims, creates queue dirs', () => {
  const { seed, manifestPath, cleanup } = makeSeedAndManifest();
  try {
    const tempdir = setupTempdir(baseInput({ seed, manifestPath }));
    try {
      for (const sub of ['brain', 'skills', 'docs', 'orchestrator', 'loops']) {
        assert.ok(existsSync(resolve(tempdir, sub)), `${sub} symlink present`);
      }
      assert.ok(existsSync(resolve(tempdir, 'projects', 'demo', '.forge', 'work-items', 'WI-1.md')));
      assert.ok(existsSync(resolve(tempdir, 'projects', 'demo', 'src', 'redactor.py')));
      assert.ok(existsSync(resolve(tempdir, '_queue', 'in-flight', 'INIT-2026-05-09-test.md')));
      assert.ok(existsSync(resolve(tempdir, 'bin', 'gh')), 'gh shim written');
      assert.ok(existsSync(resolve(tempdir, 'bin', 'vhs')), 'vhs shim written');
      assert.ok(existsSync(resolve(tempdir, 'bin', 'npx')), 'npx shim written');
      for (const q of ['pending', 'ready-for-review', 'done', 'failed']) {
        assert.ok(existsSync(resolve(tempdir, '_queue', q)), `_queue/${q} dir present`);
      }
    } finally {
      cleanupTempdir(tempdir);
    }
  } finally {
    cleanup();
  }
});

test('setupTempdir: project is a real git repo with main + initiative branch + bare origin', () => {
  const { seed, manifestPath, cleanup } = makeSeedAndManifest();
  try {
    const tempdir = setupTempdir(baseInput({ seed, manifestPath }));
    try {
      const projDir = resolve(tempdir, 'projects', 'demo');
      assert.ok(existsSync(resolve(projDir, '.git')), 'projDir is a git repo');
      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: projDir,
        encoding: 'utf8',
      }).trim();
      assert.equal(branch, 'initiative-INIT-2026-05-09-test');
      const branches = execFileSync('git', ['branch', '--list'], {
        cwd: projDir,
        encoding: 'utf8',
      });
      assert.match(branches, /main/);
      assert.match(branches, /initiative-INIT-2026-05-09-test/);
      // Bare origin exists and has main (so openPullRequest's push works).
      assert.ok(existsSync(resolve(tempdir, '_origin.git')), 'bare origin created');
      const remotes = execFileSync('git', ['remote'], { cwd: projDir, encoding: 'utf8' });
      assert.match(remotes, /origin/);
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
      }),
    );
  } finally {
    cleanup();
  }
});

test('setupTempdir: missing manifest throws', () => {
  const { seed, cleanup } = makeSeedAndManifest();
  try {
    assert.throws(() =>
      setupTempdir({
        fixtureId: 'test',
        initiativeId: 'INIT-2026-05-09-test',
        seedTreePath: seed,
        manifestPath: '/nonexistent/manifest.md',
        projectName: 'demo',
        projectType: 'lib',
        qualityGateCmd: PASSING_QUALITY_CMD,
        isStackedPr: false,
      }),
    );
  } finally {
    cleanup();
  }
});

test('gh shim: is executable and pr create records metadata + emits a fake URL', () => {
  const { seed, manifestPath, cleanup } = makeSeedAndManifest();
  try {
    const tempdir = setupTempdir(baseInput({ seed, manifestPath }));
    try {
      const ghShim = resolve(tempdir, 'bin', 'gh');
      assert.ok((statSync(ghShim).mode & 0o100) !== 0, 'owner-execute bit set');
      const projDir = resolve(tempdir, 'projects', 'demo');
      const bodyFile = join(projDir, 'pr-body.md');
      writeFileSync(bodyFile, '## Why\nbecause reasons\n');
      const out = execFileSync(
        ghShim,
        ['pr', 'create', '--body-file', bodyFile, '--title', 'Test PR'],
        { cwd: projDir, encoding: 'utf8' },
      );
      assert.match(out, /^https:\/\/bench\.local/);
      const meta = readGhMetadata(tempdir);
      assert.ok(meta);
      assert.equal(meta!.created, true);
      assert.equal(meta!.merged, false);
      assert.match(meta!.body!, /because reasons/);
    } finally {
      cleanupTempdir(tempdir);
    }
  } finally {
    cleanup();
  }
});

test('gh shim: pr merge fast-forwards initiative into main and PRESERVES .forge/', () => {
  const { seed, manifestPath, cleanup } = makeSeedAndManifest();
  try {
    const tempdir = setupTempdir(baseInput({ seed, manifestPath }));
    try {
      const projDir = resolve(tempdir, 'projects', 'demo');
      // Simulate the reviewer's last-iteration output: a .forge/ artifact
      // left uncommitted in the worktree.
      mkdirSync(join(projDir, '.forge', 'demos', 'INIT-2026-05-09-test'), { recursive: true });
      writeFileSync(join(projDir, '.forge', 'pr-description.md'), '## Why\nx\n## What\ny\n## How\nz\n## Demo\nd\n');
      writeFileSync(join(projDir, '.forge', 'demos', 'INIT-2026-05-09-test', 'source.tape'), 'Type "x"\n');

      execFileSync(
        resolve(tempdir, 'bin', 'gh'),
        ['pr', 'create', '--body-file', join(projDir, '.forge', 'pr-description.md'), '--title', 'PR'],
        { cwd: projDir, stdio: 'pipe' },
      );
      const out = execFileSync(
        resolve(tempdir, 'bin', 'gh'),
        ['pr', 'merge', '--merge'],
        { cwd: projDir, encoding: 'utf8' },
      );
      assert.match(out, /Merged initiative-/);

      // .forge/ must survive (committed by the shim, NOT clean-stripped) so
      // caseScore can still find pr-description.md + the demo bundle.
      assert.ok(existsSync(join(projDir, '.forge', 'pr-description.md')), 'pr-description.md preserved post-merge');
      assert.ok(
        existsSync(join(projDir, '.forge', 'demos', 'INIT-2026-05-09-test', 'source.tape')),
        'demo bundle preserved post-merge',
      );

      const meta = readGhMetadata(tempdir);
      assert.ok(meta);
      assert.equal(meta!.merged, true);
      assert.match(meta!.mergedBranch ?? '', /^initiative-/);
    } finally {
      cleanupTempdir(tempdir);
    }
  } finally {
    cleanup();
  }
});

test('gh shim: pr merge without prior pr create exits non-zero', () => {
  const { seed, manifestPath, cleanup } = makeSeedAndManifest();
  try {
    const tempdir = setupTempdir(baseInput({ seed, manifestPath }));
    try {
      const projDir = resolve(tempdir, 'projects', 'demo');
      let threw = false;
      try {
        execFileSync(resolve(tempdir, 'bin', 'gh'), ['pr', 'merge', '--merge'], {
          cwd: projDir,
          stdio: 'pipe',
        });
      } catch {
        threw = true;
      }
      assert.equal(threw, true);
    } finally {
      cleanupTempdir(tempdir);
    }
  } finally {
    cleanup();
  }
});

test('gh shim: unsupported subcommand exits non-zero', () => {
  const { seed, manifestPath, cleanup } = makeSeedAndManifest();
  try {
    const tempdir = setupTempdir(baseInput({ seed, manifestPath }));
    try {
      let threw = false;
      try {
        execFileSync(resolve(tempdir, 'bin', 'gh'), ['repo', 'view'], { stdio: 'pipe' });
      } catch {
        threw = true;
      }
      assert.equal(threw, true);
    } finally {
      cleanupTempdir(tempdir);
    }
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

test('runReviewer: seed with no work items short-circuits before the SDK (work_items_unreadable)', async () => {
  // The bench wrapper validates the seed's work items up-front and returns a
  // runnerError BEFORE invoking the real reviewer phase — a deterministic,
  // money-free path that guards against bench-config errors. (A seed with a
  // valid WI would proceed into the real `runReviewer`, which costs API
  // money and is exercised by the bench run itself, not unit tests.)
  const root = mkdtempSync(join(tmpdir(), 'forge-bench-review-empty-'));
  try {
    const seed = join(root, 'seed');
    // Seed has source (so git init/commit succeeds) but NO
    // .forge/work-items — so the WI-validation guard, not git, short-circuits.
    mkdirSync(join(seed, 'src'), { recursive: true });
    writeFileSync(join(seed, 'src', 'redactor.py'), 'def redact_argv(a): return list(a)\n');
    const manifestPath = join(root, 'manifest.md');
    writeFileSync(manifestPath, FIXTURE_MANIFEST);

    const out = await runReviewer(baseInput({ seed, manifestPath }));
    try {
      assert.ok(out.runnerError, 'should report runnerError');
      assert.equal(out.runnerError!.kind, 'work_items_unreadable');
      assert.equal(out.workItems.length, 0);
      assert.equal(out.qualityGatesPassed, false);
    } finally {
      cleanupTempdir(out.tempdir);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readGhMetadata: missing file returns null', () => {
  assert.equal(readGhMetadata('/nonexistent'), null);
});
