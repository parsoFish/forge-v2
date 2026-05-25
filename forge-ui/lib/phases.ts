/**
 * The forge phase order + the rule that turns an event stream into a
 * "what phase is the cycle currently in?" answer. Mirrors the canonical
 * order in `orchestrator/logging.ts`.
 */

import type { EventLogEntry } from './bridge-client';
import { cycleHasFailed } from './wi-status';

export const PHASE_ORDER = [
  'architect',
  'project-manager',
  'developer-loop',
  'review-loop',
  'closure',
  'reflection',
] as const;

export type Phase = (typeof PHASE_ORDER)[number];

/**
 * 'retrying' was added 2026-05-25 per operator note: phases that have
 * fired error events while the cycle is still recovering (e.g. the
 * unifier's composed gate retrying on transient failures) should be
 * yellow, not red. Red is reserved for cycle-level terminal failure.
 */
export type PhaseStatus = 'pending' | 'active' | 'complete' | 'retrying' | 'failed';

export type PhaseState = { phase: Phase; status: PhaseStatus; lastEventAt?: string };

export function derivePhaseStates(events: readonly EventLogEntry[]): PhaseState[] {
  const cycleFailed = cycleHasFailed(events);
  const seen = new Map<Phase, { firstAt: string; lastAt: string; ended: boolean; errored: boolean }>();
  for (const e of events) {
    if (!isPhase(e.phase)) continue;
    const entry = seen.get(e.phase) ?? { firstAt: e.started_at, lastAt: e.started_at, ended: false, errored: false };
    entry.lastAt = e.started_at;
    if (e.event_type === 'end') entry.ended = true;
    // Expected failures (iter-0 sharp-gate must-fail) emit as 'log' per
    // Bug 3 fix, but be defensive: also ignore any 'error' tagged with
    // metadata.expected_fail so they never tint the phase.
    if (e.event_type === 'error' && e.metadata?.expected_fail !== true) entry.errored = true;
    seen.set(e.phase, entry);
  }
  // Active = the latest phase that has events but hasn't ended yet.
  let activeIdx = -1;
  for (let i = PHASE_ORDER.length - 1; i >= 0; i -= 1) {
    const p = PHASE_ORDER[i];
    const s = seen.get(p);
    if (s && !s.ended) { activeIdx = i; break; }
  }
  return PHASE_ORDER.map((phase, idx): PhaseState => {
    const s = seen.get(phase);
    if (!s) return { phase, status: 'pending' };
    // Ended first — an ended phase that errored in flight but ended
    // OK should be 'complete' (the orchestrator recovered). Red only
    // when the cycle as a whole has failed terminally.
    if (s.ended) {
      if (s.errored && cycleFailed) return { phase, status: 'failed', lastEventAt: s.lastAt };
      return { phase, status: 'complete', lastEventAt: s.lastAt };
    }
    if (s.errored) {
      return { phase, status: cycleFailed ? 'failed' : 'retrying', lastEventAt: s.lastAt };
    }
    if (idx === activeIdx) return { phase, status: 'active', lastEventAt: s.lastAt };
    // Has events, isn't the latest active phase, hasn't ended: stalled.
    return { phase, status: 'active', lastEventAt: s.lastAt };
  });
}

function isPhase(s: string): s is Phase {
  return (PHASE_ORDER as readonly string[]).includes(s);
}
