/**
 * Pure scoring for the review-router bench. The router is deterministic
 * (no LLM); each fixture asserts a specific decideAction / write-effect
 * outcome against a hand-built `gh` mock.
 *
 * Criteria (all 0/1, equal weight, threshold 0.7):
 *   1. send_back_triggers_unifier_reactivation — given new comments, the
 *      router writes pr-feedback.md AND enqueues the unifier.
 *   2. approval_triggers_merge_confirm — given an APPROVED review newer
 *      than the last commit, the router calls confirmPrMerged (mocked).
 *   3. cursor_dedup_no_double_send_back — running twice with no new
 *      comments is a no-op (no second pr-feedback write).
 *   4. request_changes_threading_preserved — a path:line comment lands as
 *      "### @user on src/x.ts:42" in the pr-feedback.md.
 *   5. fallback_to_file_verdict_when_no_pr — when prRef() is null, the
 *      router writes the verdict-prompt file (file-verdict path) and
 *      emits a notification.
 *
 * Gate: `terminated_cleanly` (mirrors PM / dev-loop bench shape).
 */

export type RouterCriteria = {
  terminated_cleanly: 0 | 1;
  send_back_triggers_unifier_reactivation: 0 | 1;
  approval_triggers_merge_confirm: 0 | 1;
  cursor_dedup_no_double_send_back: 0 | 1;
  request_changes_threading_preserved: 0 | 1;
  fallback_to_file_verdict_when_no_pr: 0 | 1;
};

export type RouterScore = {
  score: number;
  passed: boolean;
  criteria: RouterCriteria;
};

export const PASS_THRESHOLD = 0.7;

// Equal weight: 5 criteria, each 0.20. Sum = 1.
export const WEIGHT_PER_CRITERION = 0.2;

export function caseScore(criteria: RouterCriteria): RouterScore {
  if (!criteria.terminated_cleanly) {
    return { score: 0, passed: false, criteria };
  }
  const score =
    WEIGHT_PER_CRITERION *
    (criteria.send_back_triggers_unifier_reactivation +
      criteria.approval_triggers_merge_confirm +
      criteria.cursor_dedup_no_double_send_back +
      criteria.request_changes_threading_preserved +
      criteria.fallback_to_file_verdict_when_no_pr);
  return {
    score,
    passed: score >= PASS_THRESHOLD,
    criteria,
  };
}

export function emptyCriteria(): RouterCriteria {
  return {
    terminated_cleanly: 0,
    send_back_triggers_unifier_reactivation: 0,
    approval_triggers_merge_confirm: 0,
    cursor_dedup_no_double_send_back: 0,
    request_changes_threading_preserved: 0,
    fallback_to_file_verdict_when_no_pr: 0,
  };
}
