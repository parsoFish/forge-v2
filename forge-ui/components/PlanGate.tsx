'use client';

import { useEffect, useState } from 'react';

import {
  postPlanVerdict,
  architectFileUrl,
  type ArchitectEscalation,
} from '@/lib/bridge-client';

/**
 * ADR 020 — the in-UI PLAN gate. Shows the comparative PLAN.html (Phase C) in a
 * `sandbox=""` iframe for reading, plus an interactive decision list (one radio
 * group per council escalation). **Approve** enables only once every decision
 * is resolved; approving POSTs the selections, which feed one more architect
 * turn that bakes them into the manifests and promotes them to `_queue/pending/`.
 * Send-back / Reject are also available. There is no auto-approve.
 */
export function PlanGate({
  project,
  sessionId,
  planUrl,
  escalations,
  idea,
  fullPage = false,
}: {
  project: string;
  sessionId: string;
  planUrl: string | null;
  escalations: ArchitectEscalation[];
  idea: string;
  /** Dedicated plan screen — render the PLAN.html iframe tall (its own page). */
  fullPage?: boolean;
}) {
  const [iframeSrc, setIframeSrc] = useState('');
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [rationale, setRationale] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (planUrl) architectFileUrl(planUrl).then((u) => { if (!cancelled) setIframeSrc(u); });
    return () => { cancelled = true; };
  }, [planUrl]);

  const allResolved = escalations.every((e) => selections[e.id]);

  async function submit(kind: 'approve' | 'revise' | 'reject'): Promise<void> {
    if (submitting) return;
    if (kind === 'approve' && !allResolved) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await postPlanVerdict({
        project,
        sessionId,
        kind,
        selections: kind === 'approve' ? selections : undefined,
        rationale: rationale.trim() || undefined,
      });
      if (!res.ok) { setError(res.error ?? 'verdict failed'); return; }
      setDone(kind);
    } finally {
      setSubmitting(false);
    }
  }

  const verdictState = done ?? (allResolved ? 'ready' : 'unresolved');

  return (
    <div
      data-section="plan-gate"
      data-session-id={sessionId}
      data-plan-verdict-state={verdictState}
      data-decisions-resolved={allResolved ? 'true' : 'false'}
      style={{ border: '1px solid #30363d', borderRadius: 10, padding: 16, background: '#0d1117' }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: '#e6edf3', marginBottom: 4 }}>
        Plan ready — review &amp; approve
      </div>
      <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 12 }}>{idea}</div>

      {iframeSrc ? (
        <iframe
          src={iframeSrc}
          sandbox=""
          data-plan-iframe
          title="PLAN"
          style={{
            width: '100%',
            height: fullPage ? '72vh' : 420,
            border: '1px solid #30363d',
            borderRadius: 8,
            background: '#fff',
            marginBottom: 14,
          }}
        />
      ) : (
        <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 14 }}>
          (PLAN.html not available)
        </div>
      )}

      {escalations.length > 0 && (
        <div data-section="design-decisions" style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#e6edf3', marginBottom: 8 }}>
            Resolve {escalations.length} design decision{escalations.length === 1 ? '' : 's'}
          </div>
          {escalations.map((e) => (
            <fieldset
              key={e.id}
              data-escalation-id={e.id}
              data-decision-resolved={selections[e.id] ? 'true' : 'false'}
              style={{ border: '1px solid #21262d', borderRadius: 6, padding: 10, margin: '0 0 10px' }}
            >
              <legend style={{ fontSize: 12, color: '#e6edf3', padding: '0 4px' }}>
                {e.question} <span style={{ color: '#8b949e' }}>({e.critic})</span>
              </legend>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {e.options.map((opt) => {
                  const selected = selections[e.id] === opt.label;
                  return (
                    <label
                      key={opt.label}
                      data-option-label={opt.label}
                      data-option-selected={selected ? 'true' : 'false'}
                      style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}
                    >
                      <input
                        type="radio"
                        name={`esc-${e.id}`}
                        checked={selected}
                        onChange={() => setSelections((s) => ({ ...s, [e.id]: opt.label }))}
                        style={{ marginTop: 2 }}
                      />
                      <span>
                        <span style={{ fontSize: 13, color: '#e6edf3' }}>{opt.label}</span>
                        <span style={{ display: 'block', fontSize: 12, color: '#8b949e' }}>{opt.rationale}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
      )}

      <textarea
        value={rationale}
        onChange={(e) => setRationale(e.target.value)}
        placeholder="Optional note (required context for send-back)…"
        rows={2}
        data-field="rationale"
        style={{
          width: '100%',
          boxSizing: 'border-box',
          background: '#010409',
          color: '#e6edf3',
          border: '1px solid #30363d',
          borderRadius: 6,
          padding: '8px 10px',
          fontSize: 13,
          marginBottom: 10,
          resize: 'vertical',
        }}
      />

      {error && <div style={{ color: '#f85149', fontSize: 12, marginBottom: 8 }}>{error}</div>}
      {done && (
        <div data-plan-verdict-submitted={done} style={{ color: '#3fb950', fontSize: 12, marginBottom: 8 }}>
          {done === 'approve' ? 'Approved — finalizing.' : done === 'revise' ? 'Sent back for another turn.' : 'Rejected.'}
        </div>
      )}

      {!done && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => void submit('approve')}
            disabled={!allResolved || submitting}
            data-action="approve-plan"
            style={btn(allResolved && !submitting, '#238636')}
          >
            Approve
          </button>
          <button
            onClick={() => void submit('revise')}
            disabled={submitting}
            data-action="revise-plan"
            style={btn(!submitting, '#9e6a03')}
          >
            Send back
          </button>
          <button
            onClick={() => void submit('reject')}
            disabled={submitting}
            data-action="reject-plan"
            style={btn(!submitting, '#6e2330')}
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

function btn(enabled: boolean, bg: string): React.CSSProperties {
  return {
    background: enabled ? bg : '#21262d',
    color: enabled ? '#fff' : '#8b949e',
    border: '1px solid #30363d',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 13,
    cursor: enabled ? 'pointer' : 'not-allowed',
  };
}
