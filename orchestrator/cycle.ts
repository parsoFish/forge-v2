/**
 * Run one initiative end-to-end:
 *   PM → developer-loop (per work item) → review-prep
 *
 * The orchestrator's only job is to thread phase outputs into the next phase's
 * inputs. Each phase is invoked by calling its skill via the Claude Agent SDK
 * (or, for the developer loop, via loops/ralph/runner.ts).
 *
 * STATUS: skeleton. Each phase invocation is a no-op stub that emits start/end
 * events to the log so the wiring is provable. Implementation lands per
 * docs/phases/<phase>.md.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { EventLogger } from './logging.ts';
import { createLogger } from './logging.ts';
import { classifyCycleFailure } from './failure-classifier.ts';
import { writeCycleReport } from './cycle-report.ts';
import { readManifestOrigin } from './manifest.ts';

// Shared cycle types + cross-runner helpers live in cycle-context.ts (the
// phase runners import them from there, never from this module — keeps the
// import graph acyclic). Re-exported here so the external surface
// (benchmarks/e2e, cli, scheduler, tests) keeps importing them from
// `./cycle.ts` unchanged.
export type {
  CycleInput,
  CycleResult,
  CycleOutcome,
  ReflectionStatus,
  ReviewerOutcome,
} from './cycle-context.ts';
export { recordBrainGateResult } from './cycle-context.ts';

// Internal uses within this module (re-export above doesn't bind names locally).
import type {
  CycleInput,
  CycleResult,
  CycleOutcome,
  ReflectionStatus,
} from './cycle-context.ts';
import { resolveQualityGateCmd } from './cycle-context.ts';

// Phase runners (extracted from this module — cycle.ts is the thin spine).
// computeAdaptiveReviewIterationCap is re-exported so benchmarks keep
// importing it from `./cycle.ts` unchanged.
import { runProjectManager } from './phases/project-manager.ts';
import { runDeveloperLoop } from './phases/developer-loop.ts';
import { runReviewer } from './phases/reviewer.ts';
import { runReflector } from './phases/reflector.ts';
import { runClosure } from './phases/closure.ts';
import { assertLocalRemoteSynced, pushInitiativeBranch } from './pr.ts';
export { computeAdaptiveReviewIterationCap } from './phases/reviewer.ts';

export async function runCycle(input: CycleInput): Promise<CycleResult> {
  const started = Date.now();
  const cycleId = input.cycleId ?? newCycleId(input.initiativeId);
  const logger = createLogger(cycleId, '_logs', { tee: input.eventTee });

  // G6: tag the cohort on the cycle's first event so `forge metrics` (which
  // reconstructs everything from the JSONL log) and the reflector can
  // separate autonomous-progress cycles from hand-directed project surgery.
  // Single read of the manifest's `origin` field; defaults to `architect`.
  const origin = readManifestOrigin(input.manifestPath);

  logger.emit({
    initiative_id: input.initiativeId,
    phase: 'orchestrator',
    skill: 'cycle',
    event_type: 'start',
    input_refs: [input.manifestPath],
    output_refs: [],
    message: input.dryRun ? 'cycle.start (dry run)' : 'cycle.start',
    metadata: { origin },
  });

  // F-04 / F-06: derive the effective quality-gate command once per cycle so
  // the dev-loop and reviewer use exactly the same gate. Precedence:
  //   1. CycleInput.qualityGateCmd (explicit override — bench harnesses use this)
  //   2. manifest.quality_gate_cmd (per-project config in initiative manifest)
  //   3. ['npm', 'test'] if the worktree has package.json
  //   4. ['true'] (no-op, tests bypassed) — only happens for non-Node repos
  //      that didn't declare a quality_gate_cmd; the dispatch will surface
  //      the absence via a metadata field.
  const effectiveQualityGateCmd = resolveQualityGateCmd(input);
  const inputWithGate: CycleInput = { ...input, qualityGateCmd: effectiveQualityGateCmd };

  // Final cycle outcome. `merged` is reachable ONLY via the closure step
  // (a GitHub-confirmed merge) — never from the reviewer (G9).
  let cycleOutcome: CycleOutcome = 'ready-for-review';
  let reflectionStatus: ReflectionStatus = 'skipped';
  try {
    if (!input.dryRun) {
      await runProjectManager(inputWithGate, logger);
      await runDeveloperLoop(inputWithGate, logger);
      // Safety net: commit any uncommitted dev-loop work before the reviewer
      // starts. The dev-loop's prompt tells the agent to commit per
      // iteration, but if it skips, source files would not reach the PR.
      // This boundary commit catches any drift. Files matching .gitignore
      // (Ralph scratch: PROMPT.md / AGENT.md / fix_plan.md, node_modules)
      // are excluded by `git add` automatically.
      commitDevLoopBoundary(inputWithGate.worktreePath, logger, inputWithGate.initiativeId);
      // G8: the boundary commit may have added a commit on top of the
      // dev-loop's last per-WI push, so push once more and then assert the
      // local↔remote invariant. This is the precondition the review
      // redesign depends on: at dev-loop close `origin/<branch>` == local
      // HEAD and `main` == merge-base (no divergence). A violation throws
      // and is classified — the branch is not in a reviewable state.
      enforceDevLoopCloseInvariant(inputWithGate.worktreePath, logger, inputWithGate.initiativeId);

      // Review phase: assess the branch holistically vs intent, refine
      // (may spawn a dev-loop), produce the demo-embedded PR, then STOP.
      // No auto-merge (G9) — the GitHub PR is the operator's merge surface.
      const reviewerOutcome = await runReviewer(inputWithGate, logger);

      // Closure: reflection fires ONLY on a GitHub-confirmed merge (G10),
      // and `_queue/done/` ⇒ the PR is MERGED (G1). The closure step asks
      // GitHub `gh pr view --json state`; on MERGED it aligns local↔remote
      // (ff main, prune the initiative branch) and moves the manifest to
      // `done/`; otherwise the manifest stays in `ready-for-review/`
      // flagged and reflection is skipped. The operator merging the PR in
      // GitHub is what closes the review phase — nothing here auto-merges.
      const closure = await runClosure(inputWithGate, logger, reviewerOutcome);
      cycleOutcome = closure.outcome;
      if (closure.merged) {
        reflectionStatus = await runReflector(inputWithGate, logger);
      }
    }
  } catch (err) {
    logger.emit({
      initiative_id: input.initiativeId,
      phase: 'orchestrator',
      skill: 'cycle',
      event_type: 'error',
      input_refs: [input.manifestPath],
      output_refs: [],
      message: err instanceof Error ? err.message : String(err),
    });
    // F-27: classify the failure mode from the event log so the scheduler
    // (and humans reading the cycle report) can see a concrete diagnosis
    // instead of grepping events.jsonl. The classifier reads the log we
    // just finished writing — including the orchestrator-level error event
    // emitted above.
    emitFailureClassification(logger, input.initiativeId, cycleId);
    const result: CycleResult = {
      cycle_id: cycleId,
      initiative_id: input.initiativeId,
      status: 'failed',
      reflection_status: reflectionStatus,
      duration_ms: Date.now() - started,
      log_path: logger.logFilePath,
    };
    // Snapshot artefacts + write report even on failure — failed cycles
    // still produce useful evidence for diagnosis. AWAIT the snapshot so
    // the report's "decomposition" / "verification" sections find the
    // copied work-items + demo dirs (otherwise the report runs before the
    // copy completes and silently shows the no-snapshot fallback).
    await snapshotCycleArtefacts(input, cycleId).catch(() => { /* best-effort */ });
    writeCycleReportSafely(cycleId);
    return result;
  }

  // Success path (no throw). Snapshot before cycle.end so the report can
  // include the cycle.end metadata and reference durable artefacts.
  await snapshotCycleArtefacts(input, cycleId).catch(() => { /* best-effort */ });

  const result: CycleResult = {
    cycle_id: cycleId,
    initiative_id: input.initiativeId,
    status: cycleOutcome,
    reflection_status: reflectionStatus,
    duration_ms: Date.now() - started,
    log_path: logger.logFilePath,
  };

  logger.emit({
    initiative_id: input.initiativeId,
    phase: 'orchestrator',
    skill: 'cycle',
    event_type: 'end',
    input_refs: [input.manifestPath],
    output_refs: [logger.logFilePath],
    duration_ms: result.duration_ms,
    message: 'cycle.end',
    metadata: { status: result.status, reflection_status: result.reflection_status },
  });

  // Generate the human-facing report as the final cycle step. Best-effort —
  // a failed report write does not fail the cycle (the merge already
  // happened; the report is meta).
  writeCycleReportSafely(cycleId);

  return result;
}

/**
 * Snapshot ephemeral cycle artefacts from the worktree to durable
 * `_logs/<cycleId>/` paths so they survive `worktree.cleanup()` and are
 * available for the cycle report (and re-generation later).
 *
 * Best-effort: missing dirs are skipped silently, copy failures are
 * surfaced via the returned promise rejection so the caller can decide
 * whether to log them.
 */
async function snapshotCycleArtefacts(
  input: CycleInput,
  cycleId: string,
): Promise<void> {
  const forgeRoot = resolve(import.meta.dirname, '..');
  const cycleLogDir = resolve(forgeRoot, '_logs', cycleId);
  if (!existsSync(cycleLogDir)) mkdirSync(cycleLogDir, { recursive: true });

  // Work-item specs: the PM's output, valuable evidence for the report's
  // "How the system decomposed it" section.
  const wiSrc = resolve(input.worktreePath, '.forge', 'work-items');
  if (existsSync(wiSrc)) {
    const wiDst = resolve(cycleLogDir, 'work-items-snapshot');
    cpSync(wiSrc, wiDst, { recursive: true, force: true });
  }

  // Demo bundle: the reviewer's recording + source script + README. Real
  // showcase content for the report's "Verification" section.
  const demoSrc = resolve(input.worktreePath, '.forge', 'demos', input.initiativeId);
  if (existsSync(demoSrc)) {
    const demoDst = resolve(cycleLogDir, 'demo');
    cpSync(demoSrc, demoDst, { recursive: true, force: true });
  }

  // PR description draft: useful for the report's "What landed" section.
  const prSrc = resolve(input.worktreePath, '.forge', 'pr-description.md');
  if (existsSync(prSrc)) {
    cpSync(prSrc, resolve(cycleLogDir, 'pr-description.md'), { force: true });
  }
}

/**
 * Best-effort report write at end of cycle. Catches all errors so a failure
 * to render the report (missing data, malformed event log, etc.) cannot
 * fail the cycle itself — the merge has already happened by the time we
 * reach this point.
 */
function writeCycleReportSafely(cycleId: string): void {
  try {
    writeCycleReport({ cycleId });
  } catch (err) {
    process.stderr.write(
      `[cycle-report] failed to write report for ${cycleId}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// runProjectManager + its PM_LIVE_* defaults moved to
// ./phases/project-manager.ts (Phase 3.4c step 3). Imported at the top.

// runDeveloperLoop + its DEV_LIVE_* defaults + prerequisiteFailed +
// the dev-only emitGateEvent helper moved to ./phases/developer-loop.ts
// (Phase 3.4c step 4). Imported at the top.

// runReviewer + its REVIEWER_LIVE_* defaults + inferProjectType +
// defaultGetVerdict + computeAdaptiveReviewIterationCap +
// ensureMinimalPrDescription + extractPrTitle moved to
// ./phases/reviewer.ts (Phase 3.4c step 5). Imported + re-exported below.

// runReflector + its REFLECTOR_LIVE_* defaults + resolveCurrentManifestPath
// moved to ./phases/reflector.ts (Phase 3.4c step 2). Imported at the top.

function newCycleId(initiativeId: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${ts}_${initiativeId}`;
}

/**
 * F-27: read the cycle's event log, classify the failure mode, and emit a
 * `failure_classification` event. Best-effort — never throws (a malformed
 * log shouldn't break the failure-path return).
 */
function emitFailureClassification(
  logger: EventLogger,
  initiativeId: string,
  cycleId: string,
): void {
  try {
    const events: import('./logging.ts').EventLogEntry[] = [];
    const raw = readFileSync(logger.logFilePath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* skip malformed line */
      }
    }
    const cls = classifyCycleFailure(events);
    logger.emit({
      initiative_id: initiativeId,
      phase: 'orchestrator',
      skill: 'cycle',
      event_type: 'log',
      input_refs: [logger.logFilePath],
      output_refs: [],
      message: 'failure_classification',
      metadata: {
        cycle_id: cycleId,
        failure_mode: cls.mode,
        recoverable: cls.recoverable,
        recommendation: cls.recommendation,
        evidence_event_ids: cls.evidence_event_ids,
      },
    });
  } catch {
    /* best-effort */
  }
}

// emitGateEvent moved to ./phases/developer-loop.ts (Phase 3.4c step 4).
// extractPrTitle moved to ./phases/reviewer.ts (Phase 3.4c step 5).

/**
 * Boundary commit between dev-loop and reviewer phases. Catches any
 * uncommitted work from the dev-loop (the agent's per-iteration commit is
 * prompt-only, not enforced; this is the safety net). Best-effort —
 * `--allow-empty` so a no-op cycle doesn't error, and `|| true`-style
 * try/catch so non-git worktrees (e.g. early dry-runs) don't fail the cycle.
 */
function commitDevLoopBoundary(
  worktreePath: string,
  logger: EventLogger,
  initiativeId: string,
): void {
  try {
    execFileSync('git', ['add', '-A'], { cwd: worktreePath, stdio: 'pipe' });
    // Second guard (linkProjectDeps writes the primary one to the worktree's
    // git exclude): never let the forge-created `node_modules` symlink into
    // the boundary commit. A project .gitignore of `node_modules/` does not
    // match a symlink named `node_modules`; `--ignore-unmatch` keeps this a
    // no-op when it isn't staged.
    try {
      execFileSync('git', ['reset', '-q', '--', 'node_modules'], {
        cwd: worktreePath,
        stdio: 'pipe',
      });
    } catch {
      /* best-effort — not staged / nothing to unstage */
    }
    execFileSync(
      'git',
      [
        'commit',
        '--allow-empty',
        '-m',
        'chore(developer-loop): pre-review boundary snapshot',
      ],
      { cwd: worktreePath, stdio: 'pipe' },
    );
    logger.emit({
      initiative_id: initiativeId,
      phase: 'orchestrator',
      skill: 'cycle',
      event_type: 'log',
      input_refs: [worktreePath],
      output_refs: [],
      message: 'cycle.dev-boundary-commit',
    });
  } catch {
    // Not a git repo, or no changes to commit, or git failed — non-fatal.
  }
}

/**
 * G8: enforce the local↔remote invariant at dev-loop close. Pushes once
 * more (the boundary commit may have added a commit on top of the
 * dev-loop's last per-WI push), then asserts:
 *   - `origin/<branch>` == local HEAD  (branch fully published)
 *   - `main` == merge-base(main, branch)  (main did not diverge)
 *
 * On violation this THROWS — a diverged / unpublished branch is not a
 * reviewable state, and the failure-classifier surfaces it. The branch
 * sync is the precondition the review-phase redesign depends on
 * (architecture.md §G / brain theme `review-phase-target-design`).
 */
function enforceDevLoopCloseInvariant(
  worktreePath: string,
  logger: EventLogger,
  initiativeId: string,
): void {
  const push = pushInitiativeBranch(worktreePath);
  logger.emit({
    initiative_id: initiativeId,
    phase: 'orchestrator',
    skill: 'cycle',
    event_type: push.pushed ? 'log' : 'error',
    input_refs: [worktreePath],
    output_refs: [],
    message: push.pushed ? 'cycle.dev-close-pushed' : 'cycle.dev-close-push-failed',
    metadata: push.pushed ? { branch: push.branch } : { reason: push.reason },
  });
  const inv = assertLocalRemoteSynced(worktreePath);
  logger.emit({
    initiative_id: initiativeId,
    phase: 'orchestrator',
    skill: 'cycle',
    event_type: 'log',
    input_refs: [worktreePath],
    output_refs: [],
    message: 'cycle.dev-close-invariant-ok',
    metadata: {
      branch: inv.branch,
      local_head: inv.localHead,
      origin_head: inv.originHead,
      main_head: inv.mainHead,
      merge_base: inv.mergeBase,
    },
  });
}
