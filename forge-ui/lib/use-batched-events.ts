/**
 * Batched event buffer (Phase B perf fix).
 *
 * At per-tool granularity the live event rate can spike to dozens/sec. Calling
 * `setEvents` per event re-derives the whole graph model + re-renders React
 * Flow each time. This hook coalesces live appends into a single state flush
 * every `flushMs` (≈4×/sec), so derivation/render runs at a bounded cadence
 * regardless of event rate. `reset` is immediate (cycle switch / full reload).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { EventLogEntry } from './bridge-client';

export function useBatchedEvents(flushMs = 250): {
  events: EventLogEntry[];
  append: (event: EventLogEntry) => void;
  reset: (rows: EventLogEntry[]) => void;
} {
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const bufferRef = useRef<EventLogEntry[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timerRef.current = null;
    if (bufferRef.current.length === 0) return;
    const batch = bufferRef.current;
    bufferRef.current = [];
    setEvents((prev) => [...prev, ...batch]);
  }, []);

  const append = useCallback(
    (event: EventLogEntry) => {
      bufferRef.current.push(event);
      // setTimeout (not rAF) so updates keep flushing when the tab is hidden.
      if (timerRef.current == null) timerRef.current = setTimeout(flush, flushMs);
    },
    [flush, flushMs],
  );

  const reset = useCallback((rows: EventLogEntry[]) => {
    bufferRef.current = [];
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setEvents(rows);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
    },
    [],
  );

  return { events, append, reset };
}
