/**
 * Pure artifact-extraction helpers for the chained bench. Kept separate from
 * score.ts (the runner) so they are trivially unit-testable without the SDK
 * or a real cycle.
 *
 * These functions ONLY locate / parse / reconstruct the generated artifacts
 * so they can be fed to the EXISTING per-phase `scoring.ts:caseScore`
 * functions. They contain NO scoring logic of their own — that would be a
 * chained-only rubric, which US-6.2 / brain theme `chained-phase-benchmarks`
 * forbids.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { LoopResult } from '../../loops/ralph/runner.ts';
import {
  readWorkItemsFromDir,
  type AcceptanceCriterion,
  type WorkItem,
} from '../../orchestrator/work-item.ts';
import type { ReflectorToolUseSummary } from '../../orchestrator/reflector-invocation.ts';
import type { ChainArtifacts } from './sdk.ts';

/** The generated manifest text (architect output, copied into the queue). */
export function readChainedManifestText(a: ChainArtifacts): string | null {
  return a.manifestText;
}

/** The PM's generated work items (`<worktree>/.forge/work-items/`). */
export function readChainedWorkItems(a: ChainArtifacts): WorkItem[] {
  const { items } = readWorkItemsFromDir(a.workItemsDir);
  return items;
}

/** The PM's generated dependency graph (`.forge/work-items/_graph.md`). */
export function readChainedGraphText(a: ChainArtifacts): string | null {
  const graphPath = resolve(a.workItemsDir, '_graph.md');
  if (!existsSync(graphPath)) return null;
  try {
    return readFileSync(graphPath, 'utf8');
  } catch {
    return null;
  }
}

type EventLine = {
  phase?: string;
  skill?: string;
  event_type?: string;
  message?: string;
  cost_usd?: number;
  duration_ms?: number;
  output_refs?: string[];
  metadata?: Record<string, unknown>;
};

function readEvents(eventLogPath: string | null): EventLine[] {
  if (!eventLogPath || !existsSync(eventLogPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(eventLogPath, 'utf8');
  } catch {
    return [];
  }
  const out: EventLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as EventLine);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/**
 * Reconstruct a single `LoopResult` from the durable event log's per-WI
 * `ralph.end` events (the spec's "reconstruct LoopResult from events.jsonl
 * ralph.end"). The dev-loop emits one `ralph.end` per work item with
 * `cost_usd`, `duration_ms`, `output_refs` (= filesChanged) and
 * `metadata.{status, iterations, stop_reason}`.
 *
 * The chain produces N work items but the dev-loop `caseScore` consumes ONE
 * `LoopResult`; we aggregate (mirrors how the live dev-loop reports a phase
 * across WIs):
 *   - status      = 'complete' iff every WI's ralph.end status is 'complete';
 *                   else 'failed' (or 'wedged' if any WI wedged)
 *   - iterations  = max across WIs (matches "iteration budget per WI")
 *   - cost_usd    = sum across WIs
 *   - duration_ms = sum across WIs
 *   - filesChanged = union across WIs
 *   - stop_reason = the worst non-complete reason, else 'gate-pass'
 *
 * Returns null if no `ralph.end` event exists (the dev-loop never ran — a
 * chain break upstream; the dev-loop rubric then scores its own zero).
 */
export function reconstructLoopResultFromEventLog(
  eventLogPath: string | null,
): LoopResult | null {
  const events = readEvents(eventLogPath);
  const wiEnds = events.filter(
    (e) =>
      e.phase === 'developer-loop' &&
      e.skill === 'developer-ralph' &&
      e.event_type === 'end' &&
      e.message === 'ralph.end',
  );
  if (wiEnds.length === 0) return null;

  let allComplete = true;
  let anyWedged = false;
  let maxIterations = 0;
  let totalCost = 0;
  let totalDuration = 0;
  const files = new Set<string>();
  // Default to the success stop reason (the live runner reports
  // 'quality-gates-pass' for a completed loop — see loops/ralph/runner.ts).
  let worstStop: LoopResult['stop_reason'] = 'quality-gates-pass';

  for (const e of wiEnds) {
    const md = e.metadata ?? {};
    const status = typeof md.status === 'string' ? md.status : 'failed';
    if (status !== 'complete') allComplete = false;
    if (status === 'wedged') anyWedged = true;
    const iters = typeof md.iterations === 'number' ? md.iterations : 0;
    if (iters > maxIterations) maxIterations = iters;
    totalCost += typeof e.cost_usd === 'number' ? e.cost_usd : 0;
    totalDuration += typeof e.duration_ms === 'number' ? e.duration_ms : 0;
    for (const f of e.output_refs ?? []) files.add(f);
    const sr = md.stop_reason;
    if (sr === 'iteration-budget' || sr === 'cost-budget' || sr === 'wedged') {
      worstStop = sr;
    }
  }

  const status: LoopResult['status'] = allComplete
    ? 'complete'
    : anyWedged
      ? 'wedged'
      : 'failed';

  return {
    status,
    iterations: maxIterations,
    cost_usd: totalCost,
    duration_ms: totalDuration,
    artifacts: { agentMdPath: '', fixPlanPath: '' },
    filesChanged: [...files],
    stop_reason: status === 'complete' ? 'quality-gates-pass' : worstStop,
  };
}

/**
 * Build a synthetic aggregate work item so the dev-loop `caseScore`
 * (one-result-one-WI) can score the whole initiative's reconstructed
 * aggregate `LoopResult`. The union of every WI's `files_in_scope` makes
 * `filesInScopeRespected` correct for the union of files the dev-loop
 * touched; the concatenated ACs preserve the aggregate intent. This is a
 * fan-out decision local to the chained harness, NOT a rubric change — the
 * scoring function itself is the unchanged `developer-loop/scoring.ts`.
 */
export function syntheticAggregateWorkItem(workItems: WorkItem[]): WorkItem {
  const filesInScope = new Set<string>();
  const acs: AcceptanceCriterion[] = [];
  for (const wi of workItems) {
    for (const f of wi.files_in_scope) filesInScope.add(f);
    for (const ac of wi.acceptance_criteria) acs.push(ac);
  }
  const first = workItems[0];
  return {
    work_item_id: 'WI-chained-aggregate',
    feature_id: first?.feature_id ?? 'FEAT-1',
    initiative_id: first?.initiative_id ?? 'INIT-chained',
    status: 'complete',
    depends_on: [],
    acceptance_criteria: acs,
    files_in_scope: [...filesInScope],
    estimated_iterations: Math.max(
      1,
      ...workItems.map((w) => w.estimated_iterations || 1),
    ),
    body: 'Synthetic aggregate of the chain\'s work items (chained-bench fan-out).',
  };
}

/**
 * Reconstruct the reflector's tool-use summary from the event log. The
 * reflection `caseScore`'s `brain_consulted` gate reads
 * `ReflectorToolUseSummary.brainReads`. The reflector phase emits a final
 * `reflection`/`reflector` `end` (or `error`) event whose
 * `metadata.tool_use` carries the tally.
 */
export function reconstructReflectorToolUse(
  eventLogPath: string | null,
): ReflectorToolUseSummary {
  const summary: ReflectorToolUseSummary = {
    brainReads: 0,
    themeWrites: 0,
    retroWrites: 0,
    bashCalls: 0,
  };
  const events = readEvents(eventLogPath);
  for (const e of events) {
    if (e.phase !== 'reflection' || e.skill !== 'reflector') continue;
    if (e.event_type !== 'end' && e.event_type !== 'error') continue;
    const tu = (e.metadata ?? {}).tool_use as
      | Partial<ReflectorToolUseSummary>
      | undefined;
    if (tu && typeof tu === 'object') {
      summary.brainReads = tu.brainReads ?? summary.brainReads;
      summary.themeWrites = tu.themeWrites ?? summary.themeWrites;
      summary.retroWrites = tu.retroWrites ?? summary.retroWrites;
      summary.bashCalls = tu.bashCalls ?? summary.bashCalls;
    }
  }
  return summary;
}
