/**
 * Scheduler terminal-status dispatch + F-27 bounded auto-retry.
 *
 * Extracted from scheduler.ts (Phase 3 simplification) so the scheduler
 * file stays under the size norm and the "what happens when a cycle
 * ends" logic is one named module. The scheduler imports
 * `dispatchTerminalStatus`; tests import the rest.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { moveTo, type QueuePaths } from './queue.ts';
import { type NotifyEvent } from './notify.ts';
import { parseManifest as parseFullManifest, serializeManifest } from './manifest.ts';

export type DispatchInput = {
  filename: string;
  manifest: { initiativeId: string; project: string };
  result: {
    status: 'merged' | 'pr-open' | 'ready-for-review' | 'send-back-cap-exhausted' | 'failed';
    log_path: string;
  };
};

export type DispatchDeps = {
  paths: QueuePaths;
  notifyFn: (event: NotifyEvent) => Promise<void>;
};

export type DispatchOutcome = {
  /**
   * Where the manifest was moved as a result of this dispatch:
   *   - 'failed'  → moved to `_queue/failed/` (terminal)
   *   - 'pending' → F-27 auto-retry: moved back to `_queue/pending/` with
   *                 retry_count incremented and previous_failure_modes appended
   *   - null      → no move (success paths handled by cycle.ts; or no-op when
   *                 the manifest isn't in in-flight/)
   */
  moved: 'failed' | 'pending' | null;
  notified: NotifyEvent['type'];
  /** F-27: surfaced for tests + telemetry. Null for success paths. */
  retry_decision?: AutoRetryDecision | null;
};

/**
 * F-27: cap on auto-retries per manifest. After this many recoverable
 * failures the scheduler stops retrying and lands the manifest in failed/
 * regardless of the classifier's recommendation. Two retries gives the
 * system enough budget to recover from a transient hiccup without thrashing
 * on a manifest the model can't actually solve.
 */
export const MAX_AUTO_RETRIES = 2;

export type AutoRetryDecision =
  | { retry: false; reason: string }
  | { retry: true; mode: string; nextRetryCount: number };

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
    case 'pr-open': {
      // Phase 6 / G9: the review gate passed and a demo-embedded PR is
      // open, awaiting the operator's merge in GitHub. The reviewer
      // already moved the manifest to `ready-for-review/` (closure
      // promotes it to `done/` only on a confirmed merge). This is the
      // expected unattended terminal state — NOT a failure. Notify the
      // operator that their merge decision is the next step.
      await notifyFn({
        type: 'review-ready',
        title: `PR open — your merge closes it: ${manifest.initiativeId}`,
        body: `${manifest.project} — review gate passed; merge the PR in GitHub to close the review phase. See ${result.log_path}`,
      });
      return { moved: null, notified: 'review-ready' };
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
      // F-27: bounded auto-retry. Read the failure_classification event from
      // the cycle's log; if recoverable AND under the cap, annotate the
      // manifest and move back to pending instead of failed.
      const decision = decideAutoRetry(filename, paths, result.log_path);

      if (decision.retry) {
        try {
          if (existsSync(join(paths.inFlight, filename))) {
            annotateManifestForRetry(
              join(paths.inFlight, filename),
              decision.nextRetryCount,
              decision.mode,
            );
            moveTo(filename, 'pending', paths);
            await notifyFn({
              type: 'failed',
              title: `Auto-retrying: ${manifest.initiativeId}`,
              body: `${manifest.project} — failure mode ${decision.mode} (recoverable). Retry ${decision.nextRetryCount}/${MAX_AUTO_RETRIES}. See ${result.log_path}`,
            });
            return { moved: 'pending', notified: 'failed', retry_decision: decision };
          }
        } catch {
          /* fall through to terminal failure path on any annotate/move error */
        }
      }

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
      return { moved, notified: 'failed', retry_decision: decision };
    }
  }
}

/**
 * F-27: decide whether to auto-retry a failed manifest. Reads the cycle's
 * event log for the most recent `failure_classification` event and the
 * manifest's existing retry_count. Returns a structured decision so the
 * caller can surface it in stdout / telemetry.
 *
 * Exported for tests; the only production caller is `dispatchTerminalStatus`.
 */
export function decideAutoRetry(
  filename: string,
  paths: QueuePaths,
  logPath: string,
): AutoRetryDecision {
  // Read manifest's current retry_count.
  let retryCount = 0;
  let priorModes: string[] = [];
  try {
    const inFlightPath = join(paths.inFlight, filename);
    if (existsSync(inFlightPath)) {
      const m = parseFullManifest(readFileSync(inFlightPath, 'utf8'));
      retryCount = m.retry_count ?? 0;
      priorModes = m.previous_failure_modes ?? [];
    }
  } catch {
    return { retry: false, reason: 'manifest read failed' };
  }
  if (retryCount >= MAX_AUTO_RETRIES) {
    return { retry: false, reason: `retry cap reached (${retryCount}/${MAX_AUTO_RETRIES})` };
  }

  // Read the cycle's event log for the classification.
  let classificationMode: string | null = null;
  let recoverable = false;
  try {
    const raw = readFileSync(logPath, 'utf8');
    for (const line of raw.split('\n').reverse()) {
      if (!line.trim()) continue;
      const e = JSON.parse(line) as { message?: string; metadata?: Record<string, unknown> };
      if (e.message === 'failure_classification') {
        const md = e.metadata ?? {};
        if (typeof md.failure_mode === 'string') classificationMode = md.failure_mode;
        if (typeof md.recoverable === 'boolean') recoverable = md.recoverable;
        break;
      }
    }
  } catch {
    return { retry: false, reason: 'log read failed' };
  }
  if (!classificationMode) {
    return { retry: false, reason: 'no failure_classification event in log' };
  }
  if (!recoverable) {
    return { retry: false, reason: `kind=${classificationMode} is terminal` };
  }
  // With the binary transient|terminal taxonomy the retry-count cap above
  // is the only protection needed — a second transient hit just means
  // another fresh sample, bounded by MAX_AUTO_RETRIES. The per-mode
  // anti-thrash check that used to live here was load-bearing only under
  // the prior 14-mode enum.
  void priorModes;
  return {
    retry: true,
    mode: classificationMode,
    nextRetryCount: retryCount + 1,
  };
}

/**
 * F-27: in-place rewrite of a manifest's frontmatter to bump retry_count and
 * append the failure mode to previous_failure_modes. Round-trips through the
 * full manifest parser/serializer so YAML formatting stays canonical.
 */
function annotateManifestForRetry(
  manifestPath: string,
  nextRetryCount: number,
  mode: string,
): void {
  const m = parseFullManifest(readFileSync(manifestPath, 'utf8'));
  const updated = {
    ...m,
    retry_count: nextRetryCount,
    previous_failure_modes: [...(m.previous_failure_modes ?? []), mode],
  };
  // Re-use the manifest module's serializer so frontmatter ordering stays
  // canonical (matches what `forge enqueue --from-manifest` would produce).
  writeFileSync(manifestPath, serializeManifest(updated));
}
