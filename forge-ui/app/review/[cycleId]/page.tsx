'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { fetchCycles, subscribe, type Cycle } from '@/lib/bridge-client';
import { ReviewVerdictForm } from '@/components/ReviewVerdictForm';
import { ArtifactBadge } from '@/components/CycleArtifacts';

/**
 * ADR 020 — the standalone review screen. The inline dashboard verdict box was
 * retired; the review human moment (approve / send-back a built PR) now runs on
 * its own page, mirroring the architect plan screen. Surfaces the PLAN + DEMO
 * artifacts for context and the verdict form.
 */
export default function ReviewCyclePage({ params }: { params: { cycleId: string } }): JSX.Element {
  const cycleId = decodeURIComponent(params.cycleId);
  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [loaded, setLoaded] = useState(false);

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
    const sub = subscribe({
      onMessage: (msg) => {
        if (msg.type === 'cycle-list-changed' || msg.type === 'snapshot') refresh();
      },
    });
    return () => { cancelled = true; sub.close(); };
  }, [cycleId]);

  const ready = cycle?.status === 'ready-for-review';

  return (
    <main
      data-page="review-cycle"
      data-cycle-id={cycleId}
      data-cycle-status={cycle?.status ?? ''}
      data-page-ready={loaded ? 'true' : 'false'}
      style={{ padding: '16px 24px', minHeight: '100vh', maxWidth: 900, margin: '0 auto' }}
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
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, fontSize: 13, color: '#8b949e' }}>
            <span>{cycle.project ?? '(no project)'}</span>
            <span>· status: <span style={{ color: ready ? '#d29922' : '#e6edf3' }}>{cycle.status}</span></span>
            <span style={{ display: 'inline-flex', gap: 8 }}>
              <ArtifactBadge cycleId={cycleId} filename="PLAN.md" href={`/plan/${encodeURIComponent(cycleId)}`} label="view plan" title="The architect's PLAN for this cycle" />
              <ArtifactBadge cycleId={cycleId} filename="DEMO.md" href={`/demo/${encodeURIComponent(cycleId)}`} label="view demo" title="The before/after demo for this cycle" />
            </span>
          </div>

          {ready ? (
            <ReviewVerdictForm initiativeId={cycle.initiativeId} />
          ) : (
            <div style={{ border: '1px solid #30363d', borderRadius: 10, padding: '14px 18px', background: '#0d1117', fontSize: 13, color: '#8b949e' }}>
              This cycle is <strong style={{ color: '#e6edf3' }}>{cycle.status}</strong> — a verdict is only needed once it reaches <code>ready-for-review</code>.
            </div>
          )}
        </>
      )}
    </main>
  );
}
