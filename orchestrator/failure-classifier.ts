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
  | 'pm-budget-exhausted'       // PM phase hit its USD cap
  | 'pm-hidden-coupling'        // F-43: two WIs share files_in_scope with no depends_on edge between them
  | 'pm-invalid-work-items'     // F-45: PM emitted ≥1 work item that failed per-item schema validation
  | 'pm-thrash-no-converge'     // 2026-05-18: PM hit a turn/$ cap AND produced degenerate WIs — never converged (often a stale brain contradicting the code, or an ambiguous manifest). NOT auto-retryable.
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
  'pm-hidden-coupling',
  'pm-invalid-work-items',
]);

const RECOMMENDATIONS: Record<FailureMode, string> = {
  'trivial-pass':
    'Gate passed before any agent work. After F-26 the runner forces ≥1 iteration; auto-retry is safe.',
  'brain-skipped':
    'Agent skipped brain/ reads. Often a one-off; auto-retry once. Persistent skips suggest a system-prompt regression — escalate after retry exhausts.',
  'pm-budget-exhausted':
    'PM phase hit its USD cap before producing valid WIs. Increase iteration_budget / cost_budget_usd in the manifest.',
  'pm-hidden-coupling':
    'Two or more WIs share files_in_scope without a depends_on edge between them — they would conflict at merge time. PM correctly identified the decomposition shape but forgot to serialise siblings that touch the same file. Auto-retry; the PM prompt explicitly covers this rule and the retry usually adds the missing edge.',
  'pm-invalid-work-items':
    'The PM emitted one or more work items that failed per-item schema validation (missing/malformed acceptance_criteria, files_in_scope, depends_on, ids, etc.). This is a stochastic generation slip, not a manifest defect — the manifest and PM prompt are valid, the model just produced one bad item this pass. Re-running the PM is exactly the right recovery (identical in spirit to pm-hidden-coupling): the next pass almost always emits a clean set. Auto-retry.',
  'pm-thrash-no-converge':
    'The PM exhausted its turn/$ cap AND the work items it did emit are degenerate (hidden coupling / schema-invalid). It never converged — this is NOT a "forgot one depends_on edge" slip and a blind auto-retry will burn the retry budget down to terminal failed/ on the same root cause. Most common cause: the project brain contradicts the current code (a by-hand change that skipped the reflection phase left a theme citing deleted/renamed files), so the PM reads the brain, then Globs the tree, hits an irreconcilable contradiction, and thrashes. Second cause: the manifest is too long/ambiguous. Do NOT auto-retry. Recover by: (1) `forge preflight <project>` — read the brain-staleness WARN and correct any theme whose cited source paths no longer exist; (2) sharpen the manifest to be terse and file-scoped; then re-queue.',
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
  let pmBudgetExhausted = false;
  let pmHiddenCoupling = false;
  let pmInvalidWorkItems = false;
  // 2026-05-18: PM hit a hard turn/$ cap (error_max_turns | error_max_budget_usd).
  let pmCapped = false;
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

    // pm-budget-exhausted: PM result_subtype.
    if (e.phase === 'project-manager' && md.result_subtype === 'error_max_budget_usd') {
      pmBudgetExhausted = true;
      pushEvidence(e);
    }

    // pm-thrash signal: PM hit a hard turn OR $ cap. On its own this is a
    // budget bump; combined with degenerate output (hidden coupling /
    // invalid items) in the SAME failure it means the PM never converged —
    // most often because the brain contradicts the code (a by-hand change
    // that skipped reflection left a theme stale) or the manifest is
    // ambiguous. That co-occurrence must NOT be auto-retried with the
    // "add the missing edge" advice (it would burn retries to terminal).
    if (
      e.phase === 'project-manager' &&
      (md.result_subtype === 'error_max_turns' || md.result_subtype === 'error_max_budget_usd')
    ) {
      pmCapped = true;
      pushEvidence(e);
    }

    // F-43 pm-hidden-coupling: PM end event carries non-empty hidden_coupling_violations.
    if (
      e.phase === 'project-manager' &&
      e.event_type === 'error' &&
      Array.isArray(md.hidden_coupling_violations) &&
      md.hidden_coupling_violations.length > 0
    ) {
      pmHiddenCoupling = true;
      pushEvidence(e);
    }

    // F-45 pm-invalid-work-items: the PM phase error event carries a
    // positive per_item_error_count (runProjectManager emits this on the
    // project-manager error event and throws
    // `project-manager phase failed: ... N per-item validation errors`).
    // One schema-invalid item is a stochastic generation slip — re-running
    // the PM is the right recovery (same shape as pm-hidden-coupling).
    if (
      e.phase === 'project-manager' &&
      e.event_type === 'error' &&
      typeof md.per_item_error_count === 'number' &&
      md.per_item_error_count > 0
    ) {
      pmInvalidWorkItems = true;
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
  // Thrash signature (capped AND degenerate output) is MORE specific than
  // bare hidden-coupling / invalid-items / budget — check it first so the
  // operator gets the reconcile-brain advice, not the misleading
  // "add the missing edge / auto-retry" guidance.
  else if (pmCapped && (pmHiddenCoupling || pmInvalidWorkItems)) mode = 'pm-thrash-no-converge';
  else if (pmHiddenCoupling) mode = 'pm-hidden-coupling';
  else if (pmInvalidWorkItems) mode = 'pm-invalid-work-items';
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
