'use client';

/**
 * FileHeatmap (Phase B) — file-attention heatmap, an agent-flow parity panel.
 * Aggregates `file_change` events into a path → count list, hottest first,
 * with a heat bar. DOM-as-metrics: data-section="file-heatmap" +
 * per-row data-file-path / data-file-changes.
 */

import { useMemo } from 'react';
import type { EventLogEntry } from '@/lib/bridge-client';
import { deriveFileHeatmap } from '@/lib/live-activity';

export type FileHeatmapProps = {
  events: EventLogEntry[];
  max?: number;
};

const OP_COLOUR: Record<string, string> = {
  add: '#7ee787',
  modify: '#58a6ff',
  delete: '#f85149',
};

export function FileHeatmap({ events, max = 12 }: FileHeatmapProps): JSX.Element {
  const heat = useMemo(() => deriveFileHeatmap(events), [events]);
  const shown = heat.slice(0, max);
  const peak = shown.length > 0 ? shown[0].changes : 1;

  return (
    <div style={panelStyle} data-section="file-heatmap" data-file-count={heat.length}>
      <h2 style={panelTitle}>file attention</h2>
      {shown.length === 0 && <div style={emptyStyle}>(no file changes yet)</div>}
      {shown.map((h) => {
        const pct = Math.max(6, Math.round((h.changes / peak) * 100));
        const colour = OP_COLOUR[h.lastOp] ?? '#58a6ff';
        return (
          <div
            key={h.path}
            data-file-path={h.path}
            data-file-changes={h.changes}
            data-file-op={h.lastOp}
            style={rowStyle}
            title={`${h.path} — ${h.changes} change(s), last ${h.lastOp}`}
          >
            <div style={barTrack}>
              <div style={{ ...barFill, width: `${pct}%`, background: colour }} />
            </div>
            <span style={pathStyle}>{shortPath(h.path)}</span>
            <span style={countStyle}>{h.changes}</span>
          </div>
        );
      })}
    </div>
  );
}

function shortPath(p: string): string {
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return `…/${parts.slice(-2).join('/')}`;
}

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

const emptyStyle: React.CSSProperties = { color: '#8b949e', fontSize: 12 };

const rowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '120px 1fr auto',
  alignItems: 'center',
  gap: 10,
  padding: '3px 0',
  fontSize: 12,
};

const barTrack: React.CSSProperties = {
  height: 8,
  background: '#0c1115',
  border: '1px solid #21262d',
  borderRadius: 4,
  overflow: 'hidden',
};

const barFill: React.CSSProperties = {
  height: '100%',
  borderRadius: 4,
  transition: 'width 250ms ease-out',
};

const pathStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
  color: '#c9d1d9',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const countStyle: React.CSSProperties = {
  color: '#8b949e',
  fontVariantNumeric: 'tabular-nums',
};
