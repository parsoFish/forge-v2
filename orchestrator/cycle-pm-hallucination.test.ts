/**
 * S3 / C5b — orchestrator-side retry on PM feature-hallucination.
 *
 * The PM validator hard-errors when a WI's `feature_id` is not in the
 * manifest's known set; `runProjectManager` catches that, retries the PM
 * **once** with an augmented prompt naming the manifest's feature IDs
 * verbatim, and on a second hallucination throws + emits
 * `pm.feature-hallucination` so the failure-classifier surfaces the
 * terminal `pm-feature-hallucination` mode.
 *
 * These tests inject a stub SDK queryFn — no network — and verify both
 * the recovery path (hallucinate → retry → succeed) and the persistent-
 * failure path (hallucinate → retry → hallucinate → throw).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runProjectManager, type PmQueryFn } from './phases/project-manager.ts';
import { createLogger, type EventLogEntry } from './logging.ts';
import type { CycleInput } from './cycle-context.ts';
import { classifyCycleFailure } from './failure-classifier.ts';

const MANIFEST_BODY = `---
initiative_id: INIT-2026-05-20-hallucination-test
project: testproj
project_repo_path: ./projects/testproj
created_at: 2026-05-20T00:00:00Z
iteration_budget: 3
cost_budget_usd: 1
phase: in-flight
origin: architect
features:
  - feature_id: FEAT-1
    title: First feature
    depends_on: []
  - feature_id: FEAT-2
    title: Second feature
    depends_on: []
  - feature_id: FEAT-3
    title: Third feature
    depends_on: []
  - feature_id: FEAT-4
    title: Fourth feature
    depends_on: []
---

# Test initiative

Implement four small features for the hallucination retry harness.
`;

/**
 * Frontmatter for a clean work-item that points at FEAT-N. The file is
 * deliberately tiny — we only need it to round-trip through readWorkItemsFromDir
 * and pass validateWorkItem.
 */
function makeWi(opts: {
  wiId: string;
  featureId: string;
  initiativeId: string;
  filename?: string;
  dependsOn?: string[];
}): string {
  const fname = opts.filename ?? `src/${opts.wiId.toLowerCase()}.ts`;
  const deps = (opts.dependsOn ?? []).map((d) => `'${d}'`).join(', ');
  return `---
work_item_id: ${opts.wiId}
feature_id: ${opts.featureId}
initiative_id: ${opts.initiativeId}
status: pending
depends_on: [${deps}]
acceptance_criteria:
  - given: "a test"
    when: "the function runs"
    then: "it returns a value"
files_in_scope:
  - ${fname}
creates:
  - ${fname}
estimated_iterations: 1
---

Body for ${opts.wiId}.
`;
}

function makeGraph(wiIds: readonly string[]): string {
  return [
    '```mermaid',
    'graph TD',
    ...wiIds.map((id) => `  ${id}["${id}"]`),
    '```',
  ].join('\n');
}

/**
 * Build a stub SDK queryFn that writes a canned set of work items to
 * `cwd/.forge/work-items/` then emits an assistant message (with a brain
 * read so the brain-gate is satisfied) and a result message.
 *
 * Each call to the returned function corresponds to one PM pass; the
 * caller supplies the per-pass WI-file map.
 */
function makeStubQueryFn(passes: Array<{
  wis: Array<{ wiId: string; featureId: string; filename?: string; dependsOn?: string[] }>;
  initiativeId: string;
}>): { queryFn: PmQueryFn; callCount: () => number } {
  let callIndex = 0;
  const fn: PmQueryFn = ({ options }) => {
    const passIndex = callIndex;
    callIndex += 1;
    const pass = passes[passIndex];
    if (!pass) {
      throw new Error(`stub queryFn called ${callIndex}× but only ${passes.length} pass(es) configured`);
    }
    const cwd = (options as { cwd: string }).cwd;
    return (async function* () {
      // Emit a synthetic assistant message that "reads" the brain so the
      // F-13 brain gate is satisfied on pass 1.
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Read',
              input: { file_path: 'brain/forge/themes/work-item-completion-by-domain.md' },
            },
          ],
        },
      };
      // Actually write the WI files + graph the PM would have written.
      const wiDir = resolve(cwd, '.forge', 'work-items');
      mkdirSync(wiDir, { recursive: true });
      for (const wi of pass.wis) {
        const md = makeWi({
          wiId: wi.wiId,
          featureId: wi.featureId,
          initiativeId: pass.initiativeId,
          filename: wi.filename,
          dependsOn: wi.dependsOn,
        });
        writeFileSync(join(wiDir, `${wi.wiId}.md`), md);
      }
      writeFileSync(
        join(wiDir, '_graph.md'),
        makeGraph(pass.wis.map((w) => w.wiId)),
      );
      yield {
        type: 'result',
        subtype: 'success',
        duration_ms: 1234,
        total_cost_usd: 0.05,
      };
    })();
  };
  return { queryFn: fn, callCount: () => callIndex };
}

type Harness = {
  dir: string;
  worktree: string;
  manifestPath: string;
  logger: ReturnType<typeof createLogger>;
  input: CycleInput;
};

function setupHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'forge-pm-halluc-'));
  const worktree = join(dir, 'projects', 'testproj');
  mkdirSync(worktree, { recursive: true });
  // Write a package.json so PM's worktree looks like a real project.
  writeFileSync(
    join(worktree, 'package.json'),
    JSON.stringify({ name: 'testproj', version: '0.0.1', scripts: { test: 'echo no tests' } }, null, 2),
  );
  const manifestPath = join(dir, '_queue', 'in-flight', 'INIT-2026-05-20-hallucination-test.md');
  mkdirSync(join(dir, '_queue', 'in-flight'), { recursive: true });
  writeFileSync(manifestPath, MANIFEST_BODY);
  const logsDir = join(dir, '_logs');
  mkdirSync(logsDir, { recursive: true });
  const logger = createLogger('TEST-cycle-halluc', logsDir);
  const input: CycleInput = {
    initiativeId: 'INIT-2026-05-20-hallucination-test',
    manifestPath,
    projectRepoPath: worktree,
    worktreePath: worktree,
  };
  return { dir, worktree, manifestPath, logger, input };
}

function readEvents(logger: ReturnType<typeof createLogger>): EventLogEntry[] {
  const text = readFileSync(logger.logFilePath, 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as EventLogEntry);
}

test('runProjectManager: hallucinates FEAT-5 on pass 1, recovers on retry', async () => {
  const h = setupHarness();
  try {
    const { queryFn, callCount } = makeStubQueryFn([
      // Pass 1: invent FEAT-5 alongside legitimate FEATs.
      {
        initiativeId: h.input.initiativeId,
        wis: [
          { wiId: 'WI-1', featureId: 'FEAT-1' },
          { wiId: 'WI-2', featureId: 'FEAT-2' },
          { wiId: 'WI-3', featureId: 'FEAT-5' }, // hallucinated
        ],
      },
      // Pass 2: clean — only manifest-known feature IDs.
      {
        initiativeId: h.input.initiativeId,
        wis: [
          { wiId: 'WI-1', featureId: 'FEAT-1' },
          { wiId: 'WI-2', featureId: 'FEAT-2' },
          { wiId: 'WI-3', featureId: 'FEAT-3' },
        ],
      },
    ]);

    await runProjectManager(h.input, h.logger, { queryFn });

    assert.equal(callCount(), 2, 'expected two SDK passes (one retry)');

    const events = readEvents(h.logger);
    const retryEvent = events.find((e) => e.message === 'pm.feature-hallucination-retry');
    assert.ok(retryEvent, 'expected pm.feature-hallucination-retry log event');
    assert.deepEqual(
      (retryEvent.metadata as { hallucinated_feature_ids: string[] }).hallucinated_feature_ids,
      ['FEAT-5'],
    );

    // Final WI files in worktree are the clean set (pass 2's output —
    // pass 1's are wiped before pass 2 runs).
    const wiDir = resolve(h.worktree, '.forge', 'work-items');
    const finalFile = readFileSync(join(wiDir, 'WI-3.md'), 'utf8');
    assert.match(finalFile, /feature_id: FEAT-3/);

    // No terminal hallucination event should have been emitted.
    assert.equal(
      events.filter((e) => e.message === 'pm.feature-hallucination').length,
      0,
      'must not emit terminal pm.feature-hallucination on a recovered pass',
    );
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('runProjectManager: two consecutive hallucinations throws + emits pm.feature-hallucination', async () => {
  const h = setupHarness();
  try {
    const { queryFn, callCount } = makeStubQueryFn([
      {
        initiativeId: h.input.initiativeId,
        wis: [
          { wiId: 'WI-1', featureId: 'FEAT-1' },
          { wiId: 'WI-2', featureId: 'FEAT-5' }, // hallucinated
        ],
      },
      {
        initiativeId: h.input.initiativeId,
        wis: [
          { wiId: 'WI-1', featureId: 'FEAT-1' },
          { wiId: 'WI-2', featureId: 'FEAT-9' }, // still hallucinated
        ],
      },
    ]);

    await assert.rejects(
      () => runProjectManager(h.input, h.logger, { queryFn }),
      /feature_id hallucination persisted/,
    );
    assert.equal(callCount(), 2, 'expected two SDK passes (no further retries)');

    const events = readEvents(h.logger);
    const terminal = events.find((e) => e.message === 'pm.feature-hallucination');
    assert.ok(terminal, 'expected terminal pm.feature-hallucination event');
    assert.equal(terminal.event_type, 'error');
    assert.equal(
      (terminal.metadata as { passes_attempted: number }).passes_attempted,
      2,
    );

    // Classifier picks this up as terminal (PM lost the manifest contract).
    const classification = classifyCycleFailure(events);
    assert.equal(classification.kind, 'terminal');
    assert.equal(classification.recoverable, false);
    assert.match(classification.reason, /feature_id not in the manifest/i);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('runProjectManager: clean first pass needs no retry', async () => {
  const h = setupHarness();
  try {
    const { queryFn, callCount } = makeStubQueryFn([
      {
        initiativeId: h.input.initiativeId,
        wis: [
          { wiId: 'WI-1', featureId: 'FEAT-1' },
          { wiId: 'WI-2', featureId: 'FEAT-2' },
        ],
      },
    ]);

    await runProjectManager(h.input, h.logger, { queryFn });
    assert.equal(callCount(), 1, 'expected exactly one SDK pass on a clean run');

    const events = readEvents(h.logger);
    const retry = events.find((e) => e.message === 'pm.feature-hallucination-retry');
    assert.equal(retry, undefined, 'must not retry when the first pass is clean');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});
