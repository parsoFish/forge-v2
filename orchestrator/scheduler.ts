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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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
import { notify, type NotifyConfig, type NotifyEvent } from './notify.ts';
import { makeFileVerdict } from './file-verdict.ts';
import { loadConfig } from './config.ts';

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

  const tick = async (): Promise<boolean> => {
    while (inFlight.size < cfg.maxConcurrentInitiatives) {
      const pending = listPending(getPaths(cfg.queueRoot));
      if (pending.length === 0) return false;
      const filename = pending[0];
      const claimed = claim(filename, getPaths(cfg.queueRoot));
      if (!claimed) continue;
      const promise = runOne(claimed, filename, cfg).finally(() => {
        inFlight.delete(filename);
      });
      inFlight.set(filename, promise);
      if (cfg.mode === 'once') break;
    }
    return inFlight.size > 0;
  };

  if (cfg.mode === 'once') {
    await tick();
    await Promise.allSettled(inFlight.values());
    return;
  }

  // F-08 / ADR 012: periodic crash-recovery sweep. The startup sweep above
  // catches state from prior crashes; this catches mid-run loss (a worktree
  // that vanishes, a heartbeat that goes stale because runOne is wedged).
  // Cleared at shutdown so the process can exit cleanly.
  const recoverTimer = setInterval(() => {
    void runRecoverySweep(cfg);
  }, cfg.recoverIntervalMs);

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
  }

  await Promise.allSettled(inFlight.values());
  // Stop is set by signal handlers (SIGINT/SIGTERM); not reachable in current
  // skeleton, but kept for future expansion.
  void stop;
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
): Promise<void> {
  const paths = getPaths(cfg.queueRoot);
  const heartbeat = setInterval(() => {
    writeHeartbeat(filename, paths);
  }, cfg.heartbeatIntervalMs);
  // Hold the handle outside the try so the finally block can clean it up
  // regardless of which path produced the result (success, failed, threw).
  let wtHandle: worktree.WorktreeHandle | null = null;
  try {
    const manifest = parseManifest(manifestPath);
    wtHandle = worktree.add({
      projectRepoPath: manifest.projectRepoPath,
      branch: `forge/${manifest.initiativeId}`,
      worktreesRoot: cfg.worktreesRoot,
      initiativeId: manifest.initiativeId,
    });
    annotateManifest(manifestPath, { worktree_path: wtHandle.path });

    const result = await runCycle({
      initiativeId: manifest.initiativeId,
      manifestPath,
      projectRepoPath: manifest.projectRepoPath,
      worktreePath: wtHandle.path,
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
    // F-09: always clean up the worktree + scratch branch. The trial showed
    // that a failed cycle leaks both indefinitely otherwise. Idempotent —
    // safe to call when the worktree was never created (wtHandle null) or
    // when gh pr merge --delete-branch already deleted the branch.
    if (wtHandle) {
      try {
        worktree.cleanup(wtHandle);
      } catch {
        /* best-effort — the cleanup helper itself swallows; this catches any unexpected throw */
      }
    }
  }
}

export type DispatchInput = {
  filename: string;
  manifest: { initiativeId: string; project: string };
  result: {
    status: 'merged' | 'ready-for-review' | 'send-back-cap-exhausted' | 'failed';
    log_path: string;
  };
};

export type DispatchDeps = {
  paths: QueuePaths;
  notifyFn: (event: NotifyEvent) => Promise<void>;
};

export type DispatchOutcome = {
  moved: 'failed' | null;
  notified: NotifyEvent['type'];
};

/**
 * Resolve the cycle's terminal status into a queue move + notification.
 * Idempotent — never moves a manifest that isn't in `in-flight/`. The
 * reviewer (cycle.ts) owns the success-path moves (`done/`,
 * `ready-for-review/`); this dispatch only owns the failure-path move and
 * the operator-visible notification.
 */
export async function dispatchTerminalStatus(
  input: DispatchInput,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const { filename, manifest, result } = input;
  const { paths, notifyFn } = deps;

  switch (result.status) {
    case 'merged': {
      await notifyFn({
        type: 'merged',
        title: `Merged: ${manifest.initiativeId}`,
        body: `${manifest.project} — see ${result.log_path}`,
      });
      return { moved: null, notified: 'merged' };
    }
    case 'ready-for-review': {
      await notifyFn({
        type: 'review-ready',
        title: `Ready for review: ${manifest.initiativeId}`,
        body: `${manifest.project} — see ${result.log_path}`,
      });
      return { moved: null, notified: 'review-ready' };
    }
    case 'send-back-cap-exhausted': {
      // Reviewer moved the manifest to `ready-for-review/` already (PR draft
      // exists; cap was hit before approval). Operator picks up via
      // `forge review <id>` to either approve manually or send back.
      // Notify as 'review-ready' with a body noting the cap.
      await notifyFn({
        type: 'review-ready',
        title: `Review needed (cap exhausted): ${manifest.initiativeId}`,
        body: `${manifest.project} — agent exhausted the send-back cap; PR draft is ready. Run \`forge review ${manifest.initiativeId}\`. See ${result.log_path}`,
      });
      return { moved: null, notified: 'review-ready' };
    }
    case 'failed': {
      let moved: 'failed' | null = null;
      if (existsSync(join(paths.inFlight, filename))) {
        try {
          moveTo(filename, 'failed', paths);
          moved = 'failed';
        } catch {
          /* concurrent move; non-fatal */
        }
      }
      await notifyFn({
        type: 'failed',
        title: `Failed: ${manifest.initiativeId}`,
        body: `${manifest.project} — ${result.status} — see ${result.log_path}`,
      });
      return { moved, notified: 'failed' };
    }
  }
}

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

