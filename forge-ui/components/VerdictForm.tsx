'use client';

import { useState } from 'react';

import { submitVerdict, type AcceptanceCriterion } from '@/lib/bridge-client';

/**
 * Surface for the operator's `ready-for-review` verdict. POSTs to the
 * bridge which writes `<id>.verdict-response.md` (lockfile-guarded).
 * Approve = rationale only. Send-back = rationale + 1+ acceptance
 * criteria, each `GIVEN ... WHEN ... THEN ...`.
 */
export function VerdictForm({ initiativeId, cycleId }: { initiativeId: string; cycleId: string | null }) {
  const [kind, setKind] = useState<'approve' | 'send-back'>('approve');
  const [rationale, setRationale] = useState('');
  const [acs, setAcs] = useState<AcceptanceCriterion[]>([{ given: '', when: '', then: '' }]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  async function onSubmit(): Promise<void> {
    setError(null);
    setSubmitting(true);
    try {
      const result = kind === 'approve'
        ? await submitVerdict({ kind, initiativeId, rationale: rationale.trim() })
        : await submitVerdict({
            kind,
            initiativeId,
            rationale: rationale.trim(),
            acceptanceCriteria: acs
              .filter((a) => a.given.trim() && a.when.trim() && a.then.trim())
              .map((a) => ({ given: a.given.trim(), when: a.when.trim(), then: a.then.trim() })),
          });
      if (!result.ok) { setError(result.error ?? 'submit failed'); return; }
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div
        style={{ ...panelStyle, borderColor: '#7ee787' }}
        data-component="verdict-form"
        data-form-state="submitted"
        data-form-kind={kind}
        data-initiative-id={initiativeId}
      >
        <h2 style={panelTitle}>verdict</h2>
        <div style={{ fontSize: 13, color: '#7ee787' }}>
          {kind === 'approve' ? 'Approved — the reviewer will close out the cycle.' : 'Sent back — the reviewer will react to the new acceptance criteria.'}
        </div>
      </div>
    );
  }

  return (
    <div
      style={panelStyle}
      data-component="verdict-form"
      data-form-state={submitting ? 'submitting' : 'editing'}
      data-form-kind={kind}
      data-initiative-id={initiativeId}
      data-ac-count={kind === 'send-back' ? acs.length : 0}
    >
      <h2 style={panelTitle}>verdict needed</h2>
      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 12 }}>
        Initiative <code>{initiativeId}</code> is awaiting your decision.
        {cycleId && (
          <>
            {' '}<a href={`/plan/${encodeURIComponent(cycleId)}`} target="_blank" rel="noreferrer" style={{ color: '#58a6ff' }} data-action="view-plan">view plan</a>
            {' · '}
            <a href={`/demo/${encodeURIComponent(cycleId)}`} target="_blank" rel="noreferrer" style={{ color: '#58a6ff' }} data-action="view-demo">view demo</a>
          </>
        )}
      </div>

      <fieldset style={{ border: 'none', padding: 0, margin: 0, marginBottom: 12, display: 'flex', gap: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <input type="radio" name="kind" value="approve" checked={kind === 'approve'} onChange={() => setKind('approve')} />
          approve
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <input type="radio" name="kind" value="send-back" checked={kind === 'send-back'} onChange={() => setKind('send-back')} />
          send back
        </label>
      </fieldset>

      <label style={labelStyle}>
        rationale
        <textarea
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder={kind === 'approve' ? 'Why is this mergeable?' : 'Why is the work not done yet?'}
          style={inputStyle}
          rows={3}
        />
      </label>

      {kind === 'send-back' && (
        <div style={{ marginTop: 12 }}>
          <div style={labelStyle}>acceptance criteria</div>
          {acs.map((a, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 6, marginBottom: 6 }}>
              <input placeholder="GIVEN ..." value={a.given} onChange={(e) => setAcs(acs.map((x, j) => j === i ? { ...x, given: e.target.value } : x))} style={inputStyle} />
              <input placeholder="WHEN ..."  value={a.when}  onChange={(e) => setAcs(acs.map((x, j) => j === i ? { ...x, when: e.target.value } : x))}  style={inputStyle} />
              <input placeholder="THEN ..."  value={a.then}  onChange={(e) => setAcs(acs.map((x, j) => j === i ? { ...x, then: e.target.value } : x))}  style={inputStyle} />
              <button
                onClick={() => setAcs(acs.filter((_, j) => j !== i))}
                disabled={acs.length === 1}
                style={{ ...buttonStyle, background: '#21262d', borderColor: '#30363d' }}
              >−</button>
            </div>
          ))}
          <button onClick={() => setAcs([...acs, { given: '', when: '', then: '' }])} style={{ ...buttonStyle, background: '#21262d', borderColor: '#30363d', fontSize: 11 }}>
            + add criterion
          </button>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 10, fontSize: 12, color: '#f85149' }}>{error}</div>
      )}

      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button onClick={() => void onSubmit()} disabled={submitting || !rationale.trim()} style={{ ...buttonStyle, background: kind === 'approve' ? '#1f6feb' : '#9e6a03' }}>
          {submitting ? 'submitting…' : kind === 'approve' ? 'approve and merge' : 'send back'}
        </button>
      </div>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  background: '#161b22',
  border: '1px solid #58a6ff',
  borderRadius: 8,
  padding: 16,
};

const panelTitle: React.CSSProperties = {
  margin: '0 0 12px',
  fontSize: 12,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  color: '#8b949e',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: '#8b949e',
  marginBottom: 6,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#0c1115',
  border: '1px solid #30363d',
  borderRadius: 6,
  color: '#e6edf3',
  padding: '6px 8px',
  fontSize: 12,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

const buttonStyle: React.CSSProperties = {
  border: '1px solid #58a6ff',
  borderRadius: 6,
  padding: '8px 14px',
  fontSize: 12,
  color: '#fff',
  cursor: 'pointer',
};

