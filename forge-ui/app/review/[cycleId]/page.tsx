'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import {
  fetchCycles,
  fetchEvents,
  fetchDemoModel,
  subscribe,
  type Cycle,
  type EventLogEntry,
  type DemoModel,
} from '@/lib/bridge-client';
import { ReviewStageHex } from '@/components/ReviewStageHex';
import { DemoComparison } from '@/components/DemoComparison';
import { ReviewVerdictForm } from '@/components/ReviewVerdictForm';

/**
 * ADR 021 — the standalone review screen. Aligned with the architect plan
 * screen: a focused review hex (left) + the rich artifact and controls (right).
 * The structured demo renders large on its own page (the review equivalent of
 * the PLAN gate), with the verdict form below.
 */
export default function ReviewCyclePage({ params }: { params: { cycleId: string } }): JSX.Element {
  const cycleId = decodeURIComponent(params.cycleId);
  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [demo, setDemo] = useState<DemoModel | null>(null);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [nowMs, setNowMs] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      fetchCycles()
        .then((snap) => {
          if (cancelled) return;
          const all = [...snap.live, ...snap.recent];
          setCycle(all.find((c) => c.cycleId === cycleId) ?? null);
          setLoaded(true);
        })
        .catch(() => { if (!cancelled) setLoaded(true); });
    };
    refresh();
    fetchDemoModel(cycleId).then((d) => { if (!cancelled) setDemo(d); }).catch(() => {});
    fetchEvents(cycleId).then((rows) => { if (!cancelled) setEvents(rows); }).catch(() => {});
    const sub = subscribe({
      onMessage: (msg) => {
        if (msg.type === 'cycle-list-changed' || msg.type === 'snapshot') refresh();
        else if (msg.type === 'event' && msg.cycleId === cycleId) {
          setEvents((prev) => (prev.some((e) => e.event_id === msg.event.event_id) ? prev : [...prev, msg.event]));
        }
      },
    });
    return () => { cancelled = true; sub.close(); };
  }, [cycleId]);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const ready = cycle?.status === 'ready-for-review';

  return (
    <main
      data-page="review-cycle"
      data-cycle-id={cycleId}
      data-cycle-status={cycle?.status ?? ''}
      data-page-ready={loaded ? 'true' : 'false'}
      style={{ padding: '16px 24px', minHeight: '100vh', maxWidth: 1100, margin: '0 auto' }}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 18 }}>
        <Link href="/" data-action="back-to-dashboard" style={{ color: '#58a6ff', fontSize: 13, textDecoration: 'none' }}>
          ← forge
        </Link>
        <h1 style={{ margin: 0, fontSize: 18, letterSpacing: 0.4 }}>review</h1>
        <span style={{ fontSize: 12, color: '#8b949e', fontFamily: 'ui-monospace, Menlo, monospace' }}>
          {cycle?.initiativeId ?? cycleId}
        </span>
      </header>

      {!loaded ? (
        <div style={{ color: '#8b949e', fontSize: 13 }}>Loading cycle…</div>
      ) : !cycle ? (
        <div style={{ color: '#8b949e', fontSize: 13 }}>
          Cycle not found. <Link href="/" style={{ color: '#58a6ff' }}>Back to dashboard</Link>.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 24, alignItems: 'start' }}>
          <ReviewStageHex status={cycle.status} events={events} nowMs={nowMs} />

          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ fontSize: 12, color: '#8b949e' }}>{cycle.project ?? '(no project)'}</div>

            {demo ? (
              <DemoComparison model={demo} />
            ) : (
              <div style={{ border: '1px solid #21262d', borderRadius: 8, padding: '14px 18px', background: '#0b0f14', fontSize: 13, color: '#8b949e' }}>
                No structured demo (<code>demo.json</code>) filed for this cycle yet.
              </div>
            )}

            {ready ? (
              <ReviewVerdictForm initiativeId={cycle.initiativeId} />
            ) : (
              <div style={{ border: '1px solid #30363d', borderRadius: 10, padding: '14px 18px', background: '#0d1117', fontSize: 13, color: '#8b949e' }}>
                This cycle is <strong style={{ color: '#e6edf3' }}>{cycle.status}</strong> — a verdict is only needed once it reaches <code>ready-for-review</code>.
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
