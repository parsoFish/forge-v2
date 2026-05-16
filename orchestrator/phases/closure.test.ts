/**
 * Tests for orchestrator/phases/closure.ts — the Phase-6 closure contract
 * (G1 / G10 / G9 / closure-aligns-local↔remote). These assert the NEW
 * (review-redesign) behaviour, replacing the old "reviewer auto-merges →
 * cycle moves to done/ → reflection fires" path:
 *
 *   - reviewer `pr-open` + confirmMerge=false  → outcome `pr-open`,
 *     merged=false, manifest stays in ready-for-review/, NOT done/
 *     (reflection is skipped — only `merged` fires it).
 *   - reviewer `pr-open` + confirmMerge=true   → outcome `merged`,
 *     merged=true, manifest moved to done/ (G1: done/ ⇒ confirmed merge),
 *     local aligned to remote.
 *   - any non-pr-open reviewer outcome         → passed through, never
 *     `merged`, no done/ move (nothing to confirm).
 *   - confirmMerge throwing                    → treated as NOT merged
 *     (a partial/unconfirmed state is never `merged`).
 *
 * `confirmMerge` is injected (the production default `confirmPrMerged`
 * shells `gh` — exercised in pr.test.ts). No SDK, no real GitHub.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runClosure } from './closure.ts';
import { createLogger, type EventLogEntry } from '../logging.ts';
import type { CycleInput, ReviewerOutcome } from '../cycle-context.ts';

// Captured ONCE at module load — the stable cwd to restore to after each
// test's chdir. Using a per-setup snapshot would race: sequential async
// subtests can have a prior test's (deleted) tempdir as cwd if its
// cleanup hasn't run yet.
const MODULE_CWD = process.cwd();

function sh(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

type Harness = {
  dir: string;
  proj: string;
  manifestPath: string;
  logger: ReturnType<typeof createLogger>;
  events: () => EventLogEntry[];
  paths: { inFlight: string; done: string; readyForReview: string };
  cleanup: () => void;
};

/**
 * A tempdir laid out as forge expects: a git project on `initiative-x`
 * with a bare origin, `_queue/{in-flight,ready-for-review,done}` dirs, and
 * the manifest staged in ready-for-review/ (where the reviewer left it).
 * `process.chdir` into the tempdir so `moveTo`'s cwd-relative `_queue`
 * resolves here (restored by cleanup()).
 */
function setup(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'forge-closure-test-'));
  const proj = join(dir, 'proj');
  mkdirSync(proj, { recursive: true });
  sh(proj, ['init', '-q', '-b', 'main']);
  sh(proj, ['config', 'user.email', 't@forge']);
  sh(proj, ['config', 'user.name', 'forge-test']);
  writeFileSync(join(proj, 'README.md'), 'base\n');
  sh(proj, ['add', '.']);
  sh(proj, ['commit', '-q', '-m', 'base']);
  const origin = join(dir, 'origin.git');
  sh(proj, ['init', '-q', '--bare', origin]);
  sh(proj, ['remote', 'add', 'origin', origin]);
  sh(proj, ['push', '-q', 'origin', 'main']);
  sh(proj, ['checkout', '-q', '-b', 'initiative-x']);
  writeFileSync(join(proj, 'feature.txt'), 'work\n');
  sh(proj, ['add', '.']);
  sh(proj, ['commit', '-q', '-m', 'feat: work']);
  sh(proj, ['push', '-q', '--set-upstream', 'origin', 'initiative-x']);

  const queue = join(dir, '_queue');
  const inFlight = join(queue, 'in-flight');
  const done = join(queue, 'done');
  const readyForReview = join(queue, 'ready-for-review');
  for (const p of [inFlight, done, readyForReview, join(queue, 'pending'), join(queue, 'failed')]) {
    mkdirSync(p, { recursive: true });
  }
  // Phase 6 contract: the reviewer does NOT move the manifest — it stays
  // in `in-flight/` through review. Closure is the single terminal-move
  // authority (moveTo's `from` is always in-flight).
  const manifestPath = join(inFlight, 'INIT-x.md');
  writeFileSync(manifestPath, '---\ninitiative_id: INIT-x\n---\n');

  const logsDir = join(dir, '_logs');
  mkdirSync(logsDir, { recursive: true });
  const logger = createLogger('TEST-closure', logsDir);

  // closure.ts:moveQueueItem → queue.ts:moveTo defaults to a cwd-relative
  // `_queue`. chdir into the tempdir for the duration of the test; restore
  // to the stable MODULE-level cwd (NOT a per-setup snapshot — that races
  // across sequential async subtests if a prior cleanup hasn't run yet).
  process.chdir(dir);

  return {
    dir,
    proj,
    manifestPath,
    logger,
    events: () => {
      const txt = readFileSync(logger.logFilePath, 'utf8');
      return txt.split('\n').filter(Boolean).map((l) => JSON.parse(l) as EventLogEntry);
    },
    paths: { inFlight, done, readyForReview },
    cleanup: () => {
      process.chdir(MODULE_CWD);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function input(h: Harness, confirm: (wt: string) => boolean | Promise<boolean>): CycleInput {
  return {
    initiativeId: 'INIT-x',
    manifestPath: h.manifestPath,
    projectRepoPath: h.proj,
    worktreePath: h.proj,
    confirmMerge: confirm,
  };
}

test('runClosure: pr-open + NOT merged → outcome pr-open, no done/ move, manifest stays ready-for-review (G9/G1)', async () => {
  const h = setup();
  try {
    const r = await runClosure(input(h, () => false), h.logger, 'pr-open');
    assert.equal(r.outcome, 'pr-open');
    assert.equal(r.merged, false);
    // Manifest NOT promoted to done/ — no auto-merge, no premature done/.
    assert.ok(existsSync(join(h.paths.readyForReview, 'INIT-x.md')));
    assert.ok(!existsSync(join(h.paths.done, 'INIT-x.md')));
    const msgs = h.events().map((e) => e.message);
    assert.ok(msgs.includes('closure.pr-open-awaiting-operator'));
    assert.ok(!msgs.includes('closure.manifest-moved-to-done'));
  } finally {
    h.cleanup();
  }
});

test('runClosure: pr-open + CONFIRMED merge → outcome merged, manifest moved to done/ (G1), local aligned', async () => {
  const h = setup();
  try {
    // Model the operator having merged the PR on the remote: ff origin/main
    // to the initiative tip. closure's alignLocalToRemote then ff's local
    // main + prunes the branch.
    const clone = join(h.dir, 'clone');
    sh(h.dir, ['clone', '-q', join(h.dir, 'origin.git'), clone]);
    sh(clone, ['config', 'user.email', 't@forge']);
    sh(clone, ['config', 'user.name', 'forge-test']);
    sh(clone, ['fetch', '-q', 'origin', 'initiative-x']);
    sh(clone, ['checkout', '-q', 'main']);
    sh(clone, ['merge', '-q', '--ff-only', 'origin/initiative-x']);
    sh(clone, ['push', '-q', 'origin', 'main']);

    const r = await runClosure(input(h, () => true), h.logger, 'pr-open');
    assert.equal(r.outcome, 'merged');
    assert.equal(r.merged, true);
    // G1: done/ ⇒ confirmed merge.
    assert.ok(existsSync(join(h.paths.done, 'INIT-x.md')));
    assert.ok(!existsSync(join(h.paths.readyForReview, 'INIT-x.md')));
    const msgs = h.events().map((e) => e.message);
    assert.ok(msgs.includes('closure.local-aligned-to-remote'));
    assert.ok(msgs.includes('closure.manifest-moved-to-done'));
  } finally {
    h.cleanup();
  }
});

test('runClosure: confirmMerge async resolving true is honoured', async () => {
  const h = setup();
  try {
    const r = await runClosure(
      input(h, async () => Promise.resolve(true)),
      h.logger,
      'pr-open',
    );
    assert.equal(r.merged, true);
    assert.equal(r.outcome, 'merged');
    assert.ok(existsSync(join(h.paths.done, 'INIT-x.md')));
  } finally {
    h.cleanup();
  }
});

test('runClosure: confirmMerge throwing → treated as NOT merged (partial/unconfirmed is never merged)', async () => {
  const h = setup();
  try {
    const r = await runClosure(
      input(h, () => {
        throw new Error('gh exploded');
      }),
      h.logger,
      'pr-open',
    );
    assert.equal(r.merged, false);
    assert.equal(r.outcome, 'pr-open');
    assert.ok(!existsSync(join(h.paths.done, 'INIT-x.md')));
    assert.ok(h.events().some((e) => e.message === 'closure.confirm-merge-threw'));
  } finally {
    h.cleanup();
  }
});

test('runClosure: non-pr-open reviewer outcome is passed through, never merged, no confirm attempted', async () => {
  for (const ro of ['ready-for-review', 'send-back-cap-exhausted'] as ReviewerOutcome[]) {
    const h = setup();
    try {
      let confirmCalled = false;
      const r = await runClosure(
        input(h, () => {
          confirmCalled = true;
          return true;
        }),
        h.logger,
        ro,
      );
      assert.equal(r.outcome, ro);
      assert.equal(r.merged, false);
      assert.equal(confirmCalled, false, 'no merge confirmation for a non-pr-open outcome');
      assert.ok(!existsSync(join(h.paths.done, 'INIT-x.md')));
    } finally {
      h.cleanup();
    }
  }
});
