'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchCost,
  fetchCycles,
  fetchEvents,
  fetchManifest,
  subscribe,
  type CostSummary,
  type Cycle,
  type CycleListSnapshot,
  type EventLogEntry,
  type ConnectionState,
  type InitiativeFeature,
} from '@/lib/bridge-client';
import { derivePhaseStates, type PhaseState } from '@/lib/phases';
import { CycleToasts } from '@/components/Toasts';
import { AgentHexCanvas, type CanvasWorkItem } from '@/components/AgentHexCanvas';
import { ActivityPanel } from '@/components/ActivityPanel';
import { VerdictForm } from '@/components/VerdictForm';
import { SchedulerBanner } from '@/components/SchedulerBanner';
import { fetchWiGraph, type WiGraph } from '@/lib/wi-graph';

export default function Page() {
  const [snapshot, setSnapshot] = useState<CycleListSnapshot>({ live: [], recent: [] });
  const [activeCycleId, setActiveCycleId] = useState<string | null>(null);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [connState, setConnState] = useState<ConnectionState>('connecting');

  // The WS handler captures activeCycleId via a ref so we don't churn the
  // subscription every time the operator clicks a different cycle.
  const activeCycleIdRef = useRef<string | null>(null);
  useEffect(() => { activeCycleIdRef.current = activeCycleId; }, [activeCycleId]);

  // Open the WebSocket exactly once per mount. Cycle filtering happens
  // inside the handler against the ref.
  useEffect(() => {
    let cancelled = false;
    fetchCycles()
      .then((s) => { if (!cancelled) setSnapshot(s); })
      .catch(() => { /* bridge offline — connState will report */ });

    const sub = subscribe({
      onState: setConnState,
      onMessage: (msg) => {
        if (msg.type === 'snapshot') {
          setSnapshot(msg.cycles);
        } else if (msg.type === 'cycle-list-changed') {
          fetchCycles().then(setSnapshot).catch(() => { /* ignore */ });
        } else if (msg.type === 'event' && msg.cycleId === activeCycleIdRef.current) {
          setEvents((prev) => [...prev, msg.event]);
        }
      },
    });
    return () => { cancelled = true; sub.close(); };
  }, []);

  // When the operator selects a different cycle, snapshot its full event log.
  useEffect(() => {
    if (!activeCycleId) { setEvents([]); return; }
    let cancelled = false;
    fetchEvents(activeCycleId).then((rows) => { if (!cancelled) setEvents(rows); });
    return () => { cancelled = true; };
  }, [activeCycleId]);

  // Operator-selected WI (set by clicking a WI node in WiGraphCanvas).
  // Flows into the ActivityPanel as the default work-item filter.
  const [selectedWiId, setSelectedWiId] = useState<string | null>(null);

  // U1: cost summary per cycle. Re-fetched whenever the active cycle
  // changes; also re-fetched every 10s so live cycles show their cost
  // ticking up. Cheap (just reads the events.jsonl server-side).
  const [cost, setCost] = useState<CostSummary | null>(null);
  useEffect(() => {
    if (!activeCycleId) { setCost(null); return; }
    let cancelled = false;
    const refresh = (): void => {
      fetchCost(activeCycleId).then((c) => { if (!cancelled) setCost(c); });
    };
    refresh();
    const id = setInterval(refresh, 10000);
    return () => { cancelled = true; clearInterval(id); };
  }, [activeCycleId]);

  const allCycles = useMemo(() => [...snapshot.live, ...snapshot.recent], [snapshot]);
  const defaultActive = useMemo(
    () => snapshot.live[0] ?? snapshot.recent[0] ?? null,
    [snapshot],
  );
  // Drive an initial selection once cycles are known.
  useEffect(() => {
    if (!activeCycleId && defaultActive) setActiveCycleId(defaultActive.cycleId);
  }, [activeCycleId, defaultActive]);

  const phaseStates = useMemo(() => derivePhaseStates(events), [events]);
  const activeCycle = useMemo(
    () => allCycles.find((c) => c.cycleId === activeCycleId) ?? null,
    [allCycles, activeCycleId],
  );

  // Manifest features for the active cycle. Hoisted to page-level (was
  // in the now-removed InitiativeInfo panel) so AgentHexCanvas can render
  // the feature tier below the dev-loop hex. Polls every 5s while
  // missing — the manifest is filed at scheduler-claim time so it's
  // usually present immediately, but new cycles can race the fetch.
  const [features, setFeatures] = useState<InitiativeFeature[]>([]);
  useEffect(() => {
    setFeatures([]);
    const initId = activeCycle?.initiativeId;
    if (!initId) return;
    let cancelled = false;
    let loaded = false;
    const attempt = (): void => {
      if (loaded) return;
      void fetchManifest(initId).then((m) => {
        if (cancelled) return;
        if (m) { setFeatures(m.features); loaded = true; }
      });
    };
    attempt();
    const id = setInterval(attempt, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [activeCycle?.initiativeId]);

  // WI graph for the active cycle (PM emits `_logs/<id>/work-items-
  // snapshot/_graph.md` at pm.end). Hoisted from the now-removed
  // WiGraphCanvas. Polls until the bridge serves the graph, then stops.
  const [wiGraph, setWiGraph] = useState<WiGraph | null>(null);
  useEffect(() => {
    setWiGraph(null);
    if (!activeCycleId) return;
    let cancelled = false;
    let loaded = false;
    const attempt = (): void => {
      if (loaded) return;
      void fetchWiGraph(activeCycleId).then((g) => {
        if (cancelled) return;
        if (g) { setWiGraph(g); loaded = true; }
      });
    };
    attempt();
    const id = setInterval(attempt, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [activeCycleId]);

  // Event-driven materialisation per operator note 2026-05-25:
  //   - Features show only when their `pm.feature-decomposed` event has
  //     fired (PM is what actually decomposes them).
  //   - WIs show only when their `pm.work-item-emitted` event has fired
  //     (each event creates one WI hex; titles + dep edges come from
  //     the wi-graph once that lands at pm.end).
  // Pre-PM, both lists are empty. Per-feature / per-WI hexes can fill
  // in incrementally as the events arrive.
  const materialisedFeatures = useMemo(() => {
    if (features.length === 0) return [];
    const ack = new Set<string>();
    for (const e of events) {
      if (e.message !== 'pm.feature-decomposed') continue;
      const fid = (e.metadata as { feature_id?: string } | undefined)?.feature_id;
      if (fid) ack.add(fid);
    }
    if (ack.size === 0) return [];
    return features.filter((f) => ack.has(f.featureId));
  }, [features, events]);

  const workItems = useMemo<CanvasWorkItem[]>(() => {
    const wiFeature = new Map<string, string | undefined>();
    for (const e of events) {
      if (e.message !== 'pm.work-item-emitted') continue;
      const wid = (e.metadata as { work_item_id?: string } | undefined)?.work_item_id;
      const fid = (e.metadata as { feature_id?: string } | undefined)?.feature_id;
      if (wid) wiFeature.set(wid, fid);
    }
    if (wiFeature.size === 0) return [];
    const titleByWi = new Map<string, string>();
    const depsByWi = new Map<string, string[]>();
    if (wiGraph) {
      for (const n of wiGraph.nodes) titleByWi.set(n.id, n.label);
      for (const edge of wiGraph.edges) {
        const arr = depsByWi.get(edge.to) ?? [];
        arr.push(edge.from);
        depsByWi.set(edge.to, arr);
      }
    }
    return Array.from(wiFeature.entries()).map(([id, featureId]) => ({
      id,
      title: titleByWi.get(id) ?? id,
      featureId,
      dependsOn: depsByWi.get(id) ?? [],
    }));
  }, [wiGraph, events]);

  // Surface the resolved bridge URL in the DOM so the operator can
  // diagnose connectivity from view-source / dev-tools without needing
  // to instrument the browser. Updated once on mount.
  const [bridgeUrlDebug, setBridgeUrlDebug] = useState<string>('');
  useEffect(() => {
    let cancelled = false;
    import('@/lib/bridge-client').then(({ resolveBridgeUrl }) => {
      resolveBridgeUrl().then((url) => { if (!cancelled) setBridgeUrlDebug(url || '(none)'); });
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <main
      style={{ padding: '16px 24px', minHeight: '100vh' }}
      // DOM-as-metrics root (cwc-workshops "how-we-claude-code" pattern):
      // every load-bearing UI state is mirrored to a data-* attribute so
      // playwright / scripted automation / LLM-driven UI tests can read
      // page state without scraping rendered text. Keep these in sync
      // when changing component state.
      data-conn-state={connState}
      data-bridge-url={bridgeUrlDebug}
      data-live-count={snapshot.live.length}
      data-recent-count={snapshot.recent.length}
      data-active-cycle-id={activeCycleId ?? ''}
      data-active-cycle-status={activeCycle?.status ?? ''}
      data-active-cycle-events={events.length}
      data-active-cycle-cost-usd={cost?.totalUsd ?? ''}
      data-page-ready={connState === 'open' || connState === 'no-bridge' ? 'true' : 'false'}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 18, letterSpacing: 0.4 }}>forge</h1>
        <ConnectionBadge state={connState} />
        {cost && (
          <span
            data-cost-badge
            data-cost-usd={cost.totalUsd}
            style={{ fontSize: 12, color: '#d2a8ff', fontFamily: 'ui-monospace, Menlo, monospace' }}
            title={`Per-phase: ${Object.entries(cost.perPhase).map(([p, m]) => `${p}=$${m.cost_usd.toFixed(2)}`).join(' · ')}`}
          >
            ${cost.totalUsd.toFixed(2)}
          </span>
        )}
        {connState !== 'open' && bridgeUrlDebug && (
          <span
            data-bridge-url-visible
            style={{ fontSize: 11, color: '#8b949e', fontFamily: 'ui-monospace, Menlo, monospace' }}
            title="The URL the browser is trying to reach for the bridge"
          >
            → {bridgeUrlDebug}
          </span>
        )}
      </header>

      <SchedulerBanner />

      <CyclesTab cycles={allCycles} activeId={activeCycleId} onSelect={setActiveCycleId} />

      {activeCycle?.status === 'ready-for-review' && (
        <section style={{ marginTop: 24 }} data-section="verdict-form">
          <VerdictForm initiativeId={activeCycle.initiativeId} cycleId={activeCycle.cycleId} />
        </section>
      )}

      {/* Single cascading hex tree per 2026-05-25 operator note: phase
          row at top, feature row branching off dev-loop (post-PM), WI
          row below features (post-PM). Replaces the old StateMachine +
          Sidebar + standalone WI graph + InitiativeInfo sections. */}
      <section style={{ marginTop: 24 }} data-section="pipeline-tree">
        <AgentHexCanvas
          phaseStates={phaseStates}
          cost={cost}
          features={materialisedFeatures}
          workItems={workItems}
          cycleId={activeCycleId}
        />
      </section>

      <section style={{ marginTop: 24 }}>
        <ActivityPanel events={events} selectedWiId={selectedWiId} />
      </section>

      <CycleToasts snapshot={snapshot} />
    </main>
  );
}

function ConnectionBadge({ state }: { state: ConnectionState }) {
  const colour =
    state === 'open' ? '#7ee787' :
    state === 'connecting' ? '#d29922' :
    state === 'reconnecting' ? '#f85149' :
    '#8b949e';
  const glyph = state === 'open' ? '●' : state === 'connecting' ? '◐' : state === 'reconnecting' ? '◌' : '○';
  return (
    <span style={{ fontSize: 12, color: colour }} data-conn-badge data-state={state}>
      bridge {glyph} {state}
    </span>
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
      <div style={{ color: '#8b949e', fontSize: 13 }} data-section="cycles-tab" data-cycles-empty="true">
        No cycles yet. Run <code>forge enqueue …</code> + <code>forge start</code>.
      </div>
    );
  }
  return (
    <div
      style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}
      data-section="cycles-tab"
      data-cycles-count={cycles.length}
    >
      {cycles.map((c) => {
        const active = c.cycleId === activeId;
        return (
          <button
            key={c.cycleId}
            data-cycle-id={c.cycleId}
            data-cycle-initiative-id={c.initiativeId}
            data-cycle-status={c.status}
            data-cycle-project={c.project ?? ''}
            data-cycle-active={active ? 'true' : 'false'}
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

function statusGlyph(s: Cycle['status']): string {
  switch (s) {
    case 'in-flight': return '▶';
    case 'ready-for-review': return '⏸';
    case 'done': return '✓';
    case 'failed': return '✗';
    case 'pending': return '○';
  }
}

function shortTime(iso: string | undefined): string {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(11, 19);
}
