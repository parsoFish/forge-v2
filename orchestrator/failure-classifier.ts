/**
 * F-27: post-cycle failure-mode classification.
 *
 * Scans a cycle's event log after a `failed` terminal status and classifies
 * the root cause into a known mode. Each mode declares whether it's
 * auto-recoverable (the scheduler may retry) or terminal (needs human
 * intervention). The result feeds two consumers:
 *
 *   - The orchestrator emits a `failure_classification` event to the log so
 *     post-mortems answer "why did this fail" without grepping ten places.
 *   - The scheduler reads the most recent classification when deciding
 *     whether to auto-retry an initiative or leave it in failed/.
 *
 * The classifier is best-effort: an unrecognised failure becomes
 * `mode: 'unknown'`, `recoverable: false`. We err on the side of NOT
 * retrying when uncertain — better to surface a stuck initiative than to
 * burn budget retrying an unfixable manifest.
 */

import type { EventLogEntry } from './logging.ts';

export type FailureMode =
  | 'trivial-pass'              // Ralph completed with iterations=0 — gate was passing before any work
  | 'brain-skipped'             // agent never read brain/ — F-13 gate (architect / PM only post-F-34)
  | 'pm-stale-context'          // PM emitted WIs with the wrong initiative_id (legacy bug, gitignore-fixed)
  | 'pm-budget-exhausted'       // PM phase hit its USD cap
  | 'pm-hallucinated-paths'     // F-36: PM emitted files_in_scope paths that don't exist + aren't being created
  | 'gate-missing-script'       // npm run X failed with "missing script: X"
  | 'worktree-no-deps'          // gate stderr matched "Cannot find module" / module-resolution
  | 'agent-rate-limited'        // SDK threw rate_limit_error
  | 'agent-threw'               // generic agent throw caught by runRalph
  | 'dev-loop-total-failure'    // 0/N work items completed
  | 'review-failed'             // reviewer-Ralph failed
  | 'unknown';

export type FailureClassification = {
  mode: FailureMode;
  recoverable: boolean;
  recommendation: string;
  /** Up to 5 event_ids whose content drove the classification — for grep-ability. */
  evidence_event_ids: string[];
};

/**
 * Modes the scheduler may auto-retry. The `recoverable: true` cases assume:
 *   - the failure is transient (rate-limit, brain-skipped fluke), OR
 *   - a load-bearing fix has just landed (trivial-pass after the F-26 guard).
 *
 * Anything not in this set requires manifest amendment or human review.
 */
const RECOVERABLE_MODES = new Set<FailureMode>([
  'trivial-pass',
  'brain-skipped',
  'agent-rate-limited',
  'pm-hallucinated-paths',
]);

const RECOMMENDATIONS: Record<FailureMode, string> = {
  'trivial-pass':
    'Gate passed before any agent work. After F-26 the runner forces ≥1 iteration; auto-retry is safe.',
  'brain-skipped':
    'Agent skipped brain/ reads. Often a one-off; auto-retry once. Persistent skips suggest a system-prompt regression — escalate after retry exhausts.',
  'pm-stale-context':
    'PM emitted WIs with wrong initiative_id (legacy bug). Gitignore + rmSync should prevent recurrence; if seen again, investigate worktree pollution.',
  'pm-budget-exhausted':
    'PM phase hit its USD cap before producing valid WIs. Increase iteration_budget / cost_budget_usd in the manifest.',
  'pm-hallucinated-paths':
    'PM emitted files_in_scope paths that don\'t exist in the worktree and aren\'t being created by any acceptance criterion. Auto-retry with the F-35 mandatory Glob enumeration; the second attempt should anchor on real paths. Persistent fabrication after retry signals a deeper prompt issue — surface for human review.',
  'gate-missing-script':
    'quality_gate_cmd referenced an npm script that does not exist in the project. Manifest bug — fix the script name; auto-retry will not help.',
  'worktree-no-deps':
    'Gate failed at module resolution — node_modules missing in worktree. F-24 symlink should prevent this; if seen, check that prepareDevWorkspace ran.',
  'agent-rate-limited':
    'Anthropic SDK rate-limited the call. Auto-retry with backoff is appropriate.',
  'agent-threw':
    'Agent invocation threw a non-rate-limit error. Investigate the exception before retrying.',
  'dev-loop-total-failure':
    '0/N work items completed. Often an upstream failure (PM emitted unsolvable WIs, gate is wrong). Examine per-WI events before retrying.',
  'review-failed':
    'Reviewer-Ralph failed to converge. Check verdict file or the reviewer’s last assistant text; manual verdict via `forge review <id>` is the usual recovery.',
  unknown:
    'Failure mode could not be classified. Read events.jsonl manually and either amend the manifest or escalate.',
};

/**
 * Walk a cycle's event log and classify the failure. Caller passes only
 * events from a single cycle (typically the result of reading
 * `_logs/<cycle-id>/events.jsonl` line-by-line + JSON.parse).
 *
 * Order of checks matters: more specific patterns are checked before
 * generic ones. Returns `mode: 'unknown'` if no signature matches.
 */
export function classifyCycleFailure(events: readonly EventLogEntry[]): FailureClassification {
  const evidence: string[] = [];
  const pushEvidence = (ev: EventLogEntry): void => {
    if (evidence.length < 5) evidence.push(ev.event_id);
  };

  // Scan once, collecting signals into named buckets. A single pass keeps
  // the classifier O(n) over event count and makes the order-dependence
  // explicit at the bottom (the if/else chain that picks a winner).
  let trivialPass = false;
  let brainSkipped = false;
  let pmStaleContext = false;
  let pmBudgetExhausted = false;
  let pmHallucinatedPaths = false;
  let gateMissingScript = false;
  let worktreeNoDeps = false;
  let rateLimited = false;
  let agentThrew = false;
  let devLoopTotalFailure = false;
  let reviewFailed = false;

  for (const e of events) {
    const md = (e.metadata ?? {}) as Record<string, unknown>;
    const msg = e.message ?? '';

    // trivial-pass: ralph.end with status=failed, iterations=0, reason=quality-gates-pass.
    if (
      msg === 'ralph.end' &&
      md.status === 'failed' &&
      (md.iterations === 0 || md.iterations === undefined) &&
      md.stop_reason === 'quality-gates-pass'
    ) {
      trivialPass = true;
      pushEvidence(e);
    }

    // brain-skipped: explicit error from F-13 gate.
    if (e.event_type === 'error' && (msg.includes('brain-skipped') || msg.includes('brain-first mandate'))) {
      brainSkipped = true;
      pushEvidence(e);
    }

    // pm-stale-context: PM phase end with per-item validation errors AND
    // metadata indicates set_errors that mention initiative_id mismatch.
    if (
      e.phase === 'project-manager' &&
      e.event_type === 'error' &&
      Array.isArray(md.set_errors) &&
      md.set_errors.some((s) => typeof s === 'string' && s.toLowerCase().includes('initiative_id'))
    ) {
      pmStaleContext = true;
      pushEvidence(e);
    }

    // pm-budget-exhausted: PM result_subtype.
    if (e.phase === 'project-manager' && md.result_subtype === 'error_max_budget_usd') {
      pmBudgetExhausted = true;
      pushEvidence(e);
    }

    // F-36 pm-hallucinated-paths: PM end event carries non-empty fabricated_paths.
    if (
      e.phase === 'project-manager' &&
      e.event_type === 'error' &&
      Array.isArray(md.fabricated_paths) &&
      md.fabricated_paths.length > 0
    ) {
      pmHallucinatedPaths = true;
      pushEvidence(e);
    }

    // gate-missing-script / worktree-no-deps: read gate.fail event stderr_tail.
    if (msg === 'gate.fail') {
      const stderr = typeof md.gate_stderr_tail === 'string' ? md.gate_stderr_tail : '';
      const stdout = typeof md.gate_stdout_tail === 'string' ? md.gate_stdout_tail : '';
      const blob = (stderr + ' ' + stdout).toLowerCase();
      if (blob.includes('missing script')) {
        gateMissingScript = true;
        pushEvidence(e);
      }
      if (blob.includes('cannot find module') || blob.includes('module not found')) {
        worktreeNoDeps = true;
        pushEvidence(e);
      }
    }

    // agent-rate-limited / agent-threw.
    if (e.event_type === 'error') {
      const blob = (msg + ' ' + JSON.stringify(md)).toLowerCase();
      if (blob.includes('rate_limit') || blob.includes('rate-limit') || blob.includes('429')) {
        rateLimited = true;
        pushEvidence(e);
      }
      if (msg.includes('agent_threw') || md.kind === 'agent_threw') {
        agentThrew = true;
        pushEvidence(e);
      }
    }

    // dev-loop-total-failure / review-failed: orchestrator-level errors.
    if (e.phase === 'orchestrator' && e.event_type === 'error') {
      if (msg.includes('developer-loop') && msg.includes('total failure')) {
        devLoopTotalFailure = true;
        pushEvidence(e);
      }
      if (msg.includes('review') && msg.includes('failed')) {
        reviewFailed = true;
        pushEvidence(e);
      }
    }
  }

  // Specific patterns first; broader patterns last. The scheduler reads only
  // `mode` + `recoverable`, so picking the most actionable mode matters more
  // than the most-recent failure.
  let mode: FailureMode;
  if (gateMissingScript) mode = 'gate-missing-script';
  else if (worktreeNoDeps) mode = 'worktree-no-deps';
  else if (pmStaleContext) mode = 'pm-stale-context';
  else if (pmHallucinatedPaths) mode = 'pm-hallucinated-paths';
  else if (pmBudgetExhausted) mode = 'pm-budget-exhausted';
  else if (trivialPass) mode = 'trivial-pass';
  else if (brainSkipped) mode = 'brain-skipped';
  else if (rateLimited) mode = 'agent-rate-limited';
  else if (agentThrew) mode = 'agent-threw';
  else if (devLoopTotalFailure) mode = 'dev-loop-total-failure';
  else if (reviewFailed) mode = 'review-failed';
  else mode = 'unknown';

  return {
    mode,
    recoverable: RECOVERABLE_MODES.has(mode),
    recommendation: RECOMMENDATIONS[mode],
    evidence_event_ids: evidence,
  };
}
