#!/usr/bin/env node
/**
 * forge CLI. Subcommands:
 *   forge serve [--once]                    run the scheduler
 *   forge cycle <initiative-id>             run one initiative end-to-end (foreground)
 *   forge enqueue <project> <spec>          drop a manifest into _queue/pending/
 *   forge enqueue --from-manifest <path>    validate + drop a pre-formed manifest
 *   forge enqueue --fixture                 drop a smoke-test fixture
 *   forge status [--watch]                  print queue + in-flight snapshot
 *   forge metrics [<cycle-id>]              print per-cycle aggregates (or all)
 *   forge preflight <project>               check the C1–C6 forge↔project contract
 *   forge brain index [--scope <project>]   emit the brain navigation indexes (cache-friendly prefix)
 *   forge brain lint  [--scope <s>]         structural integrity checks on brain/
 *   forge brain bench:promote --cycle <id>  operator-gated promotion of reflector-emitted bench-growth candidates
 *
 * (The structural graph (per C20-C22) is owned by the real `safishamsi/graphify`
 * Python CLI directly — `cd brain && graphify {update,query,path,explain} ...`.
 * forge does NOT carry a graph shim. See skills/brain-graph/SKILL.md.)
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync, openSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { runCycle } from './cycle.ts';
import { serve, status as schedulerStatus } from './scheduler.ts';
import { snapshot, render } from './visualise.ts';
import { summariseCycle, summariseAll } from './metrics.ts';
import { getPaths } from './queue.ts';
import { parseManifest, validateManifest, writeManifest } from './manifest.ts';
import { loadBrainIndex, regenerateBrainIndex } from './brain-index.ts';
import { runBrainLint, type Scope as BrainLintScope } from './brain-lint.ts';
import {
  runPromote,
  makeInteractivePrompter,
  closeInteractivePrompter,
  makeLatestResultAccuracy,
  type PromoteDecision,
  type PromptOperator,
} from './brain-bench-promote.ts';
import { runPreflight, formatPreflightReport } from './preflight.ts';
import { fileVerdictPaths } from './file-verdict.ts';
import { assertEnv } from './config.ts';
import { writeCycleReport } from './cycle-report.ts';
import { resolveInitiativeId } from './initiative-id.ts';
import {
  dispatchArchitectCommit,
  ArchitectCommitError,
} from './architect-commit.ts';
import {
  daemonPaths,
  daemonState,
  reapStalePidFile,
  writePidFile,
  clearPidFile,
  readPid,
  isAlive,
  setPaused,
} from './daemon.ts';

const args = process.argv.slice(2);
const cmd = args[0];

// F-33: resolve all queue/log paths relative to the forge install root, NOT
// the user's CWD. Without this, `forge status` / `forge review` from inside
// `projects/<name>/` would look for `_queue/` under the project repo and
// silently miss the real one. The forge root is the parent of `orchestrator/`
// where this file sits.
const FORGE_ROOT = resolve(import.meta.dirname, '..');
process.chdir(FORGE_ROOT);

(async () => {
  // F-10: surface env-setup issues at every CLI invocation (warn-only;
  // some setups — e.g., Claude Code — provide auth via credentials file).
  // Verbs that don't talk to the SDK (status, metrics, brain index, --help)
  // skip the warning to keep their output clean.
  const sdkVerbs = new Set(['serve', 'cycle']);
  if (cmd && sdkVerbs.has(cmd)) assertEnv('warn');

  switch (cmd) {
    case 'start':
      return cmdStart(args.slice(1));
    case 'stop':
      return await cmdStop(args.slice(1));
    case 'pause':
      return cmdPause(args.slice(1));
    case 'resume':
      return cmdResume();
    case 'serve':
      return await cmdServe(args.slice(1));
    case 'cycle':
      return await cmdCycle(args.slice(1));
    case 'enqueue':
      return cmdEnqueue(args.slice(1));
    case 'status':
      return cmdStatus(args.slice(1));
    case 'metrics':
      return cmdMetrics(args.slice(1));
    case 'preflight':
      return cmdPreflight(args.slice(1));
    case 'review':
      return cmdReview(args.slice(1));
    case 'report':
      return cmdReport(args.slice(1));
    case 'demo':
      return await cmdDemo(args.slice(1));
    case 'brain':
      return cmdBrain(args.slice(1));
    case 'architect':
      return await cmdArchitect(args.slice(1));
    case '--help':
    case '-h':
    case undefined:
      return cmdHelp();
    default:
      console.error(`unknown command: ${cmd}`);
      cmdHelp();
      process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

function cmdHelp(): void {
  console.log(
    `forge — autonomous multi-agent orchestrator

Usage:
  forge start                             Start the scheduler as a detached background daemon
  forge stop                              Stop the background daemon (drains in-flight cycles)
  forge pause [reason]                    Stop claiming new work (in-flight cycles continue)
  forge resume                            Resume claiming new work
  forge serve [--once]                    Run the scheduler in the foreground (use 'start' for unattended)
  forge cycle <initiative-id>             Run one initiative end-to-end (foreground)
  forge enqueue <project> <spec>          Drop an initiative manifest into _queue/pending/
  forge enqueue --from-manifest <path>    Validate + drop a pre-formed manifest
  forge enqueue --fixture                 Drop a smoke-test fixture into _queue/pending/
  forge status [--watch]                  Print queue + in-flight snapshot
  forge metrics [<cycle-id>]              Per-cycle aggregates (or all cycles)
  forge preflight <project>               Check the C1–C6 forge↔project contract (declines, naming the failing clause)
  forge review <initiative-id-or-handle>  Print the open verdict prompt and the response file's path
                                          Accepts canonical INIT-…, handle proj#N, name alias, or unique substring.
  forge report <cycle-id> [--regenerate]  Print (or regenerate) the human-facing cycle report
  forge demo <project> <baseRef> <changedRef> [--initiative <id-or-handle>] [--out <dir>] [--build] [--brief <file>]
                                          Generate a self-contained before/after comparison demo (HTML)
  forge architect commit <session-id> [--project <name>] [--via-pr]
                                          Ingest the operator's PLAN.md annotations + verdict for an architect session
                                          - approve  → writes manifests to _queue/pending/, emits architect.plan-approved
                                          - revise   → writes session-dir/feedback.md, emits architect.plan-revised
                                          - reject   → archives session dir, emits architect.plan-rejected
                                          --via-pr opens a draft PR on the project repo; falls back to local-edit if no origin
  forge brain index [--scope <project>]   Emit the brain navigation indexes as a single blob (cache-friendly prefix for prompts)
  forge brain index --write               Regenerate brain/INDEX.md from filesystem (counts + sub-wiki listing)
  forge brain lint [--scope <s>] [--fix]  Structural integrity checks on brain/ (7 checks, scopes: full|forge-only|project-only|single-file|cycle-touched-themes|cleanup-dry-run)
                                          (structural graph owned by the real safishamsi/graphify CLI — run: cd brain && graphify update .)
  forge brain bench:promote --cycle <id>  Walk reflector-emitted brain-bench candidates past the operator; promote into benchmarks/brain/questions.json
                                          Caps: ≤1 per cycle, ≤4 per calendar month. Accuracy floor 94.4%; promotion reverted on regression.

For phase-implementation guidance see docs/phases/. For decisions see docs/decisions/.`,
  );
}

async function cmdServe(rest: string[]): Promise<void> {
  const once = rest.includes('--once');
  console.log(once ? 'forge serve --once: claiming one initiative…' : 'forge serve: starting…');
  await serve({ mode: once ? 'once' : 'forever' });
  if (once) {
    // Once-mode is the showcase / debug entry point — surface the most
    // recent cycle's report path as a breadcrumb. The forever-mode
    // operator's monitor (or `forge metrics`) is the right place for
    // ongoing visibility, so we only print this for `--once`.
    printLatestReportHint();
  }
}

/**
 * `forge start` — spawn `forge serve` (forever) as a detached process so it
 * survives the launching shell. Root cause of a real strand: the operator
 * closed the terminal running a foreground `forge serve`, killing the cycle
 * mid-review. Detached + pid-file makes the scheduler a managed daemon.
 */
function cmdStart(rest: string[]): void {
  reapStalePidFile(FORGE_ROOT);
  const queueRoot = getPaths().root;
  const st = daemonState(FORGE_ROOT, queueRoot);
  if (st.running) {
    console.log(`forge already running (pid ${st.pid}, since ${st.startedAt}).`);
    console.log(`  logs:   ${daemonPaths(FORGE_ROOT).logFile}`);
    console.log('  stop:   forge stop');
    return;
  }
  const { dir, logFile } = daemonPaths(FORGE_ROOT);
  mkdirSync(dir, { recursive: true });
  const logFd = openSync(logFile, 'a');
  const cliPath = resolve(import.meta.dirname, 'cli.ts');
  const serveArgs = ['--experimental-strip-types', cliPath, 'serve', ...rest];
  const child = spawn(process.execPath, serveArgs, {
    cwd: FORGE_ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  if (typeof child.pid !== 'number') {
    console.error('forge start: failed to spawn the scheduler process');
    process.exit(1);
  }
  writePidFile(FORGE_ROOT, child.pid);
  console.log(`forge started (pid ${child.pid}) — detached; safe to close this terminal.`);
  console.log(`  logs:    tail -f ${logFile}`);
  console.log('  status:  forge status');
  console.log('  pause:   forge pause   (stop claiming new work)');
  console.log('  stop:    forge stop    (drain in-flight + exit)');
}

/**
 * `forge stop` — SIGTERM the daemon. The scheduler's existing signal handler
 * drains in-flight cycles cleanly (a second signal would force-quit, but we
 * only send one; the operator can re-run stop). Best-effort wait so the
 * common (idle) case reports a clean exit synchronously.
 */
async function cmdStop(_rest: string[]): Promise<void> {
  const { pidFile } = daemonPaths(FORGE_ROOT);
  const pid = readPid(pidFile);
  if (pid === null || !isAlive(pid)) {
    console.log('forge is not running (no live daemon).');
    clearPidFile(FORGE_ROOT);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    console.error(`forge stop: failed to signal pid ${pid}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log(`forge stop: sent SIGTERM to pid ${pid} — draining in-flight cycle(s)…`);
  for (let i = 0; i < 20 && isAlive(pid); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (isAlive(pid)) {
    console.log('  still draining (in-flight cycles finishing). It will exit on its own;');
    console.log('  re-run `forge stop` to force-quit if it hangs.');
  } else {
    clearPidFile(FORGE_ROOT);
    console.log('  stopped cleanly.');
  }
}

/** `forge pause [reason]` — stop claiming new work; in-flight cycles continue. */
function cmdPause(rest: string[]): void {
  const reason = rest.join(' ').trim();
  const queueRoot = getPaths().root;
  setPaused(true, queueRoot, reason);
  const st = daemonState(FORGE_ROOT, queueRoot);
  console.log(`forge paused — scheduler will not claim new initiatives${reason ? ` (${reason})` : ''}.`);
  console.log(st.running
    ? '  the running daemon picks this up within one poll interval; in-flight cycles keep going.'
    : '  (no daemon running — this takes effect when one is started.)');
  console.log('  resume: forge resume');
}

/** `forge resume` — clear the pause flag so claiming restarts. */
function cmdResume(): void {
  const queueRoot = getPaths().root;
  setPaused(false, queueRoot);
  console.log('forge resumed — scheduler will claim pending work again within one poll interval.');
}

function printLatestReportHint(): void {
  const logsRoot = resolve('_logs');
  if (!existsSync(logsRoot)) return;
  let newest: { cycleId: string; mtimeMs: number } | null = null;
  let entries: string[] = [];
  try {
    entries = readdirSync(logsRoot);
  } catch {
    return;
  }
  for (const name of entries) {
    const reportPath = join(logsRoot, name, 'report.md');
    if (!existsSync(reportPath)) continue;
    try {
      const st = statSync(reportPath);
      if (!newest || st.mtimeMs > newest.mtimeMs) {
        newest = { cycleId: name, mtimeMs: st.mtimeMs };
      }
    } catch {
      /* skip */
    }
  }
  if (!newest) return;
  const reportPath = resolve(logsRoot, newest.cycleId, 'report.md');
  console.log('');
  console.log(`📄 Cycle report: ${reportPath}`);
  console.log(`   View: forge report ${newest.cycleId}`);
}

async function cmdCycle(rest: string[]): Promise<void> {
  const initiativeId = rest[0];
  const dryRun = rest.includes('--dry-run');
  if (!initiativeId) {
    console.error('forge cycle: missing <initiative-id>');
    process.exit(2);
  }
  // For dry runs, we can synthesise paths; for real runs the manifest must
  // exist in _queue/in-flight/.
  const paths = getPaths();
  const manifestPath = join(paths.inFlight, `${initiativeId}.md`);
  const projectRepoPath = resolve('projects', initiativeId);
  const worktreePath = resolve('_worktrees', initiativeId);
  const result = await runCycle({
    initiativeId,
    manifestPath,
    projectRepoPath,
    worktreePath,
    dryRun,
  });
  console.log(JSON.stringify(result, null, 2));
  // Same breadcrumb as `forge serve --once`: surface the report path so
  // the operator doesn't have to know the cycle-id naming convention.
  printLatestReportHint();
}

function cmdEnqueue(rest: string[]): void {
  const paths = getPaths();
  if (!existsSync(paths.pending)) mkdirSync(paths.pending, { recursive: true });

  if (rest[0] === '--from-manifest') {
    const src = rest[1];
    if (!src) {
      console.error('forge enqueue --from-manifest: missing <path>');
      process.exit(2);
    }
    if (!existsSync(src)) {
      console.error(`forge enqueue --from-manifest: file not found: ${src}`);
      process.exit(2);
    }
    const manifest = parseManifest(readFileSync(src, 'utf8'));
    const errors = validateManifest(manifest);
    if (errors.length > 0) {
      console.error(`forge enqueue --from-manifest: invalid manifest:\n  - ${errors.join('\n  - ')}`);
      process.exit(2);
    }
    const out = writeManifest(manifest);
    console.log(`enqueued: ${out}`);
    return;
  }

  if (rest[0] === '--fixture') {
    // Bootstrap a tiny throwaway git repo at projects/fixture/ so the scheduler
    // can `git worktree add` against it and complete the (no-op) cycle, ending
    // up in _queue/ready-for-review/ instead of failing on missing-repo.
    const fixtureRepo = resolve('projects', 'fixture');
    if (!existsSync(fixtureRepo)) {
      mkdirSync(fixtureRepo, { recursive: true });
      execSync(
        `git -C "${fixtureRepo}" init -q -b main && \
         git -C "${fixtureRepo}" -c user.email=fixture@forge -c user.name=fixture commit -q --allow-empty -m "fixture: initial"`,
        { stdio: 'pipe' },
      );
    }
    const id = `INIT-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-fixture`;
    const manifest = `---
initiative_id: ${id}
project: fixture
project_repo_path: ${fixtureRepo}
created_at: ${new Date().toISOString()}
iteration_budget: 5
cost_budget_usd: 1.00
phase: pending
features:
  - feature_id: FEAT-1
    title: smoke-test feature
    depends_on: []
---

# Fixture initiative

Smoke test for the scheduler. No real work performed.
`;
    const out = join(paths.pending, `${id}.md`);
    writeFileSync(out, manifest);
    console.log(`enqueued: ${out}`);
    return;
  }

  const project = rest[0];
  const specPath = rest[1];
  if (!project || !specPath) {
    console.error('forge enqueue: usage: enqueue <project> <spec-path> | enqueue --fixture');
    process.exit(2);
  }
  const id = `INIT-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${project}`;
  const body = readFileSync(specPath, 'utf8');
  const manifest = `---
initiative_id: ${id}
project: ${project}
created_at: ${new Date().toISOString()}
iteration_budget: 50
cost_budget_usd: 25.00
phase: pending
---

${body}`;
  const out = join(paths.pending, `${id}.md`);
  writeFileSync(out, manifest);
  console.log(`enqueued: ${out}`);
}

function cmdStatus(rest: string[]): void {
  const watch = rest.includes('--watch');
  const queueRoot = getPaths().root;
  const print = (): void => {
    const snap = snapshot();
    if (watch) console.clear();
    const d = daemonState(FORGE_ROOT, queueRoot);
    const daemonLine = d.running
      ? `daemon: RUNNING (pid ${d.pid}, since ${d.startedAt})${d.paused ? ' · PAUSED (not claiming new work)' : ''}`
      : `daemon: stopped${d.paused ? ' · paused flag set (forge resume to clear)' : ''} — start with: forge start`;
    console.log(daemonLine);
    console.log(render(snap));
    if (!watch) {
      const c = schedulerStatus().counts;
      console.log(`\n(totals: ${JSON.stringify(c)})`);
    }
  };
  print();
  if (watch) setInterval(print, 2000);
}

/**
 * S1.1 helper: take any operator-typed `<id>` (canonical | handle | name |
 * unique substring) and produce the canonical id. On ambiguity print all
 * matches + exit 2 per plan 07b. On `not-found` for a non-canonical input,
 * exit 2 with a friendly message. Canonical inputs are accepted even if the
 * registry doesn't know them yet (so existing manifests pre-backfill work).
 */
function resolveOrExit(input: string, verb: string): string {
  const r = resolveInitiativeId(input);
  if (r.kind === 'ok') return r.canonical;
  if (r.kind === 'ambiguous') {
    console.error(`forge ${verb}: "${input}" matched multiple initiatives:`);
    for (const m of r.matches) console.error(`  ${m}`);
    console.error('Specify a more specific handle, name, or full canonical id.');
    process.exit(2);
  }
  console.error(`forge ${verb}: no initiative resolved from "${input}".`);
  console.error('Tried: canonical exact, handle (proj#N), name alias, unique substring.');
  console.error('Run `forge status` to list active IDs.');
  process.exit(2);
}

function cmdReview(rest: string[]): void {
  const rawId = rest[0];
  if (!rawId) {
    console.error('forge review: missing <initiative-id-or-handle>');
    console.error('Usage: forge review <initiative-id-or-handle> [--inspect | --approve | --abandon]');
    process.exit(2);
  }
  const initiativeId = resolveOrExit(rawId, 'review');
  // F-31: recovery sub-commands. The default behaviour (print verdict prompt)
  // is preserved; the new flags target the case where a cycle landed in
  // ready-for-review/ via send-back-cap-exhausted and the human needs to
  // (a) see what was committed without reading events.jsonl,
  // (b) force-merge a worktree the reviewer-Ralph couldn't approve itself,
  // (c) abandon a stuck initiative cleanly (move to failed/, drop worktree).
  if (rest.includes('--inspect')) return cmdReviewInspect(initiativeId);
  if (rest.includes('--approve')) return cmdReviewApprove(initiativeId);
  if (rest.includes('--abandon')) return cmdReviewAbandon(initiativeId);

  // Default: print the verdict prompt (existing behaviour).
  const paths = fileVerdictPaths(initiativeId);
  if (!existsSync(paths.promptPath)) {
    console.error(`forge review: no open verdict prompt at ${paths.promptPath}`);
    console.error('No initiative is currently waiting for review under that ID.');
    console.error('Run `forge status` to see what\'s in flight.');
    console.error('Other modes: --inspect | --approve | --abandon');
    process.exit(2);
  }
  process.stdout.write(readFileSync(paths.promptPath, 'utf8'));
  console.log('---');
  console.log(`Write your verdict to: ${paths.responsePath}`);
  if (existsSync(paths.responsePath)) {
    console.log('(a response file already exists; the scheduler will pick it up shortly)');
  } else {
    console.log('(use the templates above as a starting point)');
  }
  console.log('');
  console.log('Recovery commands for stuck initiatives:');
  console.log(`  forge review ${initiativeId} --inspect    show worktree state, branch, PR draft`);
  console.log(`  forge review ${initiativeId} --approve    force-merge the branch as-is`);
  console.log(`  forge review ${initiativeId} --abandon    move to failed/ and clean up worktree`);
}

/**
 * F-31: show what's actually in the preserved worktree for a stuck cycle.
 * Reads the manifest's worktree_path annotation, lists branch + commits +
 * diff stat + PR draft existence. Read-only — no state changes.
 */
function cmdReviewInspect(initiativeId: string): void {
  const queuePaths = getPaths();
  const located = locateInitiative(initiativeId, queuePaths);
  if (!located) {
    console.error(`forge review --inspect: no manifest found for ${initiativeId} in any queue dir`);
    process.exit(2);
  }
  console.log(`Initiative: ${initiativeId}`);
  console.log(`Manifest:   ${located.path} (${located.state})`);
  const m = parseManifest(readFileSync(located.path, 'utf8'));
  const wt = (m as { worktree_path?: string }).worktree_path;
  if (!wt) {
    console.log('Worktree:   (none — manifest has no worktree_path annotation)');
    return;
  }
  console.log(`Worktree:   ${wt}`);
  if (!existsSync(wt)) {
    console.log('             (path does not exist — branch was cleaned up)');
    return;
  }
  const branch = `forge/${initiativeId}`;
  console.log(`Branch:     ${branch}`);
  console.log('');
  try {
    const commits = execSync(
      `git -C "${wt}" log --no-color --format='%h %s' -n 20 main..HEAD 2>/dev/null`,
      { encoding: 'utf8' },
    );
    console.log('Commits (main..HEAD):');
    console.log(commits || '  (none)');
  } catch {
    console.log('Commits: (could not read git log)');
  }
  try {
    const stat = execSync(`git -C "${wt}" diff --stat main...HEAD 2>/dev/null`, { encoding: 'utf8' });
    console.log('Diff stat (main...HEAD):');
    console.log(stat || '  (none)');
  } catch {
    /* ignore */
  }
  const prPath = join(wt, '.forge', 'pr-description.md');
  if (existsSync(prPath)) {
    const pr = readFileSync(prPath, 'utf8');
    console.log(`PR draft:   ${prPath} (${pr.length} chars)`);
    console.log('--- PR description (first 60 lines) ---');
    console.log(pr.split('\n').slice(0, 60).join('\n'));
  } else {
    console.log('PR draft:   (none)');
  }
}

/**
 * F-31: force-merge the branch into main as-is. Used when reviewer-Ralph
 * couldn't approve itself but the human has inspected and is satisfied.
 * Performs a fast-forward merge and triggers the same cleanup the normal
 * merge path uses.
 */
function cmdReviewApprove(initiativeId: string): void {
  const queuePaths = getPaths();
  const located = locateInitiative(initiativeId, queuePaths);
  if (!located) {
    console.error(`forge review --approve: no manifest found for ${initiativeId}`);
    process.exit(2);
  }
  if (located.state !== 'ready-for-review') {
    console.error(`forge review --approve: manifest is in '${located.state}', not 'ready-for-review'`);
    console.error('Approve only operates on initiatives whose work has been committed and is awaiting verdict.');
    process.exit(2);
  }
  const m = parseManifest(readFileSync(located.path, 'utf8'));
  const wt = (m as { worktree_path?: string }).worktree_path;
  if (!wt || !existsSync(wt)) {
    console.error(`forge review --approve: worktree missing at ${wt ?? '(unannotated)'} — cannot merge`);
    console.error('The branch was cleaned up before the human could approve. Use --abandon to clear the queue state.');
    process.exit(2);
  }
  const projectRepoPath = m.project_repo_path;
  const branch = `forge/${initiativeId}`;
  try {
    console.log(`Merging ${branch} → main in ${projectRepoPath}…`);
    execSync(`git -C "${projectRepoPath}" checkout main`, { stdio: 'inherit' });
    execSync(`git -C "${projectRepoPath}" merge --ff-only "${branch}"`, { stdio: 'inherit' });
    console.log('Merged. Cleaning up worktree + branch…');
    execSync(`git -C "${projectRepoPath}" worktree remove --force "${wt}"`, { stdio: 'pipe' });
    execSync(`git -C "${projectRepoPath}" branch -D "${branch}"`, { stdio: 'pipe' });
  } catch (err) {
    console.error(`forge review --approve: merge failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error('Try running the merge manually, or use --abandon if the work is no longer wanted.');
    process.exit(1);
  }
  // Move manifest to done/.
  const doneTarget = join(queuePaths.done, basename(located.path));
  execSync(`mv "${located.path}" "${doneTarget}"`);
  // Best-effort: drop the file-verdict prompt + response.
  const vp = fileVerdictPaths(initiativeId);
  for (const p of [vp.promptPath, vp.responsePath]) {
    if (existsSync(p)) {
      try { execSync(`rm "${p}"`); } catch { /* ignore */ }
    }
  }
  console.log(`Done. Manifest moved to ${doneTarget}.`);
}

/**
 * F-31: move a stuck initiative to failed/ and clean up worktree + branch.
 * Used when the human decides the work is unrecoverable; clears state so the
 * scheduler can move on (and downstream initiatives that depend on this one
 * stay blocked, which is correct).
 */
function cmdReviewAbandon(initiativeId: string): void {
  const queuePaths = getPaths();
  const located = locateInitiative(initiativeId, queuePaths);
  if (!located) {
    console.error(`forge review --abandon: no manifest found for ${initiativeId}`);
    process.exit(2);
  }
  const m = parseManifest(readFileSync(located.path, 'utf8'));
  const wt = (m as { worktree_path?: string }).worktree_path;
  const projectRepoPath = m.project_repo_path;
  const branch = `forge/${initiativeId}`;
  if (wt && existsSync(wt) && projectRepoPath && existsSync(projectRepoPath)) {
    try {
      execSync(`git -C "${projectRepoPath}" worktree remove --force "${wt}"`, { stdio: 'pipe' });
    } catch { /* ignore */ }
    try {
      execSync(`git -C "${projectRepoPath}" branch -D "${branch}"`, { stdio: 'pipe' });
    } catch { /* ignore */ }
  }
  const failedTarget = join(queuePaths.failed, basename(located.path));
  execSync(`mv "${located.path}" "${failedTarget}"`);
  const vp = fileVerdictPaths(initiativeId);
  for (const p of [vp.promptPath, vp.responsePath]) {
    if (existsSync(p)) {
      try { execSync(`rm "${p}"`); } catch { /* ignore */ }
    }
  }
  console.log(`Abandoned ${initiativeId}. Manifest at ${failedTarget}; worktree + branch cleaned up.`);
}

/**
 * Helper: find a manifest by initiative_id across pending/in-flight/
 * ready-for-review/done/failed. Returns the path + queue state.
 */
function locateInitiative(
  initiativeId: string,
  paths: ReturnType<typeof getPaths>,
): { path: string; state: 'pending' | 'in-flight' | 'ready-for-review' | 'done' | 'failed' } | null {
  const states: Array<{ dir: string; state: 'pending' | 'in-flight' | 'ready-for-review' | 'done' | 'failed' }> = [
    { dir: paths.pending, state: 'pending' },
    { dir: paths.inFlight, state: 'in-flight' },
    { dir: paths.readyForReview, state: 'ready-for-review' },
    { dir: paths.done, state: 'done' },
    { dir: paths.failed, state: 'failed' },
  ];
  for (const { dir, state } of states) {
    const candidate = join(dir, `${initiativeId}.md`);
    if (existsSync(candidate)) return { path: candidate, state };
  }
  return null;
}

function cmdReport(rest: string[]): void {
  const cycleId = rest[0];
  if (!cycleId) {
    console.error('forge report: missing <cycle-id>');
    console.error('Usage: forge report <cycle-id> [--regenerate]');
    console.error('Run `forge metrics` to list cycle IDs.');
    process.exit(2);
  }
  const reportPath = join('_logs', cycleId, 'report.md');
  const regenerate = rest.includes('--regenerate') || !existsSync(reportPath);
  if (regenerate) {
    try {
      writeCycleReport({ cycleId });
    } catch (err) {
      console.error(`forge report: failed to generate: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
  if (!existsSync(reportPath)) {
    console.error(`forge report: no report at ${reportPath}`);
    process.exit(1);
  }
  process.stdout.write(readFileSync(reportPath, 'utf8'));
}

function flagValue(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  // A flag immediately followed by another --flag (or nothing) means the
  // value was omitted — treat as absent rather than silently consuming the
  // next flag's name as the value.
  if (v === undefined || v.startsWith('--')) {
    console.error(`forge demo: ${flag} expects a value`);
    process.exit(2);
  }
  return v;
}

async function cmdDemo(rest: string[]): Promise<void> {
  const [project, baseRef, changedRef] = rest;
  if (!project || !baseRef || !changedRef) {
    console.error('forge demo: usage: demo <project> <baseRef> <changedRef> [--initiative <id>] [--out <dir>] [--build] [--brief <file>]');
    process.exit(2);
  }
  const projectRepoPath = resolve('projects', project);
  if (!existsSync(join(projectRepoPath, '.git'))) {
    console.error(`forge demo: ${projectRepoPath} is not a git repo (clone the project into projects/${project}/ first)`);
    process.exit(2);
  }
  const rawInitiative = flagValue(rest, '--initiative');
  const initiativeId = rawInitiative ? resolveOrExit(rawInitiative, 'demo') : undefined;
  const out = flagValue(rest, '--out') ?? join('_logs', 'demos', `${project}-${Date.now()}`);
  const briefFile = flagValue(rest, '--brief');
  const brief = briefFile && existsSync(briefFile) ? readFileSync(briefFile, 'utf8') : undefined;
  const build = rest.includes('--build');

  console.log(`forge demo: ${project}  ${baseRef} → ${changedRef}  (out: ${resolve(out)})`);
  const { generateComparisonDemo } = await import('./demo.ts');
  try {
    const res = await generateComparisonDemo({
      projectRepoPath,
      project,
      baseRef,
      changedRef,
      outDir: out,
      initiativeId,
      brief,
      build,
    });
    console.log('');
    console.log(`✅ before/after demo: ${res.htmlPath}`);
    console.log(`   open: xdg-open ${res.htmlPath}`);
    console.log(`   baseline build: ${res.baselineBuild.ok ? 'ok' : 'FAILED — ' + res.baselineBuild.detail}`);
    console.log(`   changed  build: ${res.changedBuild.ok ? 'ok' : 'FAILED — ' + res.changedBuild.detail}`);
    console.log(`   agent cost: $${res.agentCostUsd.toFixed(2)}`);
  } catch (err) {
    console.error(`forge demo: failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * US-4.1 / ADR-017: check the C1–C6 forge↔project contract. The argument
 * is a project name (resolved under `projects/<name>/`) or an explicit
 * path. Prints a per-clause PASS/FAIL/WARN report and exits non-zero iff a
 * HARD clause (C1/C2/C4) fails — so an unattended caller can gate on it.
 */
function cmdPreflight(rest: string[]): void {
  const target = rest[0];
  if (!target) {
    console.error('forge preflight: missing <project>');
    console.error('Usage: forge preflight <project-name | path>');
    process.exit(2);
  }
  // Accept either an explicit path or a managed-project name.
  const asPath = resolve(target);
  const asManaged = resolve('projects', target);
  const projectDir = existsSync(asPath) && statSync(asPath).isDirectory()
    ? asPath
    : asManaged;
  if (!existsSync(projectDir)) {
    console.error(`forge preflight: project directory not found: ${projectDir}`);
    console.error('Pass a directory under projects/ or an absolute path.');
    process.exit(2);
  }
  const report = runPreflight(projectDir, { forgeRoot: FORGE_ROOT });
  console.log(formatPreflightReport(report));
  // Hard-clause failure ⇒ forge declines (non-zero so callers can gate).
  process.exit(report.ok ? 0 : 1);
}

function cmdMetrics(rest: string[]): void {
  if (rest[0]) {
    console.log(JSON.stringify(summariseCycle(rest[0]), null, 2));
  } else {
    console.log(JSON.stringify(summariseAll(), null, 2));
  }
}

function cmdBrain(rest: string[]): void {
  const sub = rest[0];
  if (sub === 'index') return cmdBrainIndex(rest.slice(1));
  if (sub === 'lint') return cmdBrainLint(rest.slice(1));
  if (sub === 'bench:promote' || sub === 'bench-promote') {
    void cmdBrainBenchPromote(rest.slice(1));
    return;
  }
  if (sub === 'graph') {
    // Per C20-C22 + post-S1.4 migration: the structural graph is owned by
    // the real `safishamsi/graphify` Python CLI, not by an orchestrator shim.
    // Pass through to `graphify` for any sub-op the operator wants; forge
    // does NOT carry its own graph walker.
    console.error(
      `forge brain graph: this surface is owned by the real graphify CLI. Use it directly:
  cd brain && graphify update .          # rebuild brain/graphify-out/graph.json
  cd brain && graphify query "<q>"        # token-efficient BFS over the graph
  cd brain && graphify path "<a>" "<b>"   # shortest connection
  cd brain && graphify explain "<node>"   # describe a node + neighbours
See skills/brain-graph/SKILL.md for the operator runbook.`,
    );
    process.exit(2);
  }
  console.error('forge brain: subcommands: index | lint | bench:promote');
  process.exit(2);
}

/**
 * `forge brain bench:promote --cycle <id>` — walks the reflector's
 * candidate file at `_logs/<id>/brain-bench-candidates.jsonl` past the
 * operator (keep/drop/edit per row, default drop) and lands accepted
 * candidates in `benchmarks/brain/questions.json`. Gated by per-cycle
 * (≤1) + monthly (≤4 excluding manual-seed-*) caps + the 94.4%
 * accuracy floor; reverts byte-for-byte on regression.
 *
 * Flags:
 *   --cycle <id>            REQUIRED. Cycle id whose candidates we promote.
 *   --auto-keep <indexes>   1-based comma list; keep these candidates without prompting.
 *   --auto-drop <indexes>   1-based comma list; drop these candidates without prompting.
 *   --skip-bench            Skip the accuracy gate (operator confirms they ran it).
 *   --help                  Show this help.
 */
async function cmdBrainBenchPromote(rest: string[]): Promise<void> {
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(`forge brain bench:promote --cycle <id> [--auto-keep <n,n>] [--auto-drop <n,n>] [--skip-bench]
  Walks _logs/<cycle-id>/brain-bench-candidates.jsonl past the operator.
  Kept candidates land in benchmarks/brain/questions.json with source_cycle stamped.
  Caps: ≤1 per cycle, ≤4 per calendar month (manual-seed-* exempt).
  Accuracy floor: 94.4% (CLAUDE.md bar) — promotion reverted on regression.`);
    return;
  }

  let cycleId: string | undefined;
  const autoKeep = new Set<number>();
  const autoDrop = new Set<number>();
  let skipBench = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--cycle') cycleId = rest[++i];
    else if (a === '--auto-keep') {
      const v = rest[++i];
      if (v) v.split(',').forEach((n) => autoKeep.add(Number(n)));
    } else if (a === '--auto-drop') {
      const v = rest[++i];
      if (v) v.split(',').forEach((n) => autoDrop.add(Number(n)));
    } else if (a === '--skip-bench') {
      skipBench = true;
    }
  }
  if (!cycleId) {
    console.error('forge brain bench:promote: missing --cycle <id>');
    console.error('Usage: forge brain bench:promote --cycle <cycle-id>');
    process.exit(2);
  }
  const candidatesPath = resolve(FORGE_ROOT, '_logs', cycleId, 'brain-bench-candidates.jsonl');
  const questionsPath = resolve(FORGE_ROOT, 'benchmarks', 'brain', 'questions.json');

  if (!existsSync(candidatesPath)) {
    console.log(`(no candidates for cycle ${cycleId} — file: ${candidatesPath})`);
    return;
  }
  if (!existsSync(questionsPath)) {
    console.error(`forge brain bench:promote: questions.json missing at ${questionsPath}`);
    process.exit(2);
  }

  // Build the prompter: prefer auto-keep/auto-drop indexes for deterministic
  // CI runs; else interactive readline.
  const interactivePrompter = autoKeep.size === 0 && autoDrop.size === 0
    ? makeInteractivePrompter()
    : null;
  const prompter: PromptOperator = async ({ candidate, index, total }) => {
    const oneBased = index + 1;
    if (autoKeep.has(oneBased)) return { action: 'keep' } as PromoteDecision;
    if (autoDrop.has(oneBased)) return { action: 'drop' } as PromoteDecision;
    if (interactivePrompter) return interactivePrompter({ candidate, index, total });
    return { action: 'drop' };
  };

  const result = await runPromote({
    cycleId,
    candidatesPath,
    questionsPath,
    deps: {
      promptOperator: prompter,
      runBenchAccuracy: skipBench
        ? async () => 1.0 // operator vouches; gate is a noop
        : makeLatestResultAccuracy(FORGE_ROOT),
      nowIso: () => new Date().toISOString(),
    },
  });

  closeInteractivePrompter();

  if (result.kind === 'ok') {
    if (result.promoted === 0) {
      console.log(`(no promotions for cycle ${cycleId} — all candidates dropped or none present)`);
    } else {
      console.log(`promoted ${result.promoted} candidate(s): ${result.ids.join(', ')}`);
      console.log(`questions.json updated. Recommend re-running: npm run bench:brain`);
    }
    return;
  }
  if (result.kind === 'cap-exceeded') {
    console.error(`forge brain bench:promote: cap-exceeded (${result.cap}): ${result.reason}`);
    process.exit(1);
  }
  // reverted
  console.error(`forge brain bench:promote: ${result.reason}`);
  console.error(`questions.json restored. No changes landed.`);
  process.exit(1);
}

function cmdBrainIndex(rest: string[]): void {
  const write = rest.includes('--write');
  if (write) {
    const result = regenerateBrainIndex({ cwd: FORGE_ROOT, write: true });
    console.log(
      `brain-index: ${result.changed ? 'updated' : 'unchanged'} ${result.path}\n` +
        `  ${result.stats.forgeThemeCount} forge themes, ` +
        `${result.stats.projectThemeCount} project themes, ` +
        `${result.stats.rawCount} raw sources, ` +
        `${result.stats.projects.length} sub-wikis`,
    );
    return;
  }
  // Default: legacy prompt-prefix loader behaviour (`--scope <project>`).
  const scopeIdx = rest.indexOf('--scope');
  const scope = scopeIdx >= 0 ? rest[scopeIdx + 1] ?? null : null;
  process.stdout.write(loadBrainIndex({ scope }) + '\n');
}

function cmdBrainLint(rest: string[]): void {
  // Parse flags. Mirror the standalone brain-lint.ts CLI but wire through the
  // forge CLI so the operator types `forge brain lint ...`.
  let scope: BrainLintScope = 'full';
  let project: string | undefined;
  let file: string | undefined;
  let cycle: string | undefined;
  let fix = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--scope') {
      const v = rest[++i];
      const allowed: BrainLintScope[] = [
        'full',
        'forge-only',
        'project-only',
        'single-file',
        'cycle-touched-themes',
        'cleanup-dry-run',
      ];
      if (!allowed.includes(v as BrainLintScope)) {
        console.error(`forge brain lint: unknown --scope: ${v}`);
        process.exit(2);
      }
      scope = v as BrainLintScope;
    } else if (a === '--project') {
      project = rest[++i];
    } else if (a === '--file') {
      file = rest[++i];
    } else if (a === '--cycle') {
      cycle = rest[++i];
    } else if (a === '--fix') {
      fix = true;
    }
  }
  const result = runBrainLint({ cwd: FORGE_ROOT, scope, project, file, cycle, fix });

  const errors = result.findings.filter((f) => f.category === 'error');
  const flags = result.findings.filter((f) => f.category === 'flag');
  const fixes = result.findings.filter((f) => f.category === 'auto-fix');
  for (const [label, group] of [
    ['ERRORS', errors],
    ['FLAGS', flags],
    ['AUTO-FIXES', fixes],
  ] as const) {
    if (group.length === 0) continue;
    console.log(`## ${label} (${group.length})`);
    for (const f of group) {
      const relPath = f.file.startsWith(FORGE_ROOT)
        ? f.file.slice(FORGE_ROOT.length + 1)
        : f.file;
      console.log(`- [${f.check ?? 'check'}] ${relPath}: ${f.message}`);
    }
    console.log('');
  }
  console.log(
    `Summary: ${errors.length} error(s), ${flags.length} flag(s), ${fixes.length} auto-fix(es).`,
  );
  process.exit(result.exitCode);
}

// `cmdBrainGraph*` removed 2026-05-23 — the structural graph is owned by the
// real `safishamsi/graphify` Python CLI (per C20-C22). The S1.4 deterministic
// walker (`orchestrator/brain-graph.ts`) was a stop-gap; the migration to the
// real tool lives in `skills/brain-graph/SKILL.md`. Use `graphify` directly.

// ---------------------------------------------------------------------------
// forge architect commit <session-id>
//
// S2A: the architect's terminal step is now writing PLAN.md to the project's
// `_architect/<sid>/` dir, NOT manifests to `_queue/pending/`. This
// subcommand ingests the operator's annotations + verdict and dispatches.
// ---------------------------------------------------------------------------

async function cmdArchitect(rest: string[]): Promise<void> {
  const sub = rest[0];
  if (sub === 'commit') return await cmdArchitectCommit(rest.slice(1));
  console.error('forge architect: subcommands: commit <session-id>');
  console.error('  forge architect commit <session-id> [--project <name>] [--via-pr]');
  process.exit(2);
}

async function cmdArchitectCommit(rest: string[]): Promise<void> {
  const sessionId = rest[0];
  if (!sessionId) {
    console.error('forge architect commit: missing <session-id>');
    console.error('Usage: forge architect commit <session-id> [--project <name>] [--via-pr]');
    process.exit(2);
  }
  const projectIdx = rest.indexOf('--project');
  const projectArg = projectIdx >= 0 ? rest[projectIdx + 1] : undefined;
  const viaPr = rest.includes('--via-pr');

  // Resolve the project root. Two surfaces:
  //  - explicit `--project <name>` → `projects/<name>/`
  //  - default: scan `projects/*/_architect/<session-id>/` for the dir
  let projectRoot: string;
  if (projectArg) {
    projectRoot = resolve('projects', projectArg);
  } else {
    const found = findSessionProject(sessionId);
    if (!found) {
      console.error(
        `forge architect commit: no project found containing _architect/${sessionId}/. ` +
          `Pass --project <name> to disambiguate.`,
      );
      process.exit(2);
    }
    projectRoot = found;
  }

  if (!existsSync(projectRoot)) {
    console.error(`forge architect commit: project root not found: ${projectRoot}`);
    process.exit(2);
  }

  try {
    const result = await dispatchArchitectCommit({
      sessionId,
      projectRoot,
      viaPr,
    });
    if (result.verdict === 'approve') {
      console.log(`approved. wrote ${result.writtenManifestPaths.length} manifest(s):`);
      for (const p of result.writtenManifestPaths) console.log(`  ${p}`);
    } else if (result.verdict === 'revise') {
      console.log(`revise. feedback bundled at ${result.feedbackPath}`);
      console.log(`Re-run /forge-architect ${result.verdict === 'revise' ? '<project>' : ''} to regenerate PLAN.md with feedback.`);
    } else {
      console.log(`rejected. archived to ${result.archivedPath}`);
    }
  } catch (err) {
    if (err instanceof ArchitectCommitError) {
      console.error(`forge architect commit: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

/**
 * Scan `projects/*` for `_architect/<sessionId>/PLAN.md` and return the
 * first match's project root. Used when the operator omits `--project`.
 */
function findSessionProject(sessionId: string): string | null {
  const projectsDir = resolve('projects');
  if (!existsSync(projectsDir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const name of entries) {
    const candidate = join(projectsDir, name);
    try {
      const stat = statSync(candidate);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    const planPath = join(candidate, '_architect', sessionId, 'PLAN.md');
    if (existsSync(planPath)) return candidate;
  }
  return null;
}
