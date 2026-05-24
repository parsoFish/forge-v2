'use client';

import { useEffect, useState } from 'react';

import { resolveBridgeUrl } from '@/lib/bridge-client';

/**
 * Shared layout for cycle-scoped artifact viewers (PLAN.md / DEMO.md).
 * The page mounts, fetches `${bridge}/api/artifact/<cycleId>/<filename>`,
 * and renders the raw markdown in a monospace pane. Markdown is shown
 * as `<pre>` for now — a richer renderer is an obvious follow-up but
 * not necessary for the operator to read it.
 *
 * DOM-as-metrics: `<main data-page="<kind>" data-cycle-id data-state>`
 * exposes the same state mirror pattern the rest of the UI uses so
 * playwright-driven probes can wait on data-state="ready" before
 * inspecting content.
 */
export function ArtifactPage({
  cycleId,
  kind,
  filename,
  title,
  emptyHint,
}: {
  cycleId: string;
  kind: 'plan' | 'demo';
  filename: string;
  title: string;
  emptyHint: string;
}): JSX.Element {
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const base = await resolveBridgeUrl();
      if (!base) {
        if (!cancelled) { setState('error'); setError('no bridge configured'); }
        return;
      }
      try {
        const res = await fetch(`${base}/api/artifact/${encodeURIComponent(cycleId)}/${encodeURIComponent(filename)}`);
        if (res.status === 404) {
          if (!cancelled) setState('missing');
          return;
        }
        if (!res.ok) {
          if (!cancelled) { setState('error'); setError(`HTTP ${res.status}`); }
          return;
        }
        const body = await res.text();
        if (!cancelled) { setContent(body); setState('ready'); }
      } catch (err) {
        if (!cancelled) { setState('error'); setError(String(err)); }
      }
    })();
    return () => { cancelled = true; };
  }, [cycleId, filename]);

  return (
    <main
      style={{ padding: '16px 24px', minHeight: '100vh' }}
      data-page={kind}
      data-cycle-id={cycleId}
      data-state={state}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 18, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 18, letterSpacing: 0.4 }}>{title}</h1>
        <a
          href="/"
          data-action="back-to-cycles"
          style={{ fontSize: 12, color: '#58a6ff', textDecoration: 'none' }}
        >
          ← back to cycles
        </a>
        <code style={{ fontSize: 11, color: '#8b949e' }}>{cycleId}</code>
      </header>

      {state === 'loading' && (
        <div style={{ ...panelStyle, color: '#8b949e' }} data-loading="true">loading…</div>
      )}
      {state === 'missing' && (
        <div style={{ ...panelStyle, color: '#8b949e' }} data-missing="true">
          {emptyHint}
        </div>
      )}
      {state === 'error' && (
        <div style={{ ...panelStyle, color: '#f85149' }} data-error="true">
          failed to load: {error}
        </div>
      )}
      {state === 'ready' && content && (
        <pre
          style={{
            ...panelStyle,
            margin: 0,
            fontSize: 12,
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: 'ui-monospace, Menlo, monospace',
          }}
          data-artifact-bytes={content.length}
        >
          {content}
        </pre>
      )}
    </main>
  );
}

const panelStyle: React.CSSProperties = {
  background: '#161b22',
  border: '1px solid #30363d',
  borderRadius: 8,
  padding: 16,
};
