/**
 * Tests for orchestrator/cycle.ts internal helpers. Heavy SDK-dependent paths
 * (runProjectManager, runDeveloperLoop, runReviewer, runReflector) are
 * exercised by their respective benchmarks; this file covers the small
 * orchestration utilities the cycle uses for gates and routing — F-13
 * brain-first gate, F-11 status routing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recordBrainGateResult } from './cycle.ts';
import { createLogger, type EventLogEntry } from './logging.ts';

function setupLogger(): { dir: string; logger: ReturnType<typeof createLogger>; cycleId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-cycle-test-'));
  const cycleId = 'TEST-cycle-2026-05-10';
  const logsDir = join(dir, '_logs');
  mkdirSync(logsDir, { recursive: true });
  const logger = createLogger(cycleId, logsDir);
  return { dir, logger, cycleId };
}

function readEvents(logger: ReturnType<typeof createLogger>): EventLogEntry[] {
  const text = readFileSync(logger.logFilePath, 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as EventLogEntry);
}

// ----- recordBrainGateResult -----

test('recordBrainGateResult: returns true and emits no event when brainReads > 0', () => {
  const { dir, logger } = setupLogger();
  try {
    const result = recordBrainGateResult('project-manager', 'project-manager', 1, {
      initiativeId: 'INIT-test',
      logger,
    });
    assert.equal(result, true);
    // No events emitted (brain consulted, gate passes silently).
    assert.ok(!existsSync(logger.logFilePath) || readEvents(logger).length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordBrainGateResult: returns false and emits a brain-skipped error event when brainReads === 0', () => {
  const { dir, logger } = setupLogger();
  try {
    const result = recordBrainGateResult('project-manager', 'project-manager', 0, {
      initiativeId: 'INIT-test',
      logger,
    });
    assert.equal(result, false);
    const events = readEvents(logger);
    assert.equal(events.length, 1);
    assert.equal(events[0].phase, 'project-manager');
    assert.equal(events[0].skill, 'project-manager');
    assert.equal(events[0].event_type, 'error');
    assert.equal(events[0].message, 'project-manager.brain-skipped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordBrainGateResult: emits per-WI subject in metadata for dev-loop', () => {
  const { dir, logger } = setupLogger();
  try {
    const result = recordBrainGateResult('developer-loop', 'developer-ralph', 0, {
      initiativeId: 'INIT-test',
      logger,
      subject: 'WI-3',
    });
    assert.equal(result, false);
    const events = readEvents(logger);
    assert.equal(events.length, 1);
    assert.equal(events[0].message, 'developer-ralph.brain-skipped');
    assert.deepEqual(events[0].metadata, { subject: 'WI-3' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordBrainGateResult: parentEventId is propagated for child-event correlation', () => {
  const { dir, logger } = setupLogger();
  try {
    recordBrainGateResult('reflection', 'reflector', 0, {
      initiativeId: 'INIT-test',
      logger,
      parentEventId: 'EV_parent_123',
    });
    const events = readEvents(logger);
    assert.equal(events[0].parent_event_id, 'EV_parent_123');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- F-30: adaptive reviewer iteration cap ----

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { computeAdaptiveReviewIterationCap } from './cycle.ts';

function makeRepoWithChangedFiles(count: number): { dir: string; worktree: string } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-adaptive-'));
  // Initialise a tiny repo on `main` with a base commit, then create a feature
  // branch with `count` extra committed files so `git diff main...HEAD
  // --name-only` reports exactly `count` lines.
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@forge']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'forge-test']);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'base']);
  execFileSync('git', ['-C', dir, 'checkout', '-q', '-b', 'feature']);
  for (let i = 0; i < count; i++) {
    writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
  }
  if (count > 0) {
    execFileSync('git', ['-C', dir, 'add', '.']);
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', `${count} files`]);
  }
  return { dir, worktree: dir };
}

test('computeAdaptiveReviewIterationCap: ≤20 changed files → 3 (default)', () => {
  const { dir, worktree } = makeRepoWithChangedFiles(10);
  try {
    assert.equal(computeAdaptiveReviewIterationCap(worktree), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeAdaptiveReviewIterationCap: 21-50 changed files → 4', () => {
  const { dir, worktree } = makeRepoWithChangedFiles(35);
  try {
    assert.equal(computeAdaptiveReviewIterationCap(worktree), 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeAdaptiveReviewIterationCap: 100+ changed files → 5/6/8 by tier', () => {
  const c1 = makeRepoWithChangedFiles(75);
  const c2 = makeRepoWithChangedFiles(150);
  const c3 = makeRepoWithChangedFiles(250);
  try {
    assert.equal(computeAdaptiveReviewIterationCap(c1.worktree), 5);
    assert.equal(computeAdaptiveReviewIterationCap(c2.worktree), 6);
    assert.equal(computeAdaptiveReviewIterationCap(c3.worktree), 8);
  } finally {
    rmSync(c1.dir, { recursive: true, force: true });
    rmSync(c2.dir, { recursive: true, force: true });
    rmSync(c3.dir, { recursive: true, force: true });
  }
});

test('computeAdaptiveReviewIterationCap: not a git repo → falls back to default 3', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-not-a-repo-'));
  try {
    assert.equal(computeAdaptiveReviewIterationCap(dir), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
