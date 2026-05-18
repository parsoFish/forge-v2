/**
 * Closure phase (Phase 6 / G1 / G10 / closure-aligns-local↔remote).
 *
 * The review phase produces a demo-embedded PR and STOPS — it never
 * merges (G9). The operator merges the PR in GitHub; that merge is what
 * closes the review phase. This module is the boundary that:
 *
 *   1. Confirms the merge on the REMOTE via `gh pr view --json state`
 *      == MERGED (`confirmPrMerged`). Never an orchestrator-internal flag.
 *      Production omits `CycleInput.confirmMerge` → that is the default.
 *      The chained bench injects a hook that models the operator clicking
 *      "merge" (drives its gh-shim) so the chain exercises closure +
 *      reflection end-to-end; `mergePullRequest` stays unreachable from
 *      every product path.
 *   2. On a CONFIRMED merge: aligns local↔remote — fast-forwards local
 *      `main`, prunes the initiative branch (`alignLocalToRemote`) — and
 *      moves the manifest `in-flight/ → done/`. Reflection then fires
 *      (cycle.ts) on this confirmed-merge signal only (G10), so
 *      `_queue/done/` ⇒ the PR is MERGED (G1).
 *   3. On an UNconfirmed merge (open PR — the expected unattended state
 *      until the operator merges, or a partial/failed state): moves the
 *      manifest `in-flight/ → ready-for-review/`, flagged; reflection is
 *      skipped.
 *
 * Closure is the SINGLE terminal-move authority. The reviewer no longer
 * moves the manifest — it stays in `in-flight/` through review (it is in
 * flight). Keeping one mover matches queue.ts:moveTo's `from = in-flight`
 * contract and removes the double-move defect.
 *
 * No SDK calls — closure is pure orchestration over git + gh + the queue.
 */

import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

import type { EventLogger } from '../logging.ts';
import { moveTo as moveQueueItem } from '../queue.ts';
import { alignLocalToRemote, confirmPrMerged } from '../pr.ts';
import type { CycleInput, CycleOutcome, ReviewerOutcome } from '../cycle-context.ts';

export type ClosureResult = {
  /** Final cycle outcome after folding in the operator-merge confirmation. */
  outcome: CycleOutcome;
  /** True iff `gh pr view` reported MERGED (the ONLY merge signal). */
  merged: boolean;
};

/**
 * Resolve the worktree's current initiative branch name (best-effort).
 * Used only for the post-merge prune; a miss just skips that hygiene step.
 */
function initiativeBranch(input: CycleInput): string | null {
  try {
    const b = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: input.worktreePath,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
    return !b || b === 'HEAD' ? null : b;
  } catch {
    return null;
  }
}

/**
 * The single terminal queue move (from `in-flight/`). Best-effort + logged
 * — the manifest may already be at the destination on an idempotent
 * re-trigger, and a failed move must not fail the cycle (on the merged
 * path the merge already happened on the remote; on the pr-open path the
 * scheduler still preserves the worktree).
 */
function terminalMove(
  input: CycleInput,
  logger: EventLogger,
  parentEventId: string,
  to: 'done' | 'ready-for-review',
): void {
  try {
    const dest = moveQueueItem(basename(input.manifestPath), to);
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: parentEventId,
      phase: 'closure',
      skill: 'cycle',
      event_type: 'log',
      input_refs: [input.manifestPath],
      output_refs: [dest],
      message: to === 'done' ? 'closure.manifest-moved-to-done' : 'closure.manifest-moved-to-ready-for-review',
      metadata: { confirmed_merge: to === 'done' },
    });
  } catch (err) {
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: parentEventId,
      phase: 'closure',
      skill: 'cycle',
      event_type: 'log',
      input_refs: [input.manifestPath],
      output_refs: [],
      message: 'closure.manifest-move-noop',
      metadata: { target: to, detail: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Closure step. Folds the reviewer outcome + the operator-merge
 * confirmation into the final cycle outcome and performs local↔remote
 * alignment on a confirmed merge.
 *
 * Reflection (in cycle.ts) fires iff `outcome === 'merged'` — which this
 * function returns ONLY when the PR is confirmed MERGED on the remote.
 */
export async function runClosure(
  input: CycleInput,
  logger: EventLogger,
  reviewerOutcome: ReviewerOutcome,
): Promise<ClosureResult> {
  const start = logger.emit({
    initiative_id: input.initiativeId,
    phase: 'closure',
    skill: 'cycle',
    event_type: 'start',
    input_refs: [input.worktreePath, input.manifestPath],
    output_refs: [],
    message: 'closure.start',
    metadata: { reviewer_outcome: reviewerOutcome },
  });

  // The reviewer only ever hands us `pr-open` when the review gate passed
  // AND the PR was created. Any other reviewer outcome (didn't converge,
  // PR creation failed, send-back cap) has no PR to confirm — closure
  // performs the single terminal move to `ready-for-review/` (the manifest
  // is still in `in-flight/`; the reviewer no longer moves it) and the
  // operator picks it up.
  if (reviewerOutcome !== 'pr-open') {
    terminalMove(input, logger, start.event_id, 'ready-for-review');
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'closure',
      skill: 'cycle',
      event_type: 'end',
      input_refs: [input.worktreePath],
      output_refs: [],
      message: 'closure.end',
      metadata: { outcome: reviewerOutcome, merged: false, reason: 'no PR to confirm' },
    });
    return { outcome: reviewerOutcome, merged: false };
  }

  // Capture the initiative branch identity NOW, before confirmMerge: in
  // production the operator merges on GitHub (the local worktree stays on
  // the initiative branch), but a bench operator-merge model may check out
  // main locally as a side effect — so resolving the branch after the
  // confirm would mis-identify it as `main`.
  const branch = initiativeBranch(input);

  // G10 / G1: the ONLY merge signal. Production default = `confirmPrMerged`
  // (`gh pr view --json state` == MERGED). Right after the PR is created
  // this is false (the operator has not merged yet) → the unattended cycle
  // ends at `pr-open` and reflection is skipped; a later re-trigger (the
  // operator-driven `/forge-review` path, Phase 7) re-checks and proceeds
  // once the PR is merged.
  const confirm = input.confirmMerge ?? confirmPrMerged;
  let merged = false;
  try {
    merged = await confirm(input.worktreePath);
  } catch (err) {
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'closure',
      skill: 'cycle',
      event_type: 'error',
      input_refs: [input.worktreePath],
      output_refs: [],
      message: 'closure.confirm-merge-threw',
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    merged = false;
  }

  if (!merged) {
    // Open / unconfirmed PR — the expected unattended terminal state until
    // the operator merges. Single terminal move: in-flight → ready-for-
    // review (flagged). Reflection is skipped (cycle.ts only reflects on a
    // confirmed merge).
    terminalMove(input, logger, start.event_id, 'ready-for-review');
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'closure',
      skill: 'cycle',
      event_type: 'log',
      input_refs: [input.worktreePath],
      output_refs: [],
      message: 'closure.pr-open-awaiting-operator',
      metadata: {
        outcome: 'pr-open',
        merged: false,
        note: 'PR not MERGED on remote — operator merges in GitHub to close the review phase; reflection deferred to confirmed merge',
      },
    });
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'closure',
      skill: 'cycle',
      event_type: 'end',
      input_refs: [input.worktreePath],
      output_refs: [],
      message: 'closure.end',
      metadata: { outcome: 'pr-open', merged: false },
    });
    return { outcome: 'pr-open', merged: false };
  }

  // Confirmed MERGED on the remote. Align local↔remote: fast-forward local
  // `main`, prune the initiative branch. `branch` was captured before the
  // confirm (a bench operator-merge may have checked out main); never
  // prune `main` itself.
  if (branch && branch !== 'main') {
    const align = alignLocalToRemote(input.worktreePath, branch, input.projectRepoPath);
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'closure',
      skill: 'cycle',
      event_type: 'log',
      input_refs: [input.worktreePath],
      output_refs: [],
      message: 'closure.local-aligned-to-remote',
      metadata: { branch, detail: align.detail },
    });
  } else {
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'closure',
      skill: 'cycle',
      event_type: 'log',
      input_refs: [input.worktreePath],
      output_refs: [],
      message: 'closure.align-skipped',
      metadata: {
        branch,
        note:
          branch === 'main'
            ? 'worktree already on main (operator-merge model ff-merged locally) — local already aligned'
            : 'detached HEAD or not a git repo — local alignment skipped',
      },
    });
  }

  // G1: `_queue/done/` ⇒ the PR is MERGED. The single terminal move to
  // done/ happens ONLY here (after a confirmed remote merge), never from
  // an orchestrator-internal flag and never from the reviewer.
  terminalMove(input, logger, start.event_id, 'done');

  logger.emit({
    initiative_id: input.initiativeId,
    parent_event_id: start.event_id,
    phase: 'closure',
    skill: 'cycle',
    event_type: 'end',
    input_refs: [input.worktreePath],
    output_refs: [],
    message: 'closure.end',
    metadata: { outcome: 'merged', merged: true },
  });
  return { outcome: 'merged', merged: true };
}
