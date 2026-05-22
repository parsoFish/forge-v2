/**
 * SDK setup + glue tests for the chained bench. No real Claude calls — the
 * architect step is injected via `architectQueryFn`, and the pure
 * artifact-extraction helpers are exercised directly.
 *
 * Asserts:
 *   - setupChainedTempdir layout (forge-tree symlinks, masked brain, seed
 *     copy, queue dirs, shims).
 *   - maskLiveBrain / restoreLiveBrain round-trips: the live brain's
 *     project themes/ + _raw/cycles/ + log.md are byte-identical afterwards,
 *     and writes during the mask land in the tempdir, not the live brain.
 *   - The pure chained-artifacts extractors (LoopResult reconstruction,
 *     synthetic aggregate WI, reflector tool-use, manifest/WI/graph readers).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { execFileSync } from 'node:child_process';

import {
  cleanupTempdir,
  maskLiveBrain,
  prewriteCannedUserFeedback,
  restoreLiveBrain,
  setupChainedTempdir,
  type ChainArtifacts,
  type ChainSeed,
} from './sdk.ts';
import {
  reconstructLoopResultFromEventLog,
  reconstructReflectorToolUse,
  readChainedWorkItems,
  readChainedGraphText,
  syntheticAggregateWorkItem,
} from './chained-artifacts.ts';
import type { WorkItem } from '../../orchestrator/work-item.ts';
import {
  buildGhShimScript,
  forgeSnapshotDir,
  readGhMetadata,
  writeShim,
} from '../_lib/gh-shim.ts';
import { confirmPrMerged } from '../../orchestrator/pr.ts';
import { classifyCycleFailure } from '../../orchestrator/failure-classifier.ts';
import type { EventLogEntry } from '../../orchestrator/logging.ts';

const FORGE_ROOT = resolve(import.meta.dirname, '..', '..');

function makeSeedTree(): { path: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'forge-chained-seed-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'src', '.gitkeep'), '');
  writeFileSync(join(root, 'package.json'), '{"name":"slugifier","type":"module","version":"0.0.1"}\n');
  return { path: root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function baseSeed(seedTreePath: string): ChainSeed {
  return {
    id: 'unit',
    architectPrompt: 'build a thing',
    project: 'slugifier',
    architectExpected: { min_features: 1, max_features: 3 },
    seedTreePath,
    spec: { manifest_ac_command: ['true'], non_functional_checks: [], required_pr_signals: [] },
  };
}

// ---------- setupChainedTempdir ----------

test('setupChainedTempdir: symlinks forge tree, masks brain, copies seed, makes queue dirs + shims', () => {
  const seed = makeSeedTree();
  try {
    const dir = setupChainedTempdir(baseSeed(seed.path));
    try {
      for (const sub of ['skills', 'docs', 'orchestrator', 'loops']) {
        assert.equal(lstatSync(resolve(dir, sub)).isSymbolicLink(), true, `${sub} symlink`);
      }
      // Masked brain: INDEX.md symlinked, target project themes/ a fresh dir.
      assert.equal(existsSync(resolve(dir, 'brain', 'INDEX.md')), true);
      const themes = resolve(dir, 'brain', 'projects', 'slugifier', 'themes');
      assert.equal(existsSync(themes), true);
      assert.equal(lstatSync(themes).isSymbolicLink(), false, 'themes/ is a real dir');
      const cycles = resolve(dir, 'brain', '_raw', 'cycles');
      assert.equal(lstatSync(cycles).isSymbolicLink(), false, '_raw/cycles/ is a real dir');
      // Seed copied.
      assert.equal(existsSync(resolve(dir, 'projects', 'slugifier', 'package.json')), true);
      // Queue dirs.
      for (const q of ['pending', 'in-flight', 'ready-for-review', 'done', 'failed']) {
        assert.equal(existsSync(resolve(dir, '_queue', q)), true, `_queue/${q}`);
      }
      // Shims.
      for (const b of ['gh', 'vhs', 'npx']) {
        assert.equal(existsSync(resolve(dir, 'bin', b)), true, `bin/${b}`);
      }
    } finally {
      cleanupTempdir(dir);
    }
  } finally {
    seed.cleanup();
  }
});

test('setupChainedTempdir: throws when the seed tree is missing', () => {
  assert.throws(
    () => setupChainedTempdir(baseSeed('/does/not/exist')),
    /seed tree path does not exist/,
  );
});

// ---------- maskLiveBrain / restoreLiveBrain ----------

test('maskLiveBrain → restoreLiveBrain leaves the live brain byte-identical and redirects writes to the tempdir', () => {
  const seed = makeSeedTree();
  // Use a project that is unlikely to collide with a real brain project so
  // the test never depends on (or perturbs) real theme content.
  const project = `__chained_test_proj_${process.pid}`;
  const liveThemes = resolve(FORGE_ROOT, 'brain', 'projects', project, 'themes');
  const liveCycles = resolve(FORGE_ROOT, 'brain', '_raw', 'cycles');
  const liveLog = resolve(FORGE_ROOT, 'brain', 'log.md');

  // Capture pre-state for the shared, real paths (_raw/cycles + log.md).
  const cyclesBefore = readdirSync(liveCycles).sort();
  const logBefore = readFileSync(liveLog, 'utf8');

  const dir = setupChainedTempdir({ ...baseSeed(seed.path), project });
  let handle: ReturnType<typeof maskLiveBrain> | null = null;
  try {
    handle = maskLiveBrain(dir, project);

    // While masked: the live paths are symlinks into the tempdir.
    assert.equal(lstatSync(liveCycles).isSymbolicLink(), true, 'cycles redirected');
    assert.equal(lstatSync(liveLog).isSymbolicLink(), true, 'log.md redirected');

    // A reflector-style absolute write to the live path lands in the tempdir.
    const archive = resolve(liveCycles, 'CY-unittest.md');
    writeFileSync(archive, '# archive\n');
    const tempdirArchive = resolve(dir, 'brain', '_raw', 'cycles', 'CY-unittest.md');
    assert.equal(existsSync(tempdirArchive), true, 'write landed in tempdir');

    const themeFile = resolve(liveThemes, '2026-05-17-x.md');
    writeFileSync(themeFile, '# theme\n');
    assert.equal(
      existsSync(resolve(dir, 'brain', 'projects', project, 'themes', '2026-05-17-x.md')),
      true,
      'theme write landed in tempdir',
    );
  } finally {
    if (handle) restoreLiveBrain(handle);
    cleanupTempdir(dir);
    seed.cleanup();
  }

  // After restore: the temp project dir is gone (it never existed live), and
  // the shared real paths are byte-identical to before.
  assert.equal(existsSync(liveThemes), false, 'temp project themes not left behind');
  assert.equal(lstatSync(liveCycles).isSymbolicLink(), false, 'cycles restored to real dir');
  assert.equal(lstatSync(liveLog).isSymbolicLink(), false, 'log.md restored to real file');
  assert.deepEqual(readdirSync(liveCycles).sort(), cyclesBefore, '_raw/cycles unchanged');
  assert.equal(readFileSync(liveLog, 'utf8'), logBefore, 'log.md unchanged');
});

// ---------- contamination boundary (S1.2) ----------

test('maskLiveBrain: contamination boundary — pre-cleans empty __chained_test_proj_* dirs and never leaves new ones', () => {
  // Pre-seed an empty contamination dir as if a previous interrupted run had
  // left one behind.
  const stale = resolve(FORGE_ROOT, 'brain', 'projects', `__chained_test_proj_stale_${process.pid}`);
  // Defensive cleanup in case of a prior run.
  if (existsSync(stale)) rmSync(stale, { recursive: true, force: true });
  mkdirSync(stale, { recursive: true });
  try {
    assert.equal(existsSync(stale), true, 'pre-seeded stale contamination');

    const seed = makeSeedTree();
    const project = `__chained_test_proj_${process.pid}_boundary`;
    const dir = setupChainedTempdir({ ...baseSeed(seed.path), project });
    let handle: ReturnType<typeof maskLiveBrain> | null = null;
    try {
      handle = maskLiveBrain(dir, project);

      // After preCleanContamination ran inside maskLiveBrain, the stale dir
      // must be gone.
      assert.equal(
        existsSync(stale),
        false,
        'stale contamination dir was pre-cleaned by maskLiveBrain',
      );
    } finally {
      if (handle) restoreLiveBrain(handle);
      cleanupTempdir(dir);
      seed.cleanup();
    }

    // Post-restore: this run also left nothing behind.
    const after = resolve(FORGE_ROOT, 'brain', 'projects', project);
    assert.equal(existsSync(after), false, 'masked project dir cleaned up on restore');

    // Stale dir still gone.
    assert.equal(existsSync(stale), false, 'stale dir stays gone');
  } finally {
    if (existsSync(stale)) rmSync(stale, { recursive: true, force: true });
  }
});

// ---------- pure artifact extractors ----------

function eventLog(lines: object[]): { path: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'forge-chained-evlog-'));
  const p = join(root, 'events.jsonl');
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { path: p, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('reconstructLoopResultFromEventLog: aggregates per-WI ralph.end events', () => {
  const ev = eventLog([
    { phase: 'developer-loop', skill: 'developer-ralph', event_type: 'start', message: 'ralph.start' },
    {
      phase: 'developer-loop',
      skill: 'developer-ralph',
      event_type: 'end',
      message: 'ralph.end',
      cost_usd: 0.2,
      duration_ms: 1000,
      output_refs: ['src/slugify.ts', 'tests/slugify.test.ts'],
      metadata: { status: 'complete', iterations: 2, stop_reason: 'gate-pass' },
    },
    {
      phase: 'developer-loop',
      skill: 'developer-ralph',
      event_type: 'end',
      message: 'ralph.end',
      cost_usd: 0.15,
      duration_ms: 800,
      output_refs: ['src/batch.ts'],
      metadata: { status: 'complete', iterations: 1, stop_reason: 'gate-pass' },
    },
  ]);
  try {
    const r = reconstructLoopResultFromEventLog(ev.path);
    assert.ok(r);
    assert.equal(r!.status, 'complete');
    assert.equal(r!.iterations, 2, 'max iterations across WIs');
    assert.ok(Math.abs(r!.cost_usd - 0.35) < 1e-9, 'summed cost');
    assert.equal(r!.duration_ms, 1800, 'summed duration');
    assert.deepEqual(
      [...r!.filesChanged].sort(),
      ['src/batch.ts', 'src/slugify.ts', 'tests/slugify.test.ts'],
      'union of files',
    );
  } finally {
    ev.cleanup();
  }
});

test('reconstructLoopResultFromEventLog: any non-complete WI ⇒ aggregate not complete', () => {
  const ev = eventLog([
    {
      phase: 'developer-loop',
      skill: 'developer-ralph',
      event_type: 'end',
      message: 'ralph.end',
      cost_usd: 0.1,
      metadata: { status: 'complete', iterations: 1, stop_reason: 'gate-pass' },
    },
    {
      phase: 'developer-loop',
      skill: 'developer-ralph',
      event_type: 'end',
      message: 'ralph.end',
      cost_usd: 0.3,
      metadata: { status: 'failed', iterations: 3, stop_reason: 'iteration-budget' },
    },
  ]);
  try {
    const r = reconstructLoopResultFromEventLog(ev.path);
    assert.ok(r);
    assert.equal(r!.status, 'failed');
    assert.equal(r!.stop_reason, 'iteration-budget');
  } finally {
    ev.cleanup();
  }
});

test('reconstructLoopResultFromEventLog: returns null when no ralph.end exists', () => {
  const ev = eventLog([{ phase: 'orchestrator', event_type: 'start', message: 'cycle.start' }]);
  try {
    assert.equal(reconstructLoopResultFromEventLog(ev.path), null);
  } finally {
    ev.cleanup();
  }
  assert.equal(reconstructLoopResultFromEventLog(null), null);
  assert.equal(reconstructLoopResultFromEventLog('/nope/events.jsonl'), null);
});

test('syntheticAggregateWorkItem: unions files_in_scope and concatenates ACs', () => {
  const wis: WorkItem[] = [
    {
      work_item_id: 'WI-1',
      feature_id: 'FEAT-1',
      initiative_id: 'INIT-2026-05-17-x',
      status: 'complete',
      depends_on: [],
      acceptance_criteria: [{ given: 'g1', when: 'w1', then: 't1' }],
      files_in_scope: ['src/slugify.ts'],
      estimated_iterations: 2,
      body: 'a',
    },
    {
      work_item_id: 'WI-2',
      feature_id: 'FEAT-2',
      initiative_id: 'INIT-2026-05-17-x',
      status: 'complete',
      depends_on: ['WI-1'],
      acceptance_criteria: [{ given: 'g2', when: 'w2', then: 't2' }],
      files_in_scope: ['src/batch.ts', 'src/slugify.ts'],
      estimated_iterations: 1,
      body: 'b',
    },
  ];
  const agg = syntheticAggregateWorkItem(wis);
  assert.deepEqual([...agg.files_in_scope].sort(), ['src/batch.ts', 'src/slugify.ts']);
  assert.equal(agg.acceptance_criteria.length, 2);
  assert.equal(agg.estimated_iterations, 2);
  assert.equal(agg.depends_on.length, 0);
});

test('reconstructReflectorToolUse: reads tool_use from the final reflector end event', () => {
  const ev = eventLog([
    { phase: 'reflection', skill: 'reflector', event_type: 'start', message: 'reflector.start' },
    {
      phase: 'reflection',
      skill: 'reflector',
      event_type: 'end',
      message: 'reflector.end',
      metadata: { tool_use: { brainReads: 3, themeWrites: 2, retroWrites: 1, bashCalls: 0 } },
    },
  ]);
  try {
    const tu = reconstructReflectorToolUse(ev.path);
    assert.equal(tu.brainReads, 3);
    assert.equal(tu.themeWrites, 2);
    assert.equal(tu.retroWrites, 1);
  } finally {
    ev.cleanup();
  }
  // Missing log → zeroed summary (brain_consulted gate then fails, as desired).
  assert.equal(reconstructReflectorToolUse(null).brainReads, 0);
});

test('readChainedWorkItems / readChainedGraphText: read from the generated work-items dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-chained-wi-'));
  try {
    const wiDir = join(root, 'projects', 'slugifier', '.forge', 'work-items');
    mkdirSync(wiDir, { recursive: true });
    writeFileSync(
      join(wiDir, 'WI-1.md'),
      [
        '---',
        'work_item_id: WI-1',
        'feature_id: FEAT-1',
        'initiative_id: INIT-2026-05-17-slug',
        'status: complete',
        'depends_on: []',
        'files_in_scope: [src/slugify.ts]',
        'estimated_iterations: 2',
        'acceptance_criteria:',
        '  - given: a string',
        '    when: slugify is called',
        '    then: a slug is returned',
        '---',
        '',
        'Body.',
      ].join('\n'),
    );
    writeFileSync(join(wiDir, '_graph.md'), '```mermaid\ngraph TD\n  WI-1\n```\n');

    const artifacts = {
      workItemsDir: wiDir,
    } as unknown as ChainArtifacts;

    const items = readChainedWorkItems(artifacts);
    assert.equal(items.length, 1);
    assert.equal(items[0].work_item_id, 'WI-1');
    const graph = readChainedGraphText(artifacts);
    assert.match(graph ?? '', /graph TD/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- deterministic operator/remote-stub plumbing (no SDK / no $) ----------
//
// The chained bench legitimately has no human + no GitHub. These prove the
// stubs (bare origin, smart gh-shim, simulated operator-merge, canned
// reflector feedback) + the new classifier mode are coherent WITHOUT any
// paid LLM call — the parts a paid run shouldn't be needed to validate.

/** A real git repo on `main` with a bare `origin`, on an initiative branch. */
function repoWithBareOrigin(): { root: string; projDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'forge-chained-plumb-'));
  const projDir = join(root, 'proj');
  mkdirSync(projDir, { recursive: true });
  const sh = (args: string[], cwd = projDir): string =>
    execFileSync('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' });
  sh(['init', '-q', '-b', 'main']);
  sh(['config', 'user.email', 'bench@forge.local']);
  sh(['config', 'user.name', 'forge bench']);
  writeFileSync(join(projDir, 'README.md'), '# seed\n');
  sh(['add', '-A']);
  sh(['commit', '-q', '-m', 'seed']);
  const origin = join(root, '_origin.git');
  sh(['init', '-q', '--bare', origin], root);
  sh(['remote', 'add', 'origin', origin]);
  sh(['push', '-q', 'origin', 'main']);
  sh(['checkout', '-q', '-b', 'initiative-INIT-x']);
  return { root, projDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('bare-origin push works (the dev-loop / G8 local↔remote precondition)', () => {
  const r = repoWithBareOrigin();
  try {
    const sh = (args: string[]): string =>
      execFileSync('git', args, { cwd: r.projDir, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' });
    writeFileSync(join(r.projDir, 'src.txt'), 'work\n');
    sh(['add', '-A']);
    sh(['commit', '-q', '-m', 'wi-1']);
    // The dev-loop pushes the initiative branch every WI; must succeed
    // against the bare origin initGitRepo creates.
    sh(['push', '-q', '-u', 'origin', 'initiative-INIT-x']);
    const remoteBranches = sh(['branch', '-r']);
    assert.match(remoteBranches, /origin\/initiative-INIT-x/);
    // origin/<branch> == local HEAD (the G8 invariant assertLocalRemoteSynced checks).
    const localHead = sh(['rev-parse', 'HEAD']).trim();
    const remoteHead = sh(['rev-parse', 'origin/initiative-INIT-x']).trim();
    assert.equal(localHead, remoteHead);
  } finally {
    r.cleanup();
  }
});

test('gh-shim: pr create → pr view OPEN → pr merge → pr view MERGED; confirmMerge→confirmPrMerged returns merged', () => {
  const r = repoWithBareOrigin();
  try {
    const tempdir = r.root;
    const binDir = join(tempdir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeShim(join(binDir, 'gh'), buildGhShimScript(r.projDir, tempdir, { cleanAfterMerge: true }));

    // Put a commit on the initiative branch so the ff-merge has content.
    const sh = (args: string[]): string =>
      execFileSync('git', args, { cwd: r.projDir, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' });
    mkdirSync(join(r.projDir, '.forge'), { recursive: true });
    writeFileSync(join(r.projDir, '.forge', 'pr-description.md'), '# PR\nWhat: did a thing.\n');
    writeFileSync(join(r.projDir, 'feature.txt'), 'feature\n');
    sh(['add', '-A']);
    sh(['commit', '-q', '-m', 'feat: thing']);

    const ghEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` };
    const runGh = (args: string[]): string =>
      execFileSync('gh', args, { cwd: r.projDir, env: ghEnv, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' });

    // 1. pr create (what orchestrator/pr.ts:openPullRequest runs).
    const url = runGh([
      'pr', 'create',
      '--title', 'feat: thing',
      '--body-file', join(r.projDir, '.forge', 'pr-description.md'),
    ]).trim();
    assert.match(url, /bench\.local\/pr/);
    let meta = readGhMetadata(tempdir);
    assert.equal(meta?.created, true);
    assert.equal(meta?.merged, false);

    // 2. pr view --json state == OPEN (confirmPrMerged before the operator merges).
    assert.equal(withGhOnPath(binDir, () => confirmPrMerged(r.projDir)), false);

    // 3. The simulated operator merges (the chained confirmMerge hook does
    //    exactly this: gh pr merge --merge via the shim).
    runGh(['pr', 'merge', '--merge']);
    meta = readGhMetadata(tempdir);
    assert.equal(meta?.merged, true);

    // 4. confirmPrMerged now reads MERGED — the ONLY signal that gates
    //    closure → reflection (G10/G1).
    assert.equal(withGhOnPath(binDir, () => confirmPrMerged(r.projDir)), true);

    // The pre-merge .forge/ snapshot survived (review/reflection rubrics
    // read it after the gh-shim's git clean).
    assert.equal(existsSync(forgeSnapshotDir(tempdir)), true);
    assert.equal(
      existsSync(join(forgeSnapshotDir(tempdir), 'pr-description.md')),
      true,
    );
    // The ff-merge actually landed on main.
    const mainLog = execFileSync('git', ['log', '--oneline', 'main'], {
      cwd: r.projDir, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8',
    });
    assert.match(mainLog, /feat: thing/);
  } finally {
    r.cleanup();
  }
});

/**
 * Run `fn` with the gh-shim dir prepended to PATH, then restore PATH.
 * `confirmPrMerged` resolves `gh` via PATH (execFileSync), so the call
 * must see the shim — but we must not leak PATH into other tests.
 */
function withGhOnPath<T>(binDir: string, fn: () => T): T {
  const original = process.env.PATH ?? '';
  process.env.PATH = `${binDir}:${original}`;
  try {
    return fn();
  } finally {
    process.env.PATH = original;
  }
}

test('prewriteCannedUserFeedback: the reflector stage-3 feedback file exists before the cycle (3rd human moment stub)', () => {
  // The chained harness pre-writes this BEFORE runCycle so the reflector
  // (which reads _logs/<cycleId>/user-feedback.md, module-relative to the
  // real forge root) finds the canned operator feedback — mirroring
  // benchmarks/reflection/simulator.ts:prepareUserFeedback.
  const cycleId = `chained-unittest-${process.pid}-${Date.now()}`;
  const FORGE_ROOT = resolve(import.meta.dirname, '..', '..');
  const expected = resolve(FORGE_ROOT, '_logs', cycleId, 'user-feedback.md');
  try {
    const written = prewriteCannedUserFeedback(cycleId);
    assert.equal(written, expected);
    assert.equal(existsSync(expected), true, 'feedback present before reflection');
    const body = readFileSync(expected, 'utf8');
    // Minimal but realistic: the reflection-bench convention (an
    // "## Answers" block + a "## Free-form" paragraph).
    assert.match(body, /##\s*Answers/);
    assert.match(body, /##\s*Free-form/);
    assert.ok(body.trim().length > 0);
  } finally {
    rmSync(resolve(FORGE_ROOT, '_logs', cycleId), { recursive: true, force: true });
  }
});

test('classifier: pm-invalid-work-items is detected from the PM error event and is recoverable (chained self-heal precondition)', () => {
  // This is the exact event runProjectManager emits when it produces a
  // schema-invalid work item (per_item_error_count > 0 on the PM error
  // event) — the failure that aborted paid run-2. It must now classify
  // recoverable so the bounded-retry wrapper re-runs the PM.
  const events: EventLogEntry[] = [
    {
      event_id: 'e1',
      cycle_id: 'c',
      initiative_id: 'INIT-x',
      started_at: '',
      phase: 'project-manager',
      skill: 'project-manager',
      event_type: 'error',
      input_refs: [],
      output_refs: [],
      message: 'pm.end',
      metadata: { work_item_count: 4, per_item_error_count: 1, hidden_coupling_violations: [] },
    } as unknown as EventLogEntry,
    {
      event_id: 'e2',
      cycle_id: 'c',
      initiative_id: 'INIT-x',
      started_at: '',
      phase: 'orchestrator',
      skill: 'cycle',
      event_type: 'error',
      input_refs: [],
      output_refs: [],
      message: 'project-manager phase failed: 1 per-item validation errors',
    } as unknown as EventLogEntry,
  ];
  const cls = classifyCycleFailure(events);
  assert.equal(cls.mode, 'pm-invalid-work-items');
  assert.equal(cls.recoverable, true);
});
