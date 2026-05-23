/**
 * JSONL event-log writer. One log file per cycle: _logs/<cycle-id>/events.jsonl.
 * Append-only, line-buffered. The single source of truth for everything that
 * happened during a cycle (per ADR 008).
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type Phase =
  | 'orchestrator'
  | 'brain'
  | 'architect'
  | 'project-manager'
  | 'developer-loop'
  | 'review-loop'
  | 'closure'
  | 'reflection';

export type EventType = 'start' | 'end' | 'log' | 'error' | 'tool_use' | 'iteration';

export type EventLogEntry = {
  event_id: string;
  cycle_id: string;
  initiative_id: string;
  parent_event_id?: string;
  phase: Phase;
  skill: string;
  iteration?: number;
  event_type: EventType;
  input_refs: string[];
  output_refs: string[];
  cost_usd?: number;
  tokens_in?: number;
  tokens_out?: number;
  /**
   * S8 / C23 — prompt-cache read hits on this event's API call. Sourced
   * from the SDK result message's `usage.cache_read_input_tokens`.
   * Optional; absent on non-SDK events (orchestrator-internal `log` /
   * `start` / `end` rows, stub-agent test runs).
   */
  cache_read_tokens?: number;
  /**
   * S8 / C23 — prompt-cache write tokens (cache MISSES that populated the
   * cache for future calls). Sourced from
   * `usage.cache_creation_input_tokens`. Optional.
   */
  cache_creation_tokens?: number;
  duration_ms?: number;
  started_at: string;
  finished_at?: string;
  message?: string;
  metadata?: Record<string, unknown>;
};

export type EventLogger = {
  emit: (entry: Omit<EventLogEntry, 'event_id' | 'cycle_id' | 'started_at'> & {
    event_id?: string;
    started_at?: string;
  }) => EventLogEntry;
  cycleId: string;
  logFilePath: string;
};

export type LoggerOptions = {
  /**
   * Optional sink invoked synchronously after each `emit()` with the entry that
   * was just written to disk. Used by the scheduler to render live progress to
   * stdout. Throws are swallowed so a misbehaving tee can't break logging.
   */
  tee?: (entry: EventLogEntry) => void;
};

export function createLogger(
  cycleId: string,
  logsDir = '_logs',
  opts: LoggerOptions = {},
): EventLogger {
  const dir = resolve(logsDir, cycleId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const logFilePath = join(dir, 'events.jsonl');

  return {
    cycleId,
    logFilePath,
    emit: (partial) => {
      const entry: EventLogEntry = {
        event_id: partial.event_id ?? newEventId(),
        cycle_id: cycleId,
        started_at: partial.started_at ?? new Date().toISOString(),
        ...partial,
      } as EventLogEntry;
      appendFileSync(logFilePath, JSON.stringify(entry) + '\n');
      if (opts.tee) {
        try {
          opts.tee(entry);
        } catch {
          /* tee is best-effort — never break logging */
        }
      }
      return entry;
    },
  };
}

/** Tiny ULID-ish ID: timestamp + random. Not a real ULID, but monotonic-ish and unique enough. */
function newEventId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 10);
  return `EV_${ts}_${rnd}`;
}
