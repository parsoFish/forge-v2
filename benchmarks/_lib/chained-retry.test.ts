/**
 * Deterministic, SDK-free tests for the chained bench's
 * production-faithful bounded auto-retry wrapper.
 *
 * These prove the NON-LLM plumbing without spending a cent: the wrapper
 * REUSES the real `orchestrator/scheduler-dispatch.ts:
 * dispatchTerminalStatus` (→ `decideAutoRetry` → `classifyCycleFailure` /
 * `RECOVERABLE_MODES` / `MAX_AUTO_RETRIES` / anti-thrash) as the retry
 * authority. We drive it through a real `_queue/` with real annotated
 * manifests + a synthetic `failure_classification` event log (exactly
 * what real `runCycle` + `emitFailureClassification` write) and a fake
 * `runCycleFn`, asserting the wrapper re-runs on a recoverable
 * classification, stops at the cap, respects the same-mode anti-thrash,
 * does not retry a non-recoverable mode, and resets the repo between
 * attempts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getPaths } from '../../orchestrator/queue.ts';
import { MAX_AUTO_RETRIES } from '../../orchestrator/scheduler-dispatch.ts';
import type { CycleInput } from '../../orchestrator/cycle.ts';
import {
  runCycleWithBoundedRetry,
  type RunCycleFn,
} from './chained-retry.ts';

// ---------------------------------------------------------------------------
// Fixtures: a real _queue/, a real (tiny) git repo, real annotated manifests,
// and a synthetic per-cycle event log with a failure_classification event.
// ---------------------------------------------------------------------------

function setupQueue(): { dir: string; paths: ReturnType<typeof getPaths> } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-chained-retry-'));
  const paths = getPaths(join(dir, '_queue'));
  for (const p of [paths.pending, paths.inFlight, paths.readyForReview, paths.done, paths.failed]) {
    mkdirSync(p, { recursive: true });
  }
  return { dir, paths };
}

/** A real git repo on an `initiative-<id>` branch, returns its HEAD sha. */
function setupRepo(dir: string): { projDir: string; head: string } {
  const projDir = join(dir, 'proj');
  mkdirSync(projDir, { recursive: true });
  const sh = (args: string[]): string =>
    execFileSync('git', args, { cwd: projDir, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' });
  sh(['init', '-q', '-b', 'main']);
  sh(['config', 'user.email', 'bench@forge.local']);
  sh(['config', 'user.name', 'forge bench']);
  writeFileSync(join(projDir, 'seed.txt'), 'seed\n');
  sh(['add', '-A']);
  sh(['commit', '-q', '-m', 'seed']);
  sh(['checkout', '-q', '-b', 'initiative-INIT-x']);
  const head = sh(['rev-parse', 'HEAD']).trim();
  return { projDir, head };
}

function writeManifest(
  inFlightDir: string,
  id: string,
  retryCount = 0,
  priorModes: string[] = [],
): void {
  const priorBlock =
    priorModes.length > 0
      ? `previous_failure_modes:\n${priorModes.map((m) => `  - ${m}`).join('\n')}\n`
      : '';
  const retryLine = retryCount > 0 ? `retry_count: ${retryCount}\n` : '';
  writeFileSync(
    join(inFlightDir, `${id}.md`),
    `---
initiative_id: ${id}
project: slugifier
project_repo_path: projects/slugifier
created_at: 2026-05-17T00:00:00Z
iteration_budget: 1
cost_budget_usd: 1.0
phase: in-flight
${retryLine}${priorBlock}---

# ${id}
`,
  );
}

/** Write the per-cycle event log exactly as runCycle+emitFailureClassification do. */
function writeClassifiedLog(dir: string, mode: string, recoverable: boolean): string {
  const logDir = join(dir, 'log');
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, 'events.jsonl');
  writeFileSync(
    logPath,
    JSON.stringify({
      event_id: 'EV_fc',
      cycle_id: 'cycle-test',
      initiative_id: 'INIT-x',
      started_at: new Date().toISOString(),
      phase: 'orchestrator',
      skill: 'cycle',
      event_type: 'log',
      input_refs: [],
      output_refs: [],
      message: 'failure_classification',
      metadata: { cycle_id: 'cycle-test', failure_mode: mode, recoverable },
    }) + '\n',
  );
  return logPath;
}

function baseCycleInput(manifestPath: string, projDir: string): CycleInput {
  return {
    initiativeId: 'INIT-x',
    manifestPath,
    projectRepoPath: projDir,
    worktreePath: projDir,
    qualityGateCmd: ['true'],
  };
}

// ---------------------------------------------------------------------------

test('runCycleWithBoundedRetry: success on first attempt → no dispatch, attempts=1', async () => {
  const { dir, paths } = setupQueue();
  const { projDir, head } = setupRepo(dir);
  try {
    writeManifest(paths.inFlight, 'INIT-x');
    const manifestPath = join(paths.inFlight, 'INIT-x.md');

    let dispatched = false;
    const runCycleFn: RunCycleFn = async () => ({
      cycle_id: 'c1',
      initiative_id: 'INIT-x',
      status: 'pr-open',
      reflection_status: 'skipped',
      duration_ms: 1,
      log_path: writeClassifiedLog(dir, 'x', false),
    });

    const out = await runCycleWithBoundedRetry({
      cycleInput: baseCycleInput(manifestPath, projDir),
      paths,
      filename: 'INIT-x.md',
      manifest: { initiativeId: 'INIT-x', project: 'slugifier' },
      projDir,
      preCycleHead: head,
      runCycleFn,
      dispatchFn: async () => {
        dispatched = true;
        return { moved: null, notified: 'review-ready' };
      },
    });

    assert.equal(out.attempts, 1);
    assert.equal(out.result.status, 'pr-open');
    assert.deepEqual(out.retriedModes, []);
    assert.equal(dispatched, false, 'dispatch not called on a non-failed status');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCycleWithBoundedRetry: recoverable classification → REAL dispatch authorises a retry, then success', async () => {
  const { dir, paths } = setupQueue();
  const { projDir, head } = setupRepo(dir);
  try {
    writeManifest(paths.inFlight, 'INIT-x', 0);
    const manifestPath = join(paths.inFlight, 'INIT-x.md');

    let call = 0;
    const runCycleFn: RunCycleFn = async () => {
      call += 1;
      if (call === 1) {
        return {
          cycle_id: 'c1',
          initiative_id: 'INIT-x',
          status: 'failed',
          reflection_status: 'skipped',
          duration_ms: 1,
          // Recoverable: the new pm-invalid-work-items mode.
          log_path: writeClassifiedLog(dir, 'pm-invalid-work-items', true),
        };
      }
      return {
        cycle_id: 'c2',
        initiative_id: 'INIT-x',
        status: 'pr-open',
        reflection_status: 'skipped',
        duration_ms: 1,
        log_path: writeClassifiedLog(dir, 'x', false),
      };
    };

    // Use the REAL dispatchTerminalStatus (default) — the production
    // retry authority. It must read the recoverable classification +
    // retry_count=0, annotate the manifest, and moveTo pending/.
    const out = await runCycleWithBoundedRetry({
      cycleInput: baseCycleInput(manifestPath, projDir),
      paths,
      filename: 'INIT-x.md',
      manifest: { initiativeId: 'INIT-x', project: 'slugifier' },
      projDir,
      preCycleHead: head,
      runCycleFn,
    });

    assert.equal(out.attempts, 2, 'one recoverable retry');
    assert.equal(out.result.status, 'pr-open');
    assert.deepEqual(out.retriedModes, ['pm-invalid-work-items']);
    // The real dispatch annotated retry_count on the manifest before the
    // re-claim; after the successful 2nd attempt it sits in in-flight/.
    const finalManifest = readFileSync(join(paths.inFlight, 'INIT-x.md'), 'utf8');
    assert.match(finalManifest, /retry_count:\s*1/);
    assert.match(finalManifest, /pm-invalid-work-items/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(`runCycleWithBoundedRetry: persistent recoverable failure stops at 1 + MAX_AUTO_RETRIES (=${1 + MAX_AUTO_RETRIES}) attempts`, async () => {
  const { dir, paths } = setupQueue();
  const { projDir, head } = setupRepo(dir);
  try {
    writeManifest(paths.inFlight, 'INIT-x', 0);
    const manifestPath = join(paths.inFlight, 'INIT-x.md');

    let call = 0;
    const runCycleFn: RunCycleFn = async () => {
      call += 1;
      // Each attempt fails recoverably with a DISTINCT mode so the
      // same-mode anti-thrash guard never short-circuits — the only thing
      // that stops the loop is the real MAX_AUTO_RETRIES cap.
      const modes = ['brain-skipped', 'agent-rate-limited', 'pm-invalid-work-items', 'trivial-pass'];
      return {
        cycle_id: `c${call}`,
        initiative_id: 'INIT-x',
        status: 'failed',
        reflection_status: 'skipped',
        duration_ms: 1,
        log_path: writeClassifiedLog(dir, modes[(call - 1) % modes.length], true),
      };
    };

    const out = await runCycleWithBoundedRetry({
      cycleInput: baseCycleInput(manifestPath, projDir),
      paths,
      filename: 'INIT-x.md',
      manifest: { initiativeId: 'INIT-x', project: 'slugifier' },
      projDir,
      preCycleHead: head,
      runCycleFn,
    });

    assert.equal(out.result.status, 'failed');
    assert.equal(out.attempts, 1 + MAX_AUTO_RETRIES, 'capped at the production bound');
    assert.equal(out.retriedModes.length, MAX_AUTO_RETRIES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCycleWithBoundedRetry: anti-thrash — same recoverable mode already retried → REAL policy declines, attempts=1', async () => {
  const { dir, paths } = setupQueue();
  const { projDir, head } = setupRepo(dir);
  try {
    // Manifest already retried once for pm-invalid-work-items; the same
    // mode shows up again. decideAutoRetry's anti-thrash guard must
    // refuse a second retry of the same mode.
    writeManifest(paths.inFlight, 'INIT-x', 1, ['pm-invalid-work-items']);
    const manifestPath = join(paths.inFlight, 'INIT-x.md');

    let call = 0;
    const runCycleFn: RunCycleFn = async () => {
      call += 1;
      return {
        cycle_id: `c${call}`,
        initiative_id: 'INIT-x',
        status: 'failed',
        reflection_status: 'skipped',
        duration_ms: 1,
        log_path: writeClassifiedLog(dir, 'pm-invalid-work-items', true),
      };
    };

    const out = await runCycleWithBoundedRetry({
      cycleInput: baseCycleInput(manifestPath, projDir),
      paths,
      filename: 'INIT-x.md',
      manifest: { initiativeId: 'INIT-x', project: 'slugifier' },
      projDir,
      preCycleHead: head,
      runCycleFn,
    });

    assert.equal(out.attempts, 1, 'no retry — same mode repeated');
    assert.equal(out.result.status, 'failed');
    assert.deepEqual(out.retriedModes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCycleWithBoundedRetry: non-recoverable classification → REAL policy declines, attempts=1', async () => {
  const { dir, paths } = setupQueue();
  const { projDir, head } = setupRepo(dir);
  try {
    writeManifest(paths.inFlight, 'INIT-x', 0);
    const manifestPath = join(paths.inFlight, 'INIT-x.md');

    const runCycleFn: RunCycleFn = async () => ({
      cycle_id: 'c1',
      initiative_id: 'INIT-x',
      status: 'failed',
      reflection_status: 'skipped',
      duration_ms: 1,
      log_path: writeClassifiedLog(dir, 'gate-missing-script', false),
    });

    const out = await runCycleWithBoundedRetry({
      cycleInput: baseCycleInput(manifestPath, projDir),
      paths,
      filename: 'INIT-x.md',
      manifest: { initiativeId: 'INIT-x', project: 'slugifier' },
      projDir,
      preCycleHead: head,
      runCycleFn,
    });

    assert.equal(out.attempts, 1, 'non-recoverable → no retry');
    assert.equal(out.result.status, 'failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCycleWithBoundedRetry: resets the repo to preCycleHead between attempts (fresh-worktree mirror)', async () => {
  const { dir, paths } = setupQueue();
  const { projDir, head } = setupRepo(dir);
  try {
    writeManifest(paths.inFlight, 'INIT-x', 0);
    const manifestPath = join(paths.inFlight, 'INIT-x.md');
    const sh = (args: string[]): string =>
      execFileSync('git', args, { cwd: projDir, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' });

    let call = 0;
    let headSeenOnRetry: string | null = null;
    let untrackedSeenOnRetry: boolean | null = null;
    const runCycleFn: RunCycleFn = async () => {
      call += 1;
      if (call === 1) {
        // Simulate a phase committing + leaving untracked scratch.
        writeFileSync(join(projDir, 'partial.txt'), 'wip\n');
        sh(['add', '-A']);
        sh(['commit', '-q', '-m', 'wip commit (should be reset away on retry)']);
        writeFileSync(join(projDir, 'scratch.tmp'), 'junk\n');
        return {
          cycle_id: 'c1',
          initiative_id: 'INIT-x',
          status: 'failed',
          reflection_status: 'skipped',
          duration_ms: 1,
          log_path: writeClassifiedLog(dir, 'pm-invalid-work-items', true),
        };
      }
      // Second attempt: the wrapper must have reset HEAD + cleaned.
      headSeenOnRetry = sh(['rev-parse', 'HEAD']).trim();
      untrackedSeenOnRetry = existsSync(join(projDir, 'scratch.tmp'));
      return {
        cycle_id: 'c2',
        initiative_id: 'INIT-x',
        status: 'pr-open',
        reflection_status: 'skipped',
        duration_ms: 1,
        log_path: writeClassifiedLog(dir, 'x', false),
      };
    };

    const out = await runCycleWithBoundedRetry({
      cycleInput: baseCycleInput(manifestPath, projDir),
      paths,
      filename: 'INIT-x.md',
      manifest: { initiativeId: 'INIT-x', project: 'slugifier' },
      projDir,
      preCycleHead: head,
      runCycleFn,
    });

    assert.equal(out.attempts, 2);
    assert.equal(headSeenOnRetry, head, 'HEAD reset to pre-cycle commit on retry');
    assert.equal(untrackedSeenOnRetry, false, 'untracked scratch cleaned on retry');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
