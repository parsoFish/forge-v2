/**
 * Shared `gh` PATH-shim + event-log reconstruction plumbing for bench
 * harnesses that drive the real `runCycle` / `runReviewer` (which call
 * `openPullRequest` + `mergePullRequest`).
 *
 * Lifted from `benchmarks/e2e/sdk.ts` (Phase 5 / 5.1) so the (removed)
 * standalone-e2e logic and the new chained sequencer share one
 * implementation rather than each carrying a copy. The `gh` shim is smarter
 * than the reject-everything shim in `recorder-shims.ts`: it handles
 * `pr create` (records metadata + outputs a fake URL) and `pr merge`
 * (commits pending work — never `git reset --hard` — then fast-forwards the
 * initiative branch into main locally + marks metadata merged), so the
 * orchestrator's PR path completes in bench mode without touching GitHub.
 *
 * Phase 5 plumbing — the durable `.forge/` snapshot. The gh-shim's
 * post-merge `git clean -fdX` strips gitignored `.forge/` (PR description +
 * demos), which the review-loop / reflection rubrics need. Before the merge
 * the shim copies `<proj>/.forge` → `<tempdir>/_forge-snapshot` (path-stable,
 * survives `git clean`). Harnesses point the review/reflection `caseScore`
 * at `forgeSnapshotDir(tempdir)` when the post-merge worktree may have been
 * cleaned. `cleanAfterMerge` is opt-out (default true → preserves the prior
 * e2e behaviour); set false for fixtures with no `.gitignore` where the
 * worktree `.forge/` survives anyway.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Verdict } from '../../orchestrator/file-verdict.ts';

/**
 * Minimal review-Ralph gate-state shape used by the e2e bench for reconstructing
 * round telemetry from the event log. Mirrors the now-deleted
 * `ReviewerGateState` type from `orchestrator/reviewer-stage2.ts` (S4 deletion).
 */
type ReviewerGateState = {
  invocations: number;
  verdicts: Verdict[];
};

export type BuildGhShimOptions = {
  /**
   * Run `git clean -fdX --exclude=node_modules` after the ff-merge. Default
   * true (preserves the prior standalone-e2e behaviour: a realistic merge
   * strips gitignored scratch). The pre-merge `.forge/` snapshot is taken
   * regardless, so review/reflection artifacts survive either way.
   */
  cleanAfterMerge?: boolean;
};

/** Directory the shim snapshots `<proj>/.forge` into before the merge. */
export function forgeSnapshotDir(tempdir: string): string {
  return join(tempdir, '_forge-snapshot');
}

/**
 * The `gh` shim handles three subcommands:
 *   `gh pr create --body-file <path> --title <title>` → records the PR
 *     metadata to `<tempdir>/_pr-metadata.json` and prints a fake URL.
 *   `gh pr merge --merge [--delete-branch]` → snapshots `.forge/`, commits
 *     any pending work (NOT `git reset --hard` — that would wipe the
 *     reviewer's uncommitted source files), fast-forwards the initiative
 *     branch into main, optionally `git clean`s, marks metadata merged.
 *     Phase 6: the orchestrator NEVER calls this (no auto-merge / G9) —
 *     it models the OPERATOR clicking "merge". The chained harness invokes
 *     it from its injected `confirmMerge` hook (the simulated operator),
 *     so the chain exercises closure + reflection end-to-end while
 *     `mergePullRequest` stays unreachable from every product path.
 *   `gh pr view --json state` → prints `{"state":"MERGED"}` iff the
 *     metadata records a merge, else `{"state":"OPEN"}`. This is the
 *     signal `orchestrator/pr.ts:confirmPrMerged` reads (G10/G1): the
 *     closure step (and reflection) only proceed on a confirmed MERGED.
 *
 * Anything else exits non-zero with a stderr message. Implemented as a node
 * script so it can use child_process.execFileSync for the git plumbing.
 */
export function buildGhShimScript(
  projDir: string,
  tempdir: string,
  opts: BuildGhShimOptions = {},
): string {
  const cleanAfterMerge = opts.cleanAfterMerge ?? true;
  // Inline the project + tempdir paths so the shim doesn't need env-var
  // wiring. Single-fixture bench → single tempdir per setup.
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROJ = ${JSON.stringify(projDir)};
const TEMPDIR = ${JSON.stringify(tempdir)};
const CLEAN_AFTER_MERGE = ${JSON.stringify(cleanAfterMerge)};
const META_PATH = path.join(TEMPDIR, '_pr-metadata.json');
const FORGE_SNAPSHOT = path.join(TEMPDIR, '_forge-snapshot');

function loadMeta() {
  try { return JSON.parse(fs.readFileSync(META_PATH, 'utf8')); } catch { return null; }
}
function saveMeta(m) { fs.writeFileSync(META_PATH, JSON.stringify(m, null, 2)); }

const argv = process.argv.slice(2);
const sub = argv[0];

function flag(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  return argv[i + 1] ?? null;
}

try {
  if (sub === 'pr' && argv[1] === 'view' && argv.includes('--json')) {
    // G10/G1: orchestrator/pr.ts:confirmPrMerged reads this. MERGED iff a
    // merge was recorded (the simulated operator ran 'gh pr merge'); OPEN
    // otherwise. A missing PR → exit 1 (gh's real behaviour), which
    // confirmPrMerged treats as "not merged".
    const meta = loadMeta();
    if (!meta || !meta.created) {
      process.stderr.write('[gh shim] no pull requests found for the current branch\\n');
      process.exit(1);
    }
    console.log(JSON.stringify({ state: meta.merged ? 'MERGED' : 'OPEN' }));
    process.exit(0);
  }
  if (sub === 'pr' && argv[1] === 'create') {
    const bodyFile = flag('--body-file');
    const title = flag('--title') ?? 'PR';
    let body = '';
    if (bodyFile && fs.existsSync(bodyFile)) body = fs.readFileSync(bodyFile, 'utf8');
    const url = 'https://bench.local/pr/1';
    saveMeta({ created: true, merged: false, url, title, body });
    console.log(url);
    process.exit(0);
  }
  if (sub === 'pr' && argv[1] === 'merge') {
    const meta = loadMeta();
    if (!meta || !meta.created) {
      process.stderr.write('[gh shim] no PR has been created yet\\n');
      process.exit(1);
    }
    // Identify the current branch (initiative-<id>) and fast-forward main.
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: PROJ, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8',
    }).trim();
    if (!branch.startsWith('initiative-')) {
      process.stderr.write('[gh shim] current branch is not an initiative branch: ' + branch + '\\n');
      process.exit(1);
    }
    // Durable pre-merge snapshot of .forge/ (PR description + demos). This
    // survives both 'git checkout main' and the optional 'git clean -fdX'.
    try {
      const forgeDir = path.join(PROJ, '.forge');
      if (fs.existsSync(forgeDir)) {
        fs.rmSync(FORGE_SNAPSHOT, { recursive: true, force: true });
        fs.cpSync(forgeDir, FORGE_SNAPSHOT, { recursive: true });
      }
    } catch { /* best-effort — the rubric falls back to the worktree */ }
    // Commit any pending work before checkout (do NOT reset --hard — that
    // would wipe the reviewer agent's uncommitted source files written in
    // its last iteration). Anything Ralph-scratch (AGENT.md / fix_plan.md /
    // PROMPT.md / node_modules) is in .gitignore so 'git add -A' skips it.
    try {
      execFileSync('git', ['add', '-A'], { cwd: PROJ, stdio: 'pipe' });
      execFileSync(
        'git',
        ['commit', '--allow-empty', '-q', '-m', 'chore(review): final reviewer iteration'],
        { cwd: PROJ, stdio: 'pipe' },
      );
    } catch { /* nothing to commit is fine */ }
    if (CLEAN_AFTER_MERGE) {
      try {
        execFileSync('git', ['clean', '-fdX', '--exclude=node_modules'], { cwd: PROJ, stdio: 'pipe' });
      } catch { /* best-effort */ }
    }
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: PROJ, stdio: 'pipe' });
    execFileSync('git', ['merge', '--ff-only', '-q', branch], { cwd: PROJ, stdio: 'pipe' });
    if (argv.includes('--delete-branch')) {
      try { execFileSync('git', ['branch', '-D', branch], { cwd: PROJ, stdio: 'pipe' }); }
      catch { /* best effort */ }
    }
    saveMeta({ ...meta, merged: true, mergedBranch: branch });
    console.log('Merged ' + branch + ' into main (bench).');
    process.exit(0);
  }
  process.stderr.write('[gh shim] unsupported subcommand: ' + argv.join(' ') + '\\n');
  process.exit(1);
} catch (err) {
  process.stderr.write('[gh shim] error: ' + (err instanceof Error ? err.message : String(err)) + '\\n');
  process.exit(2);
}
`;
}

/** Write an executable PATH shim. */
export function writeShim(path: string, script: string): void {
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

export type GhMetadata = {
  created: boolean;
  merged: boolean;
  mergedBranch?: string;
  url?: string;
  title?: string;
  body?: string;
};

export function readGhMetadata(tempdir: string): GhMetadata | null {
  const p = join(tempdir, '_pr-metadata.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as GhMetadata;
  } catch {
    return null;
  }
}

/**
 * Reconstruct review-Ralph round telemetry from the orchestrator's event
 * log. Durable across the gh-shim's post-merge `git clean` (which removes
 * AGENT.md / fix_plan.md as gitignored files). Looks for the final
 * `reviewer.end` event's metadata.gate_invocations and verdicts_summary.
 */
export function reconstructGateStateFromEventLog(
  logPath: string,
): Partial<ReviewerGateState> {
  let text: string;
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    return { invocations: 0, verdicts: [] };
  }
  let invocations = 0;
  let verdictKinds: Array<'approve' | 'send-back'> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let evt: { phase?: string; skill?: string; event_type?: string; metadata?: Record<string, unknown> };
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt.phase !== 'review-loop' || evt.skill !== 'reviewer') continue;
    if (evt.event_type !== 'end' && evt.event_type !== 'error') continue;
    const md = evt.metadata ?? {};
    if (typeof md.gate_invocations === 'number') invocations = md.gate_invocations;
    if (Array.isArray(md.verdicts_summary)) {
      verdictKinds = (md.verdicts_summary as unknown[]).filter(
        (v): v is 'approve' | 'send-back' => v === 'approve' || v === 'send-back',
      );
    }
  }
  // We only have the verdict KINDS in the event log (not the full Verdict
  // objects with rationale/feedback). Synthesise minimal Verdict shells so
  // downstream code (caseScore) sees the right round count.
  const verdicts = verdictKinds.map((kind) =>
    kind === 'approve'
      ? { kind: 'approve' as const, rationale: '' }
      : { kind: 'send-back' as const, rationale: '', feedback: [] },
  );
  return { invocations, verdicts };
}
