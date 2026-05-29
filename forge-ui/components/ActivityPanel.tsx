'use client';

import { useMemo, useState, type CSSProperties } from 'react';

import type { EventLogEntry } from '@/lib/bridge-client';

// ---- public surface -----------------------------------------------------

export type ActivityPanelProps = {
  events: EventLogEntry[];
  selectedWiId?: string | null;
};

/**
 * Filter chips + click-to-detail view over the event log.
 *
 * MVP scope (see follow-up: animated timeline). This coexists with the
 * existing EventTail in page.tsx until that's swapped out.
 *
 * Chip-state contract:
 *  - Phase chips: multi-select. Empty selection = "all".
 *  - Event-type chips: multi-select over a STABLE chip set
 *    (the common COMMON_EVENT_TYPES list) so the row doesn't reflow
 *    when new event types appear mid-cycle. Empty selection = "all".
 *  - Work-item chips: single-select. Empty = "all WIs". `selectedWiId`
 *    seeds the initial selection (without re-applying when the operator
 *    clears it).
 *  - Errors-only: a separate toggle pill. When on, supersedes the
 *    event-type filter (only event_type === 'error' rows pass).
 */
export function ActivityPanel({ events, selectedWiId }: ActivityPanelProps) {
  // ---- chip state -------------------------------------------------------
  const [activePhases, setActivePhases] = useState<ReadonlySet<string>>(() => new Set());
  const [activeTypes, setActiveTypes] = useState<ReadonlySet<string>>(() => new Set());
  const [activeWi, setActiveWi] = useState<string | null>(selectedWiId ?? null);
  const [errorsOnly, setErrorsOnly] = useState<boolean>(false);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  // ---- derive available chips ------------------------------------------
  const phasesInData = useMemo<readonly string[]>(() => {
    const seen = new Set<string>();
    for (const e of events) seen.add(e.phase);
    return [...seen].sort();
  }, [events]);

  const wisInData = useMemo<readonly string[]>(() => {
    const seen = new Set<string>();
    for (const e of events) {
      const wi = readWorkItemId(e);
      if (wi) seen.add(wi);
    }
    return [...seen].sort();
  }, [events]);

  // ---- apply filters ---------------------------------------------------
  const filtered = useMemo<readonly EventLogEntry[]>(() => {
    return events.filter((e) => {
      if (errorsOnly && e.event_type !== 'error') return false;
      if (activePhases.size > 0 && !activePhases.has(e.phase)) return false;
      if (!errorsOnly && activeTypes.size > 0 && !activeTypes.has(e.event_type)) return false;
      if (activeWi) {
        if (readWorkItemId(e) !== activeWi) return false;
      }
      return true;
    });
  }, [events, errorsOnly, activePhases, activeTypes, activeWi]);

  // Newest first, cap at 100.
  const visible = useMemo<readonly EventLogEntry[]>(() => {
    const sorted = [...filtered].sort((a, b) => {
      // started_at is ISO; lexicographic compare is correct for ISO 8601.
      if (a.started_at === b.started_at) return 0;
      return a.started_at < b.started_at ? 1 : -1;
    });
    return sorted.slice(0, 100);
  }, [filtered]);

  const selectedEvent = useMemo<EventLogEntry | null>(() => {
    if (!selectedEventId) return null;
    return events.find((e) => e.event_id === selectedEventId) ?? null;
  }, [events, selectedEventId]);

  // ---- chip toggle helpers --------------------------------------------
  const togglePhase = (p: string): void => {
    setActivePhases((prev) => toggleInSet(prev, p));
  };
  const toggleType = (t: string): void => {
    setActiveTypes((prev) => toggleInSet(prev, t));
  };
  const toggleWi = (wi: string): void => {
    setActiveWi((prev) => (prev === wi ? null : wi));
  };
  const clearPhases = (): void => setActivePhases(new Set());
  const clearTypes = (): void => setActiveTypes(new Set());
  const clearWi = (): void => setActiveWi(null);

  return (
    <div
      style={wrapperStyle}
      data-component="activity-panel"
      data-events-shown={visible.length}
      data-events-total={events.length}
    >
      <div style={chipBarStyle}>
        <ChipGroup label="phase">
          <Chip
            kind="phase"
            value="all"
            active={activePhases.size === 0}
            onClick={clearPhases}
            label="all"
          />
          {phasesInData.map((p) => (
            <Chip
              key={p}
              kind="phase"
              value={p}
              active={activePhases.has(p)}
              onClick={() => togglePhase(p)}
              label={p}
              accent={phaseColor(p)}
            />
          ))}
        </ChipGroup>

        <ChipGroup label="event type">
          <Chip
            kind="event-type"
            value="all"
            active={activeTypes.size === 0}
            onClick={clearTypes}
            label="all"
          />
          {COMMON_EVENT_TYPES.map((t) => (
            <Chip
              key={t}
              kind="event-type"
              value={t}
              active={activeTypes.has(t)}
              onClick={() => toggleType(t)}
              label={t}
            />
          ))}
        </ChipGroup>

        <ChipGroup label="work item">
          <Chip
            kind="wi"
            value="all"
            active={activeWi === null}
            onClick={clearWi}
            label="all"
          />
          {wisInData.length === 0 ? (
            <span style={{ color: '#6e7681', fontSize: 11 }} data-chip-empty="wi">
              (no work items)
            </span>
          ) : (
            wisInData.map((wi) => (
              <Chip
                key={wi}
                kind="wi"
                value={wi}
                active={activeWi === wi}
                onClick={() => toggleWi(wi)}
                label={wi}
              />
            ))
          )}
        </ChipGroup>

        <ChipGroup label="">
          <Chip
            kind="errors-only"
            value="on"
            active={errorsOnly}
            onClick={() => setErrorsOnly((v) => !v)}
            label={errorsOnly ? 'errors only ✓' : 'errors only'}
            accent="#ff7b72"
          />
        </ChipGroup>
      </div>

      <div style={gridStyle}>
        <div style={listStyle} data-section="events-list">
          {visible.length === 0 ? (
            <div style={{ color: '#8b949e', fontFamily: monoStack, fontSize: 12 }} data-events-empty="true">
              (no events match the active filters)
            </div>
          ) : (
            visible.map((e) => (
              <EventRow
                key={e.event_id}
                event={e}
                selected={e.event_id === selectedEventId}
                onClick={() => setSelectedEventId(e.event_id)}
              />
            ))
          )}
        </div>

        <div style={detailStyle} data-section="event-detail" data-detail-event-id={selectedEvent?.event_id ?? ''}>
          {selectedEvent === null ? (
            <div style={{ color: '#8b949e', fontFamily: monoStack, fontSize: 12 }}>
              (click a row to inspect)
            </div>
          ) : (
            <EventDetail event={selectedEvent} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---- subcomponents ------------------------------------------------------

function ChipGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={chipGroupStyle} data-chip-group={label || 'toggle'}>
      {label && <span style={chipGroupLabelStyle}>{label}</span>}
      <div style={chipRowStyle}>{children}</div>
    </div>
  );
}

type ChipKind = 'phase' | 'event-type' | 'wi' | 'errors-only';

function Chip({
  kind,
  value,
  active,
  onClick,
  label,
  accent,
}: {
  kind: ChipKind;
  value: string;
  active: boolean;
  onClick: () => void;
  label: string;
  accent?: string;
}) {
  const borderColor = active ? (accent ?? '#58a6ff') : '#30363d';
  const bg = active ? 'rgba(88, 166, 255, 0.12)' : 'transparent';
  return (
    <button
      type="button"
      onClick={onClick}
      data-chip-kind={kind}
      data-chip-value={value}
      data-chip-active={active ? 'true' : 'false'}
      style={{
        ...chipStyle,
        borderColor,
        background: bg,
        color: active && accent ? accent : '#e6edf3',
      }}
    >
      {label}
    </button>
  );
}

function EventRow({
  event,
  selected,
  onClick,
}: {
  event: EventLogEntry;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-event-id={event.event_id}
      data-event-phase={event.phase}
      data-event-type={event.event_type}
      data-event-selected={selected ? 'true' : 'false'}
      style={{
        ...eventRowStyle,
        background: selected ? 'rgba(88, 166, 255, 0.10)' : 'transparent',
        borderLeftColor: selected ? '#58a6ff' : 'transparent',
      }}
    >
      <span style={{ color: '#8b949e', minWidth: 64 }}>{shortTime(event.started_at)}</span>
      <span style={{ color: phaseColor(event.phase), minWidth: 110 }}>{event.phase}</span>
      <span style={{ color: '#c9d1d9', minWidth: 90 }}>{event.event_type}</span>
      <span style={{ color: '#e6edf3', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {truncate(event.message ?? '', 80)}
      </span>
      <span style={{ color: '#6e7681', marginLeft: 8 }}>{'>'}</span>
    </button>
  );
}

function EventDetail({ event }: { event: EventLogEntry }) {
  const wi = readWorkItemId(event);
  const parent = readStringField(event.metadata, 'parent_event_id');
  const cost = readNumberField(event.metadata, 'cost_usd');
  // Surface high-value per-iteration agent state up-front (operator
  // feedback 2026-05-24: "hard to discern from a single log"). These
  // fields are emitted by orchestrator/phases/developer-loop.ts:248
  // for every dev-loop iteration; the rest of metadata still renders
  // below as raw JSON for completeness.
  const bashCommands = readStringArray(event.metadata, 'bash_commands');
  const toolsUsed = readStringArray(event.metadata, 'tools_used');
  const lastText = readStringField(event.metadata, 'last_assistant_text');
  const gateStderr = readStringField(event.metadata, 'gate_stderr_tail');
  const gateStdout = readStringField(event.metadata, 'gate_stdout_tail');
  const stopReason = readStringField(event.metadata, 'stop_reason');
  const iterations = readNumberField(event.metadata, 'iterations');
  const metaJson = JSON.stringify(event.metadata ?? {}, null, 2);
  return (
    <div style={{ fontFamily: monoStack, fontSize: 12, color: '#e6edf3' }}>
      <DetailField label="event_id" value={event.event_id} />
      <DetailField label="phase" value={event.phase} accent={phaseColor(event.phase)} />
      <DetailField label="skill" value={event.skill} />
      <DetailField label="event_type" value={event.event_type} />
      <DetailField label="started_at" value={event.started_at} />
      {event.cycle_id && <DetailField label="cycle_id" value={event.cycle_id} />}
      <DetailField label="initiative_id" value={event.initiative_id} />
      {wi && <DetailField label="work_item_id" value={wi} />}
      {parent && <DetailField label="parent_event_id" value={parent} />}
      {cost !== null && <DetailField label="cost_usd" value={`$${cost.toFixed(4)}`} />}
      {iterations !== null && <DetailField label="iterations" value={String(iterations)} />}
      {stopReason && <DetailField label="stop_reason" value={stopReason} accent="#f85149" />}
      {event.message && (
        <div style={{ marginTop: 8 }}>
          <div style={detailLabelStyle}>message</div>
          <pre style={preStyle}>{event.message}</pre>
        </div>
      )}
      {toolsUsed.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={detailLabelStyle}>tools used ({toolsUsed.length})</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', padding: '4px 0' }}>
            {toolsUsed.map((t, i) => (
              <span key={i} style={toolChipStyle}>{t}</span>
            ))}
          </div>
        </div>
      )}
      {bashCommands.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={detailLabelStyle}>bash commands ({bashCommands.length})</div>
          <pre style={{ ...preStyle, maxHeight: 200 }}>
            {bashCommands.map((c, i) => `${(i + 1).toString().padStart(2, ' ')}. ${c}`).join('\n')}
          </pre>
        </div>
      )}
      {lastText && (
        <div style={{ marginTop: 8 }}>
          <div style={detailLabelStyle}>agent's last assistant text (what it thought it was doing)</div>
          <pre style={{ ...preStyle, maxHeight: 280, color: '#a5d6ff' }}>{lastText}</pre>
        </div>
      )}
      {gateStdout && (
        <div style={{ marginTop: 8 }}>
          <div style={detailLabelStyle}>gate stdout (last)</div>
          <pre style={{ ...preStyle, maxHeight: 160 }}>{gateStdout}</pre>
        </div>
      )}
      {gateStderr && (
        <div style={{ marginTop: 8 }}>
          <div style={detailLabelStyle}>gate stderr (rejection reason)</div>
          <pre style={{ ...preStyle, maxHeight: 160, color: '#ffa198' }}>{gateStderr}</pre>
        </div>
      )}
      <details style={{ marginTop: 12 }}>
        <summary style={{ ...detailLabelStyle, cursor: 'pointer' }}>raw metadata (click to expand)</summary>
        <pre style={preStyle}>{metaJson}</pre>
      </details>
    </div>
  );
}

const toolChipStyle: React.CSSProperties = {
  background: '#21262d',
  border: '1px solid #30363d',
  borderRadius: 4,
  padding: '2px 8px',
  fontSize: 11,
  color: '#79c0ff',
};

function DetailField({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
      <span style={{ ...detailLabelStyle, minWidth: 110 }}>{label}</span>
      <span style={{ color: accent ?? '#e6edf3', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}

// ---- helpers ------------------------------------------------------------

const COMMON_EVENT_TYPES: readonly string[] = [
  'start',
  'end',
  'log',
  'error',
  'tool_use',
  'file_change',
  'iteration',
  'agent_heartbeat',
];

function toggleInSet<T>(prev: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(prev);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function readWorkItemId(e: EventLogEntry): string | null {
  return readStringField(e.metadata, 'work_item_id');
}

function readStringField(
  meta: Record<string, unknown> | undefined,
  key: string,
): string | null {
  if (!meta) return null;
  const v = meta[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function readNumberField(
  meta: Record<string, unknown> | undefined,
  key: string,
): number | null {
  if (!meta) return null;
  const v = meta[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function readStringArray(
  meta: Record<string, unknown> | undefined,
  key: string,
): string[] {
  if (!meta) return [];
  const v = meta[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function shortTime(iso: string | undefined): string {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(11, 19);
}

// Mirrors phaseColor in app/page.tsx — duplicated locally so the
// component is self-contained (avoids cross-importing from a page file).
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

// ---- styles -------------------------------------------------------------

const monoStack = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const wrapperStyle: CSSProperties = {
  background: '#161b22',
  border: '1px solid #30363d',
  borderRadius: 8,
  padding: 16,
  color: '#e6edf3',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const chipBarStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 12,
  paddingBottom: 8,
  borderBottom: '1px solid #21262d',
  overflowX: 'auto',
};

const chipGroupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minWidth: 0,
};

const chipGroupLabelStyle: CSSProperties = {
  fontSize: 10,
  letterSpacing: 0.5,
  textTransform: 'uppercase',
  color: '#6e7681',
};

const chipRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
};

const chipStyle: CSSProperties = {
  fontFamily: monoStack,
  fontSize: 11,
  padding: '3px 10px',
  borderRadius: 12,
  border: '1px solid #30363d',
  cursor: 'pointer',
  lineHeight: 1.4,
};

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '60% 40%',
  gap: 12,
  minHeight: 320,
};

const listStyle: CSSProperties = {
  border: '1px solid #21262d',
  borderRadius: 6,
  padding: 6,
  maxHeight: 480,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  fontFamily: monoStack,
  fontSize: 11,
};

const detailStyle: CSSProperties = {
  border: '1px solid #21262d',
  borderRadius: 6,
  padding: 10,
  maxHeight: 480,
  overflowY: 'auto',
  background: '#0c1115',
};

const eventRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 8px',
  border: 'none',
  borderLeft: '2px solid transparent',
  borderRadius: 3,
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: monoStack,
  fontSize: 11,
  color: '#e6edf3',
  width: '100%',
};

const detailLabelStyle: CSSProperties = {
  color: '#8b949e',
  fontSize: 10,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
};

const preStyle: CSSProperties = {
  margin: '4px 0 0',
  padding: 8,
  background: '#161b22',
  border: '1px solid #21262d',
  borderRadius: 4,
  color: '#c9d1d9',
  fontSize: 11,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 320,
  overflowY: 'auto',
};
