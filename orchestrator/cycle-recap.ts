/**
 * S6B — `_logs/<cycle-id>/recap.md` writer.
 *
 * Single-page, machine-generated cycle recap produced by the orchestrator
 * (NOT the agent) at the end of the reflection phase. Per CONTRACTS.md C15a,
 * reflect owns this file; PR-comment posting is plan 04's surface.
 *
 * Inputs are pure-disk: the cycle's event log, the manifest, the themes dir,
 * the cycle archive, and the brain-gaps JSONL. No agent involvement; the
 * generator is deterministic.
 *
 * Sections (locked order):
 *   1. Outcome
 *   2. Stats
 *   3. Themes written
 *   4. Brain gaps
 *   5. Lint
 *   6. Links
 *
 * Per `feedback_reflection_close_criterion`, this is additive — the file's
 * presence is informational, NOT a gate on `reflection_status: 'closed'`.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, relative, resolve } from 'node:path';

import { parseManifest, type InitiativeManifest } from './manifest.ts';
import type { EventLogEntry } from './logging.ts';
import type { LintStatus } from './cycle-context.ts';

export type WriteRecapInput = {
  forgeRoot: string;
  cycleId: string;
  initiativeId: string;
  manifestPath: string;
  projectName: string;
  /**
   * Themes the reflector wrote this pass — relative to `forgeRoot`.
   * Computed by the caller (the reflector phase) using mtime delta on
   * the themes dir, same data flow as retention tagging.
   */
  themesWritten: string[];
  /** Path to the cycle archive (`brain/_raw/cycles/<id>.md`). */
  cycleArchivePath: string;
  /**
   * Outcome of the post-reflection brain-lint pass (S6A). The recap surfaces
   * this so the operator sees the lint state at a glance.
   */
  lintStatus: LintStatus;
  /** Total agent cost from the reflector's SDK call. */
  reflectorCostUsd: number;
  /** Reflector wall-clock. */
  reflectorDurationMs: number;
};

export type RecapResult = {
  recapPath: string;
  written: boolean;
};

/**
 * Write `_logs/<cycle-id>/recap.md`. Best-effort: any IO error is swallowed
 * with `written: false` so the recap never crashes the reflector close path.
 */
export function writeCycleRecap(input: WriteRecapInput): RecapResult {
  const recapDir = resolve(input.forgeRoot, '_logs', input.cycleId);
  const recapPath = resolve(recapDir, 'recap.md');
  try {
    mkdirSync(recapDir, { recursive: true });
    const body = renderCycleRecap(input);
    writeFileSync(recapPath, body);
    return { recapPath, written: true };
  } catch {
    return { recapPath, written: false };
  }
}

/**
 * Pure render. Exposed for testing / regeneration. Always returns a
 * non-empty string.
 */
export function renderCycleRecap(input: WriteRecapInput): string {
  const eventLogPath = resolve(input.forgeRoot, '_logs', input.cycleId, 'events.jsonl');
  const events = readEvents(eventLogPath);
  const manifest = readManifestSafe(input.manifestPath);
  const stats = computeStats(events, input.reflectorCostUsd, input.reflectorDurationMs);
  const brainGaps = readBrainGaps(input.forgeRoot, input.cycleId, events);

  const lines: string[] = [];
  lines.push(`# Cycle recap — ${input.initiativeId}`, '');

  // 1. Outcome
  lines.push('## Outcome', '');
  lines.push(formatOutcome(input, manifest, events));
  lines.push('');

  // 2. Stats
  lines.push('## Stats', '');
  lines.push(`- Cost (total): $${stats.costUsd.toFixed(2)}`);
  lines.push(`- Duration: ${formatDuration(stats.durationMs)}`);
  lines.push(`- Send-back rounds: ${stats.sendBacks}`);
  lines.push(`- Dev-loop iterations: ${stats.devIterations}`);
  lines.push('');

  // 3. Themes written
  lines.push('## Themes written', '');
  if (input.themesWritten.length === 0) {
    lines.push('_(no themes written this cycle)_');
  } else {
    for (const themePath of input.themesWritten) {
      const rel = toRelative(input.forgeRoot, themePath);
      const title = readThemeTitle(themePath) ?? basename(themePath);
      lines.push(`- \`${rel}\`: ${title}`);
    }
  }
  lines.push('');

  // 4. Brain gaps
  lines.push('## Brain gaps', '');
  lines.push(`- Closed (${brainGaps.closed.length}): ${formatGapList(brainGaps.closed)}`);
  lines.push(
    `- Outstanding (${brainGaps.outstanding.length}): ${formatGapList(brainGaps.outstanding)}`,
  );
  lines.push('');

  // 5. Lint
  lines.push('## Lint', '');
  lines.push(`- Status: ${input.lintStatus}`);
  const lintReportPath = resolve(input.forgeRoot, '_logs', input.cycleId, 'brain-lint.md');
  if (existsSync(lintReportPath)) {
    lines.push(`- Report: ${toRelative(input.forgeRoot, lintReportPath)}`);
  }
  lines.push('');

  // 6. Links
  lines.push('## Links', '');
  const retroPath = resolve(input.forgeRoot, '_logs', input.cycleId, 'retro.md');
  if (existsSync(retroPath)) {
    lines.push(`- Retro: ${toRelative(input.forgeRoot, retroPath)}`);
  }
  if (existsSync(input.cycleArchivePath)) {
    lines.push(`- Cycle archive: ${toRelative(input.forgeRoot, input.cycleArchivePath)}`);
  }
  if (existsSync(input.manifestPath)) {
    lines.push(`- Manifest: ${toRelative(input.forgeRoot, input.manifestPath)}`);
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readEvents(eventLogPath: string): EventLogEntry[] {
  if (!existsSync(eventLogPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(eventLogPath, 'utf8');
  } catch {
    return [];
  }
  const out: EventLogEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as EventLogEntry);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

function readManifestSafe(manifestPath: string): InitiativeManifest | null {
  if (!existsSync(manifestPath)) return null;
  try {
    return parseManifest(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

type Stats = {
  costUsd: number;
  durationMs: number;
  sendBacks: number;
  devIterations: number;
};

function computeStats(
  events: EventLogEntry[],
  reflectorCostUsd: number,
  reflectorDurationMs: number,
): Stats {
  // Cycle total cost = sum of every event's cost_usd (cycle.end usually
  // mirrors aggregate but we don't depend on it). Reflector's own cost is
  // included via the events list, so the reflectorCostUsd arg is only used
  // when the event log hasn't received reflector.end yet (this function
  // can be called from inside runReflector before the end emit).
  let cost = 0;
  let duration = 0;
  let sendBacks = 0;
  let devIters = 0;
  let sawReflectorEnd = false;
  let cycleStartTs: number | null = null;
  let cycleEndTs: number | null = null;
  for (const e of events) {
    if (typeof e.cost_usd === 'number') cost += e.cost_usd;
    if (typeof e.duration_ms === 'number') duration += e.duration_ms;
    if (e.message === 'reviewer.verdict.send-back') sendBacks += 1;
    if (e.event_type === 'iteration' && e.phase === 'developer-loop') devIters += 1;
    if (e.message === 'reflector.end') sawReflectorEnd = true;
    if (e.message === 'cycle.start' && typeof e.started_at === 'string') {
      const ms = Date.parse(e.started_at);
      if (!Number.isNaN(ms)) cycleStartTs = ms;
    }
    if (e.message === 'cycle.end' && typeof e.started_at === 'string') {
      const ms = Date.parse(e.started_at);
      if (!Number.isNaN(ms)) cycleEndTs = ms;
    }
  }
  if (!sawReflectorEnd) {
    cost += reflectorCostUsd;
    duration += reflectorDurationMs;
  }
  // Prefer wall-clock cycle duration if we have both bookends.
  if (cycleStartTs !== null && cycleEndTs !== null && cycleEndTs >= cycleStartTs) {
    duration = cycleEndTs - cycleStartTs;
  }
  return {
    costUsd: cost,
    durationMs: duration,
    sendBacks,
    devIterations: devIters,
  };
}

type BrainGaps = {
  closed: string[];
  outstanding: string[];
};

/**
 * Read brain-gaps.jsonl and split into closed/outstanding. A gap is "closed"
 * iff one of these events fired during the cycle referencing the gap id:
 *   - reflector.theme-emitted with the gap id in metadata
 *   - any event whose `output_refs` contains the gap id
 *
 * Otherwise it's outstanding. Best-effort — a missing file yields empty lists.
 */
function readBrainGaps(forgeRoot: string, cycleId: string, events: EventLogEntry[]): BrainGaps {
  const gapsPath = resolve(forgeRoot, '_logs', cycleId, 'brain-gaps.jsonl');
  if (!existsSync(gapsPath)) return { closed: [], outstanding: [] };
  let raw: string;
  try {
    raw = readFileSync(gapsPath, 'utf8');
  } catch {
    return { closed: [], outstanding: [] };
  }
  const allIds: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { id?: string; gap_id?: string };
      const id = obj.id ?? obj.gap_id;
      if (typeof id === 'string' && id.length > 0) allIds.push(id);
    } catch {
      /* skip malformed line */
    }
  }
  if (allIds.length === 0) return { closed: [], outstanding: [] };

  const closedSet = new Set<string>();
  const eventBlob = events
    .map((e) => JSON.stringify(e.metadata ?? {}) + ' ' + (e.message ?? ''))
    .join('\n');
  for (const id of allIds) {
    if (eventBlob.includes(id)) closedSet.add(id);
  }
  const closed: string[] = [];
  const outstanding: string[] = [];
  for (const id of allIds) {
    if (closedSet.has(id)) closed.push(id);
    else outstanding.push(id);
  }
  return { closed, outstanding };
}

function readThemeTitle(themePath: string): string | null {
  if (!existsSync(themePath)) return null;
  let raw: string;
  try {
    raw = readFileSync(themePath, 'utf8');
  } catch {
    return null;
  }
  // Frontmatter `title:` field first.
  if (raw.startsWith('---\n') || raw.startsWith('---\r\n')) {
    const end = raw.indexOf('\n---', 4);
    if (end !== -1) {
      const block = raw.slice(4, end);
      for (const line of block.split(/\r?\n/)) {
        const m = line.match(/^title:\s*(.*)$/);
        if (m) {
          let v = m[1].trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          if (v.length > 0) return v;
        }
      }
    }
  }
  // Fallback: first `# heading`.
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^#\s+(.*)$/);
    if (m) return m[1].trim();
  }
  return null;
}

function toRelative(forgeRoot: string, absPath: string): string {
  const rel = relative(forgeRoot, absPath);
  if (rel.startsWith('..')) return absPath;
  return rel;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m ${s}s`;
}

function formatGapList(ids: string[]): string {
  if (ids.length === 0) return '_(none)_';
  return ids.map((id) => `\`${id}\``).join(', ');
}

function formatOutcome(
  input: WriteRecapInput,
  manifest: InitiativeManifest | null,
  events: EventLogEntry[],
): string {
  // Look for the cycle's terminal status: cycle.end's metadata.status, the
  // reviewer.merged event, or fall back to "closed".
  let status = 'closed';
  for (const e of events) {
    if (e.message === 'cycle.end' && typeof e.metadata?.['status'] === 'string') {
      status = String(e.metadata['status']);
      break;
    }
    if (e.message === 'reviewer.merged') status = 'merged';
  }
  const project = manifest?.project ?? input.projectName;
  return `${status} — project \`${project}\`, cycle \`${input.cycleId}\`.`;
}

// Re-export for callers that need to enumerate themes against a sinceMs.
export function listFreshThemes(themesDir: string, sinceMs: number): string[] {
  if (!existsSync(themesDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(themesDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const file of entries) {
    if (!file.endsWith('.md')) continue;
    const full = resolve(themesDir, file);
    try {
      const st = statSync(full);
      if (st.mtimeMs < sinceMs) continue;
      out.push(full);
    } catch {
      /* skip */
    }
  }
  return out;
}
