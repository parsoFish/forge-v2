/**
 * Phase A (UI live telemetry) — shared per-tool event emission.
 *
 * Moves agent telemetry from once-per-iteration to once-per-tool-call so the
 * operator UI can pulse the active agent node live. Two concerns live here:
 *
 *  1. A **coalescing sampler** that bounds event-log growth. A wedged loop can
 *     fire hundreds of tool calls per iteration; unconditional emission would
 *     make the synchronous `appendFileSync` + the bridge's 200ms full-tail the
 *     bottleneck. The sampler caps individual `tool_use` emits per iteration,
 *     samples high-volume read-only tools (Read/Grep/Glob), and ALWAYS emits
 *     file-modifying tools + Bash. What it drops is surfaced (never silent) via
 *     a single coalesced summary event at iteration flush.
 *
 *  2. A **sink** binding a logger + event context, exposing the `onToolUse` /
 *     `onHeartbeat` callbacks `createClaudeAgent` expects plus `flushIteration`.
 *
 * Used by the dev-loop, the unifier, and (via `extractLiveToolDetails`) the PM's
 * own stream loop.
 */

import type { EventLogger, Phase } from './logging.ts';
import {
  fileChangeForTool,
  summarizeToolInput,
  type HeartbeatInfo,
  type ToolUseLiveDetail,
} from '../loops/ralph/claude-agent.ts';

/** Read-only, high-volume tools that get sampled rather than emitted 1:1. */
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob']);

export type ToolEventContext = {
  initiativeId: string;
  parentEventId: string;
  phase: Phase;
  skill: string;
  workItemId?: string;
  featureId?: string;
};

export type ToolEventSamplerOptions = {
  /** Max individual `tool_use` emits per iteration before coalescing. */
  cap?: number;
  /** Emit 1-in-N read-only (Read/Grep/Glob) calls. */
  readOnlySampleRate?: number;
};

const DEFAULT_CAP = 50;
const DEFAULT_READ_ONLY_SAMPLE_RATE = 4;

type ConsiderDecision = {
  /** Emit an individual `tool_use` event for this call. */
  emit: boolean;
};

/**
 * Per-iteration coalescing sampler. Stateful; reset between iterations either
 * explicitly via `flush()` or implicitly when a `seq === 1` call signals a new
 * iteration started (belt-and-suspenders for callers that don't flush).
 */
export type ToolEventSampler = {
  consider: (detail: ToolUseLiveDetail) => ConsiderDecision;
  /** Coalesced remainder for the iteration just finished, then resets. */
  flush: () => { coalescedCount: number; sampledOutCount: number };
};

export function createToolEventSampler(opts: ToolEventSamplerOptions = {}): ToolEventSampler {
  const cap = opts.cap ?? DEFAULT_CAP;
  const readOnlySampleRate = Math.max(1, opts.readOnlySampleRate ?? DEFAULT_READ_ONLY_SAMPLE_RATE);

  let emittedCount = 0;
  let coalescedCount = 0;
  let sampledOutCount = 0;
  let readOnlySeen = 0;

  const reset = (): void => {
    emittedCount = 0;
    coalescedCount = 0;
    sampledOutCount = 0;
    readOnlySeen = 0;
  };

  return {
    consider(detail) {
      // A fresh iteration restarts the per-iteration budget. Without this, a
      // caller that forgets to flush would coalesce forever after the first
      // iteration crossed the cap.
      if (detail.seq === 1) reset();

      // Past the cap → coalesce, never emit individually.
      if (emittedCount >= cap) {
        coalescedCount += 1;
        return { emit: false };
      }

      // Read-only tools are sampled 1-in-N to keep noisy Read/Grep bursts off
      // the durable log; the skipped ones are counted (surfaced at flush).
      if (READ_ONLY_TOOLS.has(detail.name)) {
        readOnlySeen += 1;
        if (readOnlySeen % readOnlySampleRate !== 1) {
          sampledOutCount += 1;
          return { emit: false };
        }
      }

      emittedCount += 1;
      return { emit: true };
    },
    flush() {
      const remainder = { coalescedCount, sampledOutCount };
      reset();
      return remainder;
    },
  };
}

/**
 * Bind a logger + context + a fresh sampler into the callbacks the SDK adapter
 * expects. `flushIteration(iteration)` should be called from the runner's
 * `onIteration` (or once after a non-iterative run, e.g. the PM) to emit the
 * coalesced summary and reset for the next iteration.
 */
export function makeToolEventSink(
  logger: EventLogger,
  ctx: ToolEventContext,
  opts: ToolEventSamplerOptions = {},
): {
  onToolUse: (detail: ToolUseLiveDetail) => void;
  onHeartbeat: (info: HeartbeatInfo) => void;
  flushIteration: (iteration: number) => void;
} {
  const sampler = createToolEventSampler(opts);
  const wiMeta = ctx.workItemId !== undefined ? { work_item_id: ctx.workItemId } : {};
  const featMeta = ctx.featureId !== undefined ? { feature_id: ctx.featureId } : {};

  return {
    onToolUse(detail) {
      const { emit } = sampler.consider(detail);
      // File mutations are always durable (drive the heatmap), independent of
      // the tool_use sampling decision.
      if (detail.filePath && detail.op) {
        logger.emit({
          initiative_id: ctx.initiativeId,
          parent_event_id: ctx.parentEventId,
          phase: ctx.phase,
          skill: ctx.skill,
          event_type: 'file_change',
          input_refs: [],
          output_refs: [detail.filePath],
          message: `file.${detail.op}`,
          metadata: { ...wiMeta, ...featMeta, path: detail.filePath, op: detail.op },
        });
      }
      if (!emit) return;
      logger.emit({
        initiative_id: ctx.initiativeId,
        parent_event_id: ctx.parentEventId,
        phase: ctx.phase,
        skill: ctx.skill,
        event_type: 'tool_use',
        input_refs: [],
        output_refs: detail.filePath ? [detail.filePath] : [],
        message: `tool.${detail.name}`,
        metadata: {
          ...wiMeta,
          ...featMeta,
          tool: detail.name,
          input_summary: detail.inputSummary,
          seq: detail.seq,
        },
      });
    },
    onHeartbeat(info) {
      logger.emit({
        initiative_id: ctx.initiativeId,
        parent_event_id: ctx.parentEventId,
        phase: ctx.phase,
        skill: ctx.skill,
        event_type: 'agent_heartbeat',
        input_refs: [],
        output_refs: [],
        message: 'agent.heartbeat',
        metadata: { ...wiMeta, ...featMeta, ...info },
      });
    },
    flushIteration(iteration) {
      const { coalescedCount, sampledOutCount } = sampler.flush();
      if (coalescedCount === 0 && sampledOutCount === 0) return;
      // Surface what the sampler dropped — never a silent cap.
      logger.emit({
        initiative_id: ctx.initiativeId,
        parent_event_id: ctx.parentEventId,
        phase: ctx.phase,
        skill: ctx.skill,
        event_type: 'tool_use',
        iteration,
        input_refs: [],
        output_refs: [],
        message: 'tool.coalesced',
        metadata: {
          ...wiMeta,
          ...featMeta,
          coalesced: true,
          coalesced_count: coalescedCount,
          sampled_out_count: sampledOutCount,
        },
      });
    },
  };
}

/**
 * Extract live tool-use details from an assistant message's content blocks,
 * for callers (the PM) that drive their own SDK stream loop rather than going
 * through `createClaudeAgent`. `seqOffset` is the running per-run tool count
 * before this message; the returned details carry 1-based `seq` continuing
 * from it.
 */
export function extractLiveToolDetails(message: unknown, seqOffset: number): ToolUseLiveDetail[] {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return [];
  const out: ToolUseLiveDetail[] = [];
  let seq = seqOffset;
  for (const block of content) {
    const b = block as { type?: string; name?: string; input?: unknown };
    if (b.type !== 'tool_use' || !b.name) continue;
    seq += 1;
    const fc = fileChangeForTool(b.name, b.input);
    out.push({
      name: b.name,
      inputSummary: summarizeToolInput(b.name, b.input),
      filePath: fc?.filePath,
      op: fc?.op,
      seq,
    });
  }
  return out;
}
