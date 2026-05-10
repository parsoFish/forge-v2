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
  checkInitiativeDeps,
  decideAutoRetry,
  dispatchTerminalStatus,
  MAX_AUTO_RETRIES,
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

// ---- F-25: initiative-level dependency enforcement ----

function manifestWithDeps(id: string, deps: string[]): string {
  const depsBlock =
    deps.length > 0
      ? `depends_on_initiatives:\n${deps.map((d) => `  - ${d}`).join('\n')}\n`
      : '';
  return `---
initiative_id: ${id}
project: trafficGame
project_repo_path: projects/trafficGame
created_at: 2026-05-10T18:00:00Z
iteration_budget: 1
cost_budget_usd: 1.0
phase: pending
${depsBlock}---

# ${id}
`;
}

test('checkInitiativeDeps: no deps declared → empty (always claimable)', () => {
  const { dir, paths } = setupQueue();
  try {
    writeFileSync(join(paths.pending, 'INIT-2026-05-10-a.md'), manifestWithDeps('INIT-2026-05-10-a', []));
    assert.deepEqual(checkInitiativeDeps('INIT-2026-05-10-a.md', paths), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkInitiativeDeps: dep in done/ → unblocked (empty result)', () => {
  const { dir, paths } = setupQueue();
  try {
    writeFileSync(
      join(paths.pending, 'INIT-2026-05-10-b.md'),
      manifestWithDeps('INIT-2026-05-10-b', ['INIT-2026-05-10-a']),
    );
    writeFileSync(join(paths.done, 'INIT-2026-05-10-a.md'), manifestWithDeps('INIT-2026-05-10-a', []));
    assert.deepEqual(checkInitiativeDeps('INIT-2026-05-10-b.md', paths), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkInitiativeDeps: dep missing from done/ → returned as blocker', () => {
  const { dir, paths } = setupQueue();
  try {
    writeFileSync(
      join(paths.pending, 'INIT-2026-05-10-b.md'),
      manifestWithDeps('INIT-2026-05-10-b', ['INIT-2026-05-10-a']),
    );
    // INIT-a not in done/ — it's nowhere, or it's still pending/in-flight/etc.
    assert.deepEqual(checkInitiativeDeps('INIT-2026-05-10-b.md', paths), ['INIT-2026-05-10-a']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkInitiativeDeps: dep in pending/ (not yet run) → returned as blocker', () => {
  const { dir, paths } = setupQueue();
  try {
    writeFileSync(
      join(paths.pending, 'INIT-2026-05-10-b.md'),
      manifestWithDeps('INIT-2026-05-10-b', ['INIT-2026-05-10-a']),
    );
    writeFileSync(join(paths.pending, 'INIT-2026-05-10-a.md'), manifestWithDeps('INIT-2026-05-10-a', []));
    assert.deepEqual(checkInitiativeDeps('INIT-2026-05-10-b.md', paths), ['INIT-2026-05-10-a']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkInitiativeDeps: multiple deps, partial completion → only missing ones returned', () => {
  const { dir, paths } = setupQueue();
  try {
    writeFileSync(
      join(paths.pending, 'INIT-2026-05-10-c.md'),
      manifestWithDeps('INIT-2026-05-10-c', ['INIT-2026-05-10-a', 'INIT-2026-05-10-b']),
    );
    writeFileSync(join(paths.done, 'INIT-2026-05-10-a.md'), manifestWithDeps('INIT-2026-05-10-a', []));
    // INIT-b never created in done/
    assert.deepEqual(checkInitiativeDeps('INIT-2026-05-10-c.md', paths), ['INIT-2026-05-10-b']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkInitiativeDeps: missing manifest file → empty (best-effort)', () => {
  const { dir, paths } = setupQueue();
  try {
    // No manifest written. Nothing to do.
    assert.deepEqual(checkInitiativeDeps('INIT-2026-05-10-nonexistent.md', paths), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- F-27: bounded auto-retry decision ----

function writeManifestWithRetry(
  inFlightDir: string,
  id: string,
  retryCount: number,
  priorModes: string[] = [],
): string {
  const path = join(inFlightDir, `${id}.md`);
  const priorBlock =
    priorModes.length > 0
      ? `previous_failure_modes:\n${priorModes.map((m) => `  - ${m}`).join('\n')}\n`
      : '';
  const retryLine = retryCount > 0 ? `retry_count: ${retryCount}\n` : '';
  writeFileSync(
    path,
    `---
initiative_id: ${id}
project: trafficGame
project_repo_path: projects/trafficGame
created_at: 2026-05-10T18:00:00Z
iteration_budget: 1
cost_budget_usd: 1.0
phase: in-flight
${retryLine}${priorBlock}---

# ${id}
`,
  );
  return path;
}

function writeFailureLog(logDir: string, mode: string, recoverable: boolean): string {
  const logPath = join(logDir, 'events.jsonl');
  const entry = {
    event_id: 'EV_test_fc',
    cycle_id: 'cycle-test',
    initiative_id: 'INIT-2026-05-10-x',
    started_at: new Date().toISOString(),
    phase: 'orchestrator',
    skill: 'cycle',
    event_type: 'log',
    input_refs: [],
    output_refs: [],
    message: 'failure_classification',
    metadata: {
      cycle_id: 'cycle-test',
      failure_mode: mode,
      recoverable,
    },
  };
  writeFileSync(logPath, JSON.stringify(entry) + '\n');
  return logPath;
}

test('decideAutoRetry: recoverable mode + retry_count=0 → retry with count=1', () => {
  const { dir, paths } = setupQueue();
  try {
    writeManifestWithRetry(paths.inFlight, 'INIT-2026-05-10-r1', 0);
    const logDir = mkdtempSync(join(tmpdir(), 'forge-log-'));
    const logPath = writeFailureLog(logDir, 'trivial-pass', true);
    try {
      const decision = decideAutoRetry('INIT-2026-05-10-r1.md', paths, logPath);
      assert.equal(decision.retry, true);
      if (decision.retry) {
        assert.equal(decision.mode, 'trivial-pass');
        assert.equal(decision.nextRetryCount, 1);
      }
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('decideAutoRetry: non-recoverable mode → no retry', () => {
  const { dir, paths } = setupQueue();
  try {
    writeManifestWithRetry(paths.inFlight, 'INIT-2026-05-10-r2', 0);
    const logDir = mkdtempSync(join(tmpdir(), 'forge-log-'));
    const logPath = writeFailureLog(logDir, 'gate-missing-script', false);
    try {
      const decision = decideAutoRetry('INIT-2026-05-10-r2.md', paths, logPath);
      assert.equal(decision.retry, false);
      if (!decision.retry) {
        assert.match(decision.reason, /not recoverable/);
      }
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(`decideAutoRetry: retry_count >= ${MAX_AUTO_RETRIES} → no retry (cap reached)`, () => {
  const { dir, paths } = setupQueue();
  try {
    writeManifestWithRetry(paths.inFlight, 'INIT-2026-05-10-r3', MAX_AUTO_RETRIES);
    const logDir = mkdtempSync(join(tmpdir(), 'forge-log-'));
    const logPath = writeFailureLog(logDir, 'trivial-pass', true);
    try {
      const decision = decideAutoRetry('INIT-2026-05-10-r3.md', paths, logPath);
      assert.equal(decision.retry, false);
      if (!decision.retry) assert.match(decision.reason, /retry cap/);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('decideAutoRetry: same recoverable mode repeated → no retry (anti-thrash)', () => {
  const { dir, paths } = setupQueue();
  try {
    // Already retried once for trivial-pass; the same mode shows up again.
    writeManifestWithRetry(paths.inFlight, 'INIT-2026-05-10-r4', 1, ['trivial-pass']);
    const logDir = mkdtempSync(join(tmpdir(), 'forge-log-'));
    const logPath = writeFailureLog(logDir, 'trivial-pass', true);
    try {
      const decision = decideAutoRetry('INIT-2026-05-10-r4.md', paths, logPath);
      assert.equal(decision.retry, false);
      if (!decision.retry) assert.match(decision.reason, /repeated despite prior retry/);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('decideAutoRetry: log without classification event → no retry', () => {
  const { dir, paths } = setupQueue();
  try {
    writeManifestWithRetry(paths.inFlight, 'INIT-2026-05-10-r5', 0);
    const logDir = mkdtempSync(join(tmpdir(), 'forge-log-'));
    const logPath = join(logDir, 'events.jsonl');
    writeFileSync(logPath, '{"event_id":"e1","message":"something else"}\n');
    try {
      const decision = decideAutoRetry('INIT-2026-05-10-r5.md', paths, logPath);
      assert.equal(decision.retry, false);
      if (!decision.retry) assert.match(decision.reason, /no failure_classification/);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('decideAutoRetry: different recoverable mode after prior retry → retry (modes are distinct)', () => {
  const { dir, paths } = setupQueue();
  try {
    // Prior: brain-skipped. Current: trivial-pass. Different modes — give it another shot.
    writeManifestWithRetry(paths.inFlight, 'INIT-2026-05-10-r6', 1, ['brain-skipped']);
    const logDir = mkdtempSync(join(tmpdir(), 'forge-log-'));
    const logPath = writeFailureLog(logDir, 'trivial-pass', true);
    try {
      const decision = decideAutoRetry('INIT-2026-05-10-r6.md', paths, logPath);
      assert.equal(decision.retry, true);
      if (decision.retry) assert.equal(decision.nextRetryCount, 2);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- F-27: failure classifier ----

test('classifyCycleFailure: trivial-pass detected from ralph.end with iterations=0', async () => {
  const { classifyCycleFailure } = await import('./failure-classifier.ts');
  const events = [
    { event_id: 'e1', cycle_id: 'c', initiative_id: 'i', started_at: '', phase: 'developer-loop', skill: 'developer-ralph', event_type: 'end', input_refs: [], output_refs: [], message: 'ralph.end', metadata: { work_item_id: 'WI-1', status: 'failed', stop_reason: 'quality-gates-pass', iterations: 0 } },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cls = classifyCycleFailure(events as any);
  assert.equal(cls.mode, 'trivial-pass');
  assert.equal(cls.recoverable, true);
});

test('classifyCycleFailure: gate-missing-script detected from gate.fail stderr', async () => {
  const { classifyCycleFailure } = await import('./failure-classifier.ts');
  const events = [
    { event_id: 'e1', cycle_id: 'c', initiative_id: 'i', started_at: '', phase: 'developer-loop', skill: 'developer-ralph', event_type: 'error', input_refs: [], output_refs: [], message: 'gate.fail', metadata: { gate_stderr_tail: 'npm error: missing script: test:visual:fast' } },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cls = classifyCycleFailure(events as any);
  assert.equal(cls.mode, 'gate-missing-script');
  assert.equal(cls.recoverable, false);
});

test('classifyCycleFailure: unknown when no signature matches', async () => {
  const { classifyCycleFailure } = await import('./failure-classifier.ts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cls = classifyCycleFailure([] as any);
  assert.equal(cls.mode, 'unknown');
  assert.equal(cls.recoverable, false);
});

// ---- F-28: dispatchTerminalStatus must NOT signal cleanup for ready-for-review ----

test('dispatchTerminalStatus: send-back-cap-exhausted → no manifest move (cycle.ts owns it)', async () => {
  const { dir, paths } = setupQueue();
  const calls: NotifyEvent[] = [];
  try {
    // Reviewer (cycle.ts) already moved the manifest to ready-for-review/.
    writeFileSync(join(paths.readyForReview, 'INIT-test.md'), 'ready');
    const out = await dispatchTerminalStatus(makeInput('send-back-cap-exhausted'), {
      paths,
      notifyFn: async (e) => { calls.push(e); },
    });
    assert.equal(out.moved, null);
    assert.equal(out.notified, 'review-ready');
    assert.equal(calls.length, 1);
    // Manifest should still be in ready-for-review/ (not moved by dispatch).
    assert.equal(existsSync(join(paths.readyForReview, 'INIT-test.md')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
