/**
 * The forge phase order + the rule that turns an event stream into a
 * "what phase is the cycle currently in?" answer. Mirrors the canonical
 * order in `orchestrator/logging.ts`.
 */

import type { EventLogEntry } from './bridge-client';

export const PHASE_ORDER = [
  'architect',
  'project-manager',
  'developer-loop',
  'review-loop',
  'closure',
  'reflection',
] as const;

export type Phase = (typeof PHASE_ORDER)[number];

export type PhaseStatus = 'pending' | 'active' | 'complete' | 'failed';

export type PhaseState = { phase: Phase; status: PhaseStatus; lastEventAt?: string };

export function derivePhaseStates(events: readonly EventLogEntry[]): PhaseState[] {
  const seen = new Map<Phase, { firstAt: string; lastAt: string; ended: boolean; errored: boolean }>();
  for (const e of events) {
    if (!isPhase(e.phase)) continue;
    const entry = seen.get(e.phase) ?? { firstAt: e.started_at, lastAt: e.started_at, ended: false, errored: false };
    entry.lastAt = e.started_at;
    if (e.event_type === 'end') entry.ended = true;
    if (e.event_type === 'error') entry.errored = true;
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
    if (s.errored) return { phase, status: 'failed', lastEventAt: s.lastAt };
    if (idx === activeIdx) return { phase, status: 'active', lastEventAt: s.lastAt };
    if (s.ended) return { phase, status: 'complete', lastEventAt: s.lastAt };
    // Has events, isn't the latest active phase, hasn't ended: stalled.
    return { phase, status: 'active', lastEventAt: s.lastAt };
  });
}

function isPhase(s: string): s is Phase {
  return (PHASE_ORDER as readonly string[]).includes(s);
}
