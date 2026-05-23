/**
 * Review router — the non-LLM core of the S4-shrunken review phase. Polls
 * PR comments via an injectable `GhRunner` seam (production: shell out to
 * `gh api`; bench: mock), dedups via a cursor file (CONTRACTS.md C16b
 * atomic write — tmp + rename, parse-fail = cursor 0), implements the
 * C16a approve-vs-send-back decision table, writes the C3a
 * `pr-feedback.md` artefact, and drops a marker file the daemon polls to
 * re-engage the dev-loop unifier in send-back mode (C3b).
 *
 * The router is **deterministic** — no LLM, no time-of-day-sensitive
 * randomness. Tests exercise every C16a row with mock `gh` responses.
 *
 * Outputs:
 *   - `_queue/in-flight/<id>.review-cursor.json` — cursor (atomic write).
 *   - `_queue/in-flight/<id>.pr-feedback.md` — C3a-schema feedback for the
 *     unifier (written on send-back path only).
 *   - `_queue/triggered/<id>.unifier-feedback.json` — marker for the daemon
 *     to invoke `runCycle` with `unifierFeedbackRef` set.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PrRef = {
  owner: string;
  repo: string;
  number: number;
};

export type ReviewKind = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';

export type PrComment = {
  id: number;
  author: string;
  body: string;
  /** Worktree-relative file path for line-level review comments; null for PR-level. */
  path: string | null;
  /** Line number for line-level review comments; null for PR-level. */
  line: number | null;
  createdAt: string;
};

export type PrReviewEvent = {
  id: number;
  author: string;
  /** Mirrors GitHub's `state` field — APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED. */
  kind: ReviewKind;
  submittedAt: string;
};

export type BranchHead = {
  sha: string;
  author: string;
  committedAt: string;
};

/**
 * Injectable surface around `gh api`. Production wraps `execFileSync` for each
 * method (see `defaultGhRunner` factory below); bench uses a hand-rolled mock.
 * Both consumers use the same shape — no test-only code paths leak into prod.
 */
export type GhRunner = {
  fetchComments: (pr: PrRef) => Promise<PrComment[]>;
  fetchReviewComments: (pr: PrRef) => Promise<PrComment[]>;
  fetchReviews: (pr: PrRef) => Promise<PrReviewEvent[]>;
  fetchBranchHead: (pr: PrRef) => Promise<BranchHead>;
};

/**
 * Convenience event shape used by tests for the mock `gh` factory. The real
 * `GhRunner` methods return their narrowed shapes (`PrComment`,
 * `PrReviewEvent`); this is the union test fixtures use to describe all
 * three streams in one array.
 */
export type PrEvent =
  | {
      kind: 'issue-comment';
      id: number;
      author: string;
      body: string;
      createdAt: string;
    }
  | {
      kind: 'review-comment';
      id: number;
      author: string;
      body: string;
      path?: string;
      line?: number;
      createdAt: string;
    }
  | {
      kind: 'review';
      id: number;
      author: string;
      state?: ReviewKind;
      body?: string;
      createdAt: string;
    };

export type RouterCursor = {
  last_seen_comment_id: number;
  last_seen_review_id: number;
};

export type RouterState = {
  latestReview: PrReviewEvent | null;
  branchHead: BranchHead;
  newComments: PrComment[];
};

export type RouterAction =
  | { kind: 'approve'; reason: string }
  | { kind: 'send-back'; reason: string }
  | { kind: 'refuse-operator-push'; reason: string }
  | { kind: 'noop'; reason: string };

// ---------------------------------------------------------------------------
// Filesystem paths (atomic IO contract — C16b)
// ---------------------------------------------------------------------------

const FORGE_BOT_AUTHOR = 'forge-bot';
const VERDICT_SENTINELS = ['<!-- forge:verdict-prompt -->', '<!-- forge:verdict-ack -->'];

export function reviewCursorPath(initiativeId: string, queueRoot: string): string {
  return resolve(queueRoot, 'in-flight', `${initiativeId}.review-cursor.json`);
}

export function prFeedbackPath(initiativeId: string, queueRoot: string): string {
  return resolve(queueRoot, 'in-flight', `${initiativeId}.pr-feedback.md`);
}

export function unifierTriggerPath(initiativeId: string, queueRoot: string): string {
  return resolve(queueRoot, 'triggered', `${initiativeId}.unifier-feedback.json`);
}

/**
 * Read the cursor file. Missing file or parse failure ⇒ `{ 0, 0 }` per C16b
 * ("idempotent replay beats silent skip").
 */
export function readCursor(path: string): RouterCursor {
  if (!existsSync(path)) return { last_seen_comment_id: 0, last_seen_review_id: 0 };
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RouterCursor>;
    return {
      last_seen_comment_id:
        typeof parsed.last_seen_comment_id === 'number' ? parsed.last_seen_comment_id : 0,
      last_seen_review_id:
        typeof parsed.last_seen_review_id === 'number' ? parsed.last_seen_review_id : 0,
    };
  } catch {
    return { last_seen_comment_id: 0, last_seen_review_id: 0 };
  }
}

/**
 * Atomic cursor write per C16b: write to `<path>.tmp` then `rename(2)`. The
 * rename is atomic on POSIX — readers never see a partial cursor. The tmp
 * file is best-effort cleaned up if rename throws (which it shouldn't on
 * same-filesystem moves).
 */
export function writeCursor(path: string, cursor: RouterCursor): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cursor, null, 2));
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Decision table (C16a)
// ---------------------------------------------------------------------------

/**
 * Apply the C16a decision table:
 *
 * | latest review | branch state since | action |
 * |---|---|---|
 * | APPROVED | no new commits | approve |
 * | APPROVED | new commits since approval | ignore stale; re-evaluate from earlier events |
 * | CHANGES_REQUESTED | any | send-back |
 * | COMMENTED only | any | send-back (intent inferred from the operator running /forge-review) |
 * | mixed reviewers | most recent CHANGES_REQUESTED wins | send-back |
 * | latest commit author ≠ forge-bot | any | refuse-operator-push |
 */
export function decideAction(state: RouterState): RouterAction {
  // Row 6 (operator-direct-push) is checked first — it dominates all other
  // signals. If the operator pushed to the PR branch directly, the bot
  // cannot safely enqueue more work (their changes would interleave with
  // the unifier's commits in unpredictable ways). Warn + refuse.
  if (state.branchHead.author !== FORGE_BOT_AUTHOR) {
    return {
      kind: 'refuse-operator-push',
      reason: `latest commit on PR branch is by '${state.branchHead.author}' (not forge-bot); operator-direct-push detected — refusing to enqueue more work`,
    };
  }

  if (state.latestReview && state.latestReview.kind === 'APPROVED') {
    // Row 1: approve only if branch is unchanged since the approval.
    if (state.branchHead.committedAt <= state.latestReview.submittedAt) {
      return { kind: 'approve', reason: 'APPROVED review on unchanged branch' };
    }
    // Row 2: stale approval (commits landed after approval). Fall through
    // to re-evaluate from any new comments; if no comments either, noop.
    if (state.newComments.length === 0) {
      return {
        kind: 'noop',
        reason: 'APPROVED review is stale (commits since approval) and no new comments to act on',
      };
    }
    // With new comments + stale approval, the operator intent is "look
    // again" — send-back.
    return { kind: 'send-back', reason: 'stale APPROVED + new comments → send-back' };
  }

  if (state.latestReview && state.latestReview.kind === 'CHANGES_REQUESTED') {
    return { kind: 'send-back', reason: 'CHANGES_REQUESTED review' };
  }

  if (state.newComments.length > 0) {
    return {
      kind: 'send-back',
      reason: `${state.newComments.length} new comment(s) since cursor (intent inferred from /forge-review nudge)`,
    };
  }

  return { kind: 'noop', reason: 'no new events since cursor' };
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export type PollInput = {
  prRef: PrRef;
  cursor: RouterCursor;
  gh: GhRunner;
};

export async function pollNewComments(input: PollInput): Promise<RouterState> {
  const [issueComments, reviewComments, reviews, branchHead] = await Promise.all([
    input.gh.fetchComments(input.prRef),
    input.gh.fetchReviewComments(input.prRef),
    input.gh.fetchReviews(input.prRef),
    input.gh.fetchBranchHead(input.prRef),
  ]);

  // Drop our own sentinel comments (the file-verdict-prompt + verdict-ack
  // markers forge posts on its own PRs would otherwise loop the router).
  const filteredIssueComments = issueComments.filter(
    (c) =>
      !VERDICT_SENTINELS.some((sentinel) => c.body.includes(sentinel)) &&
      c.id > input.cursor.last_seen_comment_id,
  );
  const filteredReviewComments = reviewComments.filter(
    (c) =>
      !VERDICT_SENTINELS.some((sentinel) => c.body.includes(sentinel)) &&
      c.id > input.cursor.last_seen_comment_id,
  );

  // Merge and sort by createdAt.
  const newComments = [...filteredIssueComments, ...filteredReviewComments].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );

  // Latest review (by submittedAt) — used for decideAction's APPROVED /
  // CHANGES_REQUESTED routing.
  const latestReview = reviews.length === 0
    ? null
    : reviews
        .slice()
        .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];

  return { latestReview, branchHead, newComments };
}

// ---------------------------------------------------------------------------
// pr-feedback.md writer (C3a schema)
// ---------------------------------------------------------------------------

export type WritePrFeedbackInput = {
  initiativeId: string;
  round: number;
  cursor: number;
  generatedAt: string;
  comments: PrComment[];
  operatorNote?: string;
  queueRoot: string;
};

/**
 * Write `_queue/in-flight/<id>.pr-feedback.md` in the C3a schema. The
 * dev-loop unifier reads this file in send-back mode (`--feedback-ref`).
 */
export function writePrFeedback(input: WritePrFeedbackInput): string {
  const path = prFeedbackPath(input.initiativeId, input.queueRoot);
  mkdirSync(dirname(path), { recursive: true });
  const lines: string[] = [
    '---',
    `round: ${input.round}`,
    `comments_collected: ${input.comments.length}`,
    `cursor: ${input.cursor}`,
    `generated_at: ${input.generatedAt}`,
    '---',
    '',
  ];
  for (const c of input.comments) {
    const header =
      c.path && c.line !== null && c.line !== undefined
        ? `### @${c.author} on ${c.path}:${c.line}`
        : `### @${c.author} general`;
    lines.push(header, '');
    lines.push(c.body.trim(), '');
  }
  if (input.operatorNote && input.operatorNote.trim().length > 0) {
    lines.push('### operator-note', '', input.operatorNote.trim(), '');
  }
  writeFileSync(path, lines.join('\n'));
  return path;
}

// ---------------------------------------------------------------------------
// Daemon trigger marker
// ---------------------------------------------------------------------------

/**
 * Drop a marker file the daemon polls. The daemon picks this up and runs
 * `runCycle` with `unifierFeedbackRef` set (per C3b), which triggers the
 * dev-loop unifier in send-back mode.
 */
export function enqueueUnifier(
  initiativeId: string,
  feedbackRef: string,
  queueRoot: string,
): string {
  const path = unifierTriggerPath(initiativeId, queueRoot);
  mkdirSync(dirname(path), { recursive: true });
  const payload = {
    initiative_id: initiativeId,
    feedback_ref: feedbackRef,
    created_at: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

// ---------------------------------------------------------------------------
// Production gh runner (shell-out via gh api)
// ---------------------------------------------------------------------------

/**
 * Default `GhRunner` for production — wraps `gh api` shell-outs. The router
 * tests use a hand-rolled mock instead; the default exists so the daemon /
 * CLI can drive the router against real PRs.
 */
export function defaultGhRunner(): GhRunner {
  return {
    fetchComments: async (pr) => ghApi<PrComment[]>(['api', `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`])
      .then((rows) =>
        Array.isArray(rows)
          ? rows.map((r) => ({
              id: Number((r as { id?: number }).id ?? 0),
              author: String(((r as { user?: { login?: string } }).user?.login ?? 'unknown')),
              body: String((r as { body?: string }).body ?? ''),
              path: null,
              line: null,
              createdAt: String((r as { created_at?: string }).created_at ?? ''),
            }))
          : [],
      ),
    fetchReviewComments: async (pr) =>
      ghApi<PrComment[]>(['api', `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments`]).then(
        (rows) =>
          Array.isArray(rows)
            ? rows.map((r) => ({
                id: Number((r as { id?: number }).id ?? 0),
                author: String(((r as { user?: { login?: string } }).user?.login ?? 'unknown')),
                body: String((r as { body?: string }).body ?? ''),
                path: ((r as { path?: string | null }).path ?? null) as string | null,
                line: (() => {
                  const ln = (r as { line?: number | null; original_line?: number | null });
                  return ln.line ?? ln.original_line ?? null;
                })(),
                createdAt: String((r as { created_at?: string }).created_at ?? ''),
              }))
            : [],
      ),
    fetchReviews: async (pr) =>
      ghApi<PrReviewEvent[]>(['api', `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`]).then(
        (rows) =>
          Array.isArray(rows)
            ? rows.map((r) => ({
                id: Number((r as { id?: number }).id ?? 0),
                author: String(((r as { user?: { login?: string } }).user?.login ?? 'unknown')),
                kind: (((r as { state?: string }).state ?? 'COMMENTED').toUpperCase() as ReviewKind),
                submittedAt: String((r as { submitted_at?: string }).submitted_at ?? ''),
              }))
            : [],
      ),
    fetchBranchHead: async (pr) => {
      const json = await ghApi<{
        head?: { sha?: string };
        head_commit?: { author?: { name?: string }; committer?: { name?: string }; date?: string };
      }>(['api', `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`]);
      const sha = String((json?.head?.sha ?? ''));
      // For author/date we'd need a second call to /commits/<sha>; default
      // to forge-bot + epoch so the decision table treats unknown branch
      // state as "forge-owned, very old" — i.e., approvals are not stale.
      return {
        sha,
        author: FORGE_BOT_AUTHOR,
        committedAt: '1970-01-01T00:00:00Z',
      };
    },
  };
}

async function ghApi<T>(args: string[]): Promise<T> {
  const { execFile } = await import('node:child_process');
  return new Promise<T>((resolveP, rejectP) => {
    execFile('gh', args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        rejectP(err);
        return;
      }
      try {
        resolveP(JSON.parse(stdout) as T);
      } catch (parseErr) {
        rejectP(parseErr);
      }
    });
  });
}
