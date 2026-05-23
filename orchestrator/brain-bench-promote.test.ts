/**
 * Tests for orchestrator/brain-bench-promote.ts.
 *
 * The promote pipeline is the gated path by which reflector-emitted
 * candidates land in `benchmarks/brain/questions.json`. We test the pure
 * function `runPromote()` directly, injecting an in-memory "operator"
 * (the prompter) + a stubbed bench-runner. Disk I/O is real but scoped
 * to a tempdir.
 *
 * Coverage (6 cases):
 *   1. promote one → questions.json grows by 1.
 *   2. per-cycle cap: 2nd promotion of the same cycle rejected.
 *   3. monthly cap: 5th promotion in a calendar month rejected.
 *   4. accuracy regression simulated → promotion reverted (snapshot restored).
 *   5. default drop preserves questions.json byte-identical.
 *   6. edit-then-keep applies operator's text verbatim.
 *
 * IMPORTANT: tests must NOT touch the live benchmarks/brain/questions.json.
 * Each test allocates its own tempdir for {candidatesPath, questionsPath}.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runPromote,
  type PromoteCandidate,
  type PromoteDeps,
  type PromoteDecision,
} from './brain-bench-promote.ts';

type QuestionRow = {
  id: string;
  question: string;
  expected_sources: string[];
  expected_keywords: string[];
  scope?: string | null;
  category?: string | null;
  source_cycle?: string | null;
};

function setupTempDir(): { dir: string; candidatesPath: string; questionsPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-brain-bench-promote-'));
  return {
    dir,
    candidatesPath: join(dir, 'brain-bench-candidates.jsonl'),
    questionsPath: join(dir, 'questions.json'),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

function writeCandidates(path: string, candidates: PromoteCandidate[]): void {
  const lines = candidates.map((c) => JSON.stringify(c)).join('\n');
  writeFileSync(path, lines + (lines ? '\n' : ''));
}

function writeQuestions(path: string, questions: QuestionRow[]): void {
  writeFileSync(path, JSON.stringify(questions, null, 2));
}

function readQuestions(path: string): QuestionRow[] {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const BASE_QUESTIONS: QuestionRow[] = [
  {
    id: 'Q1',
    question: 'baseline question 1',
    expected_sources: ['brain/forge/themes/baseline.md'],
    expected_keywords: ['baseline'],
    scope: null,
    category: null,
  },
  {
    id: 'Q2',
    question: 'baseline question 2',
    expected_sources: ['brain/forge/themes/baseline.md'],
    expected_keywords: ['baseline'],
    scope: null,
    category: null,
  },
];

const SAMPLE_CANDIDATE: PromoteCandidate = {
  question: 'what does the new theme cover?',
  expected_sources: ['brain/projects/sample/themes/new.md'],
  why_now: 'cycle observed a gap that this theme now fills',
  gap_id: 'gap-1',
};

function decisionPrompter(decisions: PromoteDecision[]): PromoteDeps['promptOperator'] {
  let i = 0;
  return async () => {
    const d = decisions[i] ?? { action: 'drop' };
    i += 1;
    return d;
  };
}

function defaultDeps(overrides: Partial<PromoteDeps> = {}): PromoteDeps {
  return {
    promptOperator: async () => ({ action: 'drop' }),
    runBenchAccuracy: async () => 1.0,
    nowIso: () => '2026-05-23T12:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

test('promote one candidate → questions.json grows by 1 + source_cycle stamped', async () => {
  const t = setupTempDir();
  try {
    writeQuestions(t.questionsPath, BASE_QUESTIONS);
    writeCandidates(t.candidatesPath, [SAMPLE_CANDIDATE]);

    const result = await runPromote({
      cycleId: 'INIT-2026-05-23-test',
      candidatesPath: t.candidatesPath,
      questionsPath: t.questionsPath,
      deps: defaultDeps({
        promptOperator: decisionPrompter([{ action: 'keep' }]),
      }),
    });

    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') return;
    assert.equal(result.promoted, 1);

    const after = readQuestions(t.questionsPath);
    assert.equal(after.length, BASE_QUESTIONS.length + 1);
    const last = after[after.length - 1];
    assert.equal(last.question, SAMPLE_CANDIDATE.question);
    assert.deepEqual(last.expected_sources, SAMPLE_CANDIDATE.expected_sources);
    assert.equal(last.source_cycle, 'INIT-2026-05-23-test');
    assert.equal(last.id, 'Q3'); // sequential id
  } finally {
    t.cleanup();
  }
});

test('per-cycle cap: 2nd promotion of same cycle is rejected (still ≤1)', async () => {
  const t = setupTempDir();
  try {
    // Existing questions include one row already from cycle 'INIT-CYCLE-X'.
    const seeded: QuestionRow[] = [
      ...BASE_QUESTIONS,
      {
        id: 'Q3',
        question: 'existing promoted question from cycle X',
        expected_sources: ['brain/forge/themes/cycle-x.md'],
        expected_keywords: ['cycle-x'],
        scope: null,
        category: null,
        source_cycle: 'INIT-CYCLE-X',
      },
    ];
    writeQuestions(t.questionsPath, seeded);
    writeCandidates(t.candidatesPath, [SAMPLE_CANDIDATE, SAMPLE_CANDIDATE]);

    const result = await runPromote({
      cycleId: 'INIT-CYCLE-X',
      candidatesPath: t.candidatesPath,
      questionsPath: t.questionsPath,
      deps: defaultDeps({
        promptOperator: decisionPrompter([{ action: 'keep' }, { action: 'keep' }]),
      }),
    });

    // First should succeed via the per-cycle cap NOT firing yet (1 existing
    // → cap of 1 reached). Actually: this is a cycle that already has 1
    // promotion, so the cap is already at the limit. So the result is
    // rejected before any append.
    assert.equal(result.kind, 'cap-exceeded');
    if (result.kind === 'cap-exceeded') {
      assert.equal(result.cap, 'per-cycle');
    }

    // questions.json unchanged (still seeded length).
    const after = readQuestions(t.questionsPath);
    assert.equal(after.length, seeded.length);
  } finally {
    t.cleanup();
  }
});

test('monthly cap: 5th promotion in a calendar month rejected', async () => {
  const t = setupTempDir();
  try {
    // 4 questions already promoted in 2026-05 from distinct cycles.
    const seeded: QuestionRow[] = [
      ...BASE_QUESTIONS,
      {
        id: 'Q3',
        question: 'may1',
        expected_sources: [],
        expected_keywords: [],
        source_cycle: '2026-05-01T00-00-00_INIT-A',
      },
      {
        id: 'Q4',
        question: 'may2',
        expected_sources: [],
        expected_keywords: [],
        source_cycle: '2026-05-05T00-00-00_INIT-B',
      },
      {
        id: 'Q5',
        question: 'may3',
        expected_sources: [],
        expected_keywords: [],
        source_cycle: '2026-05-10T00-00-00_INIT-C',
      },
      {
        id: 'Q6',
        question: 'may4',
        expected_sources: [],
        expected_keywords: [],
        source_cycle: '2026-05-15T00-00-00_INIT-D',
      },
    ];
    writeQuestions(t.questionsPath, seeded);
    writeCandidates(t.candidatesPath, [SAMPLE_CANDIDATE]);

    const result = await runPromote({
      cycleId: '2026-05-23T00-00-00_INIT-E',
      candidatesPath: t.candidatesPath,
      questionsPath: t.questionsPath,
      deps: defaultDeps({
        promptOperator: decisionPrompter([{ action: 'keep' }]),
        nowIso: () => '2026-05-23T12:00:00Z',
      }),
    });

    assert.equal(result.kind, 'cap-exceeded');
    if (result.kind === 'cap-exceeded') {
      assert.equal(result.cap, 'monthly');
    }

    const after = readQuestions(t.questionsPath);
    assert.equal(after.length, seeded.length);
  } finally {
    t.cleanup();
  }
});

test('accuracy regression simulated → promotion reverted (questions.json restored)', async () => {
  const t = setupTempDir();
  try {
    writeQuestions(t.questionsPath, BASE_QUESTIONS);
    writeCandidates(t.candidatesPath, [SAMPLE_CANDIDATE]);
    const beforeBytes = readFileSync(t.questionsPath);

    const result = await runPromote({
      cycleId: 'INIT-2026-05-23-regress',
      candidatesPath: t.candidatesPath,
      questionsPath: t.questionsPath,
      deps: defaultDeps({
        promptOperator: decisionPrompter([{ action: 'keep' }]),
        // Simulate bench dropping below 0.944.
        runBenchAccuracy: async () => 0.90,
      }),
    });

    assert.equal(result.kind, 'reverted');
    if (result.kind === 'reverted') {
      assert.ok(result.accuracy < 0.944);
    }

    // File must be byte-identical to before.
    const afterBytes = readFileSync(t.questionsPath);
    assert.equal(beforeBytes.equals(afterBytes), true, 'questions.json restored to pre-promote bytes');
  } finally {
    t.cleanup();
  }
});

test('default drop preserves questions.json byte-identical', async () => {
  const t = setupTempDir();
  try {
    writeQuestions(t.questionsPath, BASE_QUESTIONS);
    writeCandidates(t.candidatesPath, [SAMPLE_CANDIDATE, SAMPLE_CANDIDATE, SAMPLE_CANDIDATE]);
    const beforeBytes = readFileSync(t.questionsPath);

    const result = await runPromote({
      cycleId: 'INIT-2026-05-23-drop',
      candidatesPath: t.candidatesPath,
      questionsPath: t.questionsPath,
      // Default promptOperator returns {action: 'drop'} for every candidate.
      deps: defaultDeps(),
    });

    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok') {
      assert.equal(result.promoted, 0);
    }

    const afterBytes = readFileSync(t.questionsPath);
    assert.equal(beforeBytes.equals(afterBytes), true, 'questions.json untouched on all-drop');
  } finally {
    t.cleanup();
  }
});

test('edit-then-keep applies operator text verbatim', async () => {
  const t = setupTempDir();
  try {
    writeQuestions(t.questionsPath, BASE_QUESTIONS);
    writeCandidates(t.candidatesPath, [SAMPLE_CANDIDATE]);

    const edited: PromoteCandidate = {
      question: 'OPERATOR-EDITED question text',
      expected_sources: ['brain/forge/themes/operator-pick.md'],
      why_now: 'operator refined the question',
      expected_keywords: ['operator', 'edited'],
    };

    const result = await runPromote({
      cycleId: 'INIT-2026-05-23-edit',
      candidatesPath: t.candidatesPath,
      questionsPath: t.questionsPath,
      deps: defaultDeps({
        promptOperator: decisionPrompter([{ action: 'edit', edited }]),
      }),
    });

    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok') {
      assert.equal(result.promoted, 1);
    }

    const after = readQuestions(t.questionsPath);
    assert.equal(after.length, BASE_QUESTIONS.length + 1);
    const last = after[after.length - 1];
    assert.equal(last.question, 'OPERATOR-EDITED question text');
    assert.deepEqual(last.expected_sources, ['brain/forge/themes/operator-pick.md']);
    assert.deepEqual(last.expected_keywords, ['operator', 'edited']);
    assert.equal(last.source_cycle, 'INIT-2026-05-23-edit');
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Extra (no-op + manual seed) — bonus coverage beyond the required 6.
// ---------------------------------------------------------------------------

test('no candidates file → ok with promoted:0, questions.json unchanged', async () => {
  const t = setupTempDir();
  try {
    writeQuestions(t.questionsPath, BASE_QUESTIONS);
    const beforeBytes = readFileSync(t.questionsPath);
    // intentionally no candidates file

    const result = await runPromote({
      cycleId: 'INIT-2026-05-23-noop',
      candidatesPath: t.candidatesPath, // doesn't exist
      questionsPath: t.questionsPath,
      deps: defaultDeps(),
    });

    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok') {
      assert.equal(result.promoted, 0);
    }
    const afterBytes = readFileSync(t.questionsPath);
    assert.equal(beforeBytes.equals(afterBytes), true);
  } finally {
    t.cleanup();
  }
});

test('manual-seed-* rows are exempt from monthly cap', async () => {
  // 4 manual seeds in the same month, then a real promotion arrives — must succeed.
  const t = setupTempDir();
  try {
    const seeded: QuestionRow[] = [
      ...BASE_QUESTIONS,
      ...['s1', 's2', 's3', 's4'].map((s, idx) => ({
        id: `Q${idx + 3}`,
        question: `seed ${s}`,
        expected_sources: [],
        expected_keywords: [],
        source_cycle: 'manual-seed-2026-05-23',
      })),
    ];
    writeQuestions(t.questionsPath, seeded);
    writeCandidates(t.candidatesPath, [SAMPLE_CANDIDATE]);

    const result = await runPromote({
      cycleId: '2026-05-25T00-00-00_INIT-real',
      candidatesPath: t.candidatesPath,
      questionsPath: t.questionsPath,
      deps: defaultDeps({
        promptOperator: decisionPrompter([{ action: 'keep' }]),
        nowIso: () => '2026-05-25T12:00:00Z',
      }),
    });

    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok') {
      assert.equal(result.promoted, 1);
    }
    const after = readQuestions(t.questionsPath);
    assert.equal(after.length, seeded.length + 1);
  } finally {
    t.cleanup();
  }
});
