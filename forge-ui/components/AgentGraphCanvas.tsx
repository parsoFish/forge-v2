'use client';

/**
 * AgentGraphCanvas — forge's live pipeline stage, styled after patoles/agent-flow.
 *
 * Structure (operator direction 2026-05-29):
 *   - the six cycle PHASES are a top row of hexes; cost pills + live tool
 *     bursts hang off them (architect / PM / review / … fire tools before any
 *     work item exists)
 *   - work items branch off the dev-loop hex as their own hexes
 *   - tool calls are EPHEMERAL BURSTS: a thin-line pill flashes off the active
 *     hex and fades after a few seconds (agent-flow's "quick burst" feel), not
 *     a permanent rectangle stack
 *   - glowing hexes carry a gradient progress arc, a cost pill, and (for WIs) a
 *     token bar + reasoning bubble
 *   - minimal top bar ("N agents · Xk tokens ~$Y" + tab toggles); secondary
 *     detail (Files / Activity / Cost) lives in toggled panels; a bottom LIVE
 *     scrubber shows colour-coded event dots
 *
 * DOM-as-metrics: data-section/-component="agent-graph", data-state,
 * data-wi-count, data-active-wi-id, data-tool-node-count; phase hexes carry
 * data-phase-hex/-phase/-phase-status/-phase-cost-usd; WI hexes data-wi-id/
 * -wi-status/-wi-feature-id/-wi-deps; tool bursts data-tool-node.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  Handle,
  Position,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from 'reactflow';
import dagre from 'dagre';
import 'reactflow/dist/style.css';

import type { CostSummary, EventLogEntry, InitiativeFeature } from '@/lib/bridge-client';
import type { PhaseState, Phase } from '@/lib/phases';
import { PHASE_ORDER } from '@/lib/phases';
import type { WiStatus } from '@/lib/wi-status';
import type { GraphWorkItem } from '@/lib/use-graph-model';
import {
  deriveLiveToolBursts,
  derivePerWiActivity,
  deriveStageTotals,
  toolColour,
  type WiActivity,
} from '@/lib/live-activity';
import { FileHeatmap } from '@/components/FileHeatmap';
import { ActivityPanel } from '@/components/ActivityPanel';

export type AgentGraphCanvasProps = {
  phaseStates: PhaseState[];
  cost: CostSummary | null;
  features: InitiativeFeature[];
  workItems: GraphWorkItem[];
  featureStatuses: Record<string, WiStatus>;
  events: EventLogEntry[];
  cycleId: string | null;
  selectedWiId?: string | null;
  onSelectWi?: (wiId: string) => void;
};

const TOKEN_CAP = 200_000;
const BURST_WINDOW_MS = 3500;

type Dir = 'up' | 'down' | 'left' | 'right';
const DIR_ANGLE: Record<Dir, number> = { up: 270, down: 90, left: 180, right: 0 };
// Owner source handle + burst target handle for each activity direction, so
// connectors leave the correct hex side and enter the correct burst side.
const DIR_HANDLES: Record<Dir, { src: string; tgt: string }> = {
  up: { src: 'st', tgt: 'tb' },
  down: { src: 'sb', tgt: 'tt' },
  left: { src: 'sl', tgt: 'tr' },
  right: { src: 'sr', tgt: 'tl' },
};

const PHASE_X0 = 110;
const PHASE_DX = 168;
const PHASE_Y = 70;
const PHASE_ACTIVE = 116;
const PHASE_IDLE = 88;
const WI_ACTIVE = 132;
const WI_IDLE = 92;
const WI_Y0 = 330;
const TOOL_W = 168;
const TOOL_H = 30;
const BUBBLE_W = 210;
const DEV_INDEX = PHASE_ORDER.indexOf('developer-loop');

const STATUS_GLOW: Record<string, string> = {
  pending: '#475059',
  active: '#1f6feb',
  complete: '#2ea043',
  retrying: '#d29922',
  failed: '#f85149',
};

type Tab = 'none' | 'cost' | 'files' | 'activity';

export function AgentGraphCanvas(props: AgentGraphCanvasProps): JSX.Element {
  const { phaseStates, cost, workItems, events, cycleId, selectedWiId, onSelectWi } = props;
  const [tab, setTab] = useState<Tab>('none');

  // 400ms tick drives the burst fade-out (events age past the window).
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    tick();
    const id = setInterval(tick, 400);
    return () => clearInterval(id);
  }, []);

  const wiActivity = useMemo(() => derivePerWiActivity(events), [events]);
  const activeWiIds = useMemo(() => workItems.filter((w) => w.status === 'active').map((w) => w.id), [workItems]);
  const activeWiId = activeWiIds[0] ?? null;
  const bursts = useMemo(() => deriveLiveToolBursts(events, nowMs, { windowMs: BURST_WINDOW_MS }), [events, nowMs]);

  const activeUnits = activeWiIds.length + phaseStates.filter((p) => p.status === 'active' && p.phase !== 'developer-loop').length;
  const totals = useMemo(() => deriveStageTotals(events, activeUnits || 1), [events, activeUnits]);

  // ---- positions -----------------------------------------------------------
  const phaseCenter = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    PHASE_ORDER.forEach((p, i) => m.set(p, { x: PHASE_X0 + i * PHASE_DX, y: PHASE_Y }));
    return m;
  }, []);
  const devLoopX = PHASE_X0 + DEV_INDEX * PHASE_DX;

  const wiCenter = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    if (workItems.length === 0) return m;
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'TB', nodesep: 130, ranksep: 170, marginx: 20, marginy: 20 });
    g.setDefaultEdgeLabel(() => ({}));
    const ids = new Set(workItems.map((w) => w.id));
    for (const w of workItems) g.setNode(w.id, { width: WI_ACTIVE, height: WI_ACTIVE });
    for (const w of workItems) for (const d of w.dependsOn) if (ids.has(d)) g.setEdge(d, w.id);
    dagre.layout(g);
    let minX = Infinity;
    let maxX = -Infinity;
    for (const w of workItems) {
      const n = g.node(w.id);
      if (!n) continue;
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x);
    }
    const shiftX = devLoopX - (minX + maxX) / 2;
    for (const w of workItems) {
      const n = g.node(w.id);
      if (n) m.set(w.id, { x: n.x + shiftX, y: n.y + WI_Y0 });
    }
    return m;
  }, [workItems, devLoopX]);

  const ownerCenter = useCallback(
    (kind: 'wi' | 'phase', id: string): { x: number; y: number } | undefined =>
      kind === 'wi' ? wiCenter.get(id) : phaseCenter.get(id),
    [wiCenter, phaseCenter],
  );

  // Position-aware activity direction per hex, so bursts never overlap other
  // hexes or connectors:
  //   - phases fan UP (top row, nothing above; one active at a time)
  //   - branch WIs (have dependents below) fan to the SIDE, outward from the
  //     cluster centre (left-of-centre → left, right-of-centre → right)
  //   - leaf WIs (no dependents) fan DOWN
  const { dirByOwner, bubbleSideByWi } = useMemo(() => {
    const dir = new Map<string, Dir>();
    const bubble = new Map<string, 'left' | 'right'>();
    for (const p of PHASE_ORDER) dir.set(p, 'up');
    const hasChild = new Set<string>();
    const ids = new Set(workItems.map((w) => w.id));
    for (const w of workItems) for (const d of w.dependsOn) if (ids.has(d)) hasChild.add(d);
    for (const w of workItems) {
      const c = wiCenter.get(w.id);
      if (!hasChild.has(w.id)) {
        dir.set(w.id, 'down');
        bubble.set(w.id, 'right');
      } else {
        const side: Dir = c && c.x < devLoopX ? 'left' : 'right';
        dir.set(w.id, side);
        bubble.set(w.id, side === 'left' ? 'right' : 'left');
      }
    }
    return { dirByOwner: dir, bubbleSideByWi: bubble };
  }, [workItems, wiCenter, devLoopX]);

  const burstPos = useMemo(() => {
    const m = new Map<string, { x: number; y: number; dir: Dir }>();
    const idxByOwner = new Map<string, number>();
    const countByOwner = new Map<string, number>();
    for (const b of bursts) countByOwner.set(b.ownerId, (countByOwner.get(b.ownerId) ?? 0) + 1);
    for (const b of bursts) {
      const c = ownerCenter(b.ownerKind, b.ownerId);
      if (!c) continue;
      const dir = dirByOwner.get(b.ownerId) ?? 'down';
      const n = countByOwner.get(b.ownerId) ?? 1;
      const i = idxByOwner.get(b.ownerId) ?? 0;
      idxByOwner.set(b.ownerId, i + 1);
      const deg = DIR_ANGLE[dir] + (i - (n - 1) / 2) * 30;
      const theta = (deg * Math.PI) / 180;
      // Side fans reach a little farther so the wider pill clears the hex.
      const R = dir === 'left' || dir === 'right' ? 150 : 124;
      m.set(b.key, { x: c.x + R * Math.cos(theta), y: c.y + R * Math.sin(theta), dir });
    }
    return m;
  }, [bursts, ownerCenter, dirByOwner]);

  const rfNodes = useMemo<Node[]>(() => {
    const nodes: Node[] = [];

    // phase hexes
    PHASE_ORDER.forEach((phase) => {
      const st = (phaseStates.find((p) => p.phase === phase)?.status ?? 'pending') as WiStatus;
      const c = phaseCenter.get(phase)!;
      const size = st === 'active' ? PHASE_ACTIVE : PHASE_IDLE;
      nodes.push({
        id: `phase:${phase}`,
        type: 'hex',
        position: { x: c.x - size / 2, y: c.y - size / 2 },
        data: { kind: 'phase', id: phase, label: shortPhase(phase), status: st, costUsd: cost?.perPhase?.[phase]?.cost_usd ?? 0, active: st === 'active', size },
        width: size,
        height: size,
        draggable: false,
        selectable: false,
      });
    });

    // WI hexes (+ reasoning bubble for the active one)
    for (const w of workItems) {
      const c = wiCenter.get(w.id) ?? { x: devLoopX, y: WI_Y0 };
      const size = w.status === 'active' ? WI_ACTIVE : WI_IDLE;
      const act = wiActivity[w.id];
      nodes.push({
        id: `wi:${w.id}`,
        type: 'hex',
        position: { x: c.x - size / 2, y: c.y - size / 2 },
        data: { kind: 'wi', id: w.id, label: w.title || w.id, status: w.status ?? 'pending', costUsd: act?.costUsd ?? 0, tokens: act?.tokens ?? 0, active: w.status === 'active', size, featureId: w.featureId, deps: w.dependsOn, selected: w.id === selectedWiId, onSelect: onSelectWi },
        width: size,
        height: size,
        draggable: false,
      });
      if (w.status === 'active' && act?.lastReasoning) {
        const side = bubbleSideByWi.get(w.id) ?? 'right';
        const bx = side === 'right' ? c.x + size / 2 + 34 : c.x - size / 2 - 34 - BUBBLE_W;
        nodes.push({
          id: `bubble:${w.id}`,
          type: 'bubble',
          position: { x: bx, y: c.y - 26 },
          data: { text: act.lastReasoning, side },
          width: BUBBLE_W,
          draggable: false,
          selectable: false,
        });
      }
    }

    // ephemeral tool bursts
    for (const b of bursts) {
      const p = burstPos.get(b.key);
      if (!p) continue;
      nodes.push({
        id: `tool:${b.key}`,
        type: 'tool',
        position: { x: p.x - TOOL_W / 2, y: p.y - TOOL_H / 2 },
        data: { tool: b.tool, summary: b.summary, ownerId: b.ownerId, opacity: burstOpacity(b.ageMs) },
        width: TOOL_W,
        height: TOOL_H,
        draggable: false,
        selectable: false,
      });
    }
    return nodes;
  }, [phaseStates, cost, workItems, wiCenter, wiActivity, bursts, burstPos, phaseCenter, devLoopX, selectedWiId, onSelectWi]);

  const rfEdges = useMemo<Edge[]>(() => {
    const edges: Edge[] = [];
    const thin = { stroke: '#1c232c', strokeWidth: 1.5 };
    // phase chain: right → left along the top row
    for (let i = 0; i < PHASE_ORDER.length - 1; i += 1) {
      edges.push({ id: `pc-${i}`, source: `phase:${PHASE_ORDER[i]}`, target: `phase:${PHASE_ORDER[i + 1]}`, sourceHandle: 'sr', targetHandle: 'tl', type: 'default', style: thin });
    }
    // dev-loop → root WIs: bottom-of-mainline → top-of-WI
    const wiIds = new Set(workItems.map((w) => w.id));
    for (const w of workItems) {
      const isRoot = !w.dependsOn.some((d) => wiIds.has(d));
      if (isRoot) edges.push({ id: `dw-${w.id}`, source: 'phase:developer-loop', target: `wi:${w.id}`, sourceHandle: 'sb', targetHandle: 'tt', type: 'default', style: thin });
    }
    // WI deps: bottom-of-parent → top-of-child
    for (const w of workItems) for (const d of w.dependsOn) if (wiIds.has(d)) edges.push({ id: `wd-${d}-${w.id}`, source: `wi:${d}`, target: `wi:${w.id}`, sourceHandle: 'sb', targetHandle: 'tt', type: 'default', style: thin });
    // owner → burst (thin, colour-coded, fading), leaving the open side
    for (const b of bursts) {
      const op = burstOpacity(b.ageMs);
      const dir = burstPos.get(b.key)?.dir ?? 'down';
      const h = DIR_HANDLES[dir];
      edges.push({ id: `tb-${b.key}`, source: b.ownerKind === 'wi' ? `wi:${b.ownerId}` : `phase:${b.ownerId}`, sourceHandle: h.src, target: `tool:${b.key}`, targetHandle: h.tgt, type: 'default', animated: true, style: { stroke: toolColour(b.tool), strokeWidth: 1, opacity: 0.55 * op } });
    }
    // active WI → reasoning bubble, on the open side
    for (const w of workItems) {
      if (w.status !== 'active' || !wiActivity[w.id]?.lastReasoning) continue;
      const side = bubbleSideByWi.get(w.id) ?? 'right';
      edges.push({ id: `bb-${w.id}`, source: `wi:${w.id}`, sourceHandle: side === 'right' ? 'sr' : 'sl', target: `bubble:${w.id}`, targetHandle: side === 'right' ? 'tl' : 'tr', type: 'default', style: { stroke: '#30363d', strokeWidth: 1, strokeDasharray: '3 3' } });
    }
    return edges;
  }, [workItems, bursts, wiActivity, burstPos, bubbleSideByWi]);

  const fitSignal = `${workItems.length}:${activeWiIds.join(',')}:${phaseStates.map((p) => p.status[0]).join('')}`;
  const hasContent = workItems.length > 0 || phaseStates.some((p) => p.status !== 'pending');

  return (
    <div
      style={stageStyle}
      data-section="agent-graph"
      data-component="agent-graph"
      data-state={cycleId ? (hasContent ? 'ready' : 'empty') : 'no-cycle'}
      data-wi-count={workItems.length}
      data-active-wi-id={activeWiId ?? ''}
      data-tool-node-count={bursts.length}
    >
      <TopBar totals={totals} tab={tab} onTab={setTab} />
      <div style={canvasWrapStyle}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
          elementsSelectable
          zoomOnScroll
          panOnDrag
          minZoom={0.2}
        >
          <Background color="#141a22" gap={28} size={1} />
          <Controls showInteractive={false} style={controlsStyle} />
          <FitOnStructuralChange signal={fitSignal} />
        </ReactFlow>

        {tab === 'cost' && <CostPanel cost={cost} workItems={workItems} wiActivity={wiActivity} totals={totals} onClose={() => setTab('none')} />}
        <div style={panelOverlay(tab === 'files')}><FileHeatmap events={events} /></div>
        <div style={panelOverlay(tab === 'activity')}><ActivityPanel events={events} selectedWiId={selectedWiId ?? null} /></div>
      </div>
      <TimelineScrubber events={events} />
    </div>
  );
}

// ===== top bar ==============================================================

function TopBar({ totals, tab, onTab }: { totals: { agents: number; tokens: number; costUsd: number }; tab: Tab; onTab: (t: Tab) => void }): JSX.Element {
  const tabs: { key: Tab; label: string }[] = [
    { key: 'files', label: 'Files' },
    { key: 'activity', label: 'Activity' },
    { key: 'cost', label: '$Cost' },
  ];
  return (
    <div style={topBarStyle}>
      <div style={{ color: '#8b949e', fontSize: 12, fontFamily: MONO }}>
        <span style={{ color: '#e6edf3' }}>{totals.agents}</span> agents
        <span style={dotSep} />
        <span style={{ color: '#e6edf3' }}>{fmtTokens(totals.tokens)}</span> tokens
        <span style={dotSep} />~<span style={{ color: '#7ee787' }}>${totals.costUsd.toFixed(2)}</span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {tabs.map((t) => (
          <button key={t.key} data-tab={t.key} data-tab-active={tab === t.key ? 'true' : 'false'} onClick={() => onTab(tab === t.key ? 'none' : t.key)} style={tabBtn(tab === t.key)}>
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ===== hex node (phase or WI) ===============================================

type HexData = {
  kind: 'phase' | 'wi';
  id: string;
  label: string;
  status: WiStatus;
  costUsd: number;
  tokens?: number;
  active: boolean;
  size: number;
  featureId?: string;
  deps?: string[];
  selected?: boolean;
  onSelect?: (id: string) => void;
};

function HexNode({ data }: NodeProps<HexData>): JSX.Element {
  const onClick = useCallback(() => data.onSelect?.(data.id), [data]);
  const glow = STATUS_GLOW[data.status] ?? '#475059';
  const isWi = data.kind === 'wi';
  const tokens = data.tokens ?? 0;
  const frac = isWi ? Math.max(0.02, Math.min(1, tokens / TOKEN_CAP)) : data.status === 'complete' ? 1 : data.active ? 0.5 : 0.02;
  const S = data.size;
  const dataAttrs = isWi
    ? { 'data-wi-hex': data.id, 'data-wi-id': data.id, 'data-wi-status': data.status, 'data-wi-feature-id': data.featureId ?? '', 'data-wi-deps': (data.deps ?? []).join(',') }
    : { 'data-phase-hex': data.id, 'data-phase': data.id, 'data-phase-status': data.status, 'data-phase-cost-usd': data.costUsd || '' };
  return (
    <div {...dataAttrs} onClick={onClick} style={{ width: S, position: 'relative', cursor: isWi && data.onSelect ? 'pointer' : 'default', textAlign: 'center' }}>
      {/* targets */}
      <Handle id="tt" type="target" position={Position.Top} style={hiddenHandle} isConnectable={false} />
      <Handle id="tl" type="target" position={Position.Left} style={hiddenHandle} isConnectable={false} />
      {/* sources, one per side, for position-aware activity */}
      <Handle id="st" type="source" position={Position.Top} style={hiddenHandle} isConnectable={false} />
      <Handle id="sb" type="source" position={Position.Bottom} style={hiddenHandle} isConnectable={false} />
      <Handle id="sl" type="source" position={Position.Left} style={hiddenHandle} isConnectable={false} />
      <Handle id="sr" type="source" position={Position.Right} style={hiddenHandle} isConnectable={false} />

      {data.costUsd > 0 && <div style={costPill}>${data.costUsd.toFixed(isWi ? 3 : 2)}</div>}
      <Hexagon size={S} glow={glow} frac={frac} active={data.active} selected={!!data.selected} />
      <div style={{ marginTop: 5, fontSize: isWi ? 12 : 11, color: data.status === 'pending' ? '#6e7681' : '#c9d1d9', fontFamily: MONO, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={`${data.id}${isWi ? `: ${data.label}` : ''}`}>
        {isWi ? truncate(data.label, 16) : data.label}
      </div>
      {isWi && (
        <>
          <div style={tokenTrack}><div style={{ height: '100%', width: `${frac * 100}%`, background: `linear-gradient(90deg, ${glow}, #d2a8ff)`, borderRadius: 3 }} /></div>
          <div style={{ fontSize: 9, color: '#5b636d', fontFamily: MONO, marginTop: 2 }}>{fmtTokens(tokens)} / 200k</div>
        </>
      )}
    </div>
  );
}

function Hexagon({ size, glow, frac, active, selected }: { size: number; glow: string; frac: number; active: boolean; selected: boolean }): JSX.Element {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.33;
  const ringR = size * 0.42;
  const pts = [0, 60, 120, 180, 240, 300].map((d) => { const a = (d * Math.PI) / 180; return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`; }).join(' ');
  const circ = 2 * Math.PI * ringR;
  const gid = `arc-${glow.slice(1)}-${Math.round(size)}`;
  return (
    <svg width={size} height={size} style={{ filter: active ? `drop-shadow(0 0 11px ${glow}bb)` : `drop-shadow(0 0 4px ${glow}44)`, display: 'block', margin: '0 auto' }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7ee787" />
          <stop offset="55%" stopColor={glow} />
          <stop offset="100%" stopColor="#d2a8ff" />
        </linearGradient>
      </defs>
      <circle cx={cx} cy={cy} r={ringR} fill="none" stroke="#1c2128" strokeWidth={2.5} />
      <circle cx={cx} cy={cy} r={ringR} fill="none" stroke={`url(#${gid})`} strokeWidth={2.5} strokeLinecap="round" strokeDasharray={`${circ * frac} ${circ}`} transform={`rotate(-90 ${cx} ${cy})`} />
      <polygon points={pts} fill="#0a0f16" stroke={glow} strokeWidth={selected ? 3 : 2} />
      {active ? (
        <g transform={`translate(${cx} ${cy})`} stroke={glow} strokeWidth={1.5} strokeLinecap="round" opacity={0.9}>
          {[0, 45, 90, 135].map((d) => { const a = (d * Math.PI) / 180; const L = size * 0.11; return <line key={d} x1={-L * Math.cos(a)} y1={-L * Math.sin(a)} x2={L * Math.cos(a)} y2={L * Math.sin(a)} />; })}
          <animateTransform attributeName="transform" type="rotate" from="0 0 0" to="360 0 0" dur="6s" repeatCount="indefinite" additive="sum" />
        </g>
      ) : (
        <circle cx={cx} cy={cy} r={size * 0.045} fill={glow} opacity={0.5} />
      )}
    </svg>
  );
}

function ToolBurstNode({ data }: NodeProps<{ tool: string; summary: string; ownerId: string; opacity: number }>): JSX.Element {
  const colour = toolColour(data.tool);
  return (
    <div data-tool-node={data.tool} data-tool-name={data.tool} data-tool-owner={data.ownerId} style={{ width: TOOL_W, minHeight: TOOL_H, boxSizing: 'border-box', padding: '5px 9px', background: '#0a0f16cc', border: `1px solid ${colour}`, borderRadius: 6, fontSize: 11, color: '#c9d1d9', fontFamily: MONO, display: 'flex', gap: 6, alignItems: 'center', opacity: data.opacity, boxShadow: `0 0 9px ${colour}40`, transition: 'opacity 200ms linear' }} title={`${data.tool}: ${data.summary}`}>
      <Handle id="tt" type="target" position={Position.Top} style={hiddenHandle} isConnectable={false} />
      <Handle id="tb" type="target" position={Position.Bottom} style={hiddenHandle} isConnectable={false} />
      <Handle id="tl" type="target" position={Position.Left} style={hiddenHandle} isConnectable={false} />
      <Handle id="tr" type="target" position={Position.Right} style={hiddenHandle} isConnectable={false} />
      <span style={{ color: colour, fontWeight: 600 }}>{data.tool}</span>
      <span style={{ color: '#7d8590', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{truncate(data.summary, 20)}</span>
    </div>
  );
}

function BubbleNode({ data }: NodeProps<{ text: string; side?: 'left' | 'right' }>): JSX.Element {
  return (
    <div style={{ width: BUBBLE_W, background: '#0d131bee', border: '1px solid #2b333c', borderRadius: 8, padding: '7px 10px' }}>
      <Handle id="tl" type="target" position={Position.Left} style={hiddenHandle} isConnectable={false} />
      <Handle id="tr" type="target" position={Position.Right} style={hiddenHandle} isConnectable={false} />
      <div style={{ fontSize: 9, letterSpacing: 0.6, color: '#6e7681', marginBottom: 3, fontFamily: MONO }}>CLAUDE</div>
      <div style={{ fontSize: 11, color: '#adbac7', lineHeight: 1.4 }}>{truncate(data.text, 120)}</div>
    </div>
  );
}

const NODE_TYPES: NodeTypes = { hex: HexNode, tool: ToolBurstNode, bubble: BubbleNode };

function FitOnStructuralChange({ signal }: { signal: string }): JSX.Element | null {
  const rf = useReactFlow();
  useEffect(() => {
    const id = setTimeout(() => rf.fitView({ padding: 0.2, duration: 350 }), 40);
    return () => clearTimeout(id);
  }, [signal, rf]);
  return null;
}

// ===== cost panel ===========================================================

function CostPanel({ cost, workItems, wiActivity, totals, onClose }: { cost: CostSummary | null; workItems: GraphWorkItem[]; wiActivity: Record<string, WiActivity>; totals: { tokens: number; costUsd: number }; onClose: () => void }): JSX.Element {
  const perAgent = workItems.map((w) => ({ id: w.id, cost: wiActivity[w.id]?.costUsd ?? 0 })).filter((a) => a.cost > 0).sort((a, b) => b.cost - a.cost);
  const perPhase = cost ? Object.entries(cost.perPhase).filter(([, m]) => m.cost_usd > 0).sort((a, b) => b[1].cost_usd - a[1].cost_usd) : [];
  return (
    <div style={costCard} data-component="cost-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div><span style={{ color: '#7ee787', fontSize: 16, fontFamily: MONO }}>${totals.costUsd.toFixed(3)}</span> <span style={{ color: '#6e7681', fontSize: 11 }}>{fmtTokens(totals.tokens)} tokens</span></div>
        <button onClick={onClose} style={closeBtn}>×</button>
      </div>
      {perAgent.length > 0 && <div style={costSection}>BY WORK ITEM</div>}
      {perAgent.map((a) => <div key={a.id} style={costRow}><span>{a.id}</span><span style={{ color: '#adbac7' }}>${a.cost.toFixed(3)}</span></div>)}
      {perPhase.length > 0 && <div style={costSection}>BY PHASE</div>}
      {perPhase.map(([p, m]) => <div key={p} style={costRow}><span>{shortPhase(p as Phase)}</span><span style={{ color: '#adbac7' }}>${m.cost_usd.toFixed(3)}</span></div>)}
    </div>
  );
}

// ===== timeline scrubber ====================================================

const EVENT_DOT: Record<string, string> = { tool_use: '#58a6ff', file_change: '#7ee787', iteration: '#d2a8ff', error: '#f85149', agent_heartbeat: '#6e7681', start: '#39c5cf', end: '#2ea043', log: '#8b949e' };

function TimelineScrubber({ events }: { events: EventLogEntry[] }): JSX.Element {
  const dots = events.slice(-90);
  const elapsed = useMemo(() => {
    if (events.length === 0) return '0:00';
    const first = Date.parse(events[0].started_at);
    const last = Date.parse(events[events.length - 1].started_at);
    if (Number.isNaN(first) || Number.isNaN(last)) return '0:00';
    const s = Math.max(0, Math.round((last - first) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, [events]);
  return (
    <div style={scrubberStyle} data-section="timeline-scrubber" data-event-count={events.length}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#f85149', fontSize: 11, fontFamily: MONO }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#f85149', boxShadow: '0 0 6px #f85149' }} />LIVE
      </span>
      <span style={{ color: '#8b949e', fontSize: 11, fontFamily: MONO, minWidth: 34 }}>{elapsed}</span>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 3, overflow: 'hidden' }}>
        {dots.map((e, i) => <span key={`${e.event_id}-${i}`} style={{ width: 6, height: 6, borderRadius: '50%', flex: '0 0 auto', background: EVENT_DOT[e.event_type] ?? '#484f58' }} title={`${e.event_type} — ${e.message ?? ''}`} />)}
      </div>
      <span style={{ color: '#6e7681', fontSize: 11, fontFamily: MONO }}>{events.length}</span>
    </div>
  );
}

// ===== helpers / styles =====================================================

const MONO = 'ui-monospace, Menlo, Consolas, monospace';

function burstOpacity(ageMs: number): number {
  if (ageMs < 250) return ageMs / 250;
  if (ageMs > BURST_WINDOW_MS - 700) return Math.max(0, (BURST_WINDOW_MS - ageMs) / 700);
  return 1;
}
function shortPhase(p: Phase | string): string {
  switch (p) { case 'project-manager': return 'PM'; case 'developer-loop': return 'dev'; case 'review-loop': return 'review'; default: return String(p); }
}
function fmtTokens(n: number): string { return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n); }
function truncate(s: string, max: number): string { if (!s) return ''; return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`; }

const stageStyle: React.CSSProperties = { position: 'relative', background: 'radial-gradient(1200px 620px at 50% -5%, #0b121d 0%, #05070b 72%)', border: '1px solid #161d26', borderRadius: 10, overflow: 'hidden' };
const topBarStyle: React.CSSProperties = { position: 'absolute', top: 0, left: 0, right: 0, height: 44, zIndex: 5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', borderBottom: '1px solid #11161d', background: 'linear-gradient(180deg, #07090dee, #07090d00)' };
const dotSep: React.CSSProperties = { display: 'inline-block', width: 3, height: 3, borderRadius: '50%', background: '#30363d', margin: '0 8px', verticalAlign: 'middle' };
function tabBtn(active: boolean): React.CSSProperties { return { padding: '4px 12px', fontSize: 12, fontFamily: MONO, borderRadius: 6, cursor: 'pointer', color: active ? '#7ee787' : '#8b949e', background: active ? '#0d1f17' : 'transparent', border: `1px solid ${active ? '#2ea04366' : '#21262d'}` }; }
const canvasWrapStyle: React.CSSProperties = { width: '100%', height: 640, position: 'relative' };
const controlsStyle: React.CSSProperties = { background: '#0c1115', border: '1px solid #21262d' };
const costPill: React.CSSProperties = { position: 'absolute', top: -13, left: '50%', transform: 'translateX(-50%)', zIndex: 2, padding: '1px 8px', fontSize: 10, fontFamily: MONO, color: '#7ee787', background: '#07140d', border: '1px solid #2ea04366', borderRadius: 12, whiteSpace: 'nowrap' };
const tokenTrack: React.CSSProperties = { height: 4, width: '74%', margin: '4px auto 0', background: '#11161d', borderRadius: 3, overflow: 'hidden' };
const hiddenHandle: React.CSSProperties = { opacity: 0, width: 1, height: 1, border: 'none', background: 'transparent' };
function panelOverlay(show: boolean): React.CSSProperties { return { position: 'absolute', top: 52, right: 16, width: 380, maxHeight: 540, overflow: 'auto', zIndex: 6, display: show ? 'block' : 'none' }; }
const costCard: React.CSSProperties = { position: 'absolute', top: 52, right: 16, width: 300, zIndex: 6, background: '#0a0f16f2', border: '1px solid #2b333c', borderRadius: 10, padding: 14, color: '#c9d1d9', fontFamily: MONO };
const costSection: React.CSSProperties = { marginTop: 10, marginBottom: 4, fontSize: 9, letterSpacing: 0.6, color: '#6e7681' };
const costRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '2px 0' };
const closeBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: '#6e7681', fontSize: 16, cursor: 'pointer', lineHeight: 1 };
const scrubberStyle: React.CSSProperties = { position: 'absolute', bottom: 0, left: 0, right: 0, height: 40, zIndex: 5, display: 'flex', alignItems: 'center', gap: 12, padding: '0 16px', borderTop: '1px solid #11161d', background: 'linear-gradient(0deg, #07090dee, #07090d00)' };
