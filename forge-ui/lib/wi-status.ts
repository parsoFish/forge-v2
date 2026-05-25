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

export type WiStatus = 'pending' | 'active' | 'complete' | 'failed';

const LIFECYCLE_TYPES = new Set(['start', 'iteration', 'tool_use', 'end', 'error']);

export function derivePerWiStatus(
  events: readonly EventLogEntry[],
  wiIds: readonly string[],
): Record<string, WiStatus> {
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
    out[id] = statusFor(buckets.get(id) ?? []);
  }
  return out;
}

function statusFor(events: readonly EventLogEntry[]): WiStatus {
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
    if (end.metadata?.status === 'failed') return 'failed';
    if (hasErrorBetween(events, lastStartIdx, lastEndIdx)) return 'failed';
    return 'complete';
  }

  // No terminal end ≥ last start → still active. But if an error fired
  // after the start with no end, treat as failed (mid-iteration crash).
  if (lastStartIdx >= 0 && hasErrorBetween(events, lastStartIdx, events.length)) {
    return 'failed';
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
