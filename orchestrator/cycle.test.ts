/**
 * Tests for orchestrator/cycle.ts internal helpers. Heavy SDK-dependent paths
 * (runProjectManager, runDeveloperLoop, runReviewer, runReflector) are
 * exercised by their respective benchmarks; this file covers the small
 * orchestration utilities the cycle uses for gates and routing — F-13
 * brain-first gate, F-11 status routing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recordBrainGateResult } from './cycle.ts';
import { createLogger, type EventLogEntry } from './logging.ts';

function setupLogger(): { dir: string; logger: ReturnType<typeof createLogger>; cycleId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-cycle-test-'));
  const cycleId = 'TEST-cycle-2026-05-10';
  const logsDir = join(dir, '_logs');
  mkdirSync(logsDir, { recursive: true });
  const logger = createLogger(cycleId, logsDir);
  return { dir, logger, cycleId };
}

function readEvents(logger: ReturnType<typeof createLogger>): EventLogEntry[] {
  const text = readFileSync(logger.logFilePath, 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as EventLogEntry);
}

// ----- recordBrainGateResult -----

test('recordBrainGateResult: returns true and emits no event when brainReads > 0', () => {
  const { dir, logger } = setupLogger();
  try {
    const result = recordBrainGateResult('project-manager', 'project-manager', 1, {
      initiativeId: 'INIT-test',
      logger,
    });
    assert.equal(result, true);
    // No events emitted (brain consulted, gate passes silently).
    assert.ok(!existsSync(logger.logFilePath) || readEvents(logger).length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordBrainGateResult: returns false and emits a brain-skipped error event when brainReads === 0', () => {
  const { dir, logger } = setupLogger();
  try {
    const result = recordBrainGateResult('project-manager', 'project-manager', 0, {
      initiativeId: 'INIT-test',
      logger,
    });
    assert.equal(result, false);
    const events = readEvents(logger);
    assert.equal(events.length, 1);
    assert.equal(events[0].phase, 'project-manager');
    assert.equal(events[0].skill, 'project-manager');
    assert.equal(events[0].event_type, 'error');
    assert.equal(events[0].message, 'project-manager.brain-skipped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordBrainGateResult: emits per-WI subject in metadata for dev-loop', () => {
  const { dir, logger } = setupLogger();
  try {
    const result = recordBrainGateResult('developer-loop', 'developer-ralph', 0, {
      initiativeId: 'INIT-test',
      logger,
      subject: 'WI-3',
    });
    assert.equal(result, false);
    const events = readEvents(logger);
    assert.equal(events.length, 1);
    assert.equal(events[0].message, 'developer-ralph.brain-skipped');
    assert.deepEqual(events[0].metadata, { subject: 'WI-3' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordBrainGateResult: parentEventId is propagated for child-event correlation', () => {
  const { dir, logger } = setupLogger();
  try {
    recordBrainGateResult('reflection', 'reflector', 0, {
      initiativeId: 'INIT-test',
      logger,
      parentEventId: 'EV_parent_123',
    });
    const events = readEvents(logger);
    assert.equal(events[0].parent_event_id, 'EV_parent_123');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// S4 deletion: the F-30 adaptive reviewer iteration cap tests are gone —
// `computeAdaptiveReviewIterationCap` was reviewer-internal logic that
// moves away with the Ralph-reviewer deletion. The new router-driven
// review phase doesn't iterate (the unifier owns iteration in S4 mode).
