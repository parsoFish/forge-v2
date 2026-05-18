/**
 * PR + remote-sync boundary — the only place forge shells `git push` /
 * `gh pr ...` for the initiative branch.
 *
 * Extracted from cycle.ts (Phase 3 simplification) so the reviewer's
 * responsibility shrinks to assess + demo + open-PR, and the PR/merge
 * boundary is one named module. The create/merge split lets bench-mode
 * use a `gh` shim that records the operations locally without touching
 * real GitHub.
 *
 * Phase 6 (review-phase redesign) added the local↔remote sync primitives:
 *   - `pushInitiativeBranch` — dev-loop pushes per WI (G8 precondition).
 *   - `assertLocalRemoteSynced` — the G8 invariant: origin == local HEAD,
 *      main == merge-base. Throws on divergence.
 *   - `confirmPrMerged` — `gh pr view --json state` == MERGED. The ONLY
 *      gate for reflection (G10) + the `_queue/done/` move (G1).
 *   - `alignLocalToRemote` — on confirmed merge, ff local `main` and
 *      prune the initiative branch (closure aligns local↔remote).
 *
 * `mergePullRequest` is intentionally NOT called by any product code path
 * after Phase 6 (G9): the GitHub PR is the operator's merge surface. It is
 * retained only for bench/operator-tool use and is unreachable from
 * `runReviewer` / `runCycle` / the scheduler.
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { extname, join } from 'node:path';

/**
 * Best-effort PR creation via `gh pr create`. Returns the PR URL on success,
 * or null on failure. The reviewer's PR-description draft lives at
 * `<worktree>/.forge/pr-description.md` and is passed via `--body-file`.
 *
 * Pushes the local branch to the remote first; `gh pr create` requires the
 * branch to exist on origin. W4 trial caught this — pre-fix, openPullRequest
 * called `gh pr create` without a push, which fails with "no pull requests
 * found" since the branch wasn't published.
 */
/** Initiative id from a `forge/<initiativeId>` branch name. */
function basenameInitiativeId(branch: string): string {
  return branch.startsWith('forge/') ? branch.slice('forge/'.length) : branch;
}

/** Parse `owner/repo` from a git origin URL (https or ssh form). */
function parseOwnerRepo(originUrl: string): string | null {
  const s = originUrl.trim().replace(/\.git$/, '');
  const m =
    s.match(/github\.com[:/]([^/]+\/[^/]+)$/) ?? s.match(/[:/]([^/]+\/[^/]+)$/);
  return m ? m[1] : null;
}

const DEMO_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

/**
 * 2026-05-18 amendment: make the PR the SOLE review window. The reviewer
 * writes the demo bundle into `.forge/demos/<id>/` (gitignored — invisible
 * to a PR reviewer, who otherwise has to open a local HTML, infer the
 * change, then come back to comment). This copies that bundle into a
 * TRACKED `demo/<id>/` dir, commits it on the initiative branch, and
 * returns a `## Demo` markdown block that embeds the screenshots INLINE in
 * the PR body via GitHub raw URLs (and links non-image artefacts). After
 * this the reviewer sees and comments on everything from the PR alone.
 *
 * Best-effort: returns `null` on any failure (no demo, not a GitHub
 * remote, git error) so PR creation never breaks because of the demo.
 */
export function embedDemoInPr(
  worktreePath: string,
  initiativeId: string,
  branch: string,
): string | null {
  try {
    const srcDir = join(worktreePath, '.forge', 'demos', initiativeId);
    if (!existsSync(srcDir)) return null;
    const entries = readdirSync(srcDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((n) => !n.startsWith('.'));
    if (entries.length === 0) return null;

    const originUrl = execFileSync('git', ['-C', worktreePath, 'remote', 'get-url', 'origin'], {
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
    const ownerRepo = parseOwnerRepo(originUrl);
    if (!ownerRepo) return null; // only GitHub raw URLs render inline

    // Copy the bundle into a tracked path.
    const relDir = `demo/${initiativeId}`;
    const dstDir = join(worktreePath, relDir);
    mkdirSync(dstDir, { recursive: true });
    cpSync(srcDir, dstDir, { recursive: true, force: true });

    const images = entries.filter((n) => DEMO_IMAGE_EXTS.has(extname(n).toLowerCase())).sort();
    const others = entries
      .filter((n) => !DEMO_IMAGE_EXTS.has(extname(n).toLowerCase()))
      .sort();

    // Ensure a DEMO.md with RELATIVE image links exists. This is the
    // visibility-agnostic surface: GitHub renders a committed markdown
    // file (with relative images) for the authenticated reviewer on the
    // blob page even for a PRIVATE repo — whereas an `![](raw-url)` inline
    // in the PR body is fetched by GitHub's image proxy, which CANNOT read
    // a private repo and shows a broken image. Don't clobber an
    // agent-authored DEMO.md.
    const demoMdPath = join(dstDir, 'DEMO.md');
    if (!existsSync(demoMdPath) && images.length > 0) {
      const md = ['# Demo', ''];
      for (const img of images) {
        const label = img.replace(/\.[^.]+$/, '');
        md.push(`## ${label}`, '', `![${label}](./${img})`, '');
      }
      writeFileSync(demoMdPath, md.join('\n') + '\n');
    }

    // Commit the bundle on the branch (idempotent).
    execFileSync('git', ['add', '--', relDir], { cwd: worktreePath, stdio: 'pipe' });
    const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--', relDir], {
      cwd: worktreePath,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
    if (staged) {
      execFileSync(
        'git',
        ['commit', '-m', `docs(demo): embed review demo for ${initiativeId}`],
        { cwd: worktreePath, stdio: 'pipe' },
      );
    }

    // Repo visibility decides whether inline raw images render. Default to
    // PRIVATE (the safe assumption — a broken inline image is worse than a
    // link) if `gh` can't tell us.
    let isPrivate = true;
    try {
      const vis = execFileSync(
        'gh',
        ['repo', 'view', ownerRepo, '--json', 'isPrivate', '-q', '.isPrivate'],
        { cwd: worktreePath, stdio: 'pipe', encoding: 'utf8' },
      ).trim();
      isPrivate = vis !== 'false';
    } catch {
      /* keep the safe default */
    }

    const rawBase = `https://github.com/${ownerRepo}/raw/${branch}/${relDir}`;
    const blobBase = `https://github.com/${ownerRepo}/blob/${branch}/${relDir}`;
    const lines: string[] = ['', '---', '', '## Demo', ''];

    // Always: the reliable, visibility-agnostic surface.
    if (existsSync(demoMdPath)) {
      lines.push(
        `▶ **[Open the rendered demo: \`${relDir}/DEMO.md\`](${blobBase}/DEMO.md)**` +
          ' — renders inline on GitHub (works for private repos too).',
        '',
      );
    }
    lines.push(
      `The screenshots are also visible in this PR's **Files changed** tab` +
        ` (committed under \`${relDir}/\`).`,
      '',
    );

    if (!isPrivate && images.length > 0) {
      // Public repo: GitHub's proxy can fetch raw → inline them too.
      for (const img of images) {
        const label = img.replace(/\.[^.]+$/, '');
        lines.push(`**${label}**`, '', `![${label}](${rawBase}/${encodeURIComponent(img)})`, '');
      }
    }
    if (others.length > 0) {
      lines.push('Demo artefacts:');
      for (const f of others) lines.push(`- [\`${f}\`](${blobBase}/${encodeURIComponent(f)})`);
      lines.push('');
    }
    return lines.join('\n');
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? '';
    process.stderr.write(`[embedDemoInPr] non-fatal: ${stderr || e.message || 'failed'}\n`);
    return null;
  }
}

export function openPullRequest(
  worktreePath: string,
  prDescriptionPath: string,
  title: string,
): string | null {
  try {
    // Determine the current branch in the worktree.
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
    if (!branch || branch === 'HEAD') return null;

    // Make the PR self-contained: commit the demo bundle on the branch and
    // build a combined body (PR description + inline demo). Best-effort —
    // a demo failure must never block the PR. Done BEFORE the push so the
    // demo commit ships with the branch.
    let bodyFile = prDescriptionPath;
    try {
      const demoMd = embedDemoInPr(worktreePath, basenameInitiativeId(branch), branch);
      if (demoMd) {
        const base = existsSync(prDescriptionPath)
          ? readFileSync(prDescriptionPath, 'utf8')
          : '';
        const combined = join(worktreePath, '.forge', 'pr-body-with-demo.md');
        mkdirSync(join(worktreePath, '.forge'), { recursive: true });
        writeFileSync(combined, base + '\n' + demoMd + '\n');
        bodyFile = combined;
      }
    } catch {
      /* keep the plain description */
    }

    // Push to origin (set-upstream so gh pr create knows the head ref).
    // Failures here propagate to the catch — a non-pushable branch is a
    // genuine merge blocker, not a soft warning.
    execFileSync('git', ['push', '--set-upstream', 'origin', branch], {
      cwd: worktreePath,
      stdio: 'pipe',
    });

    const out = execFileSync(
      'gh',
      ['pr', 'create', '--body-file', bodyFile, '--title', title],
      { cwd: worktreePath, stdio: 'pipe', encoding: 'utf8' },
    );
    const match = out.match(/https:\S+/);
    return match ? match[0] : out.trim() || null;
  } catch (err) {
    // Surface the failure on stderr so the operator sees what went wrong;
    // openPullRequest's nullable return is otherwise opaque.
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? '';
    if (stderr) process.stderr.write(`[openPullRequest] ${stderr}\n`);
    else if (e.message) process.stderr.write(`[openPullRequest] ${e.message}\n`);
    return null;
  }
}

/**
 * Best-effort `gh pr merge` for the approved PR. Returns true on success.
 *
 * Notably does NOT pass `--delete-branch`: that flag makes `gh` switch the
 * project repo's HEAD to main and `git branch -D` the merged branch, which
 * fails when the project repo already has main checked out at
 * `projects/<name>/` (a forge worktree was added off the same repo). Branch
 * cleanup is owned by `worktree.cleanup()` in the scheduler's finally
 * block (F-09) — local branch deleted there, remote branch lingers
 * unless the GitHub repo has "auto-delete head branches" enabled.
 */
export function mergePullRequest(worktreePath: string): boolean {
  try {
    execFileSync('gh', ['pr', 'merge', '--merge'], {
      cwd: worktreePath,
      stdio: 'pipe',
    });
    return true;
  } catch (err) {
    // Surface the stderr for diagnostic visibility — the orchestrator's
    // event-log captures this via the merge-failed event_type.
    const e = err as { stderr?: Buffer | string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? '';
    if (stderr) process.stderr.write(`[mergePullRequest] ${stderr}\n`);
    return false;
  }
}

/**
 * Resolve the current branch name of a worktree. Returns null for a
 * detached HEAD or a non-git path (callers treat that as "cannot push").
 */
function currentBranch(worktreePath: string): string | null {
  try {
    const b = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
    return !b || b === 'HEAD' ? null : b;
  } catch {
    return null;
  }
}

function revParse(worktreePath: string, ref: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', ref], {
      cwd: worktreePath,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

export type PushResult =
  | { pushed: true; branch: string }
  | { pushed: false; reason: string };

/**
 * G8: push the initiative branch to `origin` so local == remote after
 * every work item. The dev-loop calls this per WI; keeping the branch
 * published every WI is the precondition the review redesign depends on
 * (no divergence → no stacked-PR merge conflicts at the boundary).
 *
 * `--set-upstream` so the first push establishes tracking; subsequent
 * pushes are fast-forwards. Best-effort by return value, not by throw:
 * a non-pushable worktree (no remote in a bench fixture without an
 * origin, detached HEAD) yields `{ pushed: false }` and the caller logs
 * it — the hard invariant is enforced separately by
 * `assertLocalRemoteSynced` at dev-loop close, which DOES throw.
 */
export function pushInitiativeBranch(worktreePath: string): PushResult {
  const branch = currentBranch(worktreePath);
  if (!branch) return { pushed: false, reason: 'detached HEAD or not a git repo' };
  try {
    execFileSync('git', ['push', '--set-upstream', 'origin', branch], {
      cwd: worktreePath,
      stdio: 'pipe',
    });
    return { pushed: true, branch };
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? '';
    return { pushed: false, reason: stderr || e.message || 'git push failed' };
  }
}

export type LocalRemoteInvariant = {
  ok: boolean;
  branch: string | null;
  localHead: string | null;
  originHead: string | null;
  mergeBase: string | null;
  mainHead: string | null;
  /** Human-readable reason when `ok` is false. */
  detail: string;
};

/**
 * G8 invariant check (pure inspection — never mutates). At dev-loop close
 * the following must hold:
 *   - `origin/<branch>` == local HEAD  (the branch is fully published)
 *   - `main` == merge-base(main, <branch>)  (main has not diverged; it is
 *      still the pre-initiative state and an ancestor of the branch)
 *
 * Returns a structured result so the caller can both assert AND emit the
 * exact ref hashes into the event log for post-mortem. `assertLocalRemoteSynced`
 * wraps this and throws on `ok === false`.
 */
export function checkLocalRemoteSynced(worktreePath: string): LocalRemoteInvariant {
  const branch = currentBranch(worktreePath);
  const localHead = revParse(worktreePath, 'HEAD');
  const originHead = branch ? revParse(worktreePath, `refs/remotes/origin/${branch}`) : null;
  const mainHead =
    revParse(worktreePath, 'refs/heads/main') ?? revParse(worktreePath, 'refs/remotes/origin/main');
  let mergeBase: string | null = null;
  if (branch && mainHead) {
    try {
      mergeBase = execFileSync('git', ['merge-base', 'main', branch], {
        cwd: worktreePath,
        stdio: 'pipe',
        encoding: 'utf8',
      }).trim();
    } catch {
      mergeBase = null;
    }
  }
  if (!branch) {
    return { ok: false, branch, localHead, originHead, mergeBase, mainHead, detail: 'detached HEAD or not a git repo' };
  }
  if (!originHead) {
    return {
      ok: false,
      branch,
      localHead,
      originHead,
      mergeBase,
      mainHead,
      detail: `origin/${branch} does not exist — branch was never pushed`,
    };
  }
  if (originHead !== localHead) {
    return {
      ok: false,
      branch,
      localHead,
      originHead,
      mergeBase,
      mainHead,
      detail: `origin/${branch} (${originHead.slice(0, 8)}) != local HEAD (${localHead?.slice(0, 8)}) — local diverged from remote`,
    };
  }
  if (mainHead && mergeBase && mainHead !== mergeBase) {
    return {
      ok: false,
      branch,
      localHead,
      originHead,
      mergeBase,
      mainHead,
      detail: `main (${mainHead.slice(0, 8)}) != merge-base (${mergeBase.slice(0, 8)}) — main diverged from the pre-initiative state`,
    };
  }
  return { ok: true, branch, localHead, originHead, mergeBase, mainHead, detail: 'origin == local HEAD; main == merge-base' };
}

/**
 * Throwing wrapper around `checkLocalRemoteSynced`. The dev-loop calls
 * this at close so a divergence is a hard, classifiable failure (the
 * review redesign cannot proceed on a branch that isn't published).
 */
export function assertLocalRemoteSynced(worktreePath: string): LocalRemoteInvariant {
  const r = checkLocalRemoteSynced(worktreePath);
  if (!r.ok) {
    throw new Error(`local↔remote invariant violated: ${r.detail}`);
  }
  return r;
}

/**
 * G10 / G1: confirm the PR is MERGED on the remote. The ONLY signal that
 * gates `runReflector` and the `_queue/done/` move. Never trusts an
 * orchestrator-internal flag — asks GitHub via `gh pr view --json state`.
 *
 * Returns false (not throw) for every non-MERGED case (open PR, no PR,
 * `gh` unavailable, GraphQL error): a partial / unconfirmed state must
 * NOT be treated as merged. The caller routes a false to `ready-for-review/`.
 */
export function confirmPrMerged(worktreePath: string): boolean {
  try {
    const out = execFileSync('gh', ['pr', 'view', '--json', 'state'], {
      cwd: worktreePath,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out) as { state?: unknown };
    return typeof parsed.state === 'string' && parsed.state.toUpperCase() === 'MERGED';
  } catch (err) {
    const e = err as { stderr?: Buffer | string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? '';
    if (stderr) process.stderr.write(`[confirmPrMerged] ${stderr}\n`);
    return false;
  }
}

export type AlignResult = {
  aligned: boolean;
  detail: string;
};

/**
 * Closure step: once the operator has merged the PR in GitHub, align the
 * local repo to the remote — fast-forward local `main` to `origin/main`
 * (which now contains the merged initiative) and delete the initiative
 * branch. Best-effort by return value: the merge already happened on the
 * remote, so a local-alignment hiccup must not fail the cycle (it is
 * cosmetic local hygiene, surfaced via the returned detail + event log).
 *
 * Caller contract: only invoke after `confirmPrMerged` returned true.
 *
 * 2026-05-18 fix: the prior implementation moved `refs/heads/main` with
 * `git update-ref` and deliberately SKIPPED the checkout, on the assumption
 * that "main may be checked out elsewhere". In the normal operator-merge
 * path the project repo at `projectRepoPath` IS the working checkout of
 * `main` (the forge worktree is a *separate* dir that gets removed), so a
 * bare ref move left the operator's working tree frozen at the pre-merge
 * code with a huge phantom reverse-diff in `git status` — they opened the
 * repo, saw OLD code, and could not review. When `projectRepoPath` is the
 * `main` checkout we now bring its WORKING TREE forward with
 * `merge --ff-only`, preserving any uncommitted operator/architect state
 * (e.g. `roadmap.md`, which the architect phase writes directly into the
 * project repo and which is NOT part of the merged initiative) via a
 * stash that is always restored or surfaced — never silently discarded.
 * The bare-ref path is kept as a fallback for the not-on-main case.
 */
export function alignLocalToRemote(
  worktreePath: string,
  initiativeBranch: string,
  projectRepoPath?: string,
): AlignResult {
  const steps: string[] = [];
  // Prefer the project repo for git ops (it shares the object store with the
  // forge worktree, so a fetch there populates origin/main for both).
  const gitCwd =
    projectRepoPath && existsSync(projectRepoPath) ? projectRepoPath : worktreePath;
  try {
    execFileSync('git', ['fetch', 'origin', '--prune'], { cwd: gitCwd, stdio: 'pipe' });
    steps.push('fetched origin');
  } catch {
    steps.push('fetch origin failed (non-fatal)');
  }
  const originMain = revParse(gitCwd, 'refs/remotes/origin/main');
  const localMain = revParse(gitCwd, 'refs/heads/main');

  let alignedViaProjectTree = false;
  if (
    projectRepoPath &&
    existsSync(projectRepoPath) &&
    originMain &&
    originMain !== localMain &&
    currentBranch(projectRepoPath) === 'main'
  ) {
    // The project repo is the working checkout of `main` — bring its WORKING
    // TREE (not just the ref) to origin/main. Preserve any uncommitted
    // operator/architect state via stash; never discard it silently.
    let dirty = false;
    try {
      const out = execFileSync('git', ['status', '--porcelain'], {
        cwd: projectRepoPath,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      dirty = out.trim().length > 0;
    } catch {
      /* if status is unreadable, treat as clean and let ff-only be the guard */
    }
    let stashed = false;
    if (dirty) {
      try {
        execFileSync(
          'git',
          ['stash', 'push', '--include-untracked', '-m', `forge-closure-preserve ${initiativeBranch}`],
          { cwd: projectRepoPath, stdio: 'pipe' },
        );
        stashed = true;
        steps.push('stashed uncommitted project changes');
      } catch {
        steps.push('could not stash uncommitted changes — skipped working-tree ff (no data loss)');
      }
    }
    if (!dirty || stashed) {
      try {
        execFileSync('git', ['merge', '--ff-only', 'origin/main'], {
          cwd: projectRepoPath,
          stdio: 'pipe',
        });
        steps.push(`project working tree fast-forwarded main → ${originMain.slice(0, 8)}`);
        alignedViaProjectTree = true;
      } catch {
        steps.push('project working-tree ff-only failed (non-fatal)');
      }
    }
    if (stashed) {
      try {
        execFileSync('git', ['stash', 'pop'], { cwd: projectRepoPath, stdio: 'pipe' });
        steps.push('restored uncommitted project changes');
      } catch {
        steps.push(
          'uncommitted changes kept in `git stash` (pop conflicted — operator resolves; no data loss)',
        );
      }
    }
  }

  if (!alignedViaProjectTree) {
    // Fallback: move the ref without a checkout (original behaviour) when the
    // project repo is not the `main` checkout / not provided.
    if (originMain && originMain !== localMain) {
      try {
        execFileSync('git', ['update-ref', 'refs/heads/main', originMain], {
          cwd: gitCwd,
          stdio: 'pipe',
        });
        steps.push(
          `fast-forwarded main ref → ${originMain.slice(0, 8)} (ref-only — project repo not the main checkout)`,
        );
      } catch {
        steps.push('main fast-forward failed (non-fatal)');
      }
    } else {
      steps.push('main already up to date');
    }
  }

  // Prune the initiative branch locally + on origin. The scheduler's
  // worktree.cleanup() also deletes the local branch in its finally; this
  // makes the closure self-contained for the operator-driven path.
  try {
    execFileSync('git', ['branch', '-D', initiativeBranch], { cwd: gitCwd, stdio: 'pipe' });
    steps.push(`deleted local ${initiativeBranch}`);
  } catch {
    steps.push(`local ${initiativeBranch} already gone`);
  }
  try {
    execFileSync('git', ['push', 'origin', '--delete', initiativeBranch], {
      cwd: gitCwd,
      stdio: 'pipe',
    });
    steps.push(`deleted origin ${initiativeBranch}`);
  } catch {
    steps.push(`origin ${initiativeBranch} already gone or undeletable`);
  }
  return { aligned: true, detail: steps.join('; ') };
}
