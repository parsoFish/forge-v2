'use client';

import { useEffect, useState } from 'react';

import { derivePhaseActivity, formatElapsed, type PhaseActivity } from '@/lib/activity';
import type { EventLogEntry } from '@/lib/bridge-client';

export function Sidebar({ events }: { events: EventLogEntry[] }) {
  // Re-render once a second so elapsed times tick.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const phases = derivePhaseActivity(events, now);
  return (
    <div style={panelStyle}>
      <h2 style={panelTitle}>activity</h2>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {phases.map((p) => (
          <PhaseRow key={p.phase} a={p} />
        ))}
      </ol>
    </div>
  );
}

function PhaseRow({ a }: { a: PhaseActivity }) {
  const empty = a.events === 0;
  return (
    <li style={{ padding: '8px 0', borderTop: '1px solid #21262d', opacity: empty ? 0.4 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 13 }}>{a.phase}</span>
        {!empty && (
          <span style={{ fontSize: 11, color: '#8b949e', flex: 1 }}>
            {a.events} event{a.events === 1 ? '' : 's'}
            {a.toolUses > 0 && <> · {a.toolUses} tool</>}
            {a.iterations > 0 && <> · {a.iterations} iter</>}
            {a.errors > 0 && <span style={{ color: '#f85149' }}> · {a.errors} err</span>}
          </span>
        )}
        {!empty && (
          <span style={{ fontSize: 11, color: '#8b949e' }}>
            {formatElapsed(a.elapsedMsSinceLastEvent)} ago
          </span>
        )}
      </div>
      {a.lastWorkItem && (
        <div style={{ fontSize: 11, color: '#79c0ff', marginTop: 2 }}>
          ↳ {a.lastWorkItem}
        </div>
      )}
      {a.lastMessage && (
        <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2, fontFamily: 'ui-monospace, Menlo, monospace' }}>
          {a.lastMessage}
        </div>
      )}
    </li>
  );
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
