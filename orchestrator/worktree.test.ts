/**
 * Tests for orchestrator/worktree.ts — focused on F1.I4 self-heal: a fresh
 * `add()` succeeds even if the prior cycle left stale `.git/worktrees/`
 * registry entries or an orphan dir at the target path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { add, list, selfHealWorktreeState } from './worktree.ts';

function initBareIshRepo(): { dir: string; repo: string } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-worktree-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't'], { stdio: 'pipe' });
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { stdio: 'pipe' });
  return { dir, repo };
}

test('add: fresh path → creates worktree + branch cleanly', () => {
  const { dir, repo } = initBareIshRepo();
  try {
    const wt = add({
      projectRepoPath: repo,
      branch: 'forge/init-test',
      worktreesRoot: join(dir, '_wt'),
      initiativeId: 'INIT-fresh',
    });
    assert.ok(existsSync(wt.path));
    assert.equal(wt.branch, 'forge/init-test');
    assert.ok(list(repo).some((w) => resolve(w.path) === resolve(wt.path)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selfHealWorktreeState: stale registry entry (dir gone) → prune restores', () => {
  const { dir, repo } = initBareIshRepo();
  try {
    const wtRoot = join(dir, '_wt');
    // First add — succeeds normally.
    const first = add({
      projectRepoPath: repo,
      branch: 'forge/heal-test',
      worktreesRoot: wtRoot,
      initiativeId: 'INIT-heal',
    });
    // Operator deletes the worktree dir behind git's back (the failure
    // mode operators hit when they `rm -rf` then re-queue).
    rmSync(first.path, { recursive: true, force: true });
    // Registry still has the entry, would block a fresh `worktree add` to
    // the same path. selfHealWorktreeState clears it.
    selfHealWorktreeState(repo, first.path);
    // Registry should no longer think the orphan is a worktree.
    const knownAfterHeal = list(repo).some((w) => resolve(w.path) === resolve(first.path));
    assert.equal(knownAfterHeal, false, 'stale registry entry should be pruned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('add: stale registry + existing branch → self-heals and re-creates worktree', () => {
  const { dir, repo } = initBareIshRepo();
  try {
    const wtRoot = join(dir, '_wt');
    const initId = 'INIT-cycle-2';
    const branch = 'forge/cycle-2';
    // Cycle 1: add → succeeds.
    const first = add({
      projectRepoPath: repo,
      branch,
      worktreesRoot: wtRoot,
      initiativeId: initId,
    });
    rmSync(first.path, { recursive: true, force: true });
    // Cycle 2: add to the same path/branch — should self-heal, not throw.
    const second = add({
      projectRepoPath: repo,
      branch,
      worktreesRoot: wtRoot,
      initiativeId: initId,
    });
    assert.ok(existsSync(second.path));
    assert.equal(second.branch, branch);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selfHealWorktreeState: orphan dir (not in registry) → removed', () => {
  const { dir, repo } = initBareIshRepo();
  try {
    // Create an orphan dir at the would-be worktree path.
    const orphan = join(dir, '_wt', 'INIT-orphan');
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, 'leftover.txt'), 'from a prior life\n');
    assert.ok(existsSync(orphan));
    // Self-heal should detect it's not a real worktree and remove it.
    selfHealWorktreeState(repo, orphan);
    assert.equal(existsSync(orphan), false, 'orphan dir should be removed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
