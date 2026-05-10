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
 *   forge bench <phase>                     run a phase's benchmark suite
 *   forge brain query "..."                 stub: invoke brain-query skill
 *   forge brain index [--scope <project>]   emit the brain navigation indexes (cache-friendly prefix)
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { runCycle } from './cycle.ts';
import { serve, status as schedulerStatus } from './scheduler.ts';
import { snapshot, render } from './visualise.ts';
import { summariseCycle, summariseAll } from './metrics.ts';
import { getPaths } from './queue.ts';
import { parseManifest, validateManifest, writeManifest } from './manifest.ts';
import { loadBrainIndex } from './brain-index.ts';
import { fileVerdictPaths } from './file-verdict.ts';
import { assertEnv } from './config.ts';
import { writeCycleReport } from './cycle-report.ts';

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
    case 'review':
      return cmdReview(args.slice(1));
    case 'report':
      return cmdReport(args.slice(1));
    case 'bench':
      return cmdBench(args.slice(1));
    case 'brain':
      return cmdBrain(args.slice(1));
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
  forge serve [--once]                    Start the unattended scheduler
  forge cycle <initiative-id>             Run one initiative end-to-end (foreground)
  forge enqueue <project> <spec>          Drop an initiative manifest into _queue/pending/
  forge enqueue --from-manifest <path>    Validate + drop a pre-formed manifest
  forge enqueue --fixture                 Drop a smoke-test fixture into _queue/pending/
  forge status [--watch]                  Print queue + in-flight snapshot
  forge metrics [<cycle-id>]              Per-cycle aggregates (or all cycles)
  forge review <initiative-id>            Print the open verdict prompt and the response file's path
  forge report <cycle-id> [--regenerate]  Print (or regenerate) the human-facing cycle report
  forge bench <phase>                     Run a phase's benchmark suite (alias for npm run bench:<phase>)
  forge brain query "<question>"          Query the brain (skeleton)
  forge brain index [--scope <project>]   Emit the brain navigation indexes as a single blob (cache-friendly prefix for prompts)

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
  const print = (): void => {
    const snap = snapshot();
    if (watch) console.clear();
    console.log(render(snap));
    if (!watch) {
      const c = schedulerStatus().counts;
      console.log(`\n(totals: ${JSON.stringify(c)})`);
    }
  };
  print();
  if (watch) setInterval(print, 2000);
}

function cmdReview(rest: string[]): void {
  const initiativeId = rest[0];
  if (!initiativeId) {
    console.error('forge review: missing <initiative-id>');
    console.error('Usage: forge review <initiative-id> [--inspect | --approve | --abandon]');
    process.exit(2);
  }
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

function cmdMetrics(rest: string[]): void {
  if (rest[0]) {
    console.log(JSON.stringify(summariseCycle(rest[0]), null, 2));
  } else {
    console.log(JSON.stringify(summariseAll(), null, 2));
  }
}

function cmdBench(rest: string[]): void {
  const phase = rest[0];
  if (!phase) {
    console.error('forge bench: usage: bench <phase>');
    process.exit(2);
  }
  console.log(`Run via: npm run bench:${phase}`);
}

function cmdBrain(rest: string[]): void {
  const sub = rest[0];
  if (sub === 'index') return cmdBrainIndex(rest.slice(1));
  if (sub === 'query') return cmdBrainQueryStub(rest.slice(1));
  console.error('forge brain: subcommands: index, query');
  process.exit(2);
}

function cmdBrainIndex(rest: string[]): void {
  const scopeIdx = rest.indexOf('--scope');
  const scope = scopeIdx >= 0 ? rest[scopeIdx + 1] ?? null : null;
  process.stdout.write(loadBrainIndex({ scope }) + '\n');
}

function cmdBrainQueryStub(rest: string[]): void {
  const question = rest.join(' ');
  console.log(`(skeleton) brain-query: "${question}"`);
  console.log('Wire the brain-query skill via @anthropic-ai/claude-agent-sdk to make this real.');
}
