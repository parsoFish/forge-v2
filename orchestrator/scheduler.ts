/**
 * The unattended scheduler. Per ADR 011, this is a ~150-line loop that:
 *   - claims pending initiatives,
 *   - spawns each as a cycle in its own git worktree,
 *   - heartbeats while the cycle runs,
 *   - moves the manifest to ready-for-review on success or failed on failure,
 *   - fires notifications.
 *
 * `forge serve` runs this forever. `forge serve --once` claims one initiative
 * and exits — used in tests and for one-shot runs.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, lstatSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { setInterval, clearInterval } from 'node:timers';
import {
  claim,
  counts,
  getPaths,
  listPending,
  moveTo,
  recover,
  writeHeartbeat,
  type QueuePaths,
} from './queue.ts';
import * as worktree from './worktree.ts';
import { runCycle } from './cycle.ts';
import { parseManifest as parseFullManifest } from './manifest.ts';
import type { EventLogEntry } from './logging.ts';
import { notify, type NotifyConfig } from './notify.ts';
import { makeFileVerdict } from './file-verdict.ts';
import { loadConfig } from './config.ts';
import {
  dispatchTerminalStatus,
  decideAutoRetry,
  MAX_AUTO_RETRIES,
} from './scheduler-dispatch.ts';

export type SchedulerConfig = {
  queueRoot?: string;
  worktreesRoot?: string; // where git worktrees live
  maxConcurrentInitiatives?: number;
  heartbeatIntervalMs?: number;
  staleHeartbeatMs?: number;
  notify?: NotifyConfig;
  pollIntervalMs?: number;
  /**
   * F-08: how often to re-run the crash-recovery sweep in forever mode.
   * Defaults to 5 minutes (per ADR 012). Ignored in `once` mode.
   */
  recoverIntervalMs?: number;
};

const DEFAULTS: Required<Omit<SchedulerConfig, 'notify' | 'recoverIntervalMs'>> & {
  recoverIntervalMs: number;
} = {
  queueRoot: '_queue',
  worktreesRoot: '_worktrees',
  maxConcurrentInitiatives: 2,
  heartbeatIntervalMs: 30_000,
  staleHeartbeatMs: 5 * 60_000,
  pollIntervalMs: 5_000,
  // F-08 / ADR 012: periodic crash-recovery sweep (forever-mode only).
  recoverIntervalMs: 5 * 60_000,
};

const DEFAULT_NOTIFY: NotifyConfig = { desktop: true, webhook_url: null };

export type RunMode = 'forever' | 'once';

export async function serve(opts: { mode: RunMode } & SchedulerConfig = { mode: 'forever' }): Promise<void> {
  // F-10 / F-18: layer per-machine config from forge.config.json under
  // explicit opts. Order: opts > forge.config.json > DEFAULTS. Missing
  // config file is fine — empty object falls through to DEFAULTS.
  const userConfig = loadConfig();
  const cfg = {
    ...DEFAULTS,
    ...opts,
    notify:
      opts.notify ??
      (userConfig.notify
        ? {
            desktop: userConfig.notify.desktop ?? DEFAULT_NOTIFY.desktop,
            webhook_url: userConfig.notify.webhook_url ?? DEFAULT_NOTIFY.webhook_url,
          }
        : DEFAULT_NOTIFY),
    maxConcurrentInitiatives:
      opts.maxConcurrentInitiatives ??
      userConfig.scheduler?.maxConcurrentInitiatives ??
      DEFAULTS.maxConcurrentInitiatives,
  };
  ensureLayout(cfg);

  // Recovery sweep at startup.
  const recoveries = recover({
    paths: getPaths(cfg.queueRoot),
    staleHeartbeatMs: cfg.staleHeartbeatMs,
    worktreeExists: worktree.exists,
  });
  for (const r of recoveries) {
    // F-09: clean up any orphaned worktrees + scratch branches the
    // recovered initiatives left behind. The recover() call moved the
    // manifest back to pending/; we read it from there to learn the
    // worktree_path and project_repo_path (annotated by the scheduler at
    // claim time).
    cleanupRecoveredWorktrees(r.recovered, getPaths(cfg.queueRoot));
    await notify(
      {
        type: 'recovered',
        title: `Recovered ${r.recovered.length} initiative(s)`,
        body: `Reason: ${r.reason}. Items: ${r.recovered.join(', ')}`,
      },
      cfg.notify,
    );
  }

  const inFlight = new Map<string, Promise<void>>();
  let stop = false;

  // F-22: live stdout in interactive mode. The scheduler-level `notify` calls
  // already print cycle-boundary events; the per-cycle event tee surfaces
  // intra-cycle progress (PM start/end, per-WI dev-loop start/end, review,
  // reflection). Quiet enough to leave running, loud enough to trust.
  // Enabled in both modes — once-mode is the typical validation entry point.
  const tee = makeProgressTee();

  // F-25: track which initiative IDs we've already announced as "blocked" so
  // the idle stdout doesn't repeat the same line every poll cycle (5s).
  const announcedBlocked = new Set<string>();

  const tick = async (): Promise<boolean> => {
    while (inFlight.size < cfg.maxConcurrentInitiatives) {
      const pending = listPending(getPaths(cfg.queueRoot));
      if (pending.length === 0) return false;
      // F-25: walk pending files in order, picking the first whose
      // initiative-level dependencies are all in `_queue/done/`. A blocked
      // initiative stays in pending; we just skip past it.
      let claimed: string | null = null;
      let claimedFilename: string | null = null;
      for (const filename of pending) {
        const initiativeId = filename.replace(/\.md$/, '');
        const blockedBy = checkInitiativeDeps(filename, getPaths(cfg.queueRoot));
        if (blockedBy.length > 0) {
          if (!announcedBlocked.has(initiativeId)) {
            console.log(
              `[serve] skipping ${initiativeId} — blocked by ${blockedBy.join(', ')}`,
            );
            announcedBlocked.add(initiativeId);
          }
          continue;
        }
        announcedBlocked.delete(initiativeId);
        const c = claim(filename, getPaths(cfg.queueRoot));
        if (c) {
          claimed = c;
          claimedFilename = filename;
          break;
        }
      }
      if (!claimed || !claimedFilename) return inFlight.size > 0;
      // Capture the filename for the closure so a later loop iteration's
      // reassignment of `claimedFilename` can't shadow this entry's cleanup.
      const fn: string = claimedFilename;
      const promise = runOne(claimed, fn, cfg, tee).finally(() => {
        inFlight.delete(fn);
      });
      inFlight.set(fn, promise);
      if (cfg.mode === 'once') break;
    }
    return inFlight.size > 0;
  };

  if (cfg.mode === 'once') {
    await tick();
    await Promise.allSettled(inFlight.values());
    return;
  }

  // F-22: signal handlers wire the existing `stop` flag so Ctrl+C drains
  // in-flight cycles cleanly instead of hard-killing the Node process. A
  // second signal force-exits — recovers the operator's intent if the drain
  // hangs (e.g., a wedged SDK call). Heartbeat + queue state is recoverable
  // either way thanks to the recovery sweep, but a clean drain is cheaper.
  const startedAt = Date.now();
  let signalCount = 0;
  const onSignal = (sig: NodeJS.Signals): void => {
    signalCount += 1;
    if (signalCount === 1) {
      stop = true;
      const n = inFlight.size;
      console.log(
        `\n[serve] received ${sig} — ${n === 0 ? 'idle, exiting' : `draining ${n} in-flight cycle(s); send ${sig} again to force-quit`}`,
      );
    } else {
      console.log(`[serve] received second ${sig} — force-quitting`);
      process.exit(130);
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // F-22: idle tick — once a minute, print a one-liner showing queue depth
  // and uptime so the operator knows the process is alive when nothing is
  // happening. Suppressed when stdout isn't a TTY (CI, file capture) so we
  // don't spam log files.
  const showIdle = process.stdout.isTTY && cfg.mode === 'forever';
  const idleTimer = showIdle
    ? setInterval(() => {
        if (stop) return;
        if (inFlight.size > 0) return; // not idle if work is in flight
        const c = counts(getPaths(cfg.queueRoot));
        const upMins = Math.floor((Date.now() - startedAt) / 60_000);
        console.log(
          `[idle] ${inFlight.size} in-flight · ${c.pending} pending · uptime ${upMins}m`,
        );
      }, 60_000)
    : null;

  // F-08 / ADR 012: periodic crash-recovery sweep. The startup sweep above
  // catches state from prior crashes; this catches mid-run loss (a worktree
  // that vanishes, a heartbeat that goes stale because runOne is wedged).
  // Cleared at shutdown so the process can exit cleanly.
  const recoverTimer = setInterval(() => {
    void runRecoverySweep(cfg);
  }, cfg.recoverIntervalMs);

  console.log(
    `[serve] forever-mode · maxConcurrent=${cfg.maxConcurrentInitiatives} · poll=${cfg.pollIntervalMs}ms · Ctrl+C to drain`,
  );

  try {
    // Forever loop.
    for (;;) {
      if (stop) break;
      const hasWork = await tick();
      if (!hasWork) {
        await sleep(cfg.pollIntervalMs);
      } else {
        await Promise.race([sleep(cfg.pollIntervalMs), Promise.all(inFlight.values())]);
      }
    }
  } finally {
    clearInterval(recoverTimer);
    if (idleTimer) clearInterval(idleTimer);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  if (inFlight.size > 0) {
    console.log(`[serve] waiting on ${inFlight.size} in-flight cycle(s) before exit…`);
  }
  await Promise.allSettled(inFlight.values());
  console.log('[serve] exited cleanly');
}

/**
 * Build a tee function that prints interesting cycle events to stdout. Filters
 * the firehose down to phase-transition + per-WI signals — enough to know what
 * the system is doing, not so much that it drowns the terminal.
 */
function makeProgressTee(): (entry: EventLogEntry) => void {
  return (e) => {
    const ts = new Date(e.started_at).toISOString().slice(11, 19);
    const id = e.initiative_id;
    const md = (e.metadata ?? {}) as Record<string, unknown>;
    const cost =
      typeof e.cost_usd === 'number' && e.cost_usd > 0 ? ` · $${e.cost_usd.toFixed(2)}` : '';
    const dur =
      typeof e.duration_ms === 'number' && e.duration_ms > 0
        ? ` · ${formatDur(e.duration_ms)}`
        : '';

    // Cycle boundary
    if (e.phase === 'orchestrator' && e.skill === 'cycle') {
      if (e.event_type === 'start') console.log(`[${ts}] ${id} · cycle started`);
      else if (e.event_type === 'error')
        console.log(`[${ts}] ${id} · cycle ERROR: ${e.message ?? '(no message)'}`);
      return;
    }

    // PM phase
    if (e.phase === 'project-manager' && e.skill === 'project-manager') {
      if (e.event_type === 'start') console.log(`[${ts}] ${id} · PM started`);
      else if (e.event_type === 'error')
        console.log(
          `[${ts}] ${id} · PM FAILED${cost}${dur} · subtype=${md.result_subtype ?? '?'} · WIs=${md.work_item_count ?? '?'}`,
        );
      else if (e.message === 'pm.feature-decomposed') {
        // Skip per-feature noise — covered by the end summary.
      }
      return;
    }

    // Developer-loop per-WI Ralph
    if (e.phase === 'developer-loop' && e.skill === 'developer-ralph') {
      const wi = md.work_item_id ?? '?';
      if (e.message === 'ralph.start') console.log(`[${ts}] ${id} · ${wi} dev started`);
      else if (e.message === 'ralph.skipped')
        console.log(`[${ts}] ${id} · ${wi} dev skipped (${md.reason ?? '?'})`);
      else if (e.message === 'ralph.end') {
        const status = md.status ?? '?';
        const iters = md.iterations ?? '?';
        const reason = md.stop_reason ? ` · ${md.stop_reason}` : '';
        console.log(`[${ts}] ${id} · ${wi} dev ${status}${cost} · iters=${iters}${reason}`);
      }
      return;
    }

    // Developer-loop phase summary
    if (e.phase === 'developer-loop' && e.event_type === 'end' && md.work_item_count) {
      console.log(
        `[${ts}] ${id} · dev-loop summary · ${md.complete}/${md.work_item_count} complete · ${md.failed} failed${cost}${dur}`,
      );
      return;
    }

    // Review phase
    if (e.phase === 'review-loop') {
      if (e.event_type === 'start') console.log(`[${ts}] ${id} · review started`);
      else if (e.event_type === 'end')
        console.log(
          `[${ts}] ${id} · review ${md.verdict ?? md.status ?? 'done'}${cost}${dur}`,
        );
      else if (e.event_type === 'error')
        console.log(`[${ts}] ${id} · review ERROR: ${e.message ?? '(no message)'}`);
      return;
    }

    // Reflection phase
    if (e.phase === 'reflection') {
      if (e.event_type === 'start') console.log(`[${ts}] ${id} · reflection started`);
      else if (e.event_type === 'end')
        console.log(`[${ts}] ${id} · reflection done${cost}${dur}`);
      else if (e.event_type === 'error')
        console.log(`[${ts}] ${id} · reflection FAILED: ${e.message ?? '(no message)'}`);
      return;
    }
  };
}

/**
 * F-25: read a pending manifest's `depends_on_initiatives` and return the
 * subset that are NOT yet in `_queue/done/`. An empty result means all deps
 * are satisfied (or there were no deps) and the scheduler may claim. Best-
 * effort: a malformed manifest returns no blocking deps (the existing
 * validate-on-claim path will reject it for other reasons). Exported for
 * unit-test access — the scheduler is the only production caller.
 */
export function checkInitiativeDeps(filename: string, paths: QueuePaths): string[] {
  const pendingPath = join(paths.pending, filename);
  if (!existsSync(pendingPath)) return [];
  let deps: string[];
  try {
    const full = parseFullManifest(readFileSync(pendingPath, 'utf8'));
    deps = full.depends_on_initiatives ?? [];
  } catch {
    return [];
  }
  if (deps.length === 0) return [];
  return deps.filter((depId) => {
    const donePath = join(paths.done, `${depId}.md`);
    return !existsSync(donePath);
  });
}

/**
 * F-24: link gitignored dependency directories from the source repo into the
 * worktree so `npm test` / `pytest` etc. can actually resolve their imports.
 * Symlinks (not copies) keep this fast — install once at the project level,
 * every cycle's worktree shares it. Idempotent; missing source is a no-op
 * (the project may not use that dep system).
 *
 * Currently links Node's `node_modules`. Generalise here when forge picks up
 * Python (`.venv`) or Rust (`target`) projects that need similar.
 */
function linkProjectDeps(projectRepoPath: string, worktreePath: string): void {
  for (const dir of ['node_modules']) {
    const src = resolve(projectRepoPath, dir);
    const dst = resolve(worktreePath, dir);
    if (!existsSync(src)) continue;
    // Skip if `git worktree add` somehow already produced this path (shouldn't,
    // since it's gitignored, but defend against it). lstatSync, not statSync,
    // so an existing symlink doesn't follow.
    let alreadyExists = false;
    try {
      lstatSync(dst);
      alreadyExists = true;
    } catch {
      /* missing — proceed */
    }
    if (alreadyExists) continue;
    try {
      symlinkSync(src, dst, 'dir');
    } catch {
      /* best-effort — a project that doesn't need deps shouldn't break the cycle */
    }
  }
  // 2026-05-18 fix: forge itself creates the `node_modules` symlink above.
  // A project `.gitignore` of `node_modules/` (trailing slash = directory)
  // does NOT match a *symlink* named `node_modules`, so `git add -A` (the
  // dev-loop boundary commit, and any per-WI agent commit) would sweep the
  // symlink into the PR and merge it to main. Add `node_modules` to THIS
  // worktree's git exclude so no commit path in the worktree can ever stage
  // it — forge-side, non-invasive (does not touch the project's tracked
  // .gitignore), and independent of how the project wrote its rule.
  try {
    const excludePath = execFileSync(
      'git',
      ['-C', worktreePath, 'rev-parse', '--git-path', 'info/exclude'],
      { encoding: 'utf8', stdio: 'pipe' },
    ).trim();
    const abs = resolve(worktreePath, excludePath);
    const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    if (!existing.split('\n').some((l) => l.trim() === 'node_modules')) {
      writeFileSync(
        abs,
        existing + (existing && !existing.endsWith('\n') ? '\n' : '') + 'node_modules\n',
      );
    }
  } catch {
    /* best-effort — the boundary-commit reset below is the second guard */
  }
}

function formatDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m${r}s`;
}

/**
 * Run a single recovery sweep: detect stale-heartbeat / missing-worktree
 * in-flight items, return them to pending/, clean up orphaned worktrees,
 * notify. Best-effort — sweep failures are logged via the notification path
 * but never throw.
 */
async function runRecoverySweep(
  cfg: { queueRoot: string; staleHeartbeatMs: number; notify: NotifyConfig },
): Promise<void> {
  try {
    const recoveries = recover({
      paths: getPaths(cfg.queueRoot),
      staleHeartbeatMs: cfg.staleHeartbeatMs,
      worktreeExists: worktree.exists,
    });
    for (const r of recoveries) {
      cleanupRecoveredWorktrees(r.recovered, getPaths(cfg.queueRoot));
      await notify(
        {
          type: 'recovered',
          title: `Recovered ${r.recovered.length} initiative(s)`,
          body: `Reason: ${r.reason}. Items: ${r.recovered.join(', ')}`,
        },
        cfg.notify,
      );
    }
  } catch {
    /* sweep is best-effort — never throw out of setInterval */
  }
}

async function runOne(
  manifestPath: string,
  filename: string,
  cfg: Required<Omit<SchedulerConfig, 'notify'>> & { notify: NotifyConfig },
  tee: ((entry: EventLogEntry) => void) | undefined,
): Promise<void> {
  const paths = getPaths(cfg.queueRoot);
  const heartbeat = setInterval(() => {
    writeHeartbeat(filename, paths);
  }, cfg.heartbeatIntervalMs);
  // Hold the handle outside the try so the finally block can clean it up
  // regardless of which path produced the result (success, failed, threw).
  let wtHandle: worktree.WorktreeHandle | null = null;
  // F-28: track whether the cycle landed in a "human-resolves-this" state so
  // the finally block can preserve the worktree + branch instead of deleting
  // the only surviving copy of the work. Set inside the try after runCycle
  // returns; defaults to false (clean up like before for thrown errors).
  let preserveWorktree = false;
  try {
    const manifest = parseManifest(manifestPath);
    if (tee) console.log(`[serve] claimed: ${manifest.initiativeId} (${manifest.project})`);
    wtHandle = worktree.add({
      projectRepoPath: manifest.projectRepoPath,
      branch: `forge/${manifest.initiativeId}`,
      worktreesRoot: cfg.worktreesRoot,
      initiativeId: manifest.initiativeId,
    });
    // F-24: link the project's installed dependencies into the worktree.
    // `git worktree add` only checks out tracked files, but `node_modules/`
    // is gitignored — without this, `npm test` fails at module resolution
    // before any test runs, and the dev-loop wedges trying to "fix" what
    // looks like a broken codebase. Idempotent — missing source is a no-op.
    linkProjectDeps(manifest.projectRepoPath, wtHandle.path);
    annotateManifest(manifestPath, { worktree_path: wtHandle.path });

    const result = await runCycle({
      initiativeId: manifest.initiativeId,
      manifestPath,
      projectRepoPath: manifest.projectRepoPath,
      worktreePath: wtHandle.path,
      eventTee: tee,
      // File-based verdict provider — writes a prompt file next to the
      // manifest in `_queue/in-flight/`, polls for the operator's response.
      // Replaces the prior auto-approving default that silently merged every
      // initiative on round 1.
      getVerdict: makeFileVerdict({
        initiativeId: manifest.initiativeId,
        queueRoot: cfg.queueRoot,
        notifier: cfg.notify,
      }),
    });

    if (tee) console.log(`[serve] ${manifest.initiativeId} · cycle ${result.status}`);
    // F-28 + Phase 6: any cycle outcome that ends with the manifest in
    // `ready-for-review/` means a human will look at the work next.
    // Deleting the worktree + branch here would erase the only copy of the
    // changes (the report has the diff text but not a working tree).
    // Preserve in those states; cleanup happens when the operator merges
    // the PR (closure aligns local↔remote) or resolves via the review CLI.
    // `pr-open` (G9: review gate passed, PR awaiting the operator's merge)
    // MUST preserve — the operator needs the branch/worktree until they
    // merge in GitHub; the next cycle re-trigger confirms + aligns.
    preserveWorktree =
      result.status === 'pr-open' ||
      result.status === 'ready-for-review' ||
      result.status === 'send-back-cap-exhausted';
    await dispatchTerminalStatus(
      {
        filename,
        manifest: { initiativeId: manifest.initiativeId, project: manifest.project },
        result,
      },
      {
        paths,
        notifyFn: (event) => notify(event, cfg.notify),
      },
    );
  } catch (err) {
    if (existsSync(join(paths.inFlight, filename))) {
      try {
        moveTo(filename, 'failed', paths);
      } catch {
        /* best-effort — manifest may have moved during throw */
      }
    }
    await notify(
      {
        type: 'failed',
        title: `Failed: ${filename}`,
        body: err instanceof Error ? err.message : String(err),
      },
      cfg.notify,
    );
  } finally {
    clearInterval(heartbeat);
    // F-09 + F-28: clean up the worktree + scratch branch on terminal states
    // only. `merged` (cycle.ts already deleted the branch via gh pr merge),
    // `failed`, or thrown errors all clean up. `ready-for-review` /
    // `send-back-cap-exhausted` preserve the worktree so the human can
    // inspect via `forge review <id>` and `forge review --approve` /
    // `--abandon` triggers cleanup at that point.
    if (wtHandle && !preserveWorktree) {
      try {
        worktree.cleanup(wtHandle);
      } catch {
        /* best-effort — the cleanup helper itself swallows; this catches any unexpected throw */
      }
    }
    if (wtHandle && preserveWorktree && tee) {
      console.log(
        `[serve] preserved worktree: ${wtHandle.path} (branch ${wtHandle.branch}) — resolve via 'forge review <id>'`,
      );
    }
  }
}

// Terminal-status dispatch + F-27 bounded auto-retry moved to
// ./scheduler-dispatch.ts (Phase 3 size split). Re-exported here so the
// public API + test imports are unchanged; scheduler.ts uses
// `dispatchTerminalStatus` internally (runOne).
export { dispatchTerminalStatus, decideAutoRetry, MAX_AUTO_RETRIES };
export type {
  DispatchInput,
  DispatchDeps,
  DispatchOutcome,
  AutoRetryDecision,
} from './scheduler-dispatch.ts';

type ParsedManifest = {
  initiativeId: string;
  project: string;
  projectRepoPath: string;
};

function parseManifest(path: string): ParsedManifest {
  const content = readFileSync(path, 'utf8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) throw new Error(`manifest ${path} missing frontmatter`);
  const fm: Record<string, string> = {};
  for (const line of fmMatch[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  if (!fm.initiative_id) throw new Error(`manifest ${path} missing initiative_id`);
  if (!fm.project) throw new Error(`manifest ${path} missing project`);
  return {
    initiativeId: fm.initiative_id,
    project: fm.project,
    projectRepoPath: fm.project_repo_path ?? resolve('projects', fm.project),
  };
}

function annotateManifest(path: string, fields: Record<string, string>): void {
  const content = readFileSync(path, 'utf8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return;
  let fm = fmMatch[1];
  for (const [k, v] of Object.entries(fields)) {
    const re = new RegExp(`^${k}:.*$`, 'm');
    if (re.test(fm)) {
      fm = fm.replace(re, `${k}: ${v}`);
    } else {
      fm += `\n${k}: ${v}`;
    }
  }
  const updated = content.replace(/^---\n[\s\S]*?\n---/, `---\n${fm}\n---`);
  writeFileSync(path, updated);
}

function ensureLayout(cfg: { queueRoot: string; worktreesRoot: string }): void {
  for (const p of [cfg.queueRoot, cfg.worktreesRoot]) {
    if (!existsSync(resolve(p))) mkdirSync(resolve(p), { recursive: true });
  }
  const paths = getPaths(cfg.queueRoot);
  for (const p of [paths.pending, paths.inFlight, paths.readyForReview, paths.done, paths.failed]) {
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Lightweight status helper for `forge status`.
export function status(queueRoot = '_queue'): { counts: Record<string, number> } {
  return { counts: counts(getPaths(queueRoot)) };
}

/**
 * Best-effort cleanup of orphaned worktrees + scratch branches for a set of
 * filenames recovered to `pending/`. Reads each recovered manifest to extract
 * `worktree_path` (annotated at claim time) and `project_repo_path`, then
 * spawns `worktree.cleanup()` against the corresponding handle. Idempotent —
 * a worktree that no longer exists is fine.
 */
function cleanupRecoveredWorktrees(filenames: string[], paths: ReturnType<typeof getPaths>): void {
  for (const filename of filenames) {
    const recoveredPath = join(paths.pending, filename);
    if (!existsSync(recoveredPath)) continue;
    try {
      const m = parseManifestFile(recoveredPath);
      if (!m || !m.worktree_path) continue;
      worktree.cleanup({
        path: m.worktree_path,
        branch: `forge/${m.initiative_id}`,
        projectRepoPath: m.project_repo_path,
      });
    } catch {
      /* malformed manifest or git error — non-fatal */
    }
  }
}

/**
 * Minimal manifest read for cleanup hot-path. Avoids importing the full
 * gray-matter parser when we only need three fields. Returns null if the
 * frontmatter is malformed.
 */
function parseManifestFile(
  manifestPath: string,
): { initiative_id: string; project_repo_path: string; worktree_path?: string } | null {
  const content = readFileSync(manifestPath, 'utf8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm: Record<string, string> = {};
  for (const line of fmMatch[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  if (!fm.initiative_id || !fm.project_repo_path) return null;
  return {
    initiative_id: fm.initiative_id,
    project_repo_path: fm.project_repo_path,
    worktree_path: fm.worktree_path,
  };
}

