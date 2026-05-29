/**
 * Live agent activity derivations (Phase B) consumed by AgentGraphCanvas
 * (ephemeral tool nodes that pulse off the active work item) and FileHeatmap
 * (the file-attention heatmap). Both read the per-tool `tool_use` /
 * `file_change` events emitted by orchestrator/tool-event-emit.ts.
 *
 * Pure + synchronous so they're unit-testable without the React tree.
 */

import type { EventLogEntry } from './bridge-client';

export type LiveToolNode = {
  /** Stable id for React Flow keying. */
  key: string;
  /** Owner hex this burst hangs off — a WI (`WI-n`) or a phase name. */
  ownerId: string;
  ownerKind: 'wi' | 'phase';
  tool: string;
  summary: string;
  /** Age in ms since the tool fired — drives the fade-in/out opacity. */
  ageMs: number;
};

/**
 * Ephemeral tool-call bursts: tool_use events whose age is within `windowMs`
 * of `nowMs`, so they flash off their owner hex and fade — the agent-flow
 * "quick burst" feel rather than a permanent pill stack. Owner is the WI when
 * the event carries `work_item_id` (dev-loop), else the phase (architect / PM
 * / review / … fire tools before any WI exists). Returns newest-first.
 *
 * Replay note: for a finished cycle every event is old, so nothing bursts —
 * correct, since replay shows final state, not live activity. Bursts only
 * animate for a genuinely live cycle (recent event timestamps).
 */
export function deriveLiveToolBursts(
  events: readonly EventLogEntry[],
  nowMs: number,
  opts: { windowMs?: number; perOwner?: number; total?: number } = {},
): LiveToolNode[] {
  const windowMs = opts.windowMs ?? 2800;
  const perOwner = opts.perOwner ?? 5;
  const total = opts.total ?? 18;
  if (!nowMs) return [];
  const perOwnerCount = new Map<string, number>();
  const out: LiveToolNode[] = [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.event_type !== 'tool_use') continue;
    const md = e.metadata as { work_item_id?: string; tool?: string; input_summary?: string; coalesced?: boolean } | undefined;
    if (!md || md.coalesced === true) continue;
    const ageMs = nowMs - Date.parse(e.started_at);
    if (Number.isNaN(ageMs) || ageMs < 0 || ageMs > windowMs) continue;
    const ownerId = typeof md.work_item_id === 'string' ? md.work_item_id : e.phase;
    const ownerKind: 'wi' | 'phase' = typeof md.work_item_id === 'string' ? 'wi' : 'phase';
    const n = perOwnerCount.get(ownerId) ?? 0;
    if (n >= perOwner) continue;
    perOwnerCount.set(ownerId, n + 1);
    out.push({ key: `${ownerId}:${e.event_id}`, ownerId, ownerKind, tool: md.tool ?? 'tool', summary: md.input_summary ?? '', ageMs });
    if (out.length >= total) break;
  }
  return out;
}

export type FileHeat = {
  path: string;
  changes: number;
  lastOp: 'add' | 'modify' | 'delete';
};

/** Per-tool colour vocab mirroring agent-flow (Bash amber, write-family green, …). */
export const TOOL_COLOURS: Record<string, string> = {
  Bash: '#d29922',
  Edit: '#7ee787',
  Write: '#7ee787',
  MultiEdit: '#7ee787',
  NotebookEdit: '#7ee787',
  Read: '#58a6ff',
  Grep: '#d2a8ff',
  Glob: '#d2a8ff',
  WebSearch: '#39c5cf',
  WebFetch: '#39c5cf',
};

export function toolColour(name: string): string {
  return TOOL_COLOURS[name] ?? '#8b949e';
}

export type WiActivity = { costUsd: number; tokens: number; lastReasoning: string };

/**
 * Per-work-item cost + token totals + latest reasoning text, summed from the
 * SDK-backed `iteration` events (which carry cost_usd / tokens_in / tokens_out
 * and metadata.last_assistant_text). Feeds the hex agents' cost pill, token
 * bar, and reasoning bubble.
 */
export function derivePerWiActivity(events: readonly EventLogEntry[]): Record<string, WiActivity> {
  const out: Record<string, WiActivity> = {};
  for (const e of events) {
    const md = e.metadata as { work_item_id?: string; last_assistant_text?: string } | undefined;
    const wi = md?.work_item_id;
    if (typeof wi !== 'string') continue;
    const a = out[wi] ?? { costUsd: 0, tokens: 0, lastReasoning: '' };
    if (typeof e.cost_usd === 'number') a.costUsd += e.cost_usd;
    if (typeof e.tokens_in === 'number') a.tokens += e.tokens_in;
    if (typeof e.tokens_out === 'number') a.tokens += e.tokens_out;
    if (typeof md?.last_assistant_text === 'string' && md.last_assistant_text) {
      a.lastReasoning = md.last_assistant_text;
    }
    out[wi] = a;
  }
  return out;
}

export type StageTotals = { agents: number; tokens: number; costUsd: number };

/** Top-bar rollup: active-agent count, total tokens, total cost across the cycle. */
export function deriveStageTotals(
  events: readonly EventLogEntry[],
  activeAgentCount: number,
): StageTotals {
  let tokens = 0;
  let costUsd = 0;
  for (const e of events) {
    if (typeof e.tokens_in === 'number') tokens += e.tokens_in;
    if (typeof e.tokens_out === 'number') tokens += e.tokens_out;
    if (typeof e.cost_usd === 'number') costUsd += e.cost_usd;
  }
  return { agents: activeAgentCount, tokens, costUsd };
}

/** First active WI id (graph centers its live activity here). */
export function firstActiveWiId(workItemStatuses: Record<string, string>): string | null {
  for (const [id, status] of Object.entries(workItemStatuses)) {
    if (status === 'active') return id;
  }
  return null;
}

/**
 * Aggregate `file_change` events into a path → change-count heatmap, sorted
 * hottest-first.
 */
export function deriveFileHeatmap(events: readonly EventLogEntry[]): FileHeat[] {
  const byPath = new Map<string, { changes: number; lastOp: FileHeat['lastOp'] }>();
  for (const e of events) {
    if (e.event_type !== 'file_change') continue;
    const md = e.metadata as { path?: string; op?: FileHeat['lastOp'] } | undefined;
    const path = md?.path;
    if (typeof path !== 'string') continue;
    const cur = byPath.get(path) ?? { changes: 0, lastOp: 'modify' as const };
    cur.changes += 1;
    if (md?.op) cur.lastOp = md.op;
    byPath.set(path, cur);
  }
  return Array.from(byPath.entries())
    .map(([path, v]) => ({ path, changes: v.changes, lastOp: v.lastOp }))
    .sort((a, b) => b.changes - a.changes);
}
