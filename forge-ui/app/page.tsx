'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  fetchCycles,
  fetchEvents,
  subscribe,
  type Cycle,
  type CycleListSnapshot,
  type EventLogEntry,
} from '@/lib/bridge-client';
import { derivePhaseStates, PHASE_ORDER, type PhaseState } from '@/lib/phases';

export default function Page() {
  const [snapshot, setSnapshot] = useState<CycleListSnapshot>({ live: [], recent: [] });
  const [activeCycleId, setActiveCycleId] = useState<string | null>(null);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [connState, setConnState] = useState<'connecting' | 'open' | 'reconnecting'>('connecting');

  // Initial load + subscribe to bridge.
  useEffect(() => {
    let cancelled = false;
    fetchCycles()
      .then((s) => { if (!cancelled) setSnapshot(s); })
      .catch(() => { /* offline */ });

    const sub = subscribe((msg) => {
      if (msg.type === 'snapshot') {
        setSnapshot(msg.cycles);
        setConnState('open');
      } else if (msg.type === 'cycle-list-changed') {
        fetchCycles().then(setSnapshot).catch(() => { /* ignore */ });
      } else if (msg.type === 'event' && msg.cycleId === activeCycleId) {
        setEvents((prev) => [...prev, msg.event]);
      }
    });
    return () => { cancelled = true; sub.close(); setConnState('reconnecting'); };
    // activeCycleId in the closure is captured intentionally per-effect-instance:
    // when it changes we re-subscribe so the per-cycle event filter is correct.
  }, [activeCycleId]);

  // When the active cycle changes, snapshot its full event log.
  useEffect(() => {
    if (!activeCycleId) { setEvents([]); return; }
    let cancelled = false;
    fetchEvents(activeCycleId).then((rows) => { if (!cancelled) setEvents(rows); });
    return () => { cancelled = true; };
  }, [activeCycleId]);

  const allCycles = useMemo(() => [...snapshot.live, ...snapshot.recent], [snapshot]);
  const activeCycle = useMemo(
    () => allCycles.find((c) => c.cycleId === activeCycleId) ?? snapshot.live[0] ?? snapshot.recent[0] ?? null,
    [allCycles, activeCycleId, snapshot],
  );

  // If no explicit selection yet, drive it from the first live cycle (or recent).
  useEffect(() => {
    if (!activeCycleId && activeCycle) setActiveCycleId(activeCycle.cycleId);
  }, [activeCycleId, activeCycle]);

  const phaseStates = useMemo(() => derivePhaseStates(events), [events]);

  return (
    <main style={{ padding: '16px 24px', minHeight: '100vh' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 18, letterSpacing: 0.4 }}>forge</h1>
        <span style={{ fontSize: 12, color: connState === 'open' ? '#7ee787' : '#8b949e' }}>
          bridge {connState === 'open' ? '●' : '○'} {connState}
        </span>
      </header>

      <CyclesTab cycles={allCycles} activeId={activeCycle?.cycleId ?? null} onSelect={setActiveCycleId} />

      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginTop: 24 }}>
        <StateMachine phaseStates={phaseStates} />
        <EventTail events={events} />
      </section>
    </main>
  );
}

function CyclesTab({
  cycles,
  activeId,
  onSelect,
}: {
  cycles: Cycle[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  if (cycles.length === 0) {
    return (
      <div style={{ color: '#8b949e', fontSize: 13 }}>
        No cycles yet. Run <code>forge enqueue …</code> + <code>forge start</code>.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {cycles.map((c) => {
        const active = c.cycleId === activeId;
        return (
          <button
            key={c.cycleId}
            onClick={() => onSelect(c.cycleId)}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              border: '1px solid ' + (active ? '#58a6ff' : '#30363d'),
              background: active ? '#0d1f3a' : '#161b22',
              color: '#e6edf3',
              borderRadius: 6,
              cursor: 'pointer',
            }}
            title={c.initiativeId}
          >
            <span style={{ marginRight: 6 }}>{statusGlyph(c.status)}</span>
            {c.project ?? '(no project)'} · <span style={{ color: '#8b949e' }}>{c.initiativeId}</span>
          </button>
        );
      })}
    </div>
  );
}

function StateMachine({ phaseStates }: { phaseStates: PhaseState[] }) {
  return (
    <div style={panelStyle}>
      <h2 style={panelTitle}>state machine</h2>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {PHASE_ORDER.map((phase) => {
          const s = phaseStates.find((p) => p.phase === phase);
          const status = s?.status ?? 'pending';
          return (
            <li key={phase} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', fontSize: 13 }}>
              <span style={{ width: 18, display: 'inline-block', textAlign: 'center' }}>
                {phaseGlyph(status)}
              </span>
              <span style={{ flex: 1 }}>{phase}</span>
              <span style={{ color: '#8b949e', fontSize: 11 }}>{status}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function EventTail({ events }: { events: EventLogEntry[] }) {
  const recent = events.slice(-50);
  return (
    <div style={panelStyle}>
      <h2 style={panelTitle}>event tail ({events.length} total · last 50 shown)</h2>
      <div style={{ maxHeight: 480, overflowY: 'auto', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 }}>
        {recent.length === 0 ? (
          <div style={{ color: '#8b949e' }}>(no events yet for this cycle)</div>
        ) : (
          recent.map((e) => (
            <div key={e.event_id} style={{ padding: '2px 0', borderBottom: '1px solid #21262d' }}>
              <span style={{ color: '#8b949e' }}>{shortTime(e.started_at)}</span>
              {' '}
              <span style={{ color: phaseColor(e.phase) }}>{e.phase}</span>
              {' '}
              <span>{e.event_type}</span>
              {' '}
              <span>{e.message ?? ''}</span>
            </div>
          ))
        )}
      </div>
    </div>
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

function statusGlyph(s: Cycle['status']): string {
  switch (s) {
    case 'in-flight': return '▶';
    case 'ready-for-review': return '⏸';
    case 'done': return '✓';
    case 'failed': return '✗';
    case 'pending': return '○';
  }
}

function phaseGlyph(s: PhaseState['status']): string {
  switch (s) {
    case 'pending': return '○';
    case 'active': return '▶';
    case 'complete': return '✓';
    case 'failed': return '✗';
  }
}

function phaseColor(phase: string): string {
  const map: Record<string, string> = {
    architect: '#a371f7',
    'project-manager': '#79c0ff',
    'developer-loop': '#7ee787',
    'review-loop': '#ffa657',
    closure: '#d2a8ff',
    reflection: '#ff7b72',
    orchestrator: '#8b949e',
  };
  return map[phase] ?? '#e6edf3';
}

function shortTime(iso: string | undefined): string {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(11, 19);
}
