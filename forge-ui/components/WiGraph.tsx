'use client';

import { useEffect, useState } from 'react';

import { fetchWiGraph, type WiGraph } from '@/lib/wi-graph';

export function WiGraphPanel({ cycleId }: { cycleId: string | null }) {
  const [graph, setGraph] = useState<WiGraph | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!cycleId) { setGraph(null); setLoaded(false); return; }
    setLoaded(false);
    fetchWiGraph(cycleId).then((g) => {
      if (cancelled) return;
      setGraph(g);
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [cycleId]);

  return (
    <div style={panelStyle}>
      <h2 style={panelTitle}>work items</h2>
      {!cycleId ? (
        <div style={emptyStyle}>(no cycle selected)</div>
      ) : !loaded ? (
        <div style={emptyStyle}>loading…</div>
      ) : !graph ? (
        <div style={emptyStyle}>(no graph for this cycle — PM may not have run)</div>
      ) : graph.nodes.length === 0 ? (
        <div style={emptyStyle}>(empty graph)</div>
      ) : (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {graph.nodes.map((n) => {
            const deps = graph.edges.filter((e) => e.to === n.id).map((e) => e.from);
            const enables = graph.edges.filter((e) => e.from === n.id).map((e) => e.to);
            return (
              <li key={n.id} style={{ padding: '6px 0', borderTop: '1px solid #21262d', fontSize: 12 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ color: '#79c0ff', fontFamily: 'ui-monospace, Menlo, monospace' }}>{n.id}</span>
                  <span style={{ flex: 1 }}>{stripPrefix(n.label, n.id)}</span>
                </div>
                {(deps.length > 0 || enables.length > 0) && (
                  <div style={{ marginLeft: 16, marginTop: 2, fontSize: 11, color: '#8b949e' }}>
                    {deps.length > 0 && <>after: {deps.join(', ')}</>}
                    {deps.length > 0 && enables.length > 0 && ' · '}
                    {enables.length > 0 && <>unblocks: {enables.join(', ')}</>}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function stripPrefix(label: string, id: string): string {
  // PM emits labels like `WI-1: <title>` — strip the redundant prefix.
  return label.startsWith(`${id}: `) ? label.slice(id.length + 2) : label;
}

const panelStyle: React.CSSProperties = {
  background: '#161b22',
  border: '1px solid #30363d',
  borderRadius: 8,
  padding: 16,
};

const panelTitle: React.CSSProperties = {
  margin: '0 0 12px',
  fontSize: 12,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  color: '#8b949e',
};

const emptyStyle: React.CSSProperties = {
  color: '#8b949e',
  fontSize: 12,
};
