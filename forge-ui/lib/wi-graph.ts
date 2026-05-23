/**
 * Tiny parser for the mermaid `graph TD` blocks the PM emits in
 * `_logs/<cycleId>/work-items-snapshot/_graph.md`. Extracts nodes
 * (id + label) and edges (from → to) so we can render the dependency
 * picture without pulling in the 600KB mermaid lib for v0.
 */

import { resolveBridgeUrl } from './bridge-client';

export type WiNode = { id: string; label: string };
export type WiEdge = { from: string; to: string };
export type WiGraph = { nodes: WiNode[]; edges: WiEdge[] };

export function parseMermaidGraph(markdown: string): WiGraph {
  const nodes: WiNode[] = [];
  const edges: WiEdge[] = [];
  const seenNodes = new Set<string>();
  // Pull out the ```mermaid ... ``` fenced block.
  const fence = markdown.match(/```mermaid\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : markdown;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('graph ') || line.startsWith('%%')) continue;
    // Node: `WI-1["WI-1: …"]`
    const nodeMatch = line.match(/^([A-Za-z0-9_-]+)\[(?:"([^"]*)"|([^\]]+))\]$/);
    if (nodeMatch) {
      const id = nodeMatch[1];
      const label = nodeMatch[2] ?? nodeMatch[3] ?? id;
      if (!seenNodes.has(id)) {
        nodes.push({ id, label });
        seenNodes.add(id);
      }
      continue;
    }
    // Edge: `WI-1 --> WI-2` (also accepts `-->`, `--->`, `-.->`, `==>`).
    const edgeMatch = line.match(/^([A-Za-z0-9_-]+)\s*(?:-+>|-+\.+->|=+>)\s*([A-Za-z0-9_-]+)$/);
    if (edgeMatch) {
      edges.push({ from: edgeMatch[1], to: edgeMatch[2] });
      if (!seenNodes.has(edgeMatch[1])) { nodes.push({ id: edgeMatch[1], label: edgeMatch[1] }); seenNodes.add(edgeMatch[1]); }
      if (!seenNodes.has(edgeMatch[2])) { nodes.push({ id: edgeMatch[2], label: edgeMatch[2] }); seenNodes.add(edgeMatch[2]); }
    }
  }
  return { nodes, edges };
}

export async function fetchWiGraph(cycleId: string): Promise<WiGraph | null> {
  const base = await resolveBridgeUrl();
  if (!base) return null;
  const res = await fetch(`${base}/api/graph/${encodeURIComponent(cycleId)}`);
  if (!res.ok) return null;
  const body = (await res.json()) as { mermaid: string };
  return parseMermaidGraph(body.mermaid);
}
