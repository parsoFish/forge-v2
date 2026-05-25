'use client';

import { useEffect, useState } from 'react';

import { resolveBridgeUrl } from '@/lib/bridge-client';

type Presence = 'unknown' | 'present' | 'missing';

/**
 * Hook: probe the bridge for an artifact's presence. Returns `present`
 * once the file is filed, otherwise `missing` (probed) or `unknown` (no
 * cycle, no bridge). Re-probes every 5s while the cycle is live so the
 * link surfaces as soon as the artifact lands.
 */
export function useArtifactPresence(cycleId: string | null, filename: string): Presence {
  const [state, setState] = useState<Presence>('unknown');
  useEffect(() => {
    if (!cycleId) { setState('unknown'); return; }
    let cancelled = false;
    const probe = async (): Promise<void> => {
      const base = await resolveBridgeUrl();
      if (!base || cancelled) return;
      try {
        const res = await fetch(`${base}/api/artifact/${encodeURIComponent(cycleId)}/${encodeURIComponent(filename)}`);
        if (cancelled) return;
        setState(res.ok ? 'present' : 'missing');
      } catch { /* bridge transient; will retry on next tick */ }
    };
    void probe();
    const id = setInterval(() => { void probe(); }, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [cycleId, filename]);
  return state;
}

/**
 * Inline link badge — used by the StateMachine phase rows so the plan
 * surfaces next to the architect row and the demo next to the
 * reflection row (per operator's 2026-05-25 note: "plan should be
 * shown after architect, demo should be shown as part of the reflect
 * phase"). Returns null when the file isn't filed yet.
 */
export function ArtifactBadge({
  cycleId,
  filename,
  href,
  label,
  title,
  visible,
}: {
  cycleId: string | null;
  filename: string;
  href: string;
  label: string;
  title: string;
  /**
   * Phase-gated visibility hint. Pass `false` to hide the badge even
   * when the file is present (e.g. demo gated on reflection-active so
   * the operator isn't pulled to it during dev-loop iteration).
   * Defaults to true.
   */
  visible?: boolean;
}): JSX.Element | null {
  const presence = useArtifactPresence(cycleId, filename);
  if (presence !== 'present') return null;
  if (visible === false) return null;
  return (
    <a
      href={href}
      data-action={`view-${filename.replace(/\.md$/, '').toLowerCase()}`}
      target="_blank"
      rel="noreferrer"
      style={badgeStyle}
      title={title}
    >
      {label}
    </a>
  );
}

const badgeStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 11,
  padding: '2px 8px',
  background: '#161b22',
  border: '1px solid #30363d',
  borderRadius: 4,
  color: '#58a6ff',
  textDecoration: 'none',
  marginLeft: 8,
};
