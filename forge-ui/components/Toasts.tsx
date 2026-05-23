'use client';

import { useEffect, useRef, useState } from 'react';

import type { CycleListSnapshot } from '@/lib/bridge-client';

export type Toast = {
  id: string;
  text: string;
  kind: 'info' | 'success' | 'error';
};

/**
 * Watches the snapshot for cycle-status transitions and surfaces brief
 * in-app toasts. Operator already gets a desktop notification via
 * notify.ts (complement, not replace) — these are the in-app sibling.
 */
export function CycleToasts({ snapshot }: { snapshot: CycleListSnapshot }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const lastStatus = useRef<Map<string, string>>(new Map());
  // Skip toasts on the very first snapshot — the operator opened the UI
  // and we're just showing existing state, not a fresh transition.
  const seeded = useRef(false);

  useEffect(() => {
    const all = [...snapshot.live, ...snapshot.recent];
    if (!seeded.current) {
      for (const c of all) lastStatus.current.set(c.cycleId, c.status);
      seeded.current = true;
      return;
    }
    const fresh: Toast[] = [];
    for (const c of all) {
      const prev = lastStatus.current.get(c.cycleId);
      if (prev !== c.status) {
        fresh.push(makeToast(c.cycleId, c.status, c.project, c.initiativeId));
        lastStatus.current.set(c.cycleId, c.status);
      }
    }
    if (fresh.length === 0) return;
    setToasts((prev) => [...prev, ...fresh]);
    for (const t of fresh) setTimeout(() => dismiss(t.id), 6000);
  }, [snapshot]);

  function dismiss(id: string): void {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  if (toasts.length === 0) return null;
  return (
    <div style={{ position: 'fixed', right: 16, bottom: 16, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 1000 }}>
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => dismiss(t.id)}
          style={{
            background: '#161b22',
            border: '1px solid ' + kindColour(t.kind),
            color: '#e6edf3',
            borderRadius: 8,
            padding: '10px 14px',
            fontSize: 12,
            maxWidth: 320,
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            cursor: 'pointer',
          }}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

function makeToast(cycleId: string, status: string, project?: string, initId?: string): Toast {
  const tag = project ? `${project} · ${initId ?? cycleId}` : (initId ?? cycleId);
  switch (status) {
    case 'ready-for-review':
      return { id: `${cycleId}@${Date.now()}`, kind: 'info', text: `${tag} is ready for review.` };
    case 'done':
      return { id: `${cycleId}@${Date.now()}`, kind: 'success', text: `${tag} merged.` };
    case 'failed':
      return { id: `${cycleId}@${Date.now()}`, kind: 'error', text: `${tag} failed.` };
    case 'in-flight':
      return { id: `${cycleId}@${Date.now()}`, kind: 'info', text: `${tag} started.` };
    default:
      return { id: `${cycleId}@${Date.now()}`, kind: 'info', text: `${tag} → ${status}.` };
  }
}

function kindColour(k: Toast['kind']): string {
  switch (k) {
    case 'success': return '#7ee787';
    case 'error':   return '#f85149';
    case 'info':    return '#58a6ff';
  }
}
