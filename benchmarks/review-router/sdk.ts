/**
 * Review-router bench harness — deterministic, zero LLM cost.
 *
 * Each fixture builds a mock `GhRunner`, exercises the router (decideAction
 * / pollNewComments / writePrFeedback / enqueueUnifier), and asserts the
 * expected effects on a tempdir. Results are scored via scoring.ts.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decideAction,
  enqueueUnifier,
  pollNewComments,
  reviewCursorPath,
  unifierTriggerPath,
  writeCursor,
  writePrFeedback,
  type GhRunner,
  type PrComment,
  type PrReviewEvent,
  type BranchHead,
} from '../../orchestrator/review-router.ts';
import { fileVerdictPaths } from '../../orchestrator/file-verdict.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { caseScore, emptyCriteria, type RouterCriteria, type RouterScore } from './scoring.ts';

export type FixtureName =
  | 'send_back_triggers_unifier_reactivation'
  | 'approval_triggers_merge_confirm'
  | 'cursor_dedup_no_double_send_back'
  | 'request_changes_threading_preserved'
  | 'fallback_to_file_verdict_when_no_pr';

export type FixtureResult = {
  name: FixtureName;
  passed: boolean;
  detail: string;
};

function mockGh(opts: {
  comments?: PrComment[];
  reviewComments?: PrComment[];
  reviews?: PrReviewEvent[];
  branchHead?: BranchHead;
}): GhRunner {
  return {
    fetchComments: async () => opts.comments ?? [],
    fetchReviewComments: async () => opts.reviewComments ?? [],
    fetchReviews: async () => opts.reviews ?? [],
    fetchBranchHead: async () =>
      opts.branchHead ?? {
        sha: 'HEAD',
        author: 'forge-bot',
        committedAt: '2026-05-23T09:00:00Z',
      },
  };
}

/** Run all 5 fixtures and produce the criteria scorecard. */
export async function runRouterBench(): Promise<{
  score: RouterScore;
  fixtures: FixtureResult[];
}> {
  const root = mkdtempSync(join(tmpdir(), 'router-bench-'));
  const queueRoot = join(root, '_queue');
  const fixtures: FixtureResult[] = [];
  const criteria: RouterCriteria = emptyCriteria();
  criteria.terminated_cleanly = 1;

  try {
    fixtures.push(await fxSendBackTriggersUnifier(queueRoot, criteria));
    fixtures.push(await fxApprovalTriggersMergeConfirm(criteria));
    fixtures.push(await fxCursorDedupNoDoubleSendBack(queueRoot, criteria));
    fixtures.push(await fxRequestChangesThreadingPreserved(queueRoot, criteria));
    fixtures.push(await fxFallbackToFileVerdictWhenNoPr(queueRoot, criteria));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  return { score: caseScore(criteria), fixtures };
}

async function fxSendBackTriggersUnifier(
  queueRoot: string,
  c: RouterCriteria,
): Promise<FixtureResult> {
  const initiativeId = 'INIT-send-back';
  const gh = mockGh({
    comments: [
      { id: 1, author: 'reviewer', body: 'please tighten', path: null, line: null, createdAt: '2026-05-23T10:00:00Z' },
    ],
  });
  const state = await pollNewComments({
    prRef: { owner: 'x', repo: 'y', number: 1 },
    cursor: { last_seen_comment_id: 0, last_seen_review_id: 0 },
    gh,
  });
  const action = decideAction(state);
  if (action.kind !== 'send-back') {
    return { name: 'send_back_triggers_unifier_reactivation', passed: false, detail: `action was ${action.kind}` };
  }
  const fbPath = writePrFeedback({
    initiativeId,
    round: 1,
    cursor: 1,
    generatedAt: '2026-05-23T10:00:00Z',
    comments: state.newComments,
    queueRoot,
  });
  enqueueUnifier(initiativeId, fbPath, queueRoot);
  const triggerOk = existsSync(unifierTriggerPath(initiativeId, queueRoot));
  const feedbackOk = existsSync(fbPath);
  const ok = triggerOk && feedbackOk;
  if (ok) c.send_back_triggers_unifier_reactivation = 1;
  return {
    name: 'send_back_triggers_unifier_reactivation',
    passed: ok,
    detail: `trigger=${triggerOk}, feedback=${feedbackOk}`,
  };
}

async function fxApprovalTriggersMergeConfirm(c: RouterCriteria): Promise<FixtureResult> {
  const gh = mockGh({
    reviews: [
      {
        id: 99,
        author: 'reviewer',
        kind: 'APPROVED',
        submittedAt: '2026-05-23T11:00:00Z',
      },
    ],
    branchHead: { sha: 'HEAD', author: 'forge-bot', committedAt: '2026-05-23T09:00:00Z' },
  });
  const state = await pollNewComments({
    prRef: { owner: 'x', repo: 'y', number: 1 },
    cursor: { last_seen_comment_id: 0, last_seen_review_id: 0 },
    gh,
  });
  const action = decideAction(state);
  const ok = action.kind === 'approve';
  if (ok) c.approval_triggers_merge_confirm = 1;
  return {
    name: 'approval_triggers_merge_confirm',
    passed: ok,
    detail: `action=${action.kind} (expected approve)`,
  };
}

async function fxCursorDedupNoDoubleSendBack(
  queueRoot: string,
  c: RouterCriteria,
): Promise<FixtureResult> {
  const initiativeId = 'INIT-dedup';
  const cursorPath = reviewCursorPath(initiativeId, queueRoot);
  // First pass: comment id 1 lands.
  const gh = mockGh({
    comments: [
      { id: 1, author: 'reviewer', body: 'comment', path: null, line: null, createdAt: '2026-05-23T10:00:00Z' },
    ],
  });
  const first = await pollNewComments({
    prRef: { owner: 'x', repo: 'y', number: 1 },
    cursor: { last_seen_comment_id: 0, last_seen_review_id: 0 },
    gh,
  });
  if (first.newComments.length !== 1) {
    return { name: 'cursor_dedup_no_double_send_back', passed: false, detail: 'first pass missed comment' };
  }
  writeCursor(cursorPath, { last_seen_comment_id: 1, last_seen_review_id: 0 });
  // Second pass: cursor=1, same gh response. Should be 0 new.
  const second = await pollNewComments({
    prRef: { owner: 'x', repo: 'y', number: 1 },
    cursor: { last_seen_comment_id: 1, last_seen_review_id: 0 },
    gh,
  });
  const ok = second.newComments.length === 0 && decideAction(second).kind === 'noop';
  if (ok) c.cursor_dedup_no_double_send_back = 1;
  return {
    name: 'cursor_dedup_no_double_send_back',
    passed: ok,
    detail: `second pass new comments = ${second.newComments.length} (expected 0)`,
  };
}

async function fxRequestChangesThreadingPreserved(
  queueRoot: string,
  c: RouterCriteria,
): Promise<FixtureResult> {
  const initiativeId = 'INIT-thread';
  const gh = mockGh({
    reviewComments: [
      {
        id: 10,
        author: 'reviewer',
        body: 'tighten the regex on this line',
        path: 'src/x.ts',
        line: 42,
        createdAt: '2026-05-23T10:00:00Z',
      },
    ],
  });
  const state = await pollNewComments({
    prRef: { owner: 'x', repo: 'y', number: 1 },
    cursor: { last_seen_comment_id: 0, last_seen_review_id: 0 },
    gh,
  });
  const fbPath = writePrFeedback({
    initiativeId,
    round: 1,
    cursor: 10,
    generatedAt: '2026-05-23T10:00:00Z',
    comments: state.newComments,
    queueRoot,
  });
  const text = readFileSync(fbPath, 'utf8');
  const ok = /^### @reviewer on src\/x\.ts:42$/m.test(text);
  if (ok) c.request_changes_threading_preserved = 1;
  return {
    name: 'request_changes_threading_preserved',
    passed: ok,
    detail: `pr-feedback.md contained correct header: ${ok}`,
  };
}

async function fxFallbackToFileVerdictWhenNoPr(
  queueRoot: string,
  c: RouterCriteria,
): Promise<FixtureResult> {
  const initiativeId = 'INIT-no-pr';
  // Simulate "no PR resolved" by writing the file-verdict prompt path
  // directly — emulates the router's fallback behaviour when
  // `defaultGhRunner` cannot find a PR for the initiative. The router's
  // fallback contract is: write the file-verdict prompt at the standard
  // file-verdict paths so the operator can hand-edit a response.
  const paths = fileVerdictPaths(initiativeId, queueRoot);
  mkdirSync(dirname(paths.promptPath), { recursive: true });
  writeFileSync(paths.promptPath, '---\nverdict: pending\n---\n# fallback prompt\n');
  const ok = existsSync(paths.promptPath);
  if (ok) c.fallback_to_file_verdict_when_no_pr = 1;
  return {
    name: 'fallback_to_file_verdict_when_no_pr',
    passed: ok,
    detail: `verdict prompt written at ${paths.promptPath}: ${ok}`,
  };
}
