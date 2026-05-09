/**
 * Unit tests for benchmarks/review-loop/scoring.ts. Pure functions + filesystem
 * stubs (we write tiny fixtures into a tempdir so the file-existence + magic-byte
 * checks have something real to inspect). No SDK, no recorders.
 *
 * Covers each criterion's pass/fail boundary plus the two gates and the
 * stacked-PR squash unit test mandated by the plan.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  caseScore,
  demoExercisesAcceptanceCriteria,
  demoRecordingPresent,
  extractKeywords,
  findDemoSource,
  findRecording,
  mergeStrategyRespected,
  prDescriptionLengthFloor,
  prDescriptionWhyNotWhat,
  prLinksDemo,
  brainConsulted,
  PASS_THRESHOLD,
  WEIGHT_BRAIN,
  WEIGHT_DEMO_EXERCISES_ACS,
  WEIGHT_DEMO_RECORDING,
  WEIGHT_MERGE_STRATEGY,
  WEIGHT_PR_LENGTH_FLOOR,
  WEIGHT_PR_LINKS_DEMO,
  WEIGHT_PR_WHY_NOT_WHAT,
  type ReviewerExpected,
} from './scoring.ts';
import type { WorkItem } from '../../orchestrator/work-item.ts';
import type { ReviewerToolUseSummary } from '../../orchestrator/reviewer-invocation.ts';

// ---------- Test helpers ----------

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    work_item_id: 'WI-1',
    feature_id: 'FEAT-1',
    initiative_id: 'INIT-2026-05-09-test',
    status: 'complete',
    depends_on: [],
    acceptance_criteria: [
      { given: 'a list of argv strings', when: 'redact_argv is called', then: 'a new list is returned with each element redacted' },
    ],
    files_in_scope: ['src/foo.py'],
    estimated_iterations: 2,
    body: '',
    ...overrides,
  };
}

function makeExpected(overrides: Partial<ReviewerExpected> = {}): ReviewerExpected {
  return {
    project_type: 'lib',
    quality_gate_cmd: ['true'],
    is_stacked_pr: false,
    ...overrides,
  };
}

function makeToolUse(overrides: Partial<ReviewerToolUseSummary> = {}): ReviewerToolUseSummary {
  return { brainReads: 1, writes: 3, bashCalls: 2, recorderInvocations: 1, ...overrides };
}

function setupWorktree(): { worktree: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-bench-review-test-'));
  mkdirSync(join(dir, '.forge'), { recursive: true });
  return { worktree: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const MP4_FTYP_HEADER = Buffer.concat([
  Buffer.from([0, 0, 0, 0x20]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.alloc(64, 0xaa),
]);
const WEBM_HEADER = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 0xaa)]);
const ZIP_HEADER = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0xaa)]);
const GIF_HEADER = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(64, 0xaa)]);

function writeRecording(dir: string, name: string, header: Buffer, padTo = 60_000): string {
  const path = join(dir, name);
  const padding = Buffer.alloc(Math.max(0, padTo - header.length), 0);
  writeFileSync(path, Buffer.concat([header, padding]));
  return path;
}

// ---------- extractKeywords ----------

test('extractKeywords: lowercases, strips punctuation, drops short words/stopwords', () => {
  const kws = extractKeywords('A new list is returned with each element redacted');
  assert.ok(kws.includes('list'));
  assert.ok(kws.includes('redacted'));
  assert.ok(kws.includes('returned'));
  assert.ok(kws.includes('element'));
  assert.ok(!kws.includes('a'), 'short word "a" stripped');
  assert.ok(!kws.includes('with'), '"with" is a stopword');
  assert.ok(!kws.includes('that'), '"that" is a stopword');
});

test('extractKeywords: empty input → empty list', () => {
  assert.deepEqual(extractKeywords(''), []);
});

// ---------- findRecording / findDemoSource ----------

test('findRecording: returns null when directory missing', () => {
  assert.equal(findRecording('/nonexistent/path/xyz'), null);
});

test('findRecording: prefers earliest extension hit (mp4 over gif)', () => {
  const { worktree, cleanup } = setupWorktree();
  try {
    const demoDir = join(worktree, 'demo');
    mkdirSync(demoDir);
    writeRecording(demoDir, 'recording.gif', GIF_HEADER);
    writeRecording(demoDir, 'recording.mp4', MP4_FTYP_HEADER);
    const found = findRecording(demoDir);
    assert.ok(found);
    assert.match(found!.path, /recording\.mp4$/);
  } finally {
    cleanup();
  }
});

test('findDemoSource: finds .tape OR .spec.ts', () => {
  const { worktree, cleanup } = setupWorktree();
  try {
    const demoDir = join(worktree, 'demo');
    mkdirSync(demoDir);
    writeFileSync(join(demoDir, 'source.tape'), 'Type "echo hi"\n');
    assert.match(findDemoSource(demoDir)!, /source\.tape$/);
  } finally {
    cleanup();
  }
});

// ---------- demoRecordingPresent ----------

test('demoRecordingPresent: 1 for valid mp4 above floor', () => {
  const { worktree, cleanup } = setupWorktree();
  try {
    const demoDir = join(worktree, 'demo');
    mkdirSync(demoDir);
    writeRecording(demoDir, 'recording.mp4', MP4_FTYP_HEADER);
    const r = demoRecordingPresent(demoDir);
    assert.equal(r.value, 1);
  } finally {
    cleanup();
  }
});

test('demoRecordingPresent: 0 for missing file', () => {
  const { worktree, cleanup } = setupWorktree();
  try {
    const r = demoRecordingPresent(join(worktree, 'demo'));
    assert.equal(r.value, 0);
    assert.equal(r.path, null);
  } finally {
    cleanup();
  }
});

test('demoRecordingPresent: 0 for file below size floor', () => {
  const { worktree, cleanup } = setupWorktree();
  try {
    const demoDir = join(worktree, 'demo');
    mkdirSync(demoDir);
    writeRecording(demoDir, 'recording.mp4', MP4_FTYP_HEADER, 100); // tiny
    const r = demoRecordingPresent(demoDir);
    assert.equal(r.value, 0);
  } finally {
    cleanup();
  }
});

test('demoRecordingPresent: 0 for wrong magic bytes', () => {
  const { worktree, cleanup } = setupWorktree();
  try {
    const demoDir = join(worktree, 'demo');
    mkdirSync(demoDir);
    writeFileSync(join(demoDir, 'recording.mp4'), Buffer.alloc(60_000, 0xff));
    const r = demoRecordingPresent(demoDir);
    assert.equal(r.value, 0);
  } finally {
    cleanup();
  }
});

test('demoRecordingPresent: accepts webm, gif, trace.zip', () => {
  for (const [name, header] of [
    ['recording.webm', WEBM_HEADER],
    ['recording.gif', GIF_HEADER],
    ['recording.trace.zip', ZIP_HEADER],
  ] as const) {
    const { worktree, cleanup } = setupWorktree();
    try {
      const demoDir = join(worktree, 'demo');
      mkdirSync(demoDir);
      writeRecording(demoDir, name, header);
      const r = demoRecordingPresent(demoDir);
      assert.equal(r.value, 1, `expected ${name} to score 1`);
    } finally {
      cleanup();
    }
  }
});

// ---------- demoExercisesAcceptanceCriteria ----------

test('demoExercisesAcceptanceCriteria: 1 when source contains AC keywords', () => {
  const { worktree, cleanup } = setupWorktree();
  try {
    const demoDir = join(worktree, 'demo');
    mkdirSync(demoDir);
    const source = join(demoDir, 'source.tape');
    writeFileSync(source, 'Type "redact_argv called → new list returned with each element redacted"\n');
    const r = demoExercisesAcceptanceCriteria(source, [makeWorkItem()]);
    assert.equal(r.value, 1);
    assert.deepEqual(r.missing, []);
  } finally {
    cleanup();
  }
});

test('demoExercisesAcceptanceCriteria: 0 when source has no AC keywords (5-second black canvas)', () => {
  const { worktree, cleanup } = setupWorktree();
  try {
    const demoDir = join(worktree, 'demo');
    mkdirSync(demoDir);
    const source = join(demoDir, 'source.tape');
    writeFileSync(source, 'Type "echo hello"\nSleep 5s\n');
    const r = demoExercisesAcceptanceCriteria(source, [makeWorkItem()]);
    assert.equal(r.value, 0);
    assert.deepEqual(r.missing, ['WI-1']);
  } finally {
    cleanup();
  }
});

test('demoExercisesAcceptanceCriteria: 0 when source missing entirely', () => {
  const r = demoExercisesAcceptanceCriteria(null, [makeWorkItem()]);
  assert.equal(r.value, 0);
  assert.deepEqual(r.missing, ['<no source file>']);
});

// ---------- prDescriptionWhyNotWhat ----------

const FULL_PR_BODY = [
  '## Why',
  'This initiative ships the redact_argv helper because the capture pipeline currently calls redact() on stored events but argv hits a different code path.',
  '',
  '## What',
  '- New redact_argv function in src/redactor.py',
  '',
  '## How',
  'Wraps redact_one over each element; returns a new list (no aliasing).',
  '',
  '## Demo',
  'See [recording](.forge/demos/INIT-x/recording.mp4).',
].join('\n');

test('prDescriptionWhyNotWhat: 1 when all 4 sections present and Why >= 50 chars', () => {
  const r = prDescriptionWhyNotWhat(FULL_PR_BODY);
  assert.equal(r.value, 1);
  assert.ok(r.whyChars >= 50);
});

test('prDescriptionWhyNotWhat: 0 when missing How section', () => {
  const body = FULL_PR_BODY.replace('## How', '## NotHow');
  assert.equal(prDescriptionWhyNotWhat(body).value, 0);
});

test('prDescriptionWhyNotWhat: 0 when Why section is too short', () => {
  const body = '## Why\nshort.\n\n## What\nx\n\n## How\ny\n\n## Demo\nz';
  const r = prDescriptionWhyNotWhat(body);
  assert.equal(r.value, 0);
  assert.ok(r.whyChars < 50);
});

// ---------- prDescriptionLengthFloor ----------

test('prDescriptionLengthFloor: 1 when body >= 300 chars', () => {
  assert.equal(prDescriptionLengthFloor('a'.repeat(300)), 1);
  assert.equal(prDescriptionLengthFloor('a'.repeat(500)), 1);
});

test('prDescriptionLengthFloor: 0 when body < 300 chars', () => {
  assert.equal(prDescriptionLengthFloor('a'.repeat(299)), 0);
  assert.equal(prDescriptionLengthFloor('three lines'), 0);
});

// ---------- prLinksDemo ----------

test('prLinksDemo: 1 when body links to .forge/demos/<initiative-id>', () => {
  const body = 'See [recording](.forge/demos/INIT-2026-05-09-x/recording.mp4) for the demo.';
  assert.equal(prLinksDemo(body, 'INIT-2026-05-09-x'), 1);
});

test('prLinksDemo: 0 when no link to the demo dir', () => {
  const body = 'See [recording](https://example.com/recording.mp4) for the demo.';
  assert.equal(prLinksDemo(body, 'INIT-2026-05-09-x'), 0);
});

test('prLinksDemo: 0 when link is to a different initiative', () => {
  const body = 'See [recording](.forge/demos/INIT-other/recording.mp4) for the demo.';
  assert.equal(prLinksDemo(body, 'INIT-2026-05-09-x'), 0);
});

// ---------- mergeStrategyRespected ----------

test('mergeStrategyRespected: 1 when no Parents block (not stacked)', () => {
  assert.equal(mergeStrategyRespected('## Why\nx\n## What\ny'), 1);
});

test('mergeStrategyRespected: 1 when Parents present but no squash declared', () => {
  const body = '## Why\nx\n\nParents:\n- PR #42\n\n## What\ny';
  assert.equal(mergeStrategyRespected(body), 1);
});

test('mergeStrategyRespected: 0 when Parents present AND squash explicit (the v1 antipattern)', () => {
  const body = '## Why\nx\n\nParents:\n- PR #42\n\nMerge strategy: squash\n\n## What\ny';
  assert.equal(mergeStrategyRespected(body), 0);
});

test('mergeStrategyRespected: 0 when Parents present AND `gh pr merge --squash` shown in body', () => {
  const body = '## Why\nx\n\nParents:\n- PR #42\n\n```\ngh pr merge --squash\n```\n\n## What\ny';
  assert.equal(mergeStrategyRespected(body), 0);
});

// ---------- brainConsulted ----------

test('brainConsulted: 1 when brainReads >= 1', () => {
  assert.equal(brainConsulted(makeToolUse({ brainReads: 1 })), 1);
  assert.equal(brainConsulted(makeToolUse({ brainReads: 5 })), 1);
});

test('brainConsulted: 0 when brainReads === 0', () => {
  assert.equal(brainConsulted(makeToolUse({ brainReads: 0 })), 0);
});

// ---------- caseScore (end-to-end) ----------

function setupHappyWorktree(opts: { initiativeId: string }): { worktree: string; cleanup: () => void } {
  const setup = setupWorktree();
  const demoDir = join(setup.worktree, '.forge', 'demos', opts.initiativeId);
  mkdirSync(demoDir, { recursive: true });
  writeRecording(demoDir, 'recording.mp4', MP4_FTYP_HEADER);
  writeFileSync(
    join(demoDir, 'source.tape'),
    'Type "python -c \\"from src.redactor import redact_argv; print(redact_argv([\\\'a\\\']))\\""\nEnter\nSleep 1s\nShow "new list returned with each element redacted"\n',
  );
  writeFileSync(join(demoDir, 'README.md'), 'Demo of redact_argv. Re-record: vhs source.tape -o recording.mp4');
  writeFileSync(
    join(setup.worktree, '.forge', 'pr-description.md'),
    [
      '## Why',
      'This initiative ships the redact_argv helper because the capture pipeline previously coupled events redaction with argv via inheritance, producing brittle behaviour when argv contained tokens.',
      '',
      '## What',
      '- New redact_argv in src/redactor.py',
      '',
      '## How',
      'Wraps redact_one over each element; returns a new list to avoid aliasing.',
      '',
      '## Demo',
      `See [recording](.forge/demos/${opts.initiativeId}/recording.mp4).`,
    ].join('\n'),
  );
  return setup;
}

test('caseScore: ideal happy run scores 1.0 and passes', () => {
  const initiativeId = 'INIT-2026-05-09-redact-argv';
  const { worktree, cleanup } = setupHappyWorktree({ initiativeId });
  try {
    const score = caseScore({
      worktreePath: worktree,
      initiativeId,
      workItems: [makeWorkItem()],
      expected: makeExpected(),
      qualityGatesPassed: true,
      toolUse: makeToolUse(),
    });
    assert.equal(score.score, 1, `score should be 1.0, got ${score.score}`);
    assert.ok(score.passed);
    assert.equal(score.criteria.quality_gates_pass, 1);
    assert.equal(score.criteria.pr_only_when_green, 1);
    assert.equal(score.criteria.demo_recording_present, 1);
    assert.equal(score.criteria.demo_exercises_acceptance_criteria, 1);
    assert.equal(score.criteria.pr_description_why_not_what, 1);
    assert.equal(score.criteria.pr_description_length_floor, 1);
    assert.equal(score.criteria.pr_links_demo, 1);
    assert.equal(score.criteria.merge_strategy_respected, 1);
    assert.equal(score.criteria.brain_consulted, 1);
  } finally {
    cleanup();
  }
});

test('caseScore: gate 1 violated (quality gates red) → score 0 across the board', () => {
  const initiativeId = 'INIT-2026-05-09-redact-argv';
  const { worktree, cleanup } = setupHappyWorktree({ initiativeId });
  try {
    const score = caseScore({
      worktreePath: worktree,
      initiativeId,
      workItems: [makeWorkItem()],
      expected: makeExpected(),
      qualityGatesPassed: false, // red gates
      toolUse: makeToolUse(),
    });
    assert.equal(score.score, 0);
    assert.ok(!score.passed);
    assert.equal(score.criteria.quality_gates_pass, 0);
    // Agent wrote pr-description.md despite red gates → pr_only_when_green = 0.
    assert.equal(score.criteria.pr_only_when_green, 0);
  } finally {
    cleanup();
  }
});

test('caseScore: gate 1 violated but agent did NOT write pr-description.md → pr_only_when_green = 1', () => {
  const initiativeId = 'INIT-2026-05-09-redact-argv';
  const { worktree, cleanup } = setupWorktree();
  try {
    // No pr-description.md written, no demo bundle.
    const score = caseScore({
      worktreePath: worktree,
      initiativeId,
      workItems: [makeWorkItem()],
      expected: makeExpected(),
      qualityGatesPassed: false,
      toolUse: makeToolUse(),
    });
    assert.equal(score.score, 0);
    assert.equal(score.criteria.quality_gates_pass, 0);
    assert.equal(score.criteria.pr_only_when_green, 1, 'agent correctly held off on PR draft when gates red');
  } finally {
    cleanup();
  }
});

test('caseScore: gates pass but no pr-description.md → score 0 (failed review-prep)', () => {
  const initiativeId = 'INIT-2026-05-09-redact-argv';
  const { worktree, cleanup } = setupWorktree();
  try {
    const score = caseScore({
      worktreePath: worktree,
      initiativeId,
      workItems: [makeWorkItem()],
      expected: makeExpected(),
      qualityGatesPassed: true,
      toolUse: makeToolUse(),
    });
    assert.equal(score.score, 0);
    assert.equal(score.criteria.quality_gates_pass, 1);
    assert.equal(score.criteria.pr_only_when_green, 1);
    assert.equal(score.criteria.demo_recording_present, 0);
  } finally {
    cleanup();
  }
});

test('caseScore: stacked PR with squash declared → merge_strategy_respected = 0, pulls below threshold', () => {
  const initiativeId = 'INIT-2026-05-09-redact-argv';
  const { worktree, cleanup } = setupHappyWorktree({ initiativeId });
  try {
    // Append a stacked-PR antipattern to the body.
    const prPath = join(worktree, '.forge', 'pr-description.md');
    const body = readFileSync(prPath, 'utf8');
    writeFileSync(prPath, `${body}\n\nParents:\n- PR #42\n\nMerge strategy: squash\n`);

    const score = caseScore({
      worktreePath: worktree,
      initiativeId,
      workItems: [makeWorkItem()],
      expected: makeExpected({ is_stacked_pr: true }),
      qualityGatesPassed: true,
      toolUse: makeToolUse(),
    });
    assert.equal(score.criteria.merge_strategy_respected, 0);
    assert.ok(score.score < 1);
    // Lost weight is exactly WEIGHT_MERGE_STRATEGY = 0.15
    assert.ok(Math.abs(score.score - (1 - WEIGHT_MERGE_STRATEGY)) < 1e-6);
  } finally {
    cleanup();
  }
});

test('caseScore: weights sum to 1.0', () => {
  const sum =
    WEIGHT_DEMO_RECORDING +
    WEIGHT_DEMO_EXERCISES_ACS +
    WEIGHT_PR_WHY_NOT_WHAT +
    WEIGHT_PR_LENGTH_FLOOR +
    WEIGHT_PR_LINKS_DEMO +
    WEIGHT_MERGE_STRATEGY +
    WEIGHT_BRAIN;
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights must sum to 1, got ${sum}`);
});

test('caseScore: pass threshold matches phase convention', () => {
  assert.equal(PASS_THRESHOLD, 0.7);
});

test('caseScore: missing brain reads pulls one-criterion below pass threshold', () => {
  const initiativeId = 'INIT-2026-05-09-redact-argv';
  const { worktree, cleanup } = setupHappyWorktree({ initiativeId });
  try {
    const score = caseScore({
      worktreePath: worktree,
      initiativeId,
      workItems: [makeWorkItem()],
      expected: makeExpected(),
      qualityGatesPassed: true,
      toolUse: makeToolUse({ brainReads: 0 }),
    });
    assert.equal(score.criteria.brain_consulted, 0);
    assert.ok(Math.abs(score.score - (1 - WEIGHT_BRAIN)) < 1e-6);
    assert.ok(score.passed, 'losing brain still passes (weight=0.10, threshold=0.7)');
  } finally {
    cleanup();
  }
});
