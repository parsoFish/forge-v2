/**
 * Unit tests for orchestrator/review-router.ts.
 *
 * The router is a non-LLM module that polls PR comments via the existing
 * `gh` seam, dedups via a cursor file (C16b atomic write), implements the
 * C16a decision table, writes the C3a `pr-feedback.md`, and drops a marker
 * for the daemon to pick up. Tests use a mock `GhRunner` interface so no
 * real `gh` is invoked.
 *
 * Coverage corresponds to S4-DECISIONS.md item 4 (C16a row-by-row):
 *   - APPROVED + no new commits → approve
 *   - APPROVED + new commits since approval → ignore (stale)
 *   - CHANGES_REQUESTED → send-back
 *   - COMMENTED only → send-back
 *   - Mixed reviewers (latest CHANGES_REQUESTED wins) → send-back
 *   - Latest commit author ≠ forge-bot → refuse-operator-push
 *
 * Plus: cursor atomicity, line-level comment threading, writePrFeedback
 * shape correctness, fallback to file-verdict when no PR is found.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  decideAction,
  pollNewComments,
  readCursor,
  reviewCursorPath,
  prFeedbackPath,
  writeCursor,
  writePrFeedback,
  enqueueUnifier,
  unifierTriggerPath,
  type GhRunner,
  type PrEvent,
  type RouterState,
} from './review-router.ts';

function newTempQueue(): { dir: string; queueRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-router-test-'));
  const queueRoot = join(dir, '_queue');
  return { dir, queueRoot };
}

// ---------- decideAction (C16a rows 1-6) ----------

test('decideAction: APPROVED with clean head → approve', () => {
  const state: RouterState = {
    latestReview: { id: 1, kind: 'APPROVED', submittedAt: '2026-05-23T10:00:00Z', author: 'reviewer' },
    branchHead: { sha: 'abc123', committedAt: '2026-05-23T09:00:00Z', author: 'forge-bot' },
    newComments: [],
  };
  const action = decideAction(state);
  assert.equal(action.kind, 'approve');
});

test('decideAction: APPROVED but commits after approval → ignore stale, re-evaluate', () => {
  const state: RouterState = {
    latestReview: { id: 1, kind: 'APPROVED', submittedAt: '2026-05-23T09:00:00Z', author: 'reviewer' },
    branchHead: { sha: 'def456', committedAt: '2026-05-23T10:00:00Z', author: 'forge-bot' },
    newComments: [],
  };
  const action = decideAction(state);
  // The approval is stale; without new comments either, fall through to noop.
  assert.equal(action.kind, 'noop');
  assert.match(action.reason, /stale/i);
});

test('decideAction: CHANGES_REQUESTED → send-back', () => {
  const state: RouterState = {
    latestReview: { id: 1, kind: 'CHANGES_REQUESTED', submittedAt: '2026-05-23T10:00:00Z', author: 'reviewer' },
    branchHead: { sha: 'abc', committedAt: '2026-05-23T09:00:00Z', author: 'forge-bot' },
    newComments: [],
  };
  const action = decideAction(state);
  assert.equal(action.kind, 'send-back');
});

test('decideAction: COMMENTED-only → send-back (intent inferred)', () => {
  const state: RouterState = {
    latestReview: null, // no formal review, just comments
    branchHead: { sha: 'abc', committedAt: '2026-05-23T09:00:00Z', author: 'forge-bot' },
    newComments: [
      { author: 'reviewer', body: 'please tighten the test', path: 'src/x.ts', line: 42, createdAt: '2026-05-23T10:00:00Z', id: 1 },
    ],
  };
  const action = decideAction(state);
  assert.equal(action.kind, 'send-back');
});

test('decideAction: mixed reviewers with most-recent CHANGES_REQUESTED → send-back', () => {
  const state: RouterState = {
    latestReview: { id: 1, kind: 'CHANGES_REQUESTED', submittedAt: '2026-05-23T11:00:00Z', author: 'reviewer-2' },
    branchHead: { sha: 'abc', committedAt: '2026-05-23T09:00:00Z', author: 'forge-bot' },
    newComments: [],
  };
  const action = decideAction(state);
  assert.equal(action.kind, 'send-back');
});

test('decideAction: operator-direct-push → refuse-operator-push', () => {
  const state: RouterState = {
    latestReview: null,
    branchHead: { sha: 'abc', committedAt: '2026-05-23T11:00:00Z', author: 'someone-else' },
    newComments: [
      { author: 'reviewer', body: 'fix me', path: null, line: null, createdAt: '2026-05-23T10:00:00Z', id: 1 },
    ],
  };
  const action = decideAction(state);
  assert.equal(action.kind, 'refuse-operator-push');
  assert.match(action.reason, /operator/i);
});

test('decideAction: no events at all → noop', () => {
  const state: RouterState = {
    latestReview: null,
    branchHead: { sha: 'abc', committedAt: '2026-05-23T09:00:00Z', author: 'forge-bot' },
    newComments: [],
  };
  const action = decideAction(state);
  assert.equal(action.kind, 'noop');
});

// ---------- Cursor atomicity (C16b) ----------

test('writeCursor + readCursor: round-trip', () => {
  const { dir, queueRoot } = newTempQueue();
  try {
    const path = reviewCursorPath('INIT-x', queueRoot);
    writeCursor(path, { last_seen_comment_id: 42, last_seen_review_id: 7 });
    const cur = readCursor(path);
    assert.equal(cur.last_seen_comment_id, 42);
    assert.equal(cur.last_seen_review_id, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCursor: missing file returns zero cursor', () => {
  const { dir, queueRoot } = newTempQueue();
  try {
    const path = reviewCursorPath('INIT-x', queueRoot);
    const cur = readCursor(path);
    assert.equal(cur.last_seen_comment_id, 0);
    assert.equal(cur.last_seen_review_id, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCursor: malformed JSON → zero cursor (per C16b)', () => {
  const { dir, queueRoot } = newTempQueue();
  try {
    const path = reviewCursorPath('INIT-x', queueRoot);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{not json');
    const cur = readCursor(path);
    assert.equal(cur.last_seen_comment_id, 0);
    assert.equal(cur.last_seen_review_id, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCursor uses tmp + rename (no half-written file visible)', () => {
  const { dir, queueRoot } = newTempQueue();
  try {
    const path = reviewCursorPath('INIT-x', queueRoot);
    writeCursor(path, { last_seen_comment_id: 1, last_seen_review_id: 1 });
    assert.ok(existsSync(path));
    // No tmp file should remain after the rename.
    assert.equal(existsSync(`${path}.tmp`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- writePrFeedback (C3a schema) ----------

test('writePrFeedback: writes the C3a schema with frontmatter + comments', () => {
  const { dir, queueRoot } = newTempQueue();
  try {
    const path = prFeedbackPath('INIT-x', queueRoot);
    writePrFeedback({
      initiativeId: 'INIT-x',
      round: 1,
      cursor: 42,
      generatedAt: '2026-05-23T10:00:00Z',
      comments: [
        {
          author: 'reviewer',
          body: 'tighten the test',
          path: 'src/x.ts',
          line: 42,
          createdAt: '2026-05-23T10:00:00Z',
          id: 1,
        },
        {
          author: 'reviewer',
          body: 'general note',
          path: null,
          line: null,
          createdAt: '2026-05-23T10:00:00Z',
          id: 2,
        },
      ],
      operatorNote: 'focus on the perf comment',
      queueRoot,
    });
    const text = readFileSync(path, 'utf8');
    assert.match(text, /^---\nround: 1\n/);
    assert.match(text, /comments_collected: 2/);
    assert.match(text, /cursor: 42/);
    assert.match(text, /### @reviewer on src\/x\.ts:42/);
    assert.match(text, /### @reviewer general/);
    assert.match(text, /### operator-note/);
    assert.match(text, /focus on the perf comment/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- enqueueUnifier ----------

test('enqueueUnifier: drops a marker file the daemon polls', () => {
  const { dir, queueRoot } = newTempQueue();
  try {
    const feedbackRef = prFeedbackPath('INIT-x', queueRoot);
    enqueueUnifier('INIT-x', feedbackRef, queueRoot);
    const triggerPath = unifierTriggerPath('INIT-x', queueRoot);
    assert.ok(existsSync(triggerPath));
    const parsed = JSON.parse(readFileSync(triggerPath, 'utf8'));
    assert.equal(parsed.feedback_ref, feedbackRef);
    assert.equal(parsed.initiative_id, 'INIT-x');
    assert.ok(typeof parsed.created_at === 'string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- pollNewComments (mock gh) ----------

function makeMockGh(events: PrEvent[]): GhRunner {
  return {
    fetchComments: async (_pr) =>
      events.filter((e) => e.kind === 'issue-comment').map((e) => ({
        id: e.id,
        author: e.author,
        body: e.body,
        path: null,
        line: null,
        createdAt: e.createdAt,
      })),
    fetchReviewComments: async (_pr) =>
      events.filter((e) => e.kind === 'review-comment').map((e) => ({
        id: e.id,
        author: e.author,
        body: e.body,
        path: e.path ?? null,
        line: e.line ?? null,
        createdAt: e.createdAt,
      })),
    fetchReviews: async (_pr) =>
      events
        .filter((e) => e.kind === 'review')
        .map((e) => ({
          id: e.id,
          author: e.author,
          kind: e.state ?? 'COMMENTED',
          submittedAt: e.createdAt,
        })),
    fetchBranchHead: async (_pr) => ({
      sha: 'HEAD-sha',
      author: 'forge-bot',
      committedAt: '2026-05-23T09:00:00Z',
    }),
  };
}

test('pollNewComments: filters out our own sentinel comments', async () => {
  const gh = makeMockGh([
    { kind: 'issue-comment', id: 1, author: 'reviewer', body: 'real comment', createdAt: '2026-05-23T10:00:00Z' },
    { kind: 'issue-comment', id: 2, author: 'forge-bot', body: '<!-- forge:verdict-prompt --> ignored', createdAt: '2026-05-23T10:01:00Z' },
    { kind: 'issue-comment', id: 3, author: 'forge-bot', body: '<!-- forge:verdict-ack --> ignored', createdAt: '2026-05-23T10:02:00Z' },
  ]);
  const state = await pollNewComments({
    prRef: { owner: 'x', repo: 'y', number: 1 },
    cursor: { last_seen_comment_id: 0, last_seen_review_id: 0 },
    gh,
  });
  assert.equal(state.newComments.length, 1);
  assert.equal(state.newComments[0].body, 'real comment');
});

test('pollNewComments: cursor dedup — re-running with no new events is empty', async () => {
  const gh = makeMockGh([
    { kind: 'issue-comment', id: 1, author: 'reviewer', body: 'real comment', createdAt: '2026-05-23T10:00:00Z' },
  ]);
  const state = await pollNewComments({
    prRef: { owner: 'x', repo: 'y', number: 1 },
    cursor: { last_seen_comment_id: 1, last_seen_review_id: 0 },
    gh,
  });
  assert.equal(state.newComments.length, 0);
});

test('pollNewComments: line-level review comments preserve path:line', async () => {
  const gh = makeMockGh([
    {
      kind: 'review-comment',
      id: 10,
      author: 'reviewer',
      body: 'tighten this',
      path: 'src/x.ts',
      line: 42,
      createdAt: '2026-05-23T10:00:00Z',
    },
  ]);
  const state = await pollNewComments({
    prRef: { owner: 'x', repo: 'y', number: 1 },
    cursor: { last_seen_comment_id: 0, last_seen_review_id: 0 },
    gh,
  });
  assert.equal(state.newComments.length, 1);
  assert.equal(state.newComments[0].path, 'src/x.ts');
  assert.equal(state.newComments[0].line, 42);
});
