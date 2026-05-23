/**
 * Unit tests for benchmarks/e2e/simulator.ts. Tests the verdict-parsing logic
 * (no SDK calls — uses the stub queryFn injection for the end-to-end
 * simulator-as-pipeline test).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  parseVerdict,
  runSpecChecks,
  simulatorVerdict,
  type SimulatorQueryFn,
  type TargetSpec,
} from './simulator.ts';
import type { VerdictContext } from '../../orchestrator/file-verdict.ts';
import type { WorkItem } from '../../orchestrator/work-item.ts';

// ---------- parseVerdict ----------

test('parseVerdict: well-formed approve fenced JSON', () => {
  const text = '```json\n{"kind":"approve","rationale":"lgtm — every check passed"}\n```';
  const v = parseVerdict(text);
  assert.equal(v.kind, 'approve');
  if (v.kind === 'approve') assert.match(v.rationale, /every check passed/);
});

test('parseVerdict: well-formed send-back with multiple ACs', () => {
  const text = `\`\`\`json
{
  "kind": "send-back",
  "rationale": "missing edge case coverage",
  "feedback": [
    {"given": "an empty input", "when": "fn() is called", "then": "an empty result is returned"},
    {"given": "an emoji input", "when": "fn() is called", "then": "emoji are stripped"}
  ]
}
\`\`\``;
  const v = parseVerdict(text);
  assert.equal(v.kind, 'send-back');
  if (v.kind === 'send-back') {
    assert.equal(v.feedback.length, 2);
    assert.equal(v.feedback[0].given, 'an empty input');
    assert.equal(v.feedback[1].then, 'emoji are stripped');
  }
});

test('parseVerdict: tolerates prose around the JSON block', () => {
  const text = `Looking at the spec results, I see the manifest ACs pass.

\`\`\`json
{"kind":"approve","rationale":"good"}
\`\`\`

Hope that helps.`;
  const v = parseVerdict(text);
  assert.equal(v.kind, 'approve');
});

test('parseVerdict: bare JSON (no fence) is accepted', () => {
  const text = '{"kind":"approve","rationale":"clean"}';
  const v = parseVerdict(text);
  assert.equal(v.kind, 'approve');
});

test('parseVerdict: throws on malformed JSON', () => {
  assert.throws(() => parseVerdict('not json at all'), /not valid JSON/);
});

test('parseVerdict: throws on unknown kind', () => {
  assert.throws(
    () => parseVerdict('{"kind":"maybe","rationale":"x"}'),
    /unknown kind/,
  );
});

test('parseVerdict: throws on send-back with empty feedback', () => {
  assert.throws(
    () => parseVerdict('{"kind":"send-back","rationale":"x","feedback":[]}'),
    /no valid feedback/,
  );
});

test('parseVerdict: drops feedback items with empty given/when/then', () => {
  const text = `\`\`\`json
{
  "kind": "send-back",
  "rationale": "x",
  "feedback": [
    {"given": "", "when": "ok", "then": "ok"},
    {"given": "g", "when": "w", "then": "t"}
  ]
}
\`\`\``;
  const v = parseVerdict(text);
  assert.equal(v.kind, 'send-back');
  if (v.kind === 'send-back') {
    assert.equal(v.feedback.length, 1);
    assert.equal(v.feedback[0].given, 'g');
  }
});

// ---------- runSpecChecks ----------

function setupFixture(): {
  worktree: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'forge-e2e-spec-test-'));
  mkdirSync(join(dir, '.forge'));
  return { worktree: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('runSpecChecks: manifest AC command + non-functional checks + PR signals', () => {
  const { worktree, cleanup } = setupFixture();
  try {
    writeFileSync(
      resolve(worktree, '.forge', 'pr-description.md'),
      '## Why\nTo handle edge cases\n## What\nadds new fn\n## How\nstd lib\n## Demo\n[link](.forge/demos/x/recording.mp4)\n',
    );
    const spec: TargetSpec = {
      manifest_ac_command: ['true'],
      non_functional_checks: [
        { description: 'always passes', command: ['true'] },
        { description: 'always fails', command: ['false'] },
      ],
      required_pr_signals: ['Why', 'edge', 'NotPresent'],
    };
    const result = runSpecChecks(worktree, spec);
    assert.equal(result.manifest_acs_pass, true);
    assert.equal(result.non_functional_results.length, 2);
    assert.equal(result.non_functional_results[0].passed, true);
    assert.equal(result.non_functional_results[1].passed, false);
    assert.equal(result.pr_signals_present['Why'], true);
    assert.equal(result.pr_signals_present['edge'], true);
    assert.equal(result.pr_signals_present['NotPresent'], false);
  } finally {
    cleanup();
  }
});

test('runSpecChecks: missing pr-description.md makes all signals false', () => {
  const { worktree, cleanup } = setupFixture();
  try {
    const spec: TargetSpec = {
      manifest_ac_command: ['true'],
      non_functional_checks: [],
      required_pr_signals: ['Why', 'What'],
    };
    const result = runSpecChecks(worktree, spec);
    assert.equal(result.pr_signals_present['Why'], false);
    assert.equal(result.pr_signals_present['What'], false);
  } finally {
    cleanup();
  }
});

// ---------- simulatorVerdict (with stub queryFn) ----------

function makeWi(): WorkItem {
  return {
    work_item_id: 'WI-1',
    feature_id: 'FEAT-1',
    initiative_id: 'INIT-x',
    status: 'complete',
    depends_on: [],
    acceptance_criteria: [{ given: 'g', when: 'w', then: 't' }],
    files_in_scope: ['src/foo.ts'],
    estimated_iterations: 1,
    body: '',
  };
}

function makeCtx(worktreePath: string): VerdictContext {
  return {
    initiativeId: 'INIT-test',
    worktreePath,
    manifestPath: '/tmp/manifest.md',
    prDescriptionPath: resolve(worktreePath, '.forge', 'pr-description.md'),
    demoBundleDir: resolve(worktreePath, '.forge', 'demos', 'INIT-test'),
    workItems: [makeWi()],
    diffSummary: 'src/foo.ts | 5 +++++\n 1 file changed, 5 insertions(+)',
    roundNumber: 1,
  };
}

function fakeQueryFn(assistantText: string): SimulatorQueryFn {
  return ({ prompt: _p, options: _o }) =>
    (async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: assistantText }] },
      };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 200 };
    })();
}

test('simulatorVerdict: stub queryFn returning approve produces approve verdict', async () => {
  const { worktree, cleanup } = setupFixture();
  try {
    writeFileSync(resolve(worktree, '.forge', 'pr-description.md'), '## Why\nx');
    const v = await simulatorVerdict({
      ctx: makeCtx(worktree),
      spec: {
        manifest_ac_command: ['true'],
        non_functional_checks: [],
        required_pr_signals: [],
      },
      preComputedSpecResults: {
        manifest_acs_pass: true,
        non_functional_results: [],
        pr_signals_present: {},
      },
      queryFn: fakeQueryFn('```json\n{"kind":"approve","rationale":"all good"}\n```'),
    });
    assert.equal(v.kind, 'approve');
  } finally {
    cleanup();
  }
});

test('simulatorVerdict: stub returning send-back produces send-back verdict with feedback', async () => {
  const { worktree, cleanup } = setupFixture();
  try {
    writeFileSync(resolve(worktree, '.forge', 'pr-description.md'), '## Why\nx');
    const v = await simulatorVerdict({
      ctx: makeCtx(worktree),
      spec: {
        manifest_ac_command: ['true'],
        non_functional_checks: [],
        required_pr_signals: [],
      },
      preComputedSpecResults: {
        manifest_acs_pass: false,
        non_functional_results: [],
        pr_signals_present: {},
      },
      queryFn: fakeQueryFn(
        '```json\n{"kind":"send-back","rationale":"missing edge case","feedback":[{"given":"empty","when":"slugify(\\"\\")","then":"returns empty string"}]}\n```',
      ),
    });
    assert.equal(v.kind, 'send-back');
    if (v.kind === 'send-back') {
      assert.equal(v.feedback.length, 1);
      assert.equal(v.feedback[0].given, 'empty');
    }
  } finally {
    cleanup();
  }
});
