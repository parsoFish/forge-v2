/**
 * Unit tests for orchestrator/unifier-invocation.ts.
 *
 * The unifier-invocation contract is the developer-unifier sub-phase's
 * equivalent of `dev-invocation.ts` for per-WI Ralphs: system prompt builder,
 * per-iteration prompt builder, workspace prep. Tests are file-system tests
 * (tmp dir, write/read assertions) — no SDK invocation, no shells.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildUnifierSystemPrompt,
  prepareUnifierWorkspace,
  renderUnifierUserPrompt,
  UNIFIER_ALLOWED_TOOLS,
  UNIFIER_DISALLOWED_TOOLS,
  UNIFIER_MODEL,
} from './unifier-invocation.ts';

function newTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'forge-unifier-test-'));
}

test('UNIFIER_ALLOWED_TOOLS includes Bash and Write (needed for tests + commits + PR draft)', () => {
  assert.ok(UNIFIER_ALLOWED_TOOLS.includes('Bash'));
  assert.ok(UNIFIER_ALLOWED_TOOLS.includes('Write'));
  assert.ok(UNIFIER_ALLOWED_TOOLS.includes('Read'));
});

test('UNIFIER_DISALLOWED_TOOLS bans web tools', () => {
  assert.ok(UNIFIER_DISALLOWED_TOOLS.includes('WebFetch'));
  assert.ok(UNIFIER_DISALLOWED_TOOLS.includes('WebSearch'));
});

test('UNIFIER_MODEL is sonnet (per dev-loop model parity)', () => {
  assert.equal(UNIFIER_MODEL, 'claude-sonnet-4-6');
});

test('buildUnifierSystemPrompt: includes SKILL.md text + Ralph discipline notes', () => {
  const sys = buildUnifierSystemPrompt();
  assert.ok(sys.includes('developer-unifier'), 'should mention skill name');
  assert.ok(sys.includes('initiative'), 'should reference initiative scope');
  assert.ok(sys.includes('Ralph'), 'should reference Ralph loop discipline');
  assert.ok(sys.length > 1000, 'system prompt should be substantive');
});

test('renderUnifierUserPrompt: initial-prep mode references manifest + WIs', () => {
  const prompt = renderUnifierUserPrompt({
    initiativeId: 'INIT-2026-05-23-test',
    manifestRelPath: '.forge/manifest.md',
    workItemSpecs: ['.forge/work-items/WI-1.md', '.forge/work-items/WI-2.md'],
    iteration: 1,
    iterationBudget: 3,
    demoShape: 'browser',
    qualityGateCmd: ['npm', 'test'],
    feedbackRef: undefined,
  });
  assert.ok(prompt.includes('INIT-2026-05-23-test'));
  assert.ok(prompt.includes('.forge/manifest.md'));
  assert.ok(prompt.includes('WI-1'));
  assert.ok(prompt.includes('WI-2'));
  assert.ok(prompt.includes('browser'));
  assert.ok(prompt.includes('npm test'));
  assert.ok(!prompt.includes('send-back'), 'initial-prep mode does not mention send-back');
});

test('renderUnifierUserPrompt: send-back mode references the feedback file', () => {
  const prompt = renderUnifierUserPrompt({
    initiativeId: 'INIT-2026-05-23-test',
    manifestRelPath: '.forge/manifest.md',
    workItemSpecs: ['.forge/work-items/WI-1.md'],
    iteration: 1,
    iterationBudget: 3,
    demoShape: 'browser',
    qualityGateCmd: ['npm', 'test'],
    feedbackRef: '_queue/in-flight/INIT-2026-05-23-test.pr-feedback.md',
  });
  assert.ok(prompt.includes('send-back'));
  assert.ok(prompt.includes('_queue/in-flight/INIT-2026-05-23-test.pr-feedback.md'));
  assert.ok(prompt.includes('Do not exceed the iteration cap'));
});

test('renderUnifierUserPrompt: demo shape "none" omits demo runtime instruction', () => {
  const promptNone = renderUnifierUserPrompt({
    initiativeId: 'X',
    manifestRelPath: '.forge/manifest.md',
    workItemSpecs: [],
    iteration: 1,
    iterationBudget: 3,
    demoShape: 'none',
    qualityGateCmd: ['true'],
    feedbackRef: undefined,
  });
  assert.ok(promptNone.includes('rationale block'));
  assert.ok(!promptNone.toLowerCase().includes('playwright'));
});

test('prepareUnifierWorkspace: stamps PROMPT.md / AGENT.md / fix_plan.md', () => {
  const root = newTempDir();
  try {
    mkdirSync(join(root, '.forge', 'work-items'), { recursive: true });
    writeFileSync(join(root, '.forge', 'manifest.md'), '# manifest');
    writeFileSync(
      join(root, '.forge', 'work-items', 'WI-1.md'),
      '---\nwork_item_id: WI-1\nfeature_id: FEAT-1\ninitiative_id: I\nstatus: complete\ndepends_on: []\nfiles_in_scope: ["src/x.ts"]\nestimated_iterations: 1\nacceptance_criteria:\n  - given: g\n    when: w\n    then: t\n---\n# WI-1\n',
    );
    const out = prepareUnifierWorkspace({
      initiativeId: 'INIT-x',
      manifestRelPath: '.forge/manifest.md',
      worktreePath: root,
      iterationBudget: 3,
      demoShape: 'artifact',
      qualityGateCmd: ['npm', 'test'],
      feedbackRef: undefined,
    });
    assert.ok(existsSync(out.promptPath));
    assert.ok(existsSync(out.agentMdPath));
    assert.ok(existsSync(out.fixPlanPath));
    const prompt = readFileSync(out.promptPath, 'utf8');
    assert.ok(prompt.includes('INIT-x'));
    assert.ok(prompt.includes('WI-1'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareUnifierWorkspace: writes feedback-aware prompt when feedbackRef is set', () => {
  const root = newTempDir();
  try {
    mkdirSync(join(root, '.forge', 'work-items'), { recursive: true });
    writeFileSync(join(root, '.forge', 'manifest.md'), '# manifest');
    const out = prepareUnifierWorkspace({
      initiativeId: 'INIT-x',
      manifestRelPath: '.forge/manifest.md',
      worktreePath: root,
      iterationBudget: 3,
      demoShape: 'artifact',
      qualityGateCmd: ['npm', 'test'],
      feedbackRef: '_queue/in-flight/INIT-x.pr-feedback.md',
    });
    const prompt = readFileSync(out.promptPath, 'utf8');
    assert.ok(prompt.includes('send-back'));
    assert.ok(prompt.includes('pr-feedback.md'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
