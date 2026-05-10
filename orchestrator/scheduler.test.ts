/**
 * Tests for the scheduler's terminal-status dispatch. Covers F-01 (scheduler
 * mishandles `merged` and `send-back-cap-exhausted` as failures) and the
 * matching reviewer/cycle contract:
 *
 *   - 'merged'                  → cycle already moved manifest to done/; no
 *                                 move; notify type 'merged'.
 *   - 'ready-for-review'        → cycle already moved; no move; notify
 *                                 'review-ready'.
 *   - 'send-back-cap-exhausted' → reviewer already moved manifest to
 *                                 ready-for-review/; no move; notify
 *                                 'review-ready' with cap-exhausted body.
 *   - 'failed'                  → manifest left in-flight; move to failed/;
 *                                 notify 'failed'.
 *
 * Whatever the status, we never double-move (no rename if file isn't in
 * in-flight) and we always emit exactly one notification.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  dispatchTerminalStatus,
  type DispatchInput,
} from './scheduler.ts';
import { getPaths } from './queue.ts';
import type { NotifyEvent } from './notify.ts';

function setupQueue(): { dir: string; paths: ReturnType<typeof getPaths> } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-sched-disp-'));
  const paths = getPaths(join(dir, '_queue'));
  for (const p of [paths.pending, paths.inFlight, paths.readyForReview, paths.done, paths.failed]) {
    mkdirSync(p, { recursive: true });
  }
  return { dir, paths };
}

function makeInput(status: DispatchInput['result']['status']): DispatchInput {
  return {
    filename: 'INIT-test.md',
    manifest: { initiativeId: 'INIT-test', project: 'demo' },
    result: { status, log_path: '_logs/INIT-test/events.jsonl' },
  };
}

test('dispatchTerminalStatus: merged → no move, notify "merged"', async () => {
  const { dir, paths } = setupQueue();
  try {
    // Cycle already moved to done/ — simulate that.
    writeFileSync(join(paths.done, 'INIT-test.md'), 'manifest');

    const calls: NotifyEvent[] = [];
    const out = await dispatchTerminalStatus(makeInput('merged'), {
      paths,
      notifyFn: async (e) => { calls.push(e); },
    });

    assert.equal(out.moved, null);
    assert.equal(out.notified, 'merged');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, 'merged');
    // Manifest still in done/, not in failed/.
    assert.ok(existsSync(join(paths.done, 'INIT-test.md')));
    assert.ok(!existsSync(join(paths.failed, 'INIT-test.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dispatchTerminalStatus: ready-for-review → no move, notify "review-ready"', async () => {
  const { dir, paths } = setupQueue();
  try {
    writeFileSync(join(paths.readyForReview, 'INIT-test.md'), 'manifest');
    const calls: NotifyEvent[] = [];
    const out = await dispatchTerminalStatus(makeInput('ready-for-review'), {
      paths,
      notifyFn: async (e) => { calls.push(e); },
    });

    assert.equal(out.moved, null);
    assert.equal(out.notified, 'review-ready');
    assert.equal(calls[0].type, 'review-ready');
    assert.ok(existsSync(join(paths.readyForReview, 'INIT-test.md')));
    assert.ok(!existsSync(join(paths.failed, 'INIT-test.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dispatchTerminalStatus: failed (in in-flight) → move to failed/, notify "failed"', async () => {
  const { dir, paths } = setupQueue();
  try {
    writeFileSync(join(paths.inFlight, 'INIT-test.md'), 'manifest');
    const calls: NotifyEvent[] = [];
    const out = await dispatchTerminalStatus(makeInput('failed'), {
      paths,
      notifyFn: async (e) => { calls.push(e); },
    });

    assert.equal(out.moved, 'failed');
    assert.equal(out.notified, 'failed');
    assert.equal(calls[0].type, 'failed');
    assert.ok(existsSync(join(paths.failed, 'INIT-test.md')));
    assert.ok(!existsSync(join(paths.inFlight, 'INIT-test.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dispatchTerminalStatus: send-back-cap-exhausted → no move (reviewer moved to ready-for-review/), notify "review-ready"', async () => {
  // F-11: cap-exhausted is no longer treated as a hard failure. The reviewer
  // now moves the manifest to ready-for-review/ before the cycle returns;
  // dispatch must not try to move it again, and must notify the operator
  // that a PR draft is ready for manual review.
  const { dir, paths } = setupQueue();
  try {
    writeFileSync(join(paths.readyForReview, 'INIT-test.md'), 'manifest');
    const calls: NotifyEvent[] = [];
    const out = await dispatchTerminalStatus(makeInput('send-back-cap-exhausted'), {
      paths,
      notifyFn: async (e) => { calls.push(e); },
    });

    assert.equal(out.moved, null);
    assert.equal(out.notified, 'review-ready');
    assert.equal(calls[0].type, 'review-ready');
    assert.match(calls[0].title, /cap exhausted/i);
    assert.ok(existsSync(join(paths.readyForReview, 'INIT-test.md')));
    assert.ok(!existsSync(join(paths.failed, 'INIT-test.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dispatchTerminalStatus: failed but manifest not in in-flight → no move, still notifies', async () => {
  // Simulates a scenario where the cycle moved the manifest to ready-for-review
  // before throwing (e.g., merge failed after the move). Double-moves would
  // ENOENT and crash; the dispatch must be idempotent.
  const { dir, paths } = setupQueue();
  try {
    writeFileSync(join(paths.readyForReview, 'INIT-test.md'), 'manifest');
    const calls: NotifyEvent[] = [];
    const out = await dispatchTerminalStatus(makeInput('failed'), {
      paths,
      notifyFn: async (e) => { calls.push(e); },
    });

    assert.equal(out.moved, null, 'dispatch did not double-move');
    assert.equal(out.notified, 'failed');
    assert.equal(calls.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
