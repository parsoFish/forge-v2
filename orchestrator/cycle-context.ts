/**
 * Shared cycle context: the types + cross-runner helpers used by the
 * orchestration spine (`cycle.ts`) and every phase runner under
 * `orchestrator/phases/`.
 *
 * This module is dependency-free with respect to `cycle.ts` and the phase
 * runners: phase modules import from here, never from `cycle.ts`, and this
 * module never imports `cycle.ts`. That keeps the import graph acyclic while
 * letting the thin spine and the phase runners share one definition of the
 * cycle's input/output shape and the brain-gate / quality-gate helpers.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { EventLogger } from './logging.ts';
import { parseManifest } from './manifest.ts';
import type { GetVerdict } from './reviewer-stage2.ts';

export type CycleInput = {
  initiativeId: string;
  manifestPath: string;
  projectRepoPath: string;
  worktreePath: string;
  cycleId?: string;
  dryRun?: boolean;
  /**
   * Verdict provider for the review-Ralph loop. Production: stdin-prompt
   * adapter (deferred). Bench: simulator agent. When absent, the review-loop
   * uses a default that approves on the first call — appropriate for the
   * per-phase review-loop bench (which only tests stage 1) but NOT for
   * end-to-end runs (the e2e bench supplies a real simulator).
   */
  getVerdict?: GetVerdict;
  /** Project quality-gate command run by the orchestrator between review iterations. Defaults to `npm test` if package.json is present, otherwise `true`. */
  qualityGateCmd?: string[];
  /**
   * Cap on review-Ralph iterations. 1 prep + N send-back rounds. Default 3
   * (1 prep + 2 send-backs) per the phase-doc target.
   */
  reviewIterationCap?: number;
  /**
   * Per-iteration USD cap for the review-Ralph. Default 1.0. The full
   * Ralph budget = reviewIterationCap × this.
   */
  reviewIterationBudgetUsd?: number;
  /**
   * Optional sink invoked after every event-log emit. The scheduler uses this
   * to render live progress to stdout in `forge serve` interactive mode.
   * Threaded straight through to `createLogger`'s `tee`.
   */
  eventTee?: (entry: import('./logging.ts').EventLogEntry) => void;
};

export type ReflectionStatus = 'closed' | 'failed' | 'skipped';

export type CycleResult = {
  cycle_id: string;
  initiative_id: string;
  status: 'merged' | 'ready-for-review' | 'send-back-cap-exhausted' | 'failed';
  /**
   * Outcome of the reflection phase. Reflection runs after a successful merge
   * and is log-and-continue: a failed reflector does not change the merge
   * outcome (`status`). Surfaced as separate telemetry, not a cycle gate.
   *
   * - `closed`   — reflection ran to completion.
   * - `failed`   — reflection ran but threw.
   * - `skipped`  — reflection was not invoked (no merge, or dry run).
   */
  reflection_status?: ReflectionStatus;
  duration_ms: number;
  log_path: string;
};

export type ReviewerOutcome = 'merged' | 'ready-for-review' | 'send-back-cap-exhausted';

/**
 * Brain-first runtime gate. CLAUDE.md and every SKILL.md require each phase's
 * agent to consult the brain (via `Read`/`Grep`/`Glob` against `brain/...`)
 * before producing output. Bench harnesses gate on this; production didn't —
 * which surfaced in W4 as a PM run that fabricated a "Brain themes consulted"
 * footer while the tool-use summary recorded `brainReads: 0`.
 *
 * Returns true iff the agent consulted the brain at least once. On false,
 * emits a `<skill>.brain-skipped` error event so the failure is observable;
 * the caller decides whether to throw (PM/review) or log-and-continue
 * (dev-loop per-WI / reflector — both have established graceful paths).
 */
export function recordBrainGateResult(
  phase: 'project-manager' | 'developer-loop' | 'review-loop' | 'reflection',
  skill: string,
  brainReads: number,
  context: {
    initiativeId: string;
    logger: EventLogger;
    parentEventId?: string;
    subject?: string;
  },
): boolean {
  if (brainReads > 0) return true;
  context.logger.emit({
    initiative_id: context.initiativeId,
    parent_event_id: context.parentEventId,
    phase,
    skill,
    event_type: 'error',
    input_refs: [],
    output_refs: [],
    message: `${skill}.brain-skipped`,
    metadata: context.subject ? { subject: context.subject } : undefined,
  });
  return false;
}

/**
 * Resolve the quality-gate command the dev-loop runner and reviewer will use.
 * Single source of truth — both phases call this and use the same vector.
 *
 * Precedence: explicit CycleInput → manifest field → npm test (if Node repo)
 * → ['true'] (no-op for non-Node repos that didn't declare a command).
 */
export function resolveQualityGateCmd(input: CycleInput): string[] {
  if (input.qualityGateCmd && input.qualityGateCmd.length > 0) {
    return [...input.qualityGateCmd];
  }
  try {
    const m = parseManifest(readFileSync(input.manifestPath, 'utf8'));
    if (m.quality_gate_cmd && m.quality_gate_cmd.length > 0) {
      return [...m.quality_gate_cmd];
    }
  } catch {
    /* manifest may not exist in dry-run / test fixtures; fall through */
  }
  if (existsSync(resolve(input.worktreePath, 'package.json'))) {
    return ['npm', 'test'];
  }
  return ['true'];
}
