/**
 * S6A — tests for orchestrator/phases/reflector.ts.
 *
 * Covers the brain-lint trigger + retention tagging wiring added in
 * stage S6A:
 *   - Clean lint run → lint_status: 'clean' + reflector.lint-invoked event.
 *   - Missing brain-lint executable → lint_status: 'skipped' +
 *     reflector.lint-skipped event with reason 'executable-missing'.
 *   - Lint exits with findings → lint_status: 'flagged' +
 *     reflector.lint-flagged event + _logs/<id>/brain-lint.md written.
 *   - reflection_status stays 'closed' for all three cases (lint is
 *     informational, not gating).
 *
 * The agent SDK is stubbed via the `deps.sdkQuery` injectable (which the
 * production code calls through). The brain-lint runner is stubbed via
 * `deps.brainLint`. The cycle log dir + manifest are pre-seeded in a
 * tempdir so the reflector reads a manifest that resolves cleanly.
 *
 * IMPORTANT: the reflector currently uses `import.meta.dirname` to resolve
 * the forge root for writes (brain/, _logs/). To keep tests isolated we
 * point the cycle id at a unique value and clean up the resulting log
 * dir after each test. The brain-write side-effect is a no-op for these
 * tests because the stub agent never writes themes — it just streams
 * back a `result` message.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runReflector } from './reflector.ts';
import { createLogger, type EventLogEntry } from '../logging.ts';
import type { CycleInput } from '../cycle-context.ts';
import type { RunBrainLintResult, Finding } from '../brain-lint.ts';

// The forge root the reflector code resolves to (orchestrator/phases/ ⇒ ..)
const FORGE_ROOT = resolve(import.meta.dirname, '..', '..');

type Harness = {
  cycleId: string;
  manifestPath: string;
  cycleLogDir: string;
  events: () => EventLogEntry[];
  logger: ReturnType<typeof createLogger>;
  cleanup: () => void;
};

function uniqueCycleId(suffix: string): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `S6A-TEST-${ts}-${rnd}-${suffix}`;
}

function setupHarness(opts: { suffix: string }): Harness {
  const cycleId = uniqueCycleId(opts.suffix);
  const tmp = mkdtempSync(join(tmpdir(), 'forge-reflector-test-'));
  // Write a minimal valid manifest into the tempdir. parseManifest needs
  // initiative_id, project, created_at, iteration_budget, cost_budget_usd.
  const manifestPath = join(tmp, 'manifest.md');
  writeFileSync(
    manifestPath,
    [
      '---',
      'initiative_id: INIT-2026-05-23-s6a',
      'project: slugifier',
      'created_at: 2026-05-23T12:00:00Z',
      'iteration_budget: 3',
      'cost_budget_usd: 1.0',
      'phase: done',
      'origin: architect',
      'features: []',
      '---',
      '',
      'body',
      '',
    ].join('\n'),
  );

  // Logger writes to <FORGE_ROOT>/_logs/<cycleId>/events.jsonl.
  const cycleLogDir = resolve(FORGE_ROOT, '_logs', cycleId);
  const logger = createLogger(cycleId, resolve(FORGE_ROOT, '_logs'));

  return {
    cycleId,
    manifestPath,
    cycleLogDir,
    logger,
    events: () => {
      if (!existsSync(logger.logFilePath)) return [];
      const raw = readFileSync(logger.logFilePath, 'utf8');
      const lines: EventLogEntry[] = [];
      for (const l of raw.split('\n')) {
        if (!l.trim()) continue;
        try {
          lines.push(JSON.parse(l));
        } catch {
          /* skip */
        }
      }
      return lines;
    },
    cleanup: () => {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      try {
        rmSync(cycleLogDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

function makeInput(h: Harness): CycleInput {
  return {
    initiativeId: 'INIT-2026-05-23-s6a',
    manifestPath: h.manifestPath,
    projectRepoPath: FORGE_ROOT,
    worktreePath: FORGE_ROOT,
    cycleId: h.cycleId,
  };
}

/**
 * Stub SDK query that streams an assistant block with one brain Read and
 * a successful result message. brainReads >= 1 is required to clear the
 * F-13 brain-gate.
 */
async function* fakeSdkQueryClean(_: {
  prompt: string;
  options: Record<string, unknown>;
}): AsyncIterable<unknown> {
  yield {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'Read', input: { file_path: 'brain/INDEX.md' } },
      ],
    },
  };
  yield {
    type: 'result',
    subtype: 'success',
    total_cost_usd: 0.05,
    duration_ms: 1234,
  };
}

function makeCleanLintStub(): (opts: { cwd: string; cycleId: string }) => RunBrainLintResult {
  return () => ({ findings: [], exitCode: 0 });
}

function makeFlaggedLintStub(): (opts: { cwd: string; cycleId: string }) => RunBrainLintResult {
  const findings: Finding[] = [
    {
      category: 'error',
      file: '/fake/brain/projects/slugifier/themes/broken.md',
      message: 'missing required frontmatter field: category',
      check: 'checkFrontmatter',
    },
    {
      category: 'error',
      file: '/fake/brain/projects/slugifier/themes/orphan.md',
      message: 'broken link: ./nonexistent.md',
      check: 'checkSourceLinks',
    },
  ];
  return () => ({ findings, exitCode: 1 });
}

function makeMissingLintStub(): (opts: { cwd: string; cycleId: string }) => RunBrainLintResult {
  return () => {
    const e = new Error("Cannot find module './brain-lint.ts'");
    // Tag the error so the reflector's regex matches.
    (e as { code?: string }).code = 'MODULE_NOT_FOUND';
    throw e;
  };
}

// ---------- tests ----------

test('runReflector: clean lint run → lint_status:clean + lint-invoked event', async () => {
  const h = setupHarness({ suffix: 'clean' });
  try {
    const result = await runReflector(makeInput(h), h.logger, {
      sdkQuery: fakeSdkQueryClean,
      brainLint: makeCleanLintStub(),
    });

    assert.equal(result.reflection_status, 'closed');
    assert.equal(result.lint_status, 'clean');

    const events = h.events();
    const lintEvent = events.find((e) => e.message === 'reflector.lint-invoked');
    assert.ok(lintEvent, 'expected reflector.lint-invoked event');
    assert.equal(lintEvent!.metadata?.['result'], 'clean');
    assert.equal(lintEvent!.metadata?.['findings_count'], 0);

    // Brain-lint report written even on clean.
    const reportPath = resolve(h.cycleLogDir, 'brain-lint.md');
    assert.ok(existsSync(reportPath), 'expected brain-lint.md report');
    const body = readFileSync(reportPath, 'utf8');
    assert.match(body, /no findings/);
  } finally {
    h.cleanup();
  }
});

test('runReflector: missing brain-lint executable → lint_status:skipped + lint-skipped event', async () => {
  const h = setupHarness({ suffix: 'missing' });
  try {
    const result = await runReflector(makeInput(h), h.logger, {
      sdkQuery: fakeSdkQueryClean,
      brainLint: makeMissingLintStub(),
    });

    assert.equal(result.reflection_status, 'closed', 'reflection should still close');
    assert.equal(result.lint_status, 'skipped');

    const events = h.events();
    const skippedEvent = events.find((e) => e.message === 'reflector.lint-skipped');
    assert.ok(skippedEvent, 'expected reflector.lint-skipped event');
    assert.equal(skippedEvent!.metadata?.['reason'], 'executable-missing');

    // No `lint-invoked` event when skipped.
    assert.equal(
      events.find((e) => e.message === 'reflector.lint-invoked'),
      undefined,
    );
  } finally {
    h.cleanup();
  }
});

test('runReflector: lint exits with findings → lint_status:flagged + lint-flagged event + report written', async () => {
  const h = setupHarness({ suffix: 'flagged' });
  try {
    const result = await runReflector(makeInput(h), h.logger, {
      sdkQuery: fakeSdkQueryClean,
      brainLint: makeFlaggedLintStub(),
    });

    assert.equal(result.reflection_status, 'closed', 'flagged lint must NOT block close');
    assert.equal(result.lint_status, 'flagged');

    const events = h.events();
    const flaggedEvent = events.find((e) => e.message === 'reflector.lint-flagged');
    assert.ok(flaggedEvent, 'expected reflector.lint-flagged event');
    assert.equal(flaggedEvent!.metadata?.['findings_count'], 2);

    // Report file present + non-empty.
    const reportPath = resolve(h.cycleLogDir, 'brain-lint.md');
    assert.ok(existsSync(reportPath), 'expected brain-lint.md report on flagged run');
    const body = readFileSync(reportPath, 'utf8');
    assert.match(body, /Errors/);
    assert.match(body, /missing required frontmatter/);
  } finally {
    h.cleanup();
  }
});

test('runReflector: reflection_status stays closed regardless of lint outcome', async () => {
  // Combined sweep — ensures the three lint outcomes do NOT change the
  // reflection close gate. Lint is informational only (per C8 + plan 06 +
  // feedback_reflection_close_criterion).
  const cases: Array<{
    suffix: string;
    stub: (opts: { cwd: string; cycleId: string }) => RunBrainLintResult;
    expectLint: 'clean' | 'flagged' | 'skipped';
  }> = [
    { suffix: 'sweep-clean', stub: makeCleanLintStub(), expectLint: 'clean' },
    { suffix: 'sweep-flagged', stub: makeFlaggedLintStub(), expectLint: 'flagged' },
    { suffix: 'sweep-missing', stub: makeMissingLintStub(), expectLint: 'skipped' },
  ];
  for (const c of cases) {
    const h = setupHarness({ suffix: c.suffix });
    try {
      const result = await runReflector(makeInput(h), h.logger, {
        sdkQuery: fakeSdkQueryClean,
        brainLint: c.stub,
      });
      assert.equal(
        result.reflection_status,
        'closed',
        `case ${c.suffix} should close`,
      );
      assert.equal(result.lint_status, c.expectLint);
    } finally {
      h.cleanup();
    }
  }
});

test('runReflector: brain-gate failure → reflection_status:failed + lint_status:skipped', async () => {
  // Sanity check: when the F-13 brain-first gate fails (zero brain reads),
  // reflection fails BEFORE lint runs. This confirms lint is gated on the
  // brain-gate, not the other way around.
  const h = setupHarness({ suffix: 'brain-gate-fail' });
  try {
    async function* fakeSdkQueryNoBrain(): AsyncIterable<unknown> {
      yield {
        type: 'assistant',
        message: {
          content: [
            // No brain reads at all.
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.01,
        duration_ms: 100,
      };
    }
    const result = await runReflector(makeInput(h), h.logger, {
      sdkQuery: fakeSdkQueryNoBrain,
      brainLint: makeCleanLintStub(),
    });
    assert.equal(result.reflection_status, 'failed');
    assert.equal(result.lint_status, 'skipped');
    // brain-skipped should be emitted; lint-invoked should NOT.
    const events = h.events();
    assert.ok(events.find((e) => e.message === 'reflector.brain-skipped'));
    assert.equal(events.find((e) => e.message === 'reflector.lint-invoked'), undefined);
  } finally {
    h.cleanup();
  }
});

test('runReflector: emits brain-bench-candidates.jsonl (one row per matched gap)', async () => {
  // Wire up a cycle where:
  //   - brain-gaps.jsonl has 2 gap rows (one matching, one not).
  //   - the agent stub "writes" a project theme file matching one gap's
  //     keywords (we pre-create it under the forge tree's brain/projects/
  //     slugifier/themes/ to mimic what the real agent would do).
  // Expected: candidates.jsonl has 1 row pointing at the written theme;
  // `reflector.bench-candidates-emitted` event fires with count=1.
  const h = setupHarness({ suffix: 'bench-cand' });
  // Pre-write brain-gaps.jsonl with two distinct gaps. The reflector's
  // F-12 touch is a no-op since the file already exists.
  const gapsPath = resolve(h.cycleLogDir, 'brain-gaps.jsonl');
  // ensure the cycle log dir exists (logger creates it but writing the
  // gaps file before the SDK kicks off is the cleaner path).
  try {
    mkdirSync(h.cycleLogDir, { recursive: true });
  } catch {
    /* dir may already exist */
  }
  writeFileSync(
    gapsPath,
    [
      JSON.stringify({
        gap_id: 'GAP-001',
        query: 'How does slugifier handle batch processing with options?',
      }),
      JSON.stringify({
        gap_id: 'GAP-002',
        query: 'Completely unrelated question about other domain xyz',
      }),
      '',
    ].join('\n'),
  );

  // Pre-create the matching theme file in the forge tree so the
  // `listFreshThemes` heuristic picks it up. The themesDir the reflector
  // computes is `<FORGE_ROOT>/brain/projects/<project>/themes`. Project
  // is `slugifier` (set in setupHarness). We add a uniquely-named theme
  // so the cleanup is targeted and we don't trample real brain content.
  const projectThemesDir = resolve(FORGE_ROOT, 'brain', 'projects', 'slugifier', 'themes');
  const themeFile = resolve(projectThemesDir, `__test-${h.cycleId.slice(-12)}-slugifier-batch-options.md`);
  try {
    mkdirSync(projectThemesDir, { recursive: true });
  } catch {
    /* may exist */
  }
  writeFileSync(
    themeFile,
    [
      '---',
      'title: Slugifier batch processing options',
      'description: How slugifier processes batches with options',
      'category: pattern',
      'keywords: [slugifier, batch, processing, options, helpers]',
      'created_at: 2026-05-23T12:00:00Z',
      'updated_at: 2026-05-23T12:00:00Z',
      '---',
      '',
      '# Slugifier batch processing options',
      '',
      'Body...',
    ].join('\n'),
  );
  // Bump the theme's mtime to slightly in the future so `listFreshThemes`
  // (mtime >= startedAtMs) picks it up — in production the agent writes
  // the file *during* the reflector pass, which we mimic here.
  const futureSec = (Date.now() + 5000) / 1000;
  utimesSync(themeFile, futureSec, futureSec);

  try {
    const result = await runReflector(makeInput(h), h.logger, {
      sdkQuery: fakeSdkQueryClean,
      brainLint: makeCleanLintStub(),
    });
    assert.equal(result.reflection_status, 'closed');

    const candidatesPath = resolve(h.cycleLogDir, 'brain-bench-candidates.jsonl');
    assert.ok(existsSync(candidatesPath), 'expected brain-bench-candidates.jsonl');
    const body = readFileSync(candidatesPath, 'utf8').trim();
    assert.ok(body.length > 0, 'expected non-empty candidates file');
    const lines = body.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'expected exactly 1 candidate (only one gap matched)');
    const candidate = JSON.parse(lines[0]);
    assert.equal(candidate.gap_id, 'GAP-001');
    assert.ok(
      candidate.expected_sources.some((s: string) => s.includes('slugifier-batch-options')),
      'candidate should point at the written theme',
    );
    assert.equal(candidate.scope, 'slugifier');

    const events = h.events();
    const emitEvent = events.find((e) => e.message === 'reflector.bench-candidates-emitted');
    assert.ok(emitEvent, 'expected reflector.bench-candidates-emitted event');
    assert.equal(emitEvent!.metadata?.['count'], 1);
  } finally {
    // Clean up the test theme so the live brain stays untouched.
    try {
      rmSync(themeFile, { force: true });
    } catch {
      /* best-effort */
    }
    h.cleanup();
  }
});

test('runReflector: zero gaps → empty candidates.jsonl, no emit event', async () => {
  const h = setupHarness({ suffix: 'no-gaps' });
  try {
    const result = await runReflector(makeInput(h), h.logger, {
      sdkQuery: fakeSdkQueryClean,
      brainLint: makeCleanLintStub(),
    });
    assert.equal(result.reflection_status, 'closed');
    const candidatesPath = resolve(h.cycleLogDir, 'brain-bench-candidates.jsonl');
    // File should exist (touched by the emit pass) but be empty.
    assert.ok(existsSync(candidatesPath));
    assert.equal(readFileSync(candidatesPath, 'utf8'), '');
    // No emit event when count = 0.
    const events = h.events();
    assert.equal(
      events.find((e) => e.message === 'reflector.bench-candidates-emitted'),
      undefined,
    );
  } finally {
    h.cleanup();
  }
});

test('runReflector: emits retention-assigned event on successful close', async () => {
  // Even when no themes are written by the stub agent, the retention
  // heuristic still runs and emits an event (defaults to 'routine' with
  // an empty cited_by — confirms the wiring fires).
  const h = setupHarness({ suffix: 'retention-evt' });
  try {
    const result = await runReflector(makeInput(h), h.logger, {
      sdkQuery: fakeSdkQueryClean,
      brainLint: makeCleanLintStub(),
    });
    assert.equal(result.reflection_status, 'closed');
    const events = h.events();
    const retentionEvent = events.find(
      (e) => e.message === 'reflector.retention-assigned',
    );
    assert.ok(retentionEvent, 'expected reflector.retention-assigned event');
    assert.ok(
      ['load-bearing', 'interesting', 'routine'].includes(
        String(retentionEvent!.metadata?.['retention']),
      ),
    );
  } finally {
    h.cleanup();
  }
});
