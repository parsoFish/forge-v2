/**
 * Thin wrappers over `git worktree`. Per ADR 006, we use git worktrees natively
 * for filesystem isolation per parallel work unit; this module exists only to
 * track lockfiles, heartbeat path, and the `gh`-friendly conventions.
 *
 * All git invocations use `execFileSync` with arg arrays (not `execSync` with
 * a string template). This eliminates a class of shell-injection risk where
 * `projectRepoPath` (operator-supplied via the manifest, no format check) or
 * a custom `branch` name could embed a shell metacharacter.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export type WorktreeHandle = {
  path: string;
  branch: string;
  projectRepoPath: string;
};

export function add(opts: {
  projectRepoPath: string;
  branch: string;
  worktreesRoot: string;
  initiativeId: string;
}): WorktreeHandle {
  const path = resolve(opts.worktreesRoot, opts.initiativeId);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });

  // F1.I4 self-heal: a prior cycle may have left a stale `git worktree`
  // registry entry pointing at `path` (e.g., the dir was deleted out from
  // under git, or `forge requeue` removed it but the registry still has
  // the entry). Without these two steps, the subsequent `worktree add`
  // fails with "<path> already exists" or "is not a working tree". Both
  // are idempotent — no-op when the situation is clean.
  selfHealWorktreeState(opts.projectRepoPath, path);

  // Create branch off main and a worktree pointing at it.
  // -b creates the branch; if it already exists, we just point at it.
  const branchExists = (() => {
    try {
      execFileSync('git', ['-C', opts.projectRepoPath, 'rev-parse', '--verify', opts.branch], {
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  })();

  const args = branchExists
    ? ['-C', opts.projectRepoPath, 'worktree', 'add', path, opts.branch]
    : ['-C', opts.projectRepoPath, 'worktree', 'add', '-b', opts.branch, path];
  execFileSync('git', args, { stdio: 'pipe' });

  return { path, branch: opts.branch, projectRepoPath: opts.projectRepoPath };
}

/**
 * F1.I4: clear stale state before `git worktree add` to avoid collisions
 * with leftovers from prior cycles or manual operator intervention.
 *
 * Two cases handled:
 *   1. Stale registry entry: a previous `worktree add` recorded `path` in
 *      `.git/worktrees/`, but the dir is now gone. `git worktree prune`
 *      garbage-collects those entries.
 *   2. Orphan directory: `path` exists on disk but git doesn't know about
 *      it (someone `rm -rf'd then mkdir'd, or the registry entry was
 *      pruned earlier but the dir survived). Without removing the dir,
 *      `worktree add` fails with "already exists". We `rm -rf` it.
 *
 * Both calls are best-effort; production paths swallow errors.
 */
export function selfHealWorktreeState(projectRepoPath: string, path: string): void {
  try {
    execFileSync('git', ['-C', projectRepoPath, 'worktree', 'prune'], { stdio: 'pipe' });
  } catch {
    /* non-fatal */
  }
  // If `path` exists but is NOT in `git worktree list`, it's an orphan.
  // Removing it is the only safe option — a fresh `worktree add` would
  // EADDR otherwise.
  if (existsSync(path)) {
    const known = list(projectRepoPath).some((w) => resolve(w.path) === resolve(path));
    if (!known) {
      try { rmSync(path, { recursive: true, force: true }); } catch { /* */ }
    }
  }
}

export function remove(handle: WorktreeHandle, opts: { force?: boolean } = {}): void {
  const args = ['-C', handle.projectRepoPath, 'worktree', 'remove'];
  if (opts.force) args.push('--force');
  args.push(handle.path);
  try {
    execFileSync('git', args, { stdio: 'pipe' });
  } catch {
    // Best-effort: a worktree that's already gone is fine.
  }
}

/**
 * F-09: full cleanup of a worktree's filesystem footprint AND the branch it
 * was attached to. Idempotent — repeated calls are safe; missing artefacts
 * are not errors. Used by the scheduler at the end of every cycle (success
 * or failure) so worktrees + scratch branches don't accumulate.
 *
 * Sequence: `worktree remove --force` (handles the worktree dir + git's
 * internal `worktrees/` metadata) → `worktree prune` (cleans dangling
 * metadata if remove half-failed) → `branch -D` (deletes the scratch
 * branch; for merged initiatives `gh pr merge --delete-branch` already did
 * this and the call is a no-op).
 */
export function cleanup(handle: WorktreeHandle): void {
  try {
    execFileSync(
      'git',
      ['-C', handle.projectRepoPath, 'worktree', 'remove', '--force', handle.path],
      { stdio: 'pipe' },
    );
  } catch {
    /* worktree already gone, or never existed; non-fatal */
  }
  try {
    execFileSync('git', ['-C', handle.projectRepoPath, 'worktree', 'prune'], { stdio: 'pipe' });
  } catch {
    /* non-fatal */
  }
  try {
    execFileSync('git', ['-C', handle.projectRepoPath, 'branch', '-D', handle.branch], {
      stdio: 'pipe',
    });
  } catch {
    /* branch already deleted (e.g., gh pr merge --delete-branch) */
  }
}

export function exists(path: string): boolean {
  return existsSync(path);
}

export function list(projectRepoPath: string): Array<{ path: string; branch: string }> {
  try {
    const output = execFileSync(
      'git',
      ['-C', projectRepoPath, 'worktree', 'list', '--porcelain'],
      { encoding: 'utf8' },
    );
    const entries: Array<{ path: string; branch: string }> = [];
    let current: { path?: string; branch?: string } = {};
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path && current.branch) entries.push(current as { path: string; branch: string });
        current = { path: line.slice('worktree '.length) };
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice('branch refs/heads/'.length);
      }
    }
    if (current.path && current.branch) entries.push(current as { path: string; branch: string });
    return entries;
  } catch {
    return [];
  }
}
