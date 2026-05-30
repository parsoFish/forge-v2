/**
 * Production `gh` shim for projects without an `origin` remote.
 *
 * Operator's guidance (2026-05-24): "essentially mocking the git
 * remote to avoid the challenges of auth and potential network latency
 * and issues causing negative impacts to our forge development cycles
 * for use in no remote git repos." Local IS the source of truth; the
 * shim makes `gh pr create / view / merge` succeed by writing the same
 * `_pr-metadata.json` the bench's [benchmarks/_lib/gh-shim.ts] uses,
 * then doing the local fast-forward at merge time.
 *
 * Retained 2026-05-30 (ADR 023 §4 review): all current managed projects have
 * origins so this is dormant, but it stays as the deliberate no-remote model —
 * cleanly gated by `hasOriginRemote()` and orthogonal to the UI-surface work.
 *
 * Wired into [`orchestrator/pr.ts`]'s `openPullRequest`, `prRef`,
 * `confirmPrMerged`, and `mergePullRequest`. Each call site checks
 * `hasOriginRemote(worktreePath)` and dispatches to the shim function
 * when false. No PATH plumbing — the dispatch happens in-process so
 * the agent (which is told NOT to call `gh` directly per
 * skills/developer-unifier/SKILL.md) sees nothing.
 *
 * Branch validation accepts both `forge/<initiative-id>` (production)
 * and `initiative-<initiative-id>` (bench-style); the bench's shim
 * kept hard-coded `initiative-` because that's what its fixtures use.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** Branch prefixes the shim considers valid initiative branches. */
const INITIATIVE_BRANCH_PREFIXES = ['forge/', 'initiative-'];

export type GhMetadata = {
  created: boolean;
  merged: boolean;
  mergedBranch?: string;
  url?: string;
  title?: string;
  body?: string;
};

/**
 * Where the shim's metadata lives. Stable per-worktree path so
 * subsequent `gh` calls (view, merge) find what `pr create` wrote.
 * `.forge/` is gitignored across forge projects so this never
 * accidentally lands in the PR diff.
 */
export function ghMetadataPath(worktreePath: string): string {
  return join(worktreePath, '.forge', '_pr-metadata.json');
}

export function readGhMetadata(worktreePath: string): GhMetadata | null {
  const p = ghMetadataPath(worktreePath);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as GhMetadata;
  } catch {
    return null;
  }
}

function writeGhMetadata(worktreePath: string, meta: GhMetadata): void {
  const p = ghMetadataPath(worktreePath);
  mkdirSync(join(worktreePath, '.forge'), { recursive: true });
  writeFileSync(p, JSON.stringify(meta, null, 2));
}

export type ShimResult =
  | { ok: true; stdout: string }
  | { ok: false; stderr: string; exitCode: number };

/**
 * Emulates `gh pr create --body-file <path> --title <title>` for a
 * no-origin project: records the PR metadata + returns a stable
 * synthetic URL. Matches the bench's shim's contract so anything
 * reading `_pr-metadata.json` (post-merge, etc) works identically.
 */
export function shimPrCreate(
  worktreePath: string,
  args: { bodyFile?: string; title: string },
): ShimResult {
  let body = '';
  if (args.bodyFile && existsSync(args.bodyFile)) {
    body = readFileSync(args.bodyFile, 'utf8');
  }
  const url = 'https://local.forge/pr/1';
  writeGhMetadata(worktreePath, { created: true, merged: false, url, title: args.title, body });
  return { ok: true, stdout: url };
}

/**
 * Emulates `gh pr view --json state` (the only field the orchestrator
 * actually reads via `pr.ts:confirmPrMerged`). MERGED iff `pr merge`
 * was previously dispatched; OPEN iff a PR was created but not
 * merged; exits 1 iff no PR exists (matches real `gh`).
 */
export function shimPrViewState(worktreePath: string): ShimResult {
  const meta = readGhMetadata(worktreePath);
  if (!meta || !meta.created) {
    return { ok: false, stderr: 'no pull requests found for the current branch', exitCode: 1 };
  }
  return { ok: true, stdout: JSON.stringify({ state: meta.merged ? 'MERGED' : 'OPEN' }) };
}

/**
 * Emulates `gh pr view <branch> --json number,url,state -q '...'` for
 * `pr.ts:prRef`. Returns a synthetic OPEN-state ref iff a PR exists
 * locally and is not merged.
 */
export function shimPrViewForRef(worktreePath: string): ShimResult {
  const meta = readGhMetadata(worktreePath);
  if (!meta || !meta.created) {
    return { ok: false, stderr: 'no pull requests found for the current branch', exitCode: 1 };
  }
  const state = meta.merged ? 'MERGED' : 'OPEN';
  return { ok: true, stdout: JSON.stringify({ n: 1, u: meta.url ?? 'https://local.forge/pr/1', s: state }) };
}

/**
 * Emulates `gh pr merge --merge [--delete-branch]` for a no-origin
 * project:
 *   1. Commits any pending work (do NOT `git reset --hard`; that
 *      would wipe an in-flight reviewer iteration).
 *   2. Checks out main, fast-forwards to the initiative branch.
 *   3. Marks the metadata merged + records `mergedBranch`.
 *   4. Optionally deletes the local branch.
 *
 * Lifted shape-for-shape from [benchmarks/_lib/gh-shim.ts]; the only
 * difference is the wider branch-prefix acceptance list
 * (`forge/` for production, `initiative-` for the bench's existing
 * fixtures).
 */
export function shimPrMerge(
  worktreePath: string,
  args: { deleteBranch?: boolean } = {},
): ShimResult {
  const meta = readGhMetadata(worktreePath);
  if (!meta || !meta.created) {
    return { ok: false, stderr: 'no PR has been created yet', exitCode: 1 };
  }
  let branch: string;
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8',
    }).trim();
  } catch (err) {
    return { ok: false, stderr: `git rev-parse failed: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 };
  }
  if (!INITIATIVE_BRANCH_PREFIXES.some((p) => branch.startsWith(p))) {
    return { ok: false, stderr: `current branch is not an initiative branch (must start with one of ${INITIATIVE_BRANCH_PREFIXES.join(', ')}): ${branch}`, exitCode: 1 };
  }
  try {
    // Commit pending work BEFORE checkout (do NOT reset --hard; would
    // wipe the agent's uncommitted final iteration). `.gitignore`
    // already excludes Ralph scratch (AGENT.md / fix_plan.md /
    // PROMPT.md / node_modules) so `git add -A` won't sweep them in.
    execFileSync('git', ['add', '-A'], { cwd: worktreePath, stdio: 'pipe' });
    execFileSync(
      'git',
      ['commit', '--allow-empty', '-q', '-m', 'chore(review): final iteration before merge (gh-shim)'],
      { cwd: worktreePath, stdio: 'pipe' },
    );
  } catch {
    /* nothing to commit is fine */
  }
  try {
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: worktreePath, stdio: 'pipe' });
  } catch {
    // Fall back to master if main doesn't exist (matches the
    // base-branch resolution in loops/ralph/stop-conditions.ts).
    try {
      execFileSync('git', ['checkout', '-q', 'master'], { cwd: worktreePath, stdio: 'pipe' });
    } catch (err) {
      return { ok: false, stderr: `no main/master branch to merge into: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 };
    }
  }
  try {
    execFileSync('git', ['merge', '--ff-only', '-q', branch], { cwd: worktreePath, stdio: 'pipe' });
  } catch (err) {
    return { ok: false, stderr: `ff-only merge failed (branch likely diverged): ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 };
  }
  if (args.deleteBranch) {
    try { execFileSync('git', ['branch', '-D', branch], { cwd: worktreePath, stdio: 'pipe' }); }
    catch { /* best-effort */ }
  }
  writeGhMetadata(worktreePath, { ...meta, merged: true, mergedBranch: branch });
  return { ok: true, stdout: `Merged ${branch} into main (gh-shim).` };
}
