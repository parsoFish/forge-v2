/**
 * Tests for orchestrator/pr.ts — the Phase-6 local↔remote sync + PR
 * boundary primitives. These assert the NEW (review-redesign) contract:
 *
 *   - G8: `checkLocalRemoteSynced` / `assertLocalRemoteSynced` enforce
 *     `origin/<branch>` == local HEAD AND `main` == merge-base.
 *   - G10/G1: `confirmPrMerged` returns true ONLY when `gh pr view`
 *     reports MERGED — never on any other state.
 *   - closure: `alignLocalToRemote` fast-forwards local main + prunes the
 *     initiative branch.
 *   - `pushInitiativeBranch` publishes the branch to origin.
 *
 * Real tiny git repos with a bare origin (same pattern the review-loop
 * bench setup uses). `confirmPrMerged` is tested with a `gh` PATH-shim so
 * no real GitHub is touched. No SDK calls.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  alignLocalToRemote,
  assertLocalRemoteSynced,
  assertTrackedDemoExists,
  checkLocalRemoteSynced,
  confirmPrMerged,
  embedDemoInPr,
  pushInitiativeBranch,
} from './pr.ts';

function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
}

/**
 * Build a repo on `main` with a base commit, a bare origin (main pushed),
 * and an `initiative-x` branch checked out with one extra commit. Mirrors
 * the dev-loop-close shape.
 */
function makeRepoWithOrigin(): { root: string; proj: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'forge-pr-test-'));
  const proj = join(root, 'proj');
  mkdirSync(proj, { recursive: true });
  sh(proj, 'git', ['init', '-q', '-b', 'main']);
  sh(proj, 'git', ['config', 'user.email', 't@forge']);
  sh(proj, 'git', ['config', 'user.name', 'forge-test']);
  writeFileSync(join(proj, 'README.md'), 'base\n');
  sh(proj, 'git', ['add', '.']);
  sh(proj, 'git', ['commit', '-q', '-m', 'base']);
  const origin = join(root, 'origin.git');
  sh(proj, 'git', ['init', '-q', '--bare', origin]);
  sh(proj, 'git', ['remote', 'add', 'origin', origin]);
  sh(proj, 'git', ['push', '-q', 'origin', 'main']);
  sh(proj, 'git', ['checkout', '-q', '-b', 'initiative-x']);
  writeFileSync(join(proj, 'feature.txt'), 'work\n');
  sh(proj, 'git', ['add', '.']);
  sh(proj, 'git', ['commit', '-q', '-m', 'feat: work']);
  return { root, proj, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ---- G8: pushInitiativeBranch + the local↔remote invariant ----

test('pushInitiativeBranch: publishes the current branch to origin', () => {
  const { proj, cleanup } = makeRepoWithOrigin();
  try {
    const r = pushInitiativeBranch(proj);
    assert.equal(r.pushed, true);
    assert.equal(r.pushed && r.branch, 'initiative-x');
    // origin now has the branch at local HEAD.
    const local = sh(proj, 'git', ['rev-parse', 'HEAD']).trim();
    const remote = sh(proj, 'git', ['rev-parse', 'refs/remotes/origin/initiative-x']).trim();
    assert.equal(remote, local);
  } finally {
    cleanup();
  }
});

test('pushInitiativeBranch: not a git repo → { pushed: false } (no throw)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-pr-nogit-'));
  try {
    const r = pushInitiativeBranch(dir);
    assert.equal(r.pushed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkLocalRemoteSynced + assertLocalRemoteSynced: OK when branch pushed and main == merge-base', () => {
  const { proj, cleanup } = makeRepoWithOrigin();
  try {
    pushInitiativeBranch(proj);
    const inv = checkLocalRemoteSynced(proj);
    assert.equal(inv.ok, true);
    assert.equal(inv.branch, 'initiative-x');
    assert.equal(inv.originHead, inv.localHead);
    assert.equal(inv.mainHead, inv.mergeBase);
    // The asserting wrapper does not throw.
    assert.doesNotThrow(() => assertLocalRemoteSynced(proj));
  } finally {
    cleanup();
  }
});

test('assertLocalRemoteSynced: THROWS when the branch was never pushed (local diverged from remote)', () => {
  const { proj, cleanup } = makeRepoWithOrigin();
  try {
    // No pushInitiativeBranch → origin/initiative-x does not exist.
    const inv = checkLocalRemoteSynced(proj);
    assert.equal(inv.ok, false);
    assert.match(inv.detail, /never pushed|does not exist/);
    assert.throws(() => assertLocalRemoteSynced(proj), /local↔remote invariant violated/);
  } finally {
    cleanup();
  }
});

test('assertLocalRemoteSynced: THROWS when local has an unpushed commit ahead of origin', () => {
  const { proj, cleanup } = makeRepoWithOrigin();
  try {
    pushInitiativeBranch(proj); // origin == local
    // Add a local commit WITHOUT pushing → divergence.
    writeFileSync(join(proj, 'extra.txt'), 'unpushed\n');
    sh(proj, 'git', ['add', '.']);
    sh(proj, 'git', ['commit', '-q', '-m', 'unpushed work']);
    const inv = checkLocalRemoteSynced(proj);
    assert.equal(inv.ok, false);
    assert.match(inv.detail, /local diverged from remote/);
    assert.throws(() => assertLocalRemoteSynced(proj), /local↔remote invariant violated/);
  } finally {
    cleanup();
  }
});

test('checkLocalRemoteSynced: detects main diverged from the merge-base', () => {
  const { proj, cleanup } = makeRepoWithOrigin();
  try {
    pushInitiativeBranch(proj);
    // Advance local main so it is no longer the merge-base (pre-initiative
    // state). This is exactly the stacked-PR divergence the invariant guards.
    sh(proj, 'git', ['checkout', '-q', 'main']);
    writeFileSync(join(proj, 'mainonly.txt'), 'diverged\n');
    sh(proj, 'git', ['add', '.']);
    sh(proj, 'git', ['commit', '-q', '-m', 'main diverged']);
    sh(proj, 'git', ['checkout', '-q', 'initiative-x']);
    const inv = checkLocalRemoteSynced(proj);
    assert.equal(inv.ok, false);
    assert.match(inv.detail, /main diverged from the pre-initiative state/);
  } finally {
    cleanup();
  }
});

// ---- G10 / G1: confirmPrMerged is the ONLY merge signal ----

function withGhShim(root: string, stateJson: string | null): string {
  // A `gh` PATH-shim: `gh pr view --json state` prints `stateJson` (or
  // exits non-zero when null, modelling "no PR / gh error").
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const shim = join(binDir, 'gh');
  const body =
    stateJson === null
      ? `#!/usr/bin/env node
process.stderr.write('no pull requests found\\n');
process.exit(1);
`
      : `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'pr' && a[1] === 'view') { console.log(${JSON.stringify(stateJson)}); process.exit(0); }
process.stderr.write('unsupported\\n');
process.exit(1);
`;
  writeFileSync(shim, body);
  chmodSync(shim, 0o755);
  return binDir;
}

test('confirmPrMerged: true ONLY when gh reports state MERGED', () => {
  const { root, proj, cleanup } = makeRepoWithOrigin();
  const originalPath = process.env.PATH ?? '';
  try {
    const binDir = withGhShim(root, '{"state":"MERGED"}');
    process.env.PATH = `${binDir}:${originalPath}`;
    assert.equal(confirmPrMerged(proj), true);
  } finally {
    process.env.PATH = originalPath;
    cleanup();
  }
});

test('confirmPrMerged: false for OPEN PR (no auto-treat-as-merged)', () => {
  const { root, proj, cleanup } = makeRepoWithOrigin();
  const originalPath = process.env.PATH ?? '';
  try {
    const binDir = withGhShim(root, '{"state":"OPEN"}');
    process.env.PATH = `${binDir}:${originalPath}`;
    assert.equal(confirmPrMerged(proj), false);
  } finally {
    process.env.PATH = originalPath;
    cleanup();
  }
});

test('confirmPrMerged: false when gh errors / no PR (partial/unconfirmed is NOT merged)', () => {
  const { root, proj, cleanup } = makeRepoWithOrigin();
  const originalPath = process.env.PATH ?? '';
  try {
    const binDir = withGhShim(root, null);
    process.env.PATH = `${binDir}:${originalPath}`;
    assert.equal(confirmPrMerged(proj), false);
  } finally {
    process.env.PATH = originalPath;
    cleanup();
  }
});

// ---- closure: alignLocalToRemote ----

test('alignLocalToRemote: fast-forwards local main to origin/main and prunes the initiative branch', () => {
  const { root, proj, cleanup } = makeRepoWithOrigin();
  try {
    pushInitiativeBranch(proj);
    // Model the operator merging the PR on the remote: push initiative-x
    // into origin/main (ff). After this origin/main is ahead of local main.
    const clone = join(root, 'clone');
    sh(root, 'git', ['clone', '-q', join(root, 'origin.git'), clone]);
    sh(clone, 'git', ['config', 'user.email', 't@forge']);
    sh(clone, 'git', ['config', 'user.name', 'forge-test']);
    sh(clone, 'git', ['fetch', '-q', 'origin', 'initiative-x']);
    sh(clone, 'git', ['checkout', '-q', 'main']);
    sh(clone, 'git', ['merge', '-q', '--ff-only', 'origin/initiative-x']);
    sh(clone, 'git', ['push', '-q', 'origin', 'main']);

    const beforeMain = sh(proj, 'git', ['rev-parse', 'refs/heads/main']).trim();
    const r = alignLocalToRemote(proj, 'initiative-x');
    assert.equal(r.aligned, true);
    const afterMain = sh(proj, 'git', ['rev-parse', 'refs/heads/main']).trim();
    const originMain = sh(proj, 'git', ['rev-parse', 'refs/remotes/origin/main']).trim();
    assert.notEqual(afterMain, beforeMain, 'local main moved');
    assert.equal(afterMain, originMain, 'local main == origin/main (fast-forwarded)');
    // The branch prune is best-effort: `git branch -D` cannot delete the
    // CURRENTLY-CHECKED-OUT branch (the closure runs in the worktree where
    // initiative-x is checked out), so the authoritative branch deletion
    // is owned by the scheduler's worktree.cleanup() from the main repo.
    // Here it stays checked out — the load-bearing assertion is the
    // local-main fast-forward above. The detail records the no-op.
    assert.match(r.detail, /initiative-x already gone|deleted local initiative-x/);
    // On a detached/non-current branch the prune DOES delete: verify the
    // prune path works by checking out a different ref and re-pruning a
    // throwaway branch.
    sh(proj, 'git', ['checkout', '-q', 'main']);
    sh(proj, 'git', ['branch', 'tmp-prune-me']);
    const r2 = alignLocalToRemote(proj, 'tmp-prune-me');
    assert.equal(r2.aligned, true);
    assert.throws(() => sh(proj, 'git', ['rev-parse', '--verify', 'refs/heads/tmp-prune-me']));
  } finally {
    cleanup();
  }
});

test('alignLocalToRemote: best-effort — returns aligned even when nothing to do', () => {
  const { proj, cleanup } = makeRepoWithOrigin();
  try {
    // No remote merge happened; main already matches. Must not throw.
    const r = alignLocalToRemote(proj, 'nonexistent-branch');
    assert.equal(r.aligned, true);
    assert.match(r.detail, /already up to date|main/);
  } finally {
    cleanup();
  }
});

// ---- S4: assertTrackedDemoExists + embedDemoInPr (pure composer) ----

test('assertTrackedDemoExists: throws when demo/<id>/DEMO.md is missing', () => {
  const { proj, cleanup } = makeRepoWithOrigin();
  try {
    assert.throws(
      () => assertTrackedDemoExists(proj, 'INIT-missing'),
      /dev-loop-unifier-demo-failed/,
    );
  } finally {
    cleanup();
  }
});

test('assertTrackedDemoExists: returns the demo dir when DEMO.md exists', () => {
  const { proj, cleanup } = makeRepoWithOrigin();
  try {
    mkdirSync(join(proj, 'demo', 'INIT-ok'), { recursive: true });
    writeFileSync(join(proj, 'demo', 'INIT-ok', 'DEMO.md'), '# Demo\n');
    const dir = assertTrackedDemoExists(proj, 'INIT-ok');
    assert.equal(dir, join(proj, 'demo', 'INIT-ok'));
  } finally {
    cleanup();
  }
});

test('embedDemoInPr (S4 signature): returns null when trackedDemoDir is missing', () => {
  const { proj, cleanup } = makeRepoWithOrigin();
  try {
    const result = embedDemoInPr(proj, 'INIT-x', 'forge/INIT-x', join(proj, 'demo', 'INIT-x'), true);
    assert.equal(result, null);
  } finally {
    cleanup();
  }
});
