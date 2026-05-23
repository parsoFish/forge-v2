/**
 * Daemon-related helpers used by the CLI for `forge start` / `stop` /
 * `pause` / `resume`. This module exists as a thin set of helpers around
 * a PID file + log file + pause marker on disk; the scheduler proper lives
 * in `scheduler.ts` (only difference: `daemon.ts` adds the file-based
 * detach + signal protocol).
 *
 * S4: re-introduced as a minimal stub so the CLI typechecks. Operator WIP
 * carries the production daemon implementation; this stub provides only
 * the surface the CLI imports, falling back to no-ops where the real
 * detach + signal protocol would live.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type DaemonPaths = {
  dir: string;
  pidFile: string;
  logFile: string;
  pausedFile: string;
};

/**
 * Resolve daemon-related on-disk paths under `<forgeRoot>/_meta/daemon/`.
 */
export function daemonPaths(forgeRoot: string): DaemonPaths {
  const dir = resolve(forgeRoot, '_meta', 'daemon');
  return {
    dir,
    pidFile: resolve(dir, 'forge.pid'),
    logFile: resolve(dir, 'forge.log'),
    pausedFile: resolve(forgeRoot, '_queue', '.paused'),
  };
}

export type DaemonState = {
  running: boolean;
  pid: number | null;
  paused: boolean;
  startedAt: string | null;
};

/**
 * Inspect the daemon's on-disk state. Returns `{ running: false }` if the
 * pid file is missing or the process has gone away.
 *
 * Takes both `forgeRoot` (for the pid/log paths) and `queueRoot` (for the
 * paused marker) — the CLI's status command needs both.
 */
export function daemonState(forgeRoot: string, queueRoot: string): DaemonState {
  const paths = daemonPaths(forgeRoot);
  const pid = readPid(paths.pidFile);
  const running = pid !== null && isAlive(pid);
  let startedAt: string | null = null;
  if (running && existsSync(paths.pidFile)) {
    try {
      startedAt = statSync(paths.pidFile).mtime.toISOString();
    } catch {
      startedAt = null;
    }
  }
  const pausedFile = resolve(queueRoot, '.paused');
  return {
    running,
    pid: running ? pid : null,
    paused: existsSync(pausedFile),
    startedAt,
  };
}

export function reapStalePidFile(forgeRoot: string): void {
  const paths = daemonPaths(forgeRoot);
  const pid = readPid(paths.pidFile);
  if (pid === null) return;
  if (!isAlive(pid)) {
    try {
      rmSync(paths.pidFile, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

export function writePidFile(forgeRoot: string, pid: number): void {
  const paths = daemonPaths(forgeRoot);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.pidFile, String(pid));
}

export function clearPidFile(forgeRoot: string): void {
  const paths = daemonPaths(forgeRoot);
  try {
    rmSync(paths.pidFile, { force: true });
  } catch {
    /* best-effort */
  }
}

export function readPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  try {
    const raw = readFileSync(pidFile, 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function isAlive(pid: number): boolean {
  try {
    // Signal 0 = existence check (POSIX). Throws if the process is gone.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Toggle the paused marker for the scheduler. `paused = true` writes the
 * marker (with an optional reason as the file body); `paused = false`
 * removes it. Idempotent in both directions.
 */
export function setPaused(paused: boolean, queueRoot: string, reason?: string): void {
  const pausedFile = resolve(queueRoot, '.paused');
  if (paused) {
    mkdirSync(resolve(pausedFile, '..'), { recursive: true });
    writeFileSync(pausedFile, reason ? `${new Date().toISOString()}\n${reason}\n` : new Date().toISOString());
  } else {
    try {
      rmSync(pausedFile, { force: true });
    } catch {
      /* best-effort */
    }
  }
}
