/**
 * Derive per-work-item status from the event log.
 *
 * The orchestrator emits events scoped to a work-item via
 * `metadata.work_item_id`. Status is a function of the most-recent
 * lifecycle-relevant event for that WI:
 *
 *   - no events                                    → 'pending'
 *   - any 'start' / 'iteration' / 'tool_use' but
 *     no terminal 'end' yet                        → 'active'
 *   - terminal 'end' with metadata.status==='failed'
 *     OR an 'error' event after the most recent
 *     'start'                                      → 'failed'
 *   - terminal 'end' otherwise                     → 'complete'
 *
 * The function is pure and synchronous so it can be unit-tested without
 * the React tree.
 */

import type { EventLogEntry } from './bridge-client';

/**
 * Status state per work item, also reused for features (rolled-up from
 * their WIs) and the dev-loop phase. Distinct from `PhaseStatus` so the
 * 'retrying' state can travel separately from the orchestrator's
 * top-level phase state.
 *
 *   - 'pending'  → no lifecycle events recorded for this unit yet
 *   - 'active'   → started, no terminal end
 *   - 'complete' → ended successfully
 *   - 'retrying' → had at least one non-expected error AND is either
 *     still running OR cycle has not yet emitted a terminal failure.
 *     This corresponds to a transient mid-cycle hiccup that the
 *     orchestrator is recovering from — operator note 2026-05-25:
 *     yellow until the cycle decides it's truly dead.
 *   - 'failed'   → terminal end with metadata.status === 'failed'
 *     AND the cycle has emitted its own terminal failure. Only this
 *     state surfaces red.
 */
export type WiStatus = 'pending' | 'active' | 'complete' | 'retrying' | 'failed';

const LIFECYCLE_TYPES = new Set(['start', 'iteration', 'tool_use', 'end', 'error']);

export function derivePerWiStatus(
  events: readonly EventLogEntry[],
  wiIds: readonly string[],
): Record<string, WiStatus> {
  const cycleFailed = cycleHasFailed(events);
  // Bucket lifecycle events by WI id once. We preserve insertion order from
  // the source array — callers should pass events in chronological order
  // (the bridge guarantees this since the JSONL log is append-only).
  const buckets = new Map<string, EventLogEntry[]>();
  for (const id of wiIds) buckets.set(id, []);
  for (const ev of events) {
    const wiId = ev.metadata?.work_item_id;
    if (typeof wiId !== 'string') continue;
    if (!LIFECYCLE_TYPES.has(ev.event_type)) continue;
    const bucket = buckets.get(wiId);
    if (bucket) bucket.push(ev);
  }

  const out: Record<string, WiStatus> = {};
  for (const id of wiIds) {
    out[id] = statusFor(buckets.get(id) ?? [], cycleFailed);
  }
  return out;
}

/**
 * Returns true iff the cycle has emitted a terminal failure (orchestrator
 * end with status: 'failed'). When false (still running OR ended
 * successfully), per-WI 'failed' is downgraded to 'retrying' (yellow)
 * since the orchestrator considers the failure recoverable in context.
 */
export function cycleHasFailed(events: readonly EventLogEntry[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev.event_type !== 'end') continue;
    // Only the orchestrator's own end carries the cycle-level status.
    if (ev.phase !== 'orchestrator') continue;
    return ev.metadata?.status === 'failed';
  }
  return false;
}

function statusFor(events: readonly EventLogEntry[], cycleFailed: boolean): WiStatus {
  if (events.length === 0) return 'pending';

  // Look at the last 'end' (if any). If present, that's the terminal state
  // for this run of the WI — its metadata.status tells us pass/fail. We
  // also consider any 'error' event that arrived AFTER the most recent
  // 'start' but BEFORE any subsequent 'end' as a fail signal — the
  // orchestrator sometimes emits error then end-failed, sometimes just
  // error with no end (mid-iteration crash).
  const lastEndIdx = lastIndexOfType(events, 'end');
  const lastStartIdx = lastIndexOfType(events, 'start');

  if (lastEndIdx >= 0 && (lastStartIdx < 0 || lastEndIdx > lastStartIdx)) {
    // Terminal end is the freshest lifecycle signal.
    const end = events[lastEndIdx];
    const endIndicatesFailure =
      end.metadata?.status === 'failed' || hasErrorBetween(events, lastStartIdx, lastEndIdx);
    if (endIndicatesFailure) {
      // Per operator note 2026-05-25: red only when the cycle itself
      // has reported a terminal failure. Otherwise this WI is in a
      // transient/retry state — surface yellow.
      return cycleFailed ? 'failed' : 'retrying';
    }
    return 'complete';
  }

  // No terminal end ≥ last start → still active. If an error fired after
  // the start with no end yet, the orchestrator is still running its
  // recovery — yellow, never red, until cycle.end says otherwise.
  if (lastStartIdx >= 0 && hasErrorBetween(events, lastStartIdx, events.length)) {
    return cycleFailed ? 'failed' : 'retrying';
  }
  return 'active';
}

function lastIndexOfType(events: readonly EventLogEntry[], type: string): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].event_type === type) return i;
  }
  return -1;
}

function hasErrorBetween(events: readonly EventLogEntry[], afterIdx: number, beforeIdx: number): boolean {
  for (let i = afterIdx + 1; i < beforeIdx; i++) {
    if (events[i].event_type !== 'error') continue;
    // Expected failures (e.g. iter-0 must-fail gate check) are emitted
    // as `log` events per developer-loop.ts emitGateEvent — but be
    // defensive: also treat any `error` event tagged
    // `metadata.expected_fail: true` as non-terminal so the phase
    // doesn't go red on what is a healthy code path.
    if (events[i].metadata?.expected_fail === true) continue;
    return true;
  }
  return false;
}

/**
 * Roll a set of per-WI statuses up to a per-feature status. Operator
 * note 2026-05-25: failures should not propagate across siblings —
 * features and the dev-loop phase reflect the worst-case state of
 * their own work items only.
 *
 *   - all WIs complete             → 'complete' (green)
 *   - any failed (terminal red)    → 'failed'   (red — cycle dead)
 *   - any retrying (yellow signal) → 'retrying' (yellow)
 *   - any active                   → 'active'   (blue)
 *   - no WIs / no events           → 'pending'  (gray)
 *
 * The "failed > retrying > active > complete > pending" precedence
 * keeps the worst-case state visible while letting healthy siblings
 * stay green next to a yellow sibling.
 */
export function rollupStatus(statuses: readonly WiStatus[]): WiStatus {
  if (statuses.length === 0) return 'pending';
  if (statuses.some((s) => s === 'failed')) return 'failed';
  if (statuses.some((s) => s === 'retrying')) return 'retrying';
  if (statuses.some((s) => s === 'active')) return 'active';
  if (statuses.every((s) => s === 'complete')) return 'complete';
  return 'pending';
}
