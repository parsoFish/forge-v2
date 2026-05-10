/**
 * File-based initiative queue (per ADR 011).
 *
 * State machine via directory rename:
 *   _queue/pending → in-flight → ready-for-review → done
 *                      ↓
 *                   failed
 *
 * Atomicity: `rename` on a single filesystem is atomic. That is the entire
 * claim mechanism.
 *
 * Recovery: on serve startup, sweep in-flight for stale heartbeats and
 * missing worktrees; move them back to pending.
 */

import {
  readdirSync,
  renameSync,
  existsSync,
  statSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export type QueueState = 'pending' | 'in-flight' | 'ready-for-review' | 'done' | 'failed';

export type QueuePaths = {
  root: string;
  pending: string;
  inFlight: string;
  readyForReview: string;
  done: string;
  failed: string;
};

export function getPaths(queueRoot = '_queue'): QueuePaths {
  const root = resolve(queueRoot);
  return {
    root,
    pending: join(root, 'pending'),
    inFlight: join(root, 'in-flight'),
    readyForReview: join(root, 'ready-for-review'),
    done: join(root, 'done'),
    failed: join(root, 'failed'),
  };
}

export function listPending(paths = getPaths()): string[] {
  if (!existsSync(paths.pending)) return [];
  return readdirSync(paths.pending)
    .filter((f) => f.endsWith('.md'))
    .sort();
}

export function listInFlight(paths = getPaths()): string[] {
  if (!existsSync(paths.inFlight)) return [];
  return readdirSync(paths.inFlight).filter((f) => f.endsWith('.md'));
}

export function counts(paths = getPaths()): Record<QueueState, number> {
  return {
    pending: safeCount(paths.pending),
    'in-flight': safeCount(paths.inFlight),
    'ready-for-review': safeCount(paths.readyForReview),
    done: safeCount(paths.done),
    failed: safeCount(paths.failed),
  };
}

function safeCount(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith('.md')).length;
}

/**
 * Atomically claim a pending initiative by `rename`. Returns the new in-flight
 * path, or `null` if the file is no longer in pending (claimed by a
 * concurrent caller).
 */
export function claim(filename: string, paths = getPaths()): string | null {
  const from = join(paths.pending, filename);
  const to = join(paths.inFlight, filename);
  try {
    renameSync(from, to);
  } catch {
    return null;
  }
  writeHeartbeat(filename, paths);
  return to;
}

/**
 * Move a manifest from `_queue/in-flight/` to another terminal directory.
 * F-27 widened the target set to include `pending` so the scheduler can
 * auto-retry recoverable failures by sending them back to the front of the
 * queue. `pending` is unique in that it's also the *initial* state — the
 * caller (scheduler) is responsible for incrementing retry_count first so
 * the same manifest doesn't oscillate between in-flight ↔ pending forever.
 */
export function moveTo(
  filename: string,
  toState: Exclude<QueueState, 'in-flight'>,
  paths = getPaths(),
): string {
  const from = join(paths.inFlight, filename);
  const to = join(paths[toStateKey(toState)], filename);
  renameSync(from, to);
  // Clean up the heartbeat that lived alongside the manifest in in-flight.
  const hbPath = join(paths.inFlight, filename + '.heartbeat');
  if (existsSync(hbPath)) unlinkSync(hbPath);
  return to;
}

function toStateKey(state: Exclude<QueueState, 'in-flight'>): keyof QueuePaths {
  switch (state) {
    case 'pending':
      return 'pending';
    case 'ready-for-review':
      return 'readyForReview';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
  }
}

export function writeHeartbeat(filename: string, paths = getPaths()): void {
  const hbPath = join(paths.inFlight, filename + '.heartbeat');
  writeFileSync(hbPath, new Date().toISOString());
}

export type RecoveryResult = {
  recovered: string[];
  reason: 'stale-heartbeat' | 'missing-worktree';
};

/**
 * Sweep in-flight for stale heartbeats and missing worktrees. Returns the
 * filenames that were moved back to pending.
 */
export function recover(opts: {
  paths?: QueuePaths;
  staleHeartbeatMs?: number;
  worktreeExists?: (workTreePath: string) => boolean;
} = {}): RecoveryResult[] {
  const paths = opts.paths ?? getPaths();
  const staleMs = opts.staleHeartbeatMs ?? 5 * 60 * 1000;
  const wtExists = opts.worktreeExists ?? ((p: string) => existsSync(p));

  const stale: string[] = [];
  const missing: string[] = [];

  for (const filename of listInFlight(paths)) {
    const hbPath = join(paths.inFlight, filename + '.heartbeat');
    const manifestPath = join(paths.inFlight, filename);

    // Stale-heartbeat sweep
    if (existsSync(hbPath)) {
      const age = Date.now() - statSync(hbPath).mtimeMs;
      if (age > staleMs) {
        renameSync(manifestPath, join(paths.pending, filename));
        stale.push(filename);
        continue;
      }
    }

    // Missing-worktree sweep
    const worktreePath = parseWorktreePath(manifestPath);
    if (worktreePath && !wtExists(worktreePath)) {
      renameSync(manifestPath, join(paths.pending, filename));
      missing.push(filename);
    }
  }

  const out: RecoveryResult[] = [];
  if (stale.length) out.push({ recovered: stale, reason: 'stale-heartbeat' });
  if (missing.length) out.push({ recovered: missing, reason: 'missing-worktree' });
  return out;
}

/**
 * Parse the `worktree_path` field out of a manifest's YAML frontmatter.
 * Minimal parsing — full YAML parsing comes via gray-matter when needed.
 */
function parseWorktreePath(manifestPath: string): string | null {
  if (!existsSync(manifestPath)) return null;
  const content = readFileSync(manifestPath, 'utf8');
  const match = content.match(/^worktree_path:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}
