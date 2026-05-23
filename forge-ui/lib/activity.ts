/**
 * Derive a per-phase activity summary from a cycle's event stream.
 * Reads the same JSONL the bridge tails — no extra bridge endpoint
 * needed. Powers the activity sidebar.
 */

import type { EventLogEntry } from './bridge-client';
import { PHASE_ORDER, type Phase } from './phases';

export type PhaseActivity = {
  phase: Phase;
  events: number;
  toolUses: number;
  iterations: number;
  errors: number;
  lastEvent?: EventLogEntry;
  /** Most recent message string from a log / start / end event. */
  lastMessage?: string;
  /** Most recent work-item ID a dev-loop event touched (dev-loop only). */
  lastWorkItem?: string;
  /** Elapsed milliseconds since the phase's last event, given `now`. */
  elapsedMsSinceLastEvent?: number;
};

export function derivePhaseActivity(events: readonly EventLogEntry[], now = Date.now()): PhaseActivity[] {
  const byPhase = new Map<Phase, PhaseActivity>();
  for (const p of PHASE_ORDER) {
    byPhase.set(p, { phase: p, events: 0, toolUses: 0, iterations: 0, errors: 0 });
  }

  for (const e of events) {
    if (!isPhase(e.phase)) continue;
    const a = byPhase.get(e.phase);
    if (!a) continue;
    a.events += 1;
    if (e.event_type === 'tool_use') a.toolUses += 1;
    if (e.event_type === 'iteration') a.iterations += 1;
    if (e.event_type === 'error') a.errors += 1;
    a.lastEvent = e;
    if (e.message) a.lastMessage = truncate(e.message, 80);
    const wi = (e.metadata as { work_item_id?: string } | undefined)?.work_item_id;
    if (wi) a.lastWorkItem = wi;
  }

  for (const a of byPhase.values()) {
    if (!a.lastEvent) continue;
    const t = Date.parse(a.lastEvent.started_at);
    if (!Number.isNaN(t)) a.elapsedMsSinceLastEvent = Math.max(0, now - t);
  }

  return PHASE_ORDER.map((p) => byPhase.get(p)!);
}

function isPhase(s: string): s is Phase {
  return (PHASE_ORDER as readonly string[]).includes(s);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * Format an elapsed-ms value as a compact human string (`2s`, `1m 23s`,
 * `14m`, `1h 02m`, etc.). Returns `--` for undefined.
 */
export function formatElapsed(ms: number | undefined): string {
  if (ms === undefined) return '--';
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec > 0 ? `${min}m ${remSec.toString().padStart(2, '0')}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin.toString().padStart(2, '0')}m`;
}
