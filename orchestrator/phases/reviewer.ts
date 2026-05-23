/**
 * Review-loop phase runner — POST-S4 minimal surface.
 *
 * The reviewer no longer authors anything: the dev-loop unifier (run inside
 * `runDeveloperLoop`) already produced the tracked demo, the PR description
 * draft, and a pushable branch. The review phase's only job is to open the
 * PR and wait for the operator's verdict.
 *
 * On verdict:
 *   - approve → outcome `pr-open`; closure decides `merged` from a real
 *               GitHub-confirmed merge (G10 / G1, unchanged).
 *   - send-back → the new `review-router` writes `pr-feedback.md` (C3a)
 *                 and the next cycle invocation runs the unifier in
 *                 send-back mode via `unifierFeedbackRef` (C3b).
 *
 * For an unattended cycle whose verdict-provider is `makeFileVerdict`, the
 * cycle simply exits at `ready-for-review` after PR open and waits for the
 * operator's nudge (`/forge-review <id>`); the router resumes the dev-loop
 * unifier with the new feedback.
 */

import { resolve } from 'node:path';

import type { EventLogger } from '../logging.ts';
import { openPullRequest } from '../pr.ts';
import type { CycleInput, ReviewerOutcome } from '../cycle-context.ts';

export async function runReviewer(input: CycleInput, logger: EventLogger): Promise<ReviewerOutcome> {
  const start = logger.emit({
    initiative_id: input.initiativeId,
    phase: 'review-loop',
    skill: 'review-router',
    event_type: 'start',
    input_refs: [input.worktreePath, input.manifestPath],
    output_refs: [],
  });

  // The dev-loop unifier authored .forge/pr-description.md; use it.
  // S4 precondition: openPullRequest asserts the tracked demo bundle exists
  // (assertTrackedDemoExists). A missing demo means the unifier failed —
  // classified upstream as dev-loop-unifier-demo-failed.
  const prDescriptionPath = resolve(input.worktreePath, '.forge', 'pr-description.md');
  const prTitle = `forge: ${input.initiativeId}`;
  const prUrl = openPullRequest(input.worktreePath, prDescriptionPath, prTitle);

  logger.emit({
    initiative_id: input.initiativeId,
    parent_event_id: start.event_id,
    phase: 'review-loop',
    skill: 'review-router',
    event_type: prUrl ? 'log' : 'error',
    input_refs: [prDescriptionPath],
    output_refs: prUrl ? [prUrl] : [],
    message: prUrl ? 'reviewer.pr-opened' : 'reviewer.pr-open-failed',
    metadata: { url: prUrl, pr_created: prUrl !== null },
  });

  // Post-S4: no Ralph, no verdict gate, no send-back loop here. The router
  // is invoked separately via /forge-review (operator-initiated). The
  // outcome is simply pr-open (success) or ready-for-review (PR open failed).
  const outcome: ReviewerOutcome = prUrl ? 'pr-open' : 'ready-for-review';

  logger.emit({
    initiative_id: input.initiativeId,
    parent_event_id: start.event_id,
    phase: 'review-loop',
    skill: 'review-router',
    event_type: 'end',
    input_refs: [input.worktreePath],
    output_refs: prUrl ? [prUrl] : [input.worktreePath],
    metadata: { outcome, pr_url: prUrl },
  });

  return outcome;
}
