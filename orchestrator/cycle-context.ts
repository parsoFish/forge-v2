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
import type { GetVerdict } from './file-verdict.ts';

export type CycleInput = {
  initiativeId: string;
  manifestPath: string;
  projectRepoPath: string;
  worktreePath: string;
  cycleId?: string;
  dryRun?: boolean;
  /**
   * Verdict provider for the review-Ralph loop. Production: file-based
   * operator adapter (`makeFileVerdict`). Bench: simulator agent. When
   * absent, the review-loop uses a default that approves on the first call
   * — appropriate for the per-phase review-loop bench (which only tests
   * stage 1) but NOT for end-to-end runs (the chained bench supplies a
   * real simulator). NOTE (Phase 6 / G9): an `approve` verdict no longer
   * causes a merge — it means the review gate passed and the PR is
   * produced. The GitHub PR is the operator's merge surface.
   */
  getVerdict?: GetVerdict;
  /**
   * Operator-merge confirmation hook (Phase 6 / G9 / G10). The review
   * phase NEVER merges; the operator merges the PR in GitHub. The closure
   * step calls this to learn whether the operator has merged yet.
   *
   * Production (scheduler): omitted → defaults to `confirmPrMerged`
   * (`gh pr view --json state` == MERGED). Right after the PR is created
   * this is false (the operator hasn't merged), so the unattended cycle
   * stops at `ready-for-review` and reflection is skipped; a later
   * re-trigger re-checks and proceeds once the operator has merged.
   *
   * Bench: the chained harness injects a hook that models the operator
   * clicking "merge" (drives its gh-shim) so the chain exercises closure
   * + reflection end-to-end. This keeps `mergePullRequest` unreachable
   * from any product path — only the bench's injected hook merges.
   */
  confirmMerge?: (worktreePath: string) => Promise<boolean> | boolean;
  /**
   * US-1.3 opt-in: when the holistic intent gate finds the whole branch
   * misaligned, spawn a targeted developer-loop (reusing `runDeveloperLoop`)
   * to refine/fix/align before the review-Ralph produces the PR. Default
   * OFF — the unattended path uses the review-Ralph's send-back loop as the
   * primary gap-filler; the spawned alignment dev-loop is the structural
   * hook for the holistic refinement described in the review-phase redesign.
   */
  spawnAlignmentDevLoop?: boolean;
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
  /**
   * S4 — when set, the unifier runs in send-back mode (CONTRACTS.md C3b).
   * Points at a `_queue/in-flight/<id>.pr-feedback.md` file the unifier
   * reads as its iteration input. Set by the daemon/scheduler when the
   * review router enqueues a re-entrant unifier run.
   */
  unifierFeedbackRef?: string;
};

export type ReflectionStatus = 'closed' | 'failed' | 'skipped';

/**
 * S6A / C8 — outcome of the post-reflection brain-lint pass over
 * cycle-touched themes. Sibling field on `CycleResult`; NOT a new value on
 * the existing `reflection_status` enum. Per
 * `feedback_reflection_close_criterion`, `lint_status: 'flagged'` does
 * NOT block `reflection_status: 'closed'` — themes the reflector wrote
 * are still internally consistent; flagged lint reports pre-existing
 * brain debt for the next cycle.
 *
 * - `clean`   — lint ran, zero error findings.
 * - `flagged` — lint ran, ≥ 1 error finding (or lint itself threw on a
 *               malformed brain file — see S6A-DECISIONS.md "Failure mode").
 * - `skipped` — lint did not run (reflector bailed before lint trigger,
 *               or lint module is unavailable in the runtime).
 */
export type LintStatus = 'clean' | 'flagged' | 'skipped';

/**
 * Combined outcome of the reflection phase — what `runReflector` returns
 * so `runCycle` can populate both sibling fields on `CycleResult` from a
 * single phase-runner invocation.
 */
export type ReflectorPhaseResult = {
  reflection_status: ReflectionStatus;
  lint_status: LintStatus;
};

export type CycleResult = {
  cycle_id: string;
  initiative_id: string;
  /**
   * Terminal cycle status. Post-Phase-6 (review redesign):
   * - `merged`                 — the operator merged the PR in GitHub, the
   *                              merge was confirmed (`gh pr view` == MERGED),
   *                              local was aligned to remote, and the
   *                              manifest moved to `_queue/done/`. Only this
   *                              status fires reflection.
   * - `pr-open`                — the review gate passed and the demo-embedded
   *                              PR is open, awaiting the operator's merge.
   *                              Manifest in `_queue/ready-for-review/`.
   *                              NOT a failure — the expected unattended
   *                              terminal state until the operator merges.
   * - `ready-for-review`       — review did not fully converge / PR not
   *                              produced; operator picks up the worktree.
   * - `send-back-cap-exhausted`— send-back cap hit before convergence.
   * - `failed`                 — a phase threw.
   */
  status: 'merged' | 'pr-open' | 'ready-for-review' | 'send-back-cap-exhausted' | 'failed';
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
  /**
   * S6A / C8 — sibling to `reflection_status`. Records whether the post-
   * reflection brain-lint pass found errors in cycle-touched themes.
   * Optional (absent ⇒ `'skipped'`). Informational only — does NOT
   * change `status` or block `reflection_status: 'closed'`.
   */
  lint_status?: LintStatus;
  duration_ms: number;
  log_path: string;
};

/**
 * Outcome of `runReviewer` (Phase 6: the reviewer no longer merges).
 * - `pr-open`                — review gate passed, demo-embedded PR created;
 *                              control returns to the closure step (which
 *                              decides `merged` vs `pr-open` based on whether
 *                              the operator has merged). The reviewer itself
 *                              never produces `merged`.
 * - `ready-for-review`       — review did not converge / PR creation failed.
 * - `send-back-cap-exhausted`— send-back cap hit.
 */
export type ReviewerOutcome = 'pr-open' | 'ready-for-review' | 'send-back-cap-exhausted';

/**
 * Final cycle outcome after the closure step folds in the operator-merge
 * confirmation. `merged` is reachable ONLY here (never from the reviewer)
 * and ONLY when `gh pr view --json state` == MERGED.
 */
export type CycleOutcome = 'merged' | 'pr-open' | 'ready-for-review' | 'send-back-cap-exhausted';

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
