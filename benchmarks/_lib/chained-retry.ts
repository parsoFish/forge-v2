/**
 * Production-faithful bounded auto-retry for the chained bench.
 *
 * `benchmarks/chained/sdk.ts:runChain` calls the real `orchestrator/
 * cycle.ts:runCycle` exactly once. **Production never does that.**
 * `forge serve` wraps every cycle in the scheduler's bounded auto-retry:
 * after a cycle ends, `orchestrator/scheduler-dispatch.ts:
 * dispatchTerminalStatus` reads the `failure_classification` event
 * `runCycle` wrote (`classifyCycleFailure` + `RECOVERABLE_MODES`), and on
 * a recoverable mode under `MAX_AUTO_RETRIES` (with the same-mode
 * anti-thrash guard in `decideAutoRetry`) annotates the manifest and
 * moves it back to `_queue/pending/`; the scheduler loop then re-claims
 * it and re-runs the cycle.
 *
 * So a single stochastic phase-miss (e.g. the PM emitting one
 * schema-invalid work item — now classified `pm-invalid-work-items`,
 * recoverable) aborts the bench though it would self-heal in prod.
 *
 * This wrapper makes the chained bench exercise the SAME path prod uses
 * by **reusing the real `dispatchTerminalStatus`** as the retry
 * authority — NOT reimplementing the policy. `dispatchTerminalStatus`
 * internally calls `decideAutoRetry` (which reads the classification +
 * the manifest's `retry_count`/`previous_failure_modes`, applies
 * `MAX_AUTO_RETRIES` and the anti-thrash guard) and performs the
 * annotate + `moveTo('pending')` exactly as in `forge serve`. We then
 * mirror the scheduler's re-claim (rename `pending/` → `in-flight/`) and
 * a fresh-worktree-equivalent git reset, and re-run the cycle.
 *
 * The retry/cap/anti-thrash policy lives entirely in the imported
 * orchestrator code; this module only sequences attempts the way the
 * scheduler's `runOne` + poll loop does.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import type { CycleInput, CycleResult } from '../../orchestrator/cycle.ts';
import {
  dispatchTerminalStatus,
  MAX_AUTO_RETRIES,
} from '../../orchestrator/scheduler-dispatch.ts';
import type { QueuePaths } from '../../orchestrator/queue.ts';
import type { NotifyEvent } from '../../orchestrator/notify.ts';

export type RunCycleFn = (input: CycleInput) => Promise<CycleResult>;

export type BoundedRetryInput = {
  /** The cycle input. `manifestPath` must point at `_queue/in-flight/<filename>`. */
  cycleInput: CycleInput;
  /** Queue paths rooted at the chained tempdir's `_queue/`. */
  paths: QueuePaths;
  /** Manifest filename (e.g. `INIT-2026-05-17-x.md`). */
  filename: string;
  manifest: { initiativeId: string; project: string };
  /**
   * The project repo's git HEAD captured immediately after `initGitRepo`
   * (before the first cycle). A retry resets the repo to this commit +
   * cleans, mirroring the scheduler handing each attempt a fresh
   * `git worktree add` of the initiative branch. For the PM-phase
   * recoverable case this is a no-op (the PM never commits); it makes the
   * mirror faithful for any deeper recoverable classification too.
   */
  projDir: string;
  preCycleHead: string;
  /** Inject the cycle runner (test seam). Defaults to the real `runCycle`. */
  runCycleFn: RunCycleFn;
  /**
   * Inject the dispatch (test seam). Defaults to the REAL
   * `dispatchTerminalStatus` — the production retry authority.
   */
  dispatchFn?: typeof dispatchTerminalStatus;
};

export type BoundedRetryResult = {
  /** The final cycle result (last attempt). */
  result: CycleResult;
  /** Number of times the cycle was actually run (1 = no retry). */
  attempts: number;
  /**
   * Per-retry classification modes the real policy authorised
   * (in order). Empty when the first attempt did not fail recoverably.
   */
  retriedModes: string[];
};

/** No-op notifier — the bench has no operator inbox; dispatch only needs the move. */
const NOOP_NOTIFY = async (_event: NotifyEvent): Promise<void> => {
  /* bench: no notification sink */
};

/**
 * Reset the project repo to its pre-cycle commit on the initiative
 * branch and remove untracked files — the in-place equivalent of the
 * scheduler giving a retry a fresh `git worktree add`. The PM also wipes
 * `.forge/work-items/` itself at the start of every run (F-21), so a
 * retried PM always starts from a clean canvas regardless.
 */
function resetRepoForRetry(projDir: string, preCycleHead: string): void {
  const sh = (args: string[]): void => {
    execFileSync('git', args, { cwd: projDir, stdio: 'pipe' });
  };
  try {
    // Find the initiative branch (the one initGitRepo checked out).
    const branch = execFileSync(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: projDir, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' },
    ).trim();
    const targetBranch = branch.startsWith('initiative-') ? branch : null;
    if (targetBranch) sh(['checkout', '-q', targetBranch]);
    sh(['reset', '-q', '--hard', preCycleHead]);
    // Drop untracked scratch (.forge work-items / partial PM output etc.).
    sh(['clean', '-fdq', '-x', '--exclude=node_modules']);
  } catch {
    /* best-effort: a clean repo (PM-only failure) needs no reset anyway */
  }
}

/**
 * Re-claim a manifest the real `dispatchTerminalStatus` moved back to
 * `_queue/pending/` (atomic rename → `_queue/in-flight/`), mirroring the
 * scheduler's `claim`. Returns true iff the manifest is now in in-flight/.
 */
function reclaim(filename: string, paths: QueuePaths): boolean {
  const from = join(paths.pending, filename);
  const to = join(paths.inFlight, filename);
  if (existsSync(to)) return true; // already in-flight (unexpected but fine)
  if (!existsSync(from)) return false;
  try {
    renameSync(from, to);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the cycle with the SAME bounded auto-retry production uses. Reuses
 * the real `dispatchTerminalStatus` (→ `decideAutoRetry` →
 * `classifyCycleFailure` / `RECOVERABLE_MODES` / `MAX_AUTO_RETRIES` /
 * anti-thrash) as the retry authority; this module only sequences the
 * attempts the way the scheduler does.
 *
 * Total attempts are bounded at `1 + MAX_AUTO_RETRIES` (the production
 * bound: the first run carries retry_count=0, then the policy permits at
 * most `MAX_AUTO_RETRIES` re-runs).
 */
export async function runCycleWithBoundedRetry(
  input: BoundedRetryInput,
): Promise<BoundedRetryResult> {
  const {
    cycleInput,
    paths,
    filename,
    manifest,
    projDir,
    preCycleHead,
    runCycleFn,
  } = input;
  const dispatch = input.dispatchFn ?? dispatchTerminalStatus;

  const maxAttempts = 1 + MAX_AUTO_RETRIES;
  const retriedModes: string[] = [];
  let attempts = 0;
  let result: CycleResult;

  for (;;) {
    attempts += 1;
    if (attempts > 1) {
      // Mirror the scheduler: a fresh attempt gets a fresh worktree of
      // the initiative branch. Re-claim the manifest the real dispatch
      // moved back to pending/ (annotated with retry_count), then reset
      // the repo to the pre-cycle commit.
      if (!reclaim(filename, paths)) {
        // The manifest is not where a retry expects it — give up rather
        // than loop forever (defensive; the real dispatch always leaves
        // it in pending/ on an authorised retry).
        break;
      }
      resetRepoForRetry(projDir, preCycleHead);
    }

    result = await runCycleFn(cycleInput);

    if (result.status !== 'failed') {
      // Success / pr-open / ready-for-review / send-back-cap-exhausted —
      // not a retryable failure. The chained harness scores from here.
      return { result, attempts, retriedModes };
    }

    // Failed: hand the terminal status to the REAL production dispatch.
    // It reads the classification `runCycle` wrote, applies the cap +
    // anti-thrash, and (on an authorised recoverable retry) annotates
    // the manifest + moves it back to pending/. We never make this
    // decision ourselves.
    const outcome = await dispatch(
      { filename, manifest, result },
      { paths, notifyFn: NOOP_NOTIFY },
    );

    if (
      outcome.moved === 'pending' &&
      outcome.retry_decision?.retry === true &&
      attempts < maxAttempts
    ) {
      retriedModes.push(outcome.retry_decision.mode);
      continue; // policy authorised an auto-retry — re-run the cycle.
    }

    // Policy declined a retry (non-recoverable / cap reached / same mode
    // repeated) OR we hit the absolute attempt bound: terminal failure.
    return { result, attempts, retriedModes };
  }

  // Unreachable in practice (the loop returns), but TS needs a value and
  // `result` is definitely assigned by the time we can break.
  return { result: result!, attempts, retriedModes };
}
