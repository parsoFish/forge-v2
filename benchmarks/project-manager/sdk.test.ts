/**
 * Tests for runProjectManager — the SDK-invocation glue. The SDK's `query` is
 * dependency-injectable; the fake yields message sequences and writes work
 * items into the agent's tempdir to simulate the real flow.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  cleanupTempdir,
  runProjectManager,
  setupTempdir,
  type PmQueryFn,
  type RunPmInput,
} from './sdk.ts';

const FIXTURE_MANIFEST = [
  '---',
  'initiative_id: INIT-2026-05-08-test',
  'project: demo',
  'project_repo_path: projects/demo',
  'created_at: 2026-05-08T10:00:00Z',
  'iteration_budget: 10',
  'cost_budget_usd: 5',
  'phase: in-flight',
  'features:',
  '  - feature_id: FEAT-1',
  '    title: Test feature',
  '    depends_on: []',
  '---',
  '',
  '# Test initiative',
  '',
  'Body.',
].join('\n');

const baseInput: Omit<RunPmInput, 'queryFn'> = {
  fixtureId: 'TEST',
  initiativeId: 'INIT-2026-05-08-test',
  initiativeManifest: FIXTURE_MANIFEST,
  projectName: 'demo',
  expected: { min_work_items: 1, max_work_items: 5, parallel_fraction_at_least: 0.3 },
};

function fakeQueryFn(messages: unknown[], onCall?: (cwd: string) => void): PmQueryFn {
  return ({ options }) => {
    if (onCall && options) onCall((options as { cwd?: string }).cwd ?? '');
    async function* gen() {
      for (const m of messages) yield m;
    }
    return gen();
  };
}

function writeWorkItemFile(cwd: string, projectName: string, id: string, body: string): void {
  const dir = resolve(cwd, 'projects', projectName, '.forge', 'work-items');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${id}.md`), body);
}

function makeWiContent(id: string, opts: { depends_on?: string[]; files?: string[] } = {}): string {
  const deps = (opts.depends_on ?? []).map((d) => `  - ${d}`).join('\n');
  const files = (opts.files ?? ['src/x.ts']).map((f) => `  - ${f}`).join('\n');
  return [
    '---',
    `work_item_id: ${id}`,
    'feature_id: FEAT-1',
    'initiative_id: INIT-2026-05-08-test',
    'status: pending',
    `depends_on:${opts.depends_on && opts.depends_on.length > 0 ? '\n' + deps : ' []'}`,
    'acceptance_criteria:',
    '  - given: precondition',
    '    when: action',
    '    then: outcome',
    `files_in_scope:\n${files}`,
    'estimated_iterations: 2',
    '---',
    '',
    'rationale',
  ].join('\n');
}

test('setupTempdir: creates _queue/in-flight, projects/<name>/, symlinks brain', () => {
  const dir = setupTempdir(baseInput);
  try {
    assert.ok(existsSync(resolve(dir, '_queue/in-flight')));
    assert.ok(existsSync(resolve(dir, '_queue/in-flight/INIT-2026-05-08-test.md')));
    assert.ok(existsSync(resolve(dir, 'projects/demo')));
    assert.ok(existsSync(resolve(dir, 'brain')));
    assert.ok(existsSync(resolve(dir, 'skills')));
  } finally {
    cleanupTempdir(dir);
  }
});

test('setupTempdir: scaffolds README.md when no projectTreePath supplied', () => {
  const dir = setupTempdir(baseInput);
  try {
    assert.ok(existsSync(resolve(dir, 'projects/demo/README.md')));
  } finally {
    cleanupTempdir(dir);
  }
});

test('runProjectManager: reads back work items the agent wrote in tempdir', async () => {
  const queryFn = fakeQueryFn(
    [{ type: 'result', subtype: 'success', duration_ms: 1234, total_cost_usd: 0.0042 }],
    (cwd) => {
      writeWorkItemFile(cwd, 'demo', 'WI-1', makeWiContent('WI-1'));
      writeWorkItemFile(cwd, 'demo', 'WI-2', makeWiContent('WI-2', { depends_on: ['WI-1'], files: ['src/y.ts'] }));
      const graphPath = resolve(cwd, 'projects/demo/.forge/work-items/_graph.md');
      writeFileSync(graphPath, '```mermaid\ngraph TD\n  WI-1["one"]\n  WI-2["two"]\n  WI-1 --> WI-2\n```\n');
    },
  );

  const r = await runProjectManager({ ...baseInput, queryFn });
  try {
    assert.equal(r.runnerError, undefined);
    assert.equal(r.durationMs, 1234);
    assert.equal(r.costUsd, 0.0042);
    assert.equal(r.workItems.length, 2);
    assert.equal(r.workItems[0]!.work_item_id, 'WI-1');
    assert.equal(r.workItems[1]!.work_item_id, 'WI-2');
    assert.notEqual(r.graphText, null);
    assert.match(r.graphText!, /graph TD/);
  } finally {
    cleanupTempdir(r.tempdir);
  }
});

test('runProjectManager: tallies brain reads, writes, bash calls', async () => {
  const queryFn = fakeQueryFn(
    [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: 'brain/forge/themes/x.md' } },
            { type: 'tool_use', name: 'Grep', input: { pattern: 'thing', path: 'brain/' } },
            { type: 'tool_use', name: 'Read', input: { file_path: 'docs/phases/project-manager.md' } },
            { type: 'tool_use', name: 'Write', input: { file_path: 'projects/demo/.forge/work-items/WI-1.md' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: 'projects/demo/.forge/work-items/WI-1.md' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      { type: 'result', subtype: 'success', duration_ms: 100, total_cost_usd: 0.001 },
    ],
    (cwd) => {
      writeWorkItemFile(cwd, 'demo', 'WI-1', makeWiContent('WI-1'));
    },
  );

  const r = await runProjectManager({ ...baseInput, queryFn });
  try {
    assert.equal(r.toolUseSummary.brainReads, 2);
    assert.equal(r.toolUseSummary.writes, 2);
    assert.equal(r.toolUseSummary.bashCalls, 1);
  } finally {
    cleanupTempdir(r.tempdir);
  }
});

test('runProjectManager: missing work items surfaces as no_work_items_written', async () => {
  const queryFn = fakeQueryFn([
    { type: 'result', subtype: 'success', duration_ms: 100, total_cost_usd: 0.001 },
  ]);

  const r = await runProjectManager({ ...baseInput, queryFn });
  try {
    assert.equal(r.workItems.length, 0);
    assert.equal(r.runnerError?.kind, 'no_work_items_written');
  } finally {
    cleanupTempdir(r.tempdir);
  }
});

test('runProjectManager: parse errors surface as work_item_parse_error', async () => {
  const queryFn = fakeQueryFn(
    [{ type: 'result', subtype: 'success', duration_ms: 100, total_cost_usd: 0.001 }],
    (cwd) => {
      // Valid one + intentionally malformed (missing required field)
      writeWorkItemFile(cwd, 'demo', 'WI-1', makeWiContent('WI-1'));
      writeWorkItemFile(cwd, 'demo', 'WI-2', '---\nfeature_id: FEAT-1\n---\nbody');
    },
  );

  const r = await runProjectManager({ ...baseInput, queryFn });
  try {
    assert.equal(r.runnerError?.kind, 'work_item_parse_error');
    assert.equal(r.workItems.length, 1);
    assert.ok(Object.keys(r.parseErrors).length > 0);
  } finally {
    cleanupTempdir(r.tempdir);
  }
});

test('runProjectManager: maps error_max_turns to runner_error', async () => {
  const queryFn = fakeQueryFn([
    { type: 'result', subtype: 'error_max_turns', duration_ms: 500, total_cost_usd: 0.01 },
  ]);
  const r = await runProjectManager({ ...baseInput, queryFn });
  try {
    assert.equal(r.runnerError?.kind, 'error_max_turns');
  } finally {
    cleanupTempdir(r.tempdir);
  }
});

test('runProjectManager: empty iterator surfaces as no_result', async () => {
  const queryFn = fakeQueryFn([]);
  const r = await runProjectManager({ ...baseInput, queryFn });
  try {
    assert.equal(r.runnerError?.kind, 'no_result');
  } finally {
    cleanupTempdir(r.tempdir);
  }
});
