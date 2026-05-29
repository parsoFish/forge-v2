'use client';

import type { EventLogEntry } from '@/lib/bridge-client';

/**
 * Shared focused-hex visual (ADR 020/021) — the agent-flow hex aesthetic
 * (glowing hexagon + progress arc + ephemeral tool-burst chips) for a single
 * stage. Both the architect plan screen and the review screen render through
 * this so the two screens stay visually aligned and don't drift. Callers map
 * their domain state (architect phase / cycle status) to `{title, statusLabel,
 * glow, frac, active}`.
 */

const MONO = 'ui-monospace, Menlo, Consolas, monospace';
const BURST_WINDOW_MS = 3500;

export function StageHex({
  title,
  statusLabel,
  glow,
  frac,
  active,
  events,
  nowMs,
  component = 'stage-hex',
  extraData,
}: {
  title: string;
  statusLabel: string;
  glow: string;
  /** Progress-arc fraction 0..1. */
  frac: number;
  active: boolean;
  /** Optional live event stream — drives the ephemeral tool-burst chips. */
  events?: EventLogEntry[];
  nowMs?: number;
  /** `data-component` id (so callers keep stable anchors, e.g. architect-hex). */
  component?: string;
  /** Extra `data-*` attributes spread onto the root (e.g. data-architect-phase). */
  extraData?: Record<string, string>;
}): JSX.Element {
  const now = nowMs ?? 0;
  const recent = (events ?? []).filter((e) => {
    const t = e.started_at;
    return t && now ? now - new Date(t).getTime() < BURST_WINDOW_MS : false;
  });
  const lastTool = [...(events ?? [])].reverse().find((e) => e.event_type === 'tool_use');

  return (
    <div
      data-component={component}
      data-stage-active={active ? 'true' : 'false'}
      {...extraData}
      style={{
        position: 'relative',
        background: 'radial-gradient(900px 460px at 50% -10%, #0b121d 0%, #05070b 72%)',
        border: '1px solid #161d26',
        borderRadius: 10,
        padding: '28px 16px 22px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <Hexagon size={120} glow={glow} frac={frac} active={active} />
      <div style={{ fontSize: 13, fontWeight: 600, color: '#e6edf3', letterSpacing: 0.3 }}>{title}</div>
      <div style={{ fontSize: 12, color: glow, textAlign: 'center' }}>{statusLabel}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center', minHeight: 22 }}>
        {recent.slice(-6).map((e, i) => {
          const t = e.started_at;
          const age = t ? now - new Date(t).getTime() : BURST_WINDOW_MS;
          const opacity = Math.max(0.15, 1 - age / BURST_WINDOW_MS);
          return (
            <span
              key={`${e.event_id}-${i}`}
              data-tool-burst
              style={{
                fontSize: 10,
                fontFamily: MONO,
                color: '#c9d1d9',
                background: '#0a0f16cc',
                border: `1px solid ${glow}66`,
                borderRadius: 5,
                padding: '2px 6px',
                opacity,
                transition: 'opacity 200ms linear',
              }}
            >
              {(e.metadata?.tool as string) ?? (e.metadata?.tool_name as string) ?? e.event_type}
            </span>
          );
        })}
      </div>
      {lastTool && (
        <div style={{ fontSize: 11, color: '#6e7681', fontFamily: MONO }}>
          last: {(lastTool.metadata?.tool as string) ?? (lastTool.metadata?.tool_name as string) ?? lastTool.message ?? 'tool'}
        </div>
      )}
    </div>
  );
}

function Hexagon({ size, glow, frac, active }: { size: number; glow: string; frac: number; active: boolean }): JSX.Element {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.33;
  const ringR = size * 0.42;
  const pts = [0, 60, 120, 180, 240, 300]
    .map((d) => {
      const a = (d * Math.PI) / 180;
      return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
    })
    .join(' ');
  const circ = 2 * Math.PI * ringR;
  const gid = `stage-arc-${glow.slice(1)}`;
  return (
    <svg
      width={size}
      height={size}
      style={{
        filter: active ? `drop-shadow(0 0 13px ${glow}bb)` : `drop-shadow(0 0 5px ${glow}55)`,
        display: 'block',
      }}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7ee787" />
          <stop offset="55%" stopColor={glow} />
          <stop offset="100%" stopColor="#d2a8ff" />
        </linearGradient>
      </defs>
      <circle cx={cx} cy={cy} r={ringR} fill="none" stroke="#1c2128" strokeWidth={2.5} />
      <circle
        cx={cx}
        cy={cy}
        r={ringR}
        fill="none"
        stroke={`url(#${gid})`}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray={`${circ * frac} ${circ}`}
        transform={`rotate(-90 ${cx} ${cy})`}
      />
      <polygon points={pts} fill="#0a0f16" stroke={glow} strokeWidth={2} />
      {active ? (
        <g transform={`translate(${cx} ${cy})`} stroke={glow} strokeWidth={1.5} strokeLinecap="round" opacity={0.9}>
          {[0, 45, 90, 135].map((d) => {
            const a = (d * Math.PI) / 180;
            const L = size * 0.11;
            return <line key={d} x1={-L * Math.cos(a)} y1={-L * Math.sin(a)} x2={L * Math.cos(a)} y2={L * Math.sin(a)} />;
          })}
          <animateTransform attributeName="transform" type="rotate" from="0 0 0" to="360 0 0" dur="6s" repeatCount="indefinite" additive="sum" />
        </g>
      ) : (
        <circle cx={cx} cy={cy} r={size * 0.045} fill={glow} opacity={0.5} />
      )}
    </svg>
  );
}
