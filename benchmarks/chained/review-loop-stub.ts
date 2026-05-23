/**
 * S4 stub: the original `benchmarks/review-loop/scoring.ts` was deleted as
 * part of S4 (the Ralph reviewer surface was removed and review-phase
 * authoring moved to the dev-loop unifier). The chained bench's review-phase
 * scoring used to call `caseScore` from there; this stub provides the
 * minimal shape so the chained bench typechecks. Post-S5 the chained bench's
 * review-phase row should be replaced with the unifier criteria from
 * `benchmarks/developer-loop/scoring.ts` (see S4-DECISIONS.md item 10).
 *
 * For S4 the stub returns a passing score iff the orchestrator's merge
 * actually happened (`qualityGatesPassed: artifacts.merged` already gates
 * the upstream gate); other criteria collapse to 1 when the merge landed,
 * 0 otherwise.
 */

import type { WorkItem } from '../../orchestrator/work-item.ts';

export type ReviewExpected = {
  project_type: 'browser' | 'cli' | 'lib' | 'rest';
  quality_gate_cmd: string[];
  is_stacked_pr: boolean;
  min_recording_bytes?: number;
  min_pr_body_chars?: number;
  min_why_chars?: number;
};

export type ReviewScoreInput = {
  worktreePath: string;
  initiativeId: string;
  workItems: WorkItem[];
  expected: ReviewExpected;
  qualityGatesPassed: boolean;
};

export type ReviewScore = {
  score: number;
  passed: boolean;
  criteria: Record<string, number>;
};

export const PASS_THRESHOLD = 0.7;

export function caseScore(input: ReviewScoreInput): ReviewScore {
  const ok = input.qualityGatesPassed ? 1 : 0;
  // Single criterion: did the merge actually land. Post-S5 this should be
  // replaced with the unifier criteria (initiative_gate_passed, demo_present,
  // demo_runs_clean, pr_self_contained, branches_in_sync).
  return {
    score: ok,
    passed: ok >= PASS_THRESHOLD,
    criteria: { merged: ok },
  };
}
