'use client';

import { useState } from 'react';

import type { DemoModel, DemoModelCheckpoint, DemoHarnessMetricRow } from '@/lib/bridge-client';

/**
 * ADR 021 — renders the unifier-authored structured `demo.json` natively (the
 * in-UI equivalent of `renderComparisonHtml`). The schema this renders IS the
 * contract the unifier fills, which is what makes demos consistent. Forge dark
 * theme; mirrors the plan screen's "rich artifact on its own page" treatment.
 */
const PARITY_COLOR: Record<DemoHarnessMetricRow['parity'], string> = {
  match: '#2ea043',
  within: '#2ea043',
  diverged: '#f85149',
  incomplete: '#d29922',
};

export function DemoComparison({ model }: { model: DemoModel }): JSX.Element {
  return (
    <div data-section="demo-comparison" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 16, fontWeight: 600, color: '#e6edf3' }}>{model.title}</div>
        <div
          style={{
            marginTop: 8,
            padding: '10px 14px',
            borderLeft: '3px solid #2b333c',
            background: '#0d131b',
            borderRadius: '0 6px 6px 0',
            fontSize: 13,
            color: '#c9d1d9',
          }}
        >
          {model.essence}
        </div>
      </div>

      {model.checkpoints.map((c, i) => (
        <CheckpointCard key={`${c.label}-${i}`} cp={c} />
      ))}

      {model.acceptanceCriteria && model.acceptanceCriteria.length > 0 && (
        <div data-section="demo-acs">
          <div style={{ fontSize: 12, fontWeight: 600, color: '#8b949e', marginBottom: 6 }}>Acceptance criteria</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#c9d1d9' }}>
            {model.acceptanceCriteria.map((ac, i) => (
              <li key={i}>{ac}</li>
            ))}
          </ul>
        </div>
      )}

      <details style={{ fontSize: 12, color: '#8b949e' }}>
        <summary style={{ cursor: 'pointer' }}>
          Changed files (<code>git diff --stat {model.baseRef ?? 'main'}..{model.changedRef ?? 'HEAD'}</code>)
        </summary>
        <pre style={{ overflow: 'auto', background: '#010409', border: '1px solid #21262d', borderRadius: 6, padding: 10, marginTop: 8 }}>
          {model.diffStat}
        </pre>
      </details>
    </div>
  );
}

function CheckpointCard({ cp }: { cp: DemoModelCheckpoint }): JSX.Element {
  return (
    <figure
      data-checkpoint={cp.label}
      data-checkpoint-kind={cp.kind ?? 'screenshot'}
      style={{ margin: 0, border: '1px solid #21262d', borderRadius: 8, padding: 14, background: '#0b0f14' }}
    >
      <figcaption style={{ fontSize: 13, color: '#e6edf3', marginBottom: 10, fontWeight: 500 }}>{cp.caption}</figcaption>
      {cp.kind === 'harness' && cp.metrics && cp.metrics.length > 0 ? (
        <MetricTable rows={cp.metrics} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Side label="before" note={cp.beforeNote} image={cp.beforeImage} />
          <Side label="after" note={cp.afterNote} image={cp.afterImage} />
        </div>
      )}
    </figure>
  );
}

function Side({ label, note, image }: { label: string; note?: string; image?: string | null }): JSX.Element {
  return (
    <div data-side={label}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: '#6e7681', marginBottom: 6 }}>{label}</div>
      {image ? (
        // Only data: URIs reach here (validateDemoModel rejects remote/scheme refs).
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image} alt={`${label} state`} style={{ width: '100%', border: '1px solid #21262d', borderRadius: 6, display: 'block' }} />
      ) : (
        <div style={{ fontSize: 13, color: '#c9d1d9' }}>{note ?? <span style={{ color: '#6e7681' }}>—</span>}</div>
      )}
      {image && note && <div style={{ fontSize: 12, color: '#8b949e', marginTop: 6 }}>{note}</div>}
    </div>
  );
}

function MetricTable({ rows }: { rows: DemoHarnessMetricRow[] }): JSX.Element {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ color: '#6e7681', textAlign: 'left' }}>
          <th style={th}>metric</th>
          <th style={th}>before</th>
          <th style={th}>after</th>
          <th style={th}>Δ</th>
          <th style={th}>parity</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const d = r.deltaPct === null ? '—' : `${r.deltaPct > 0 ? '+' : ''}${r.deltaPct.toFixed(1)}%`;
          return (
            <tr key={i} style={{ borderTop: '1px solid #21262d' }}>
              <td style={td}>{r.label}</td>
              <td style={td}>{r.before ?? '—'}{r.unit ? ` ${r.unit}` : ''}</td>
              <td style={td}>{r.after ?? '—'}{r.unit ? ` ${r.unit}` : ''}</td>
              <td style={td}>{d}</td>
              <td style={{ ...td, color: PARITY_COLOR[r.parity], fontWeight: 600 }}>{r.parity}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const th: React.CSSProperties = { padding: '4px 8px', fontWeight: 500 };
const td: React.CSSProperties = { padding: '4px 8px', color: '#c9d1d9', fontFamily: 'ui-monospace, Menlo, monospace' };
