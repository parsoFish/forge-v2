/**
 * Post-cycle failure classification — `transient | terminal` only.
 *
 * Collapsed from a 14-mode taxonomy on 2026-05-24 (rebuild-review §3 #8).
 * The retry-count cap is the only thing bounding repeats; the per-mode
 * recommendation table + anti-thrash guard were future-proofing that
 * wasn't earning its keep. Defaults to `terminal` when no signature
 * matches — better to surface an unrecognised failure than to auto-retry
 * into the same hole.
 */

import type { EventLogEntry } from './logging.ts';

export type FailureKind = 'transient' | 'terminal';

export type FailureClassification = {
  kind: FailureKind;
  reason: string;
  /** Convenience: true iff kind === 'transient'. Scheduler reads this. */
  recoverable: boolean;
  /** Up to 5 event_ids whose content drove the classification. */
  evidence_event_ids: string[];
};

const T = (kind: FailureKind, reason: string, evidence: string[]): FailureClassification => ({
  kind, reason, recoverable: kind === 'transient', evidence_event_ids: evidence,
});

export function classifyCycleFailure(events: readonly EventLogEntry[]): FailureClassification {
  const evidence: string[] = [];
  const ev = (e: EventLogEntry): void => { if (evidence.length < 5) evidence.push(e.event_id); };

  let trivialPass = false, brainSkipped = false, rateLimited = false;
  let pmHiddenCoupling = false, pmInvalidWorkItems = false, pmCapped = false;
  let pmBudgetExhausted = false, pmFeatureHallucination = false;
  let gateMissingScript = false, worktreeNoDeps = false;
  let agentThrew = false, devLoopTotalFailure = false, reviewFailed = false;
  let unifierNoDemo = false;

  for (const e of events) {
    const md = (e.metadata ?? {}) as Record<string, unknown>;
    const msg = e.message ?? '';
    const pmErr = e.phase === 'project-manager' && e.event_type === 'error';

    if (msg === 'ralph.end' && md.status === 'failed' && (md.iterations === 0 || md.iterations === undefined) && md.stop_reason === 'quality-gates-pass') { trivialPass = true; ev(e); }
    if (e.event_type === 'error' && (msg.includes('brain-skipped') || msg.includes('brain-first mandate'))) { brainSkipped = true; ev(e); }
    if (e.phase === 'project-manager' && (md.result_subtype === 'error_max_turns' || md.result_subtype === 'error_max_budget_usd')) {
      pmCapped = true;
      if (md.result_subtype === 'error_max_budget_usd') pmBudgetExhausted = true;
      ev(e);
    }
    if (pmErr && Array.isArray(md.hidden_coupling_violations) && md.hidden_coupling_violations.length > 0) { pmHiddenCoupling = true; ev(e); }
    if (pmErr && typeof md.per_item_error_count === 'number' && md.per_item_error_count > 0) { pmInvalidWorkItems = true; ev(e); }
    if (e.phase === 'project-manager' && e.message === 'pm.feature-hallucination') { pmFeatureHallucination = true; ev(e); }
    if (msg === 'gate.fail') {
      const blob = (String(md.gate_stderr_tail ?? '') + ' ' + String(md.gate_stdout_tail ?? '')).toLowerCase();
      if (blob.includes('missing script')) { gateMissingScript = true; ev(e); }
      if (blob.includes('cannot find module') || blob.includes('module not found')) { worktreeNoDeps = true; ev(e); }
    }
    if (e.event_type === 'error') {
      const blob = (msg + ' ' + JSON.stringify(md)).toLowerCase();
      if (blob.includes('rate_limit') || blob.includes('rate-limit') || blob.includes('429')) { rateLimited = true; ev(e); }
      if (msg.includes('agent_threw') || md.kind === 'agent_threw') { agentThrew = true; ev(e); }
    }
    if (e.phase === 'orchestrator' && e.event_type === 'error') {
      if (msg.includes('developer-loop') && msg.includes('total failure')) { devLoopTotalFailure = true; ev(e); }
      // F1.I1: distinguish unifier-no-demo from generic reviewer failure.
      // Order matters — check the more specific signature first.
      if (msg.includes('reviewer.pr-open-failed') || msg.includes('DEMO.md') || msg.includes('pr-description.md')) {
        unifierNoDemo = true; ev(e);
      } else if (msg.includes('review') && msg.includes('failed')) {
        reviewFailed = true; ev(e);
      }
    }
  }

  // Terminal first — manifest/env/code defects auto-retry can't fix.
  if (gateMissingScript) return T('terminal', 'gate referenced a missing npm script', evidence);
  if (worktreeNoDeps) return T('terminal', 'gate failed at module resolution — worktree missing deps', evidence);
  if (pmFeatureHallucination) return T('terminal', 'PM emitted a feature_id not in the manifest', evidence);
  if (pmCapped && (pmHiddenCoupling || pmInvalidWorkItems)) return T('terminal', 'PM hit cap AND produced degenerate WIs — never converged', evidence);
  if (pmBudgetExhausted) return T('terminal', 'PM exhausted its budget cap', evidence);
  if (agentThrew) return T('terminal', 'agent threw a non-rate-limit error', evidence);
  if (devLoopTotalFailure) return T('terminal', 'dev-loop completed 0/N work items', evidence);
  if (unifierNoDemo) return T('terminal', 'unifier did not author the PR — DEMO.md / pr-description.md missing because dev-loop WIs failed to produce their declared paths', evidence);
  if (reviewFailed) return T('terminal', 'reviewer-Ralph failed to converge', evidence);

  // Transient — auto-retry within MAX_AUTO_RETRIES.
  if (rateLimited) return T('transient', 'agent rate-limited', evidence);
  if (pmHiddenCoupling) return T('transient', 'PM emitted overlapping WIs (hidden coupling)', evidence);
  if (pmInvalidWorkItems) return T('transient', 'PM emitted schema-invalid WIs', evidence);
  if (brainSkipped) return T('transient', 'agent skipped brain reads', evidence);
  if (trivialPass) return T('transient', 'gate passed before any iteration — F-26 forces ≥1 iteration on retry', evidence);

  return T('terminal', 'failure could not be classified — examine events.jsonl manually', evidence);
}
