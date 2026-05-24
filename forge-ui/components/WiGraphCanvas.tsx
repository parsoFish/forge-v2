'use client';

/**
 * WiGraphCanvas — React Flow visualisation of the PM-emitted work-item DAG.
 *
 * Lifecycle:
 *   - On `cycleId` change, refetch the graph (via `fetchWiGraph`) and
 *     compute a dagre TB layout. Stale fetches are guarded by a cancel
 *     flag — the old in-flight promise can't overwrite fresh state.
 *   - Per-WI status is derived from the `events` prop on each render
 *     (cheap; events is already a render-driver upstream).
 *
 * DOM-as-metrics:
 *   - Container: data-section="wi-graph", data-state, data-wi-count
 *   - Each node carries: data-wi-id, data-wi-status, data-wi-deps,
 *     data-wi-enables
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from 'reactflow';
import dagre from 'dagre';
import 'reactflow/dist/style.css';

import type { EventLogEntry } from '@/lib/bridge-client';
import { fetchWiGraph, type WiGraph } from '@/lib/wi-graph';
import { derivePerWiStatus, type WiStatus } from '@/lib/wi-status';

type LoadState = 'no-cycle' | 'loading' | 'no-graph' | 'empty' | 'ready';

type WiNodeData = {
  wiId: string;
  title: string;
  status: WiStatus;
  deps: string[];
  enables: string[];
  onSelect?: (wiId: string) => void;
};

export type WiGraphCanvasProps = {
  cycleId: string | null;
  events: EventLogEntry[];
  onSelectWi?: (wiId: string) => void;
};

const NODE_WIDTH = 180;
const NODE_HEIGHT = 56;

export function WiGraphCanvas({ cycleId, events, onSelectWi }: WiGraphCanvasProps): JSX.Element {
  const [graph, setGraph] = useState<WiGraph | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setGraph(null);
    setLoaded(false);
    if (!cycleId) return;
    fetchWiGraph(cycleId)
      .then((g) => {
        if (cancelled) return;
        setGraph(g);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setGraph(null);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [cycleId]);

  const wiIds = useMemo(() => (graph?.nodes ?? []).map((n) => n.id), [graph]);
  const statusByWi = useMemo(() => derivePerWiStatus(events, wiIds), [events, wiIds]);

  const layoutEdges = useMemo<{ from: string; to: string }[]>(
    () => graph?.edges.map((e) => ({ from: e.from, to: e.to })) ?? [],
    [graph],
  );

  const positions = useMemo(() => {
    if (!graph || graph.nodes.length === 0) return new Map<string, { x: number; y: number }>();
    return computeDagreLayout(graph.nodes.map((n) => n.id), layoutEdges);
  }, [graph, layoutEdges]);

  // ReactFlow nodes. Status / onSelect bind via `data` (the WiNode component
  // reads them) — this means changing status doesn't reshape the graph, it
  // only rerenders nodes whose data identity changes.
  const rfNodes = useMemo<Node<WiNodeData>[]>(() => {
    if (!graph) return [];
    const depsByTo = new Map<string, string[]>();
    const enablesByFrom = new Map<string, string[]>();
    for (const e of graph.edges) {
      const toList = depsByTo.get(e.to) ?? [];
      toList.push(e.from);
      depsByTo.set(e.to, toList);
      const fromList = enablesByFrom.get(e.from) ?? [];
      fromList.push(e.to);
      enablesByFrom.set(e.from, fromList);
    }
    return graph.nodes.map((n) => {
      const pos = positions.get(n.id) ?? { x: 0, y: 0 };
      return {
        id: n.id,
        type: 'wi',
        position: pos,
        data: {
          wiId: n.id,
          title: extractTitle(n.label, n.id),
          status: statusByWi[n.id] ?? 'pending',
          deps: depsByTo.get(n.id) ?? [],
          enables: enablesByFrom.get(n.id) ?? [],
          onSelect: onSelectWi,
        },
        // Width/height hints help ReactFlow size the bounding box for fitView.
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      } satisfies Node<WiNodeData>;
    });
  }, [graph, positions, statusByWi, onSelectWi]);

  const rfEdges = useMemo<Edge[]>(() => {
    if (!graph) return [];
    return graph.edges.map((e, i) => ({
      id: `e-${e.from}-${e.to}-${i}`,
      source: e.from,
      target: e.to,
      animated: false,
      style: { stroke: '#30363d', strokeWidth: 1.5 },
      // Arrowhead colour matches the edge stroke.
      markerEnd: { type: MarkerType.ArrowClosed, color: '#30363d' },
    }));
  }, [graph]);

  const state: LoadState = !cycleId
    ? 'no-cycle'
    : !loaded
    ? 'loading'
    : !graph
    ? 'no-graph'
    : graph.nodes.length === 0
    ? 'empty'
    : 'ready';

  const wiCount = graph?.nodes.length ?? 0;

  return (
    <div
      style={panelStyle}
      data-section="wi-graph"
      data-state={state}
      data-wi-count={wiCount}
    >
      <h2 style={panelTitle}>work items</h2>
      {state === 'no-cycle' && <div style={emptyStyle}>(no cycle selected)</div>}
      {state === 'loading' && <div style={emptyStyle}>loading…</div>}
      {state === 'no-graph' && (
        <div style={emptyStyle}>(no graph for this cycle — PM may not have run)</div>
      )}
      {state === 'empty' && <div style={emptyStyle}>(empty graph)</div>}
      {state === 'ready' && (
        <div style={canvasWrapStyle}>
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={NODE_TYPES}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={true}
            zoomOnScroll={true}
            panOnDrag={true}
          >
            <Background color="#21262d" gap={16} />
            <Controls
              showInteractive={false}
              style={{ background: '#0c1115', border: '1px solid #30363d' }}
            />
          </ReactFlow>
          <style>{PULSE_KEYFRAMES}</style>
        </div>
      )}
    </div>
  );
}

// ----- node renderer ------------------------------------------------------

function WiNode({ data }: NodeProps<WiNodeData>): JSX.Element {
  const onClick = useCallback(() => {
    data.onSelect?.(data.wiId);
  }, [data]);
  const colours = STATUS_COLOURS[data.status];
  return (
    <div
      data-wi-id={data.wiId}
      data-wi-status={data.status}
      data-wi-deps={data.deps.join(',')}
      data-wi-enables={data.enables.join(',')}
      onClick={onClick}
      style={{
        width: NODE_WIDTH,
        minHeight: NODE_HEIGHT,
        boxSizing: 'border-box',
        padding: '8px 10px',
        background: '#161b22',
        color: '#e6edf3',
        border: `2px solid ${colours.border}`,
        borderRadius: 6,
        cursor: data.onSelect ? 'pointer' : 'default',
        fontSize: 12,
        animation: data.status === 'active' ? 'wi-pulse 1.6s ease-in-out infinite' : undefined,
        // Tiny coloured dot to reinforce status without relying on border alone.
        boxShadow: `inset 4px 0 0 0 ${colours.border}`,
      }}
    >
      <Handle type="target" position={Position.Top} style={handleStyle} isConnectable={false} />
      <div
        style={{
          fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
          color: '#79c0ff',
          fontSize: 11,
          marginBottom: 2,
        }}
      >
        {data.wiId}
      </div>
      <div
        style={{
          fontSize: 12,
          lineHeight: 1.3,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={data.title}
      >
        {truncate(data.title, 40)}
      </div>
      <Handle type="source" position={Position.Bottom} style={handleStyle} isConnectable={false} />
    </div>
  );
}

const NODE_TYPES: NodeTypes = { wi: WiNode };

// ----- helpers ------------------------------------------------------------

/**
 * Run dagre to compute (x, y) positions for each node. Returns CENTER-
 * relative coordinates that ReactFlow's default (top-left) renderer can
 * consume — we offset by half the node size.
 */
function computeDagreLayout(
  nodeIds: readonly string[],
  edges: readonly { from: string; to: string }[],
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 60, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of nodeIds) {
    g.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const e of edges) {
    // Skip edges whose endpoints aren't in the node set (defensive).
    if (g.node(e.from) && g.node(e.to)) g.setEdge(e.from, e.to);
  }
  dagre.layout(g);
  const positions = new Map<string, { x: number; y: number }>();
  for (const id of nodeIds) {
    const n = g.node(id);
    if (!n) continue;
    // dagre returns center-coords; ReactFlow positions are top-left.
    positions.set(id, { x: n.x - NODE_WIDTH / 2, y: n.y - NODE_HEIGHT / 2 });
  }
  return positions;
}

function extractTitle(label: string, id: string): string {
  // Labels look like `WI-1: <title>` — strip the prefix.
  return label.startsWith(`${id}: `) ? label.slice(id.length + 2) : label;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

// ----- styles -------------------------------------------------------------

const STATUS_COLOURS: Record<WiStatus, { border: string }> = {
  pending: { border: '#30363d' },
  active: { border: '#1f6feb' },
  complete: { border: '#7ee787' },
  failed: { border: '#f85149' },
};

const panelStyle: React.CSSProperties = {
  background: '#161b22',
  border: '1px solid #30363d',
  borderRadius: 8,
  padding: 16,
  color: '#e6edf3',
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

const canvasWrapStyle: React.CSSProperties = {
  width: '100%',
  height: 480,
  background: '#0c1115',
  border: '1px solid #21262d',
  borderRadius: 6,
  overflow: 'hidden',
};

const handleStyle: React.CSSProperties = {
  width: 6,
  height: 6,
  background: '#30363d',
  border: 'none',
};

const PULSE_KEYFRAMES = `
@keyframes wi-pulse {
  0%, 100% { box-shadow: inset 4px 0 0 0 #1f6feb, 0 0 0 0 rgba(31, 111, 235, 0.45); }
  50%      { box-shadow: inset 4px 0 0 0 #1f6feb, 0 0 0 4px rgba(31, 111, 235, 0.0); }
}
`;
