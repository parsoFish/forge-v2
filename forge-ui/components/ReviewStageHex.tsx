'use client';

import { StageHex } from './StageHex';
import type { Cycle, EventLogEntry } from '@/lib/bridge-client';

/**
 * ADR 021 — the focused review hex for the standalone review screen. Maps the
 * cycle status to the shared {@link StageHex} so the review screen aligns
 * visually with the architect plan screen: amber "your call" at
 * ready-for-review, green when merged, red on failure.
 */
const STATUS: Record<Cycle['status'], { glow: string; frac: number; label: string }> = {
  pending: { glow: '#6e7681', frac: 0.1, label: 'queued' },
  'in-flight': { glow: '#1f6feb', frac: 0.5, label: 'building' },
  'ready-for-review': { glow: '#d29922', frac: 0.85, label: 'your call' },
  done: { glow: '#2ea043', frac: 1, label: 'merged' },
  failed: { glow: '#f85149', frac: 1, label: 'failed' },
};

export function ReviewStageHex({
  status,
  events,
  nowMs,
}: {
  status: Cycle['status'];
  events: EventLogEntry[];
  nowMs: number;
}): JSX.Element {
  const meta = STATUS[status] ?? { glow: '#475059', frac: 0, label: status };
  const recentActive = events.some((e) => e.started_at && nowMs - new Date(e.started_at).getTime() < 3500);
  return (
    <StageHex
      title="review"
      component="review-hex"
      extraData={{ 'data-cycle-status': status }}
      statusLabel={meta.label}
      glow={meta.glow}
      frac={meta.frac}
      active={status === 'in-flight' || recentActive}
      events={events}
      nowMs={nowMs}
    />
  );
}
