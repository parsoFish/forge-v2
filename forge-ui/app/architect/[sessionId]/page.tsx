'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

import {
  fetchArchitectSessions,
  fetchEvents,
  subscribe,
  type ArchitectSessionSummary,
  type EventLogEntry,
} from '@/lib/bridge-client';
import { ArchitectStageHex } from '@/components/ArchitectStageHex';
import { ArchitectQuestionForm } from '@/components/ArchitectQuestionForm';
import { PlanGate } from '@/components/PlanGate';

/**
 * ADR 020 — the dedicated architect / plan screen. Keeps the primary dashboard
 * uncluttered: this is where the operator runs the interview and reviews the
 * rich PLAN on its own page. Shows the focused architect hex (live tool bursts
 * from the session's event stream) plus the phase-appropriate feedback surface.
 */
export default function ArchitectSessionPage({
  params,
}: {
  params: { sessionId: string };
}): JSX.Element {
  const sessionId = decodeURIComponent(params.sessionId);
  const cycleId = `_architect-${sessionId}`;

  const [session, setSession] = useState<ArchitectSessionSummary | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Resolve this session from the full list; re-fetch on architect changes.
  const refresh = useRef(() => {});
  useEffect(() => {
    let cancelled = false;
    refresh.current = () => {
      fetchArchitectSessions()
        .then((list) => {
          if (cancelled) return;
          setSession(list.find((s) => s.sessionId === sessionId) ?? null);
          setLoaded(true);
        })
        .catch(() => { if (!cancelled) setLoaded(true); });
    };
    refresh.current();
    fetchEvents(cycleId).then((rows) => { if (!cancelled) setEvents(rows); }).catch(() => {});

    const sub = subscribe({
      onMessage: (msg) => {
        if (msg.type === 'architect-list-changed') {
          refresh.current();
        } else if (msg.type === 'event' && msg.cycleId === cycleId) {
          // The live tail replays from offset 0, so dedup against the events
          // already painted by the initial fetchEvents.
          setEvents((prev) =>
            prev.some((e) => e.event_id === msg.event.event_id) ? prev : [...prev, msg.event],
          );
        }
      },
    });
    // Poll fallback for a just-created session whose status.json is still settling.
    const poll = setInterval(() => refresh.current(), 3000);
    return () => { cancelled = true; sub.close(); clearInterval(poll); };
  }, [sessionId, cycleId]);

  // Ticker for the hex burst fade.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  return (
    <main
      data-page="architect-session"
      data-session-id={sessionId}
      data-architect-phase={session?.phase ?? ''}
      data-page-ready={loaded ? 'true' : 'false'}
      style={{ padding: '16px 24px', minHeight: '100vh', maxWidth: 1100, margin: '0 auto' }}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 18 }}>
        <Link href="/" data-action="back-to-dashboard" style={{ color: '#58a6ff', fontSize: 13, textDecoration: 'none' }}>
          ← forge
        </Link>
        <h1 style={{ margin: 0, fontSize: 18, letterSpacing: 0.4 }}>architect</h1>
        <span style={{ fontSize: 12, color: '#8b949e', fontFamily: 'ui-monospace, Menlo, monospace' }}>{sessionId}</span>
      </header>

      {!loaded ? (
        <div style={{ color: '#8b949e', fontSize: 13 }}>Loading session…</div>
      ) : !session ? (
        <div style={{ color: '#8b949e', fontSize: 13 }}>
          Session not found (it may still be starting, or has been committed/rejected).{' '}
          <Link href="/" style={{ color: '#58a6ff' }}>Back to dashboard</Link>.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 24, alignItems: 'start' }}>
          <ArchitectStageHex phase={session.phase} events={events} nowMs={nowMs} />

          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, color: '#e6edf3', marginBottom: 4, fontWeight: 600 }}>{session.idea}</div>
            <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 16, fontFamily: 'ui-monospace, Menlo, monospace' }}>
              {session.project}
            </div>

            {(session.phase === 'interviewing' || session.phase === 'awaiting-answers') &&
              (session.questions && session.questions.length > 0 ? (
                <ArchitectQuestionForm
                  project={session.project}
                  sessionId={session.sessionId}
                  round={session.round}
                  questions={session.questions}
                />
              ) : (
                <Status label={`The architect is thinking… (round ${session.round})`} />
              ))}

            {session.phase === 'drafting' && <Status label="The architect is drafting the plan…" />}

            {session.phase === 'awaiting-verdict' && (
              <PlanGate
                fullPage
                project={session.project}
                sessionId={session.sessionId}
                planUrl={session.planUrl}
                escalations={session.escalations ?? []}
                idea={session.idea}
              />
            )}

            {session.phase === 'finalizing' && <Status label="Approved — finalizing manifests…" />}
          </div>
        </div>
      )}
    </main>
  );
}

function Status({ label }: { label: string }): JSX.Element {
  return (
    <div
      data-section="architect-status"
      style={{ border: '1px solid #30363d', borderRadius: 10, padding: '14px 18px', background: '#0d1117', fontSize: 13, color: '#8b949e' }}
    >
      {label}
    </div>
  );
}
