'use client';

import { useEffect, useState } from 'react';

import { resolveBridgeUrl } from '@/lib/bridge-client';

/**
 * Surface "view plan / view demo" links the moment the architect or
 * unifier has filed the corresponding artifact for a cycle. Earlier
 * this lived inside the VerdictForm (only visible at ready-for-review),
 * which buried the architect's plan until after dev-loop + review had
 * finished. The plan is the operator's hand-off acceptance criterion;
 * it should be readable the moment it exists.
 *
 * Probes /api/artifact/<cycleId>/<name> with a HEAD-ish GET; the bridge
 * returns 404 cheaply when the file isn't filed yet. Re-probes every
 * 5s while the cycle is live so the links appear as soon as the
 * artifact lands.
 */
export function CycleArtifacts({ cycleId }: { cycleId: string | null }): JSX.Element | null {
  const [plan, setPlan] = useState<'unknown' | 'present' | 'missing'>('unknown');
  const [demo, setDemo] = useState<'unknown' | 'present' | 'missing'>('unknown');

  useEffect(() => {
    if (!cycleId) { setPlan('unknown'); setDemo('unknown'); return; }
    let cancelled = false;
    const probe = async (filename: string, setter: (s: 'present' | 'missing') => void): Promise<void> => {
      const base = await resolveBridgeUrl();
      if (!base) return;
      try {
        const res = await fetch(`${base}/api/artifact/${encodeURIComponent(cycleId)}/${encodeURIComponent(filename)}`);
        if (cancelled) return;
        setter(res.ok ? 'present' : 'missing');
      } catch { /* bridge transient; will retry on next tick */ }
    };
    const tick = (): void => {
      void probe('PLAN.md', setPlan);
      void probe('DEMO.md', setDemo);
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [cycleId]);

  if (!cycleId) return null;
  if (plan !== 'present' && demo !== 'present') return null;

  return (
    <div
      style={containerStyle}
      data-component="cycle-artifacts"
      data-plan-state={plan}
      data-demo-state={demo}
    >
      <span style={{ fontSize: 11, color: '#8b949e', textTransform: 'uppercase', letterSpacing: 0.4 }}>
        artifacts
      </span>
      {plan === 'present' && (
        <a
          href={`/plan/${encodeURIComponent(cycleId)}`}
          data-action="view-plan"
          target="_blank"
          rel="noreferrer"
          style={linkStyle}
          title="The architect's PLAN.md for this cycle"
        >
          📋 view plan
        </a>
      )}
      {demo === 'present' && (
        <a
          href={`/demo/${encodeURIComponent(cycleId)}`}
          data-action="view-demo"
          target="_blank"
          rel="noreferrer"
          style={linkStyle}
          title="The unifier's DEMO.md for this cycle"
        >
          🎬 view demo
        </a>
      )}
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  marginTop: 14,
  padding: '8px 12px',
  background: '#0d1117',
  border: '1px solid #21262d',
  borderRadius: 6,
};

const linkStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  padding: '4px 10px',
  background: '#161b22',
  border: '1px solid #30363d',
  borderRadius: 5,
  color: '#58a6ff',
  textDecoration: 'none',
};
