'use client';

import { StageHex } from './StageHex';
import type { ArchitectPhase, EventLogEntry } from '@/lib/bridge-client';

/**
 * ADR 020 — the focused architect hex for the dedicated plan screen. Maps the
 * architect phase to the shared {@link StageHex} (glow + arc + label): amber =
 * "needs you" (awaiting answers/verdict), blue = working; pulses with recent
 * tool activity from the session's event stream.
 */

const PHASE_GLOW: Record<ArchitectPhase, string> = {
  interviewing: '#1f6feb',
  drafting: '#1f6feb',
  finalizing: '#1f6feb',
  'awaiting-answers': '#d29922',
  'awaiting-verdict': '#d29922',
  committed: '#2ea043',
  rejected: '#f85149',
};

const PHASE_FRAC: Record<ArchitectPhase, number> = {
  interviewing: 0.15,
  'awaiting-answers': 0.3,
  drafting: 0.55,
  'awaiting-verdict': 0.8,
  finalizing: 0.92,
  committed: 1,
  rejected: 1,
};

const PHASE_LABEL: Record<ArchitectPhase, string> = {
  interviewing: 'thinking',
  'awaiting-answers': 'needs your answers',
  drafting: 'drafting the plan',
  'awaiting-verdict': 'plan ready — your call',
  finalizing: 'finalizing manifests',
  committed: 'queued',
  rejected: 'rejected',
};

export function ArchitectStageHex({
  phase,
  events,
  nowMs,
}: {
  phase: ArchitectPhase;
  events: EventLogEntry[];
  nowMs: number;
}): JSX.Element {
  const working = phase === 'interviewing' || phase === 'drafting' || phase === 'finalizing';
  const recentActive = events.some((e) => e.started_at && nowMs - new Date(e.started_at).getTime() < 3500);
  return (
    <StageHex
      title="architect"
      component="architect-hex"
      extraData={{ 'data-architect-phase': phase, 'data-architect-active': working || recentActive ? 'true' : 'false' }}
      statusLabel={PHASE_LABEL[phase] ?? phase}
      glow={PHASE_GLOW[phase] ?? '#475059'}
      frac={PHASE_FRAC[phase] ?? 0}
      active={working || recentActive}
      events={events}
      nowMs={nowMs}
    />
  );
}
