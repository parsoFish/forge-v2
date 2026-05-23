/**
 * Unit tests for benchmarks/reflection/scoring.ts. Pure functions + filesystem
 * fixtures (we write tiny brain trees into a tempdir so theme/source-link
 * checks have something real to inspect). No SDK calls, no real cycle data.
 *
 * Covers each gate, each weighted criterion's pass/fail boundary, and the
 * top-level case scorer's gate-short-circuit + threshold logic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  brainConsulted,
  brainGapsAddressed,
  caseScore,
  checkCycleArchive,
  checkTheme,
  lintInvoked,
  listThemeFiles,
  logHasWedgeOrSendBack,
  parseEventLog,
  parseFrontmatter,
  recapEmitted,
  retentionAssigned,
  retroHasThreeSections,
  PASS_THRESHOLD,
  WEIGHT_BRAIN_GAPS,
  WEIGHT_CATEGORIES_BALANCED,
  WEIGHT_CYCLE_ARCHIVED,
  WEIGHT_EVIDENCE_GROUNDED,
  WEIGHT_RETRO_SECTIONS,
  WEIGHT_THEMES_EMITTED,
  type ReflectionExpected,
} from './scoring.ts';
import type { ReflectorToolUseSummary } from '../../orchestrator/reflector-invocation.ts';

// ---------- helpers ----------

function makeToolUse(overrides: Partial<ReflectorToolUseSummary> = {}): ReflectorToolUseSummary {
  return {
    brainReads: 2,
    themeWrites: 2,
    retroWrites: 1,
    bashCalls: 1,
    ...overrides,
  };
}

function makeExpected(overrides: Partial<ReflectionExpected> = {}): ReflectionExpected {
  return {
    project: 'slugifier',
    min_themes: 1,
    brain_gap_ids: [],
    ...overrides,
  };
}

type BenchTree = {
  root: string;
  brainRoot: string;
  cycleLogDir: string;
  cleanup: () => void;
};

function setupBenchTree(cycleId: string): BenchTree {
  const root = mkdtempSync(join(tmpdir(), 'forge-bench-reflect-test-'));
  const brainRoot = join(root, 'brain');
  const cycleLogDir = join(root, '_logs', cycleId);
  mkdirSync(cycleLogDir, { recursive: true });
  mkdirSync(join(brainRoot, '_raw', 'cycles'), { recursive: true });
  mkdirSync(join(brainRoot, 'projects', 'slugifier', 'themes'), { recursive: true });
  return { root, brainRoot, cycleLogDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeMinimalFixture(t: BenchTree, cycleId: string, opts: {
  themeBodies?: Record<string, string>;
  retroBody?: string;
  archiveBody?: string;
  manifestBody?: string;
  events?: string;
} = {}): { manifestPath: string; eventLogPath: string; retroPath: string; archivePath: string } {
  const manifestPath = join(t.root, '_queue', 'done', 'INIT-test.md');
  mkdirSync(join(t.root, '_queue', 'done'), { recursive: true });
  writeFileSync(manifestPath, opts.manifestBody ?? '---\ninitiative_id: INIT-test\n---\n');

  const eventLogPath = join(t.cycleLogDir, 'events.jsonl');
  const events =
    opts.events ??
    [
      JSON.stringify({ event_type: 'start', phase: 'orchestrator', message: 'cycle.start' }),
      JSON.stringify({ event_type: 'log', phase: 'project-manager', message: 'pm.work-item-emitted' }),
      JSON.stringify({ event_type: 'end', phase: 'orchestrator', message: 'cycle.end' }),
    ].join('\n') + '\n';
  writeFileSync(eventLogPath, events);

  const retroPath = join(t.cycleLogDir, 'retro.md');
  writeFileSync(
    retroPath,
    opts.retroBody ??
      [
        '# Retro',
        '',
        '## Self-reflection',
        'Cycle ran in 1 dev iteration.',
        '',
        '## User questions',
        '_(no feedback supplied this cycle)_',
        '',
        '## User feedback',
        '_(no feedback supplied this cycle)_',
        '',
      ].join('\n'),
  );

  const archivePath = join(t.brainRoot, '_raw', 'cycles', `${cycleId}.md`);
  writeFileSync(
    archivePath,
    opts.archiveBody ??
      [
        '---',
        'source_type: cycle',
        `source_url: _logs/${cycleId}/events.jsonl`,
        `source_title: Cycle ${cycleId}`,
        `cycle_id: ${cycleId}`,
        'initiative_id: INIT-test',
        'project: slugifier',
        'ingested_at: 2026-05-10T12:00:00Z',
        'ingested_by: reflector',
        '---',
        '',
        'Cycle archive body.',
      ].join('\n'),
  );

  for (const [filename, body] of Object.entries(opts.themeBodies ?? {})) {
    const themePath = join(t.brainRoot, 'projects', 'slugifier', 'themes', filename);
    writeFileSync(themePath, body);
  }

  return { manifestPath, eventLogPath, retroPath, archivePath };
}

function makeThemeBody(opts: {
  category?: string;
  evidence?: string[];
  withFrontmatter?: boolean;
}): string {
  const cat = opts.category ?? 'pattern';
  const ev = opts.evidence ?? ['_logs/CY-1/events.jsonl'];
  const lines: string[] = [];
  if (opts.withFrontmatter !== false) {
    lines.push(
      '---',
      'title: Sample theme',
      'description: A sample',
      `category: ${cat}`,
      'created_at: 2026-05-10T12:00:00Z',
      'updated_at: 2026-05-10T12:00:00Z',
      '---',
      '',
    );
  }
  lines.push('# Sample theme', '', 'Body content.', '', '## Sources', '');
  for (const src of ev) lines.push(`- [${src}](${src})`);
  lines.push('');
  return lines.join('\n');
}

// ---------- parseFrontmatter ----------

test('parseFrontmatter: returns null when no frontmatter', () => {
  assert.equal(parseFrontmatter('# Just a heading\n\nBody'), null);
});

test('parseFrontmatter: extracts simple key/value pairs', () => {
  const fm = parseFrontmatter('---\ntitle: Hello\ncategory: pattern\n---\nBody');
  assert.deepEqual(fm, { title: 'Hello', category: 'pattern' });
});

test('parseFrontmatter: strips quotes from values', () => {
  const fm = parseFrontmatter('---\ntitle: "Hello world"\n---\nBody');
  assert.equal(fm?.title, 'Hello world');
});

// ---------- parseEventLog ----------

test('parseEventLog: returns ok=false when file missing', () => {
  const r = parseEventLog('/nonexistent/path');
  assert.equal(r.ok, false);
  assert.deepEqual(r.lines, []);
});

test('parseEventLog: parses valid JSONL', () => {
  const t = setupBenchTree('CY-test');
  try {
    const path = join(t.cycleLogDir, 'events.jsonl');
    writeFileSync(path, '{"event_type":"start"}\n{"event_type":"end"}\n');
    const r = parseEventLog(path);
    assert.equal(r.ok, true);
    assert.equal(r.lines.length, 2);
  } finally {
    t.cleanup();
  }
});

test('parseEventLog: returns ok=false on invalid JSONL', () => {
  const t = setupBenchTree('CY-test');
  try {
    const path = join(t.cycleLogDir, 'events.jsonl');
    writeFileSync(path, '{"event_type":"start"}\nNOT JSON\n');
    const r = parseEventLog(path);
    assert.equal(r.ok, false);
  } finally {
    t.cleanup();
  }
});

// ---------- logHasWedgeOrSendBack ----------

test('logHasWedgeOrSendBack: false on a clean cycle', () => {
  assert.equal(
    logHasWedgeOrSendBack([
      { event_type: 'start', phase: 'orchestrator' },
      { event_type: 'end', phase: 'review-loop', message: 'reviewer.merged' },
    ]),
    false,
  );
});

test('logHasWedgeOrSendBack: true on send-back verdict', () => {
  assert.equal(
    logHasWedgeOrSendBack([
      { event_type: 'log', phase: 'review-loop', message: 'reviewer.verdict.send-back' },
    ]),
    true,
  );
});

test('logHasWedgeOrSendBack: true on wedge stop_reason', () => {
  assert.equal(
    logHasWedgeOrSendBack([
      { event_type: 'end', phase: 'developer-loop', message: 'ralph.end', metadata: { stop_reason: 'wedged' } },
    ]),
    true,
  );
});

test('logHasWedgeOrSendBack: true on iteration-budget stop_reason', () => {
  assert.equal(
    logHasWedgeOrSendBack([
      { event_type: 'end', message: 'ralph.end', metadata: { stop_reason: 'iteration-budget' } },
    ]),
    true,
  );
});

test('logHasWedgeOrSendBack: true on any error event', () => {
  assert.equal(
    logHasWedgeOrSendBack([{ event_type: 'error', phase: 'review-loop' }]),
    true,
  );
});

// ---------- listThemeFiles ----------

test('listThemeFiles: returns empty when project dir missing', () => {
  const t = setupBenchTree('CY-test');
  try {
    assert.deepEqual(listThemeFiles(t.brainRoot, 'nonexistent-project'), []);
  } finally {
    t.cleanup();
  }
});

test('listThemeFiles: returns only .md files', () => {
  const t = setupBenchTree('CY-test');
  try {
    const dir = join(t.brainRoot, 'projects', 'slugifier', 'themes');
    writeFileSync(join(dir, '2026-05-10-foo.md'), 'theme');
    writeFileSync(join(dir, '2026-05-10-bar.md'), 'theme');
    writeFileSync(join(dir, 'ignore.txt'), 'not a theme');
    const files = listThemeFiles(t.brainRoot, 'slugifier');
    assert.equal(files.length, 2);
    assert.ok(files.every((f) => f.endsWith('.md')));
  } finally {
    t.cleanup();
  }
});

// ---------- checkTheme ----------

test('checkTheme: extracts frontmatter category', () => {
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1', {
      themeBodies: { 'theme-a.md': makeThemeBody({ category: 'antipattern' }) },
    });
    const themePath = join(t.brainRoot, 'projects', 'slugifier', 'themes', 'theme-a.md');
    const r = checkTheme(themePath, t.cycleLogDir, fix.archivePath, t.brainRoot);
    assert.equal(r.hasFrontmatter, true);
    assert.equal(r.category, 'antipattern');
  } finally {
    t.cleanup();
  }
});

test('checkTheme: resolves _logs path against allowed roots', () => {
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1');
    const themePath = join(t.brainRoot, 'projects', 'slugifier', 'themes', 'theme-b.md');
    writeFileSync(themePath, makeThemeBody({ evidence: [fix.eventLogPath] }));
    const r = checkTheme(themePath, t.cycleLogDir, fix.archivePath, t.brainRoot);
    assert.equal(r.resolvedEvidence.length, 1, `expected resolved evidence, got ${JSON.stringify(r)}`);
    assert.equal(r.unresolvedEvidence.length, 0);
  } finally {
    t.cleanup();
  }
});

test('checkTheme: rejects evidence outside allowed roots', () => {
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1');
    const themePath = join(t.brainRoot, 'projects', 'slugifier', 'themes', 'theme-bad.md');
    // Existing path but NOT under _logs/<cycle-id> or the cycle archive.
    writeFileSync(themePath, makeThemeBody({ evidence: [fix.manifestPath] }));
    const r = checkTheme(themePath, t.cycleLogDir, fix.archivePath, t.brainRoot);
    assert.equal(r.resolvedEvidence.length, 0);
    assert.ok(r.unresolvedEvidence.includes(fix.manifestPath));
  } finally {
    t.cleanup();
  }
});

// ---------- checkCycleArchive ----------

test('checkCycleArchive: returns ok=false when file missing', () => {
  const r = checkCycleArchive('/nonexistent', 'CY-1');
  assert.equal(r.ok, false);
});

test('checkCycleArchive: enforces required frontmatter fields', () => {
  const t = setupBenchTree('CY-1');
  try {
    writeFileSync(
      join(t.brainRoot, '_raw', 'cycles', 'CY-1.md'),
      '---\nsource_type: cycle\n---\nbody',
    );
    const r = checkCycleArchive(join(t.brainRoot, '_raw', 'cycles', 'CY-1.md'), 'CY-1');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /ingested_at|ingested_by/);
  } finally {
    t.cleanup();
  }
});

test('checkCycleArchive: passes when all required fields present', () => {
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1');
    const r = checkCycleArchive(fix.archivePath, 'CY-1');
    assert.equal(r.ok, true);
    assert.equal(r.reason, null);
  } finally {
    t.cleanup();
  }
});

test('checkCycleArchive: rejects mismatched cycle_id', () => {
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1');
    const r = checkCycleArchive(fix.archivePath, 'CY-DIFFERENT');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /cycle_id mismatch/);
  } finally {
    t.cleanup();
  }
});

// ---------- retroHasThreeSections ----------

test('retroHasThreeSections: true when all three headings present', () => {
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1');
    assert.equal(retroHasThreeSections(fix.retroPath), true);
  } finally {
    t.cleanup();
  }
});

test('retroHasThreeSections: false when missing User feedback section', () => {
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1', {
      retroBody: '## Self-reflection\nfoo\n## User questions\nbar\n',
    });
    assert.equal(retroHasThreeSections(fix.retroPath), false);
  } finally {
    t.cleanup();
  }
});

test('retroHasThreeSections: case-insensitive and tolerates variations', () => {
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1', {
      retroBody:
        '## SELF-REFLECTION\nfoo\n## User Questions\nbar\n## user_feedback\nbaz\n',
    });
    assert.equal(retroHasThreeSections(fix.retroPath), true);
  } finally {
    t.cleanup();
  }
});

// ---------- brainGapsAddressed ----------

test('brainGapsAddressed: auto-passes on empty gap list', () => {
  const r = brainGapsAddressed('/nonexistent/retro.md', [], []);
  assert.equal(r.value, 1);
});

test('brainGapsAddressed: passes when all gap-ids appear in retro', () => {
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1', {
      retroBody:
        '## Self-reflection\nAddressed gaps GAP-1, GAP-2.\n## User questions\nx\n## User feedback\ny\n',
    });
    const r = brainGapsAddressed(fix.retroPath, [], ['GAP-1', 'GAP-2']);
    assert.equal(r.value, 1);
    assert.deepEqual(r.unaddressed, []);
  } finally {
    t.cleanup();
  }
});

test('brainGapsAddressed: passes when gap is referenced in a theme', () => {
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1', {
      themeBodies: {
        'theme-with-gap.md': makeThemeBody({}) + '\nResolves GAP-7.\n',
      },
    });
    const themePaths = [join(t.brainRoot, 'projects', 'slugifier', 'themes', 'theme-with-gap.md')];
    const r = brainGapsAddressed(fix.retroPath, themePaths, ['GAP-7']);
    assert.equal(r.value, 1);
  } finally {
    t.cleanup();
  }
});

test('brainGapsAddressed: fails when gap is unaddressed', () => {
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1');
    const r = brainGapsAddressed(fix.retroPath, [], ['GAP-MISSING']);
    assert.equal(r.value, 0);
    assert.deepEqual(r.unaddressed, ['GAP-MISSING']);
  } finally {
    t.cleanup();
  }
});

// ---------- brainConsulted ----------

test('brainConsulted: 0 when zero brain reads', () => {
  assert.equal(brainConsulted({ brainReads: 0, themeWrites: 0, retroWrites: 0, bashCalls: 0 }), 0);
});

test('brainConsulted: 1 when at least one brain read', () => {
  assert.equal(brainConsulted({ brainReads: 1, themeWrites: 0, retroWrites: 0, bashCalls: 0 }), 1);
});

// ---------- caseScore: gates ----------

test('caseScore: gate manifest_provided fails → score 0', () => {
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1');
    writeFileSync(
      join(t.brainRoot, 'projects', 'slugifier', 'themes', 'good.md'),
      makeThemeBody({ evidence: [fix.eventLogPath] }),
    );
    const score = caseScore({
      cycleId: 'CY-1',
      benchRoot: t.root,
      manifestPath: '/path/that/does/not/exist',
      eventLogPath: fix.eventLogPath,
      toolUse: makeToolUse(),
      expected: makeExpected(),
    });
    assert.equal(score.score, 0);
    assert.equal(score.passed, false);
    assert.equal(score.criteria.manifest_provided, 0);
  } finally {
    t.cleanup();
  }
});

test('caseScore: gate retro_emitted fails → score 0', () => {
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1');
    rmSync(fix.retroPath);
    const score = caseScore({
      cycleId: 'CY-1',
      benchRoot: t.root,
      manifestPath: fix.manifestPath,
      eventLogPath: fix.eventLogPath,
      toolUse: makeToolUse(),
      expected: makeExpected(),
    });
    assert.equal(score.score, 0);
    assert.equal(score.criteria.retro_emitted, 0);
  } finally {
    t.cleanup();
  }
});

test('caseScore: gate brain_consulted fails when zero brain reads', () => {
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1');
    writeFileSync(
      join(t.brainRoot, 'projects', 'slugifier', 'themes', 'a.md'),
      makeThemeBody({ evidence: [fix.eventLogPath] }),
    );
    const score = caseScore({
      cycleId: 'CY-1',
      benchRoot: t.root,
      manifestPath: fix.manifestPath,
      eventLogPath: fix.eventLogPath,
      toolUse: makeToolUse({ brainReads: 0 }),
      expected: makeExpected(),
    });
    assert.equal(score.score, 0);
    assert.equal(score.criteria.brain_consulted, 0);
  } finally {
    t.cleanup();
  }
});

test('caseScore: gate no_brain_corruption fails when theme missing frontmatter', () => {
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1', {
      themeBodies: {
        'broken.md': '# No frontmatter, just a title\n\nbody\n## Sources\n- _logs/CY-1/events.jsonl\n',
      },
    });
    const score = caseScore({
      cycleId: 'CY-1',
      benchRoot: t.root,
      manifestPath: fix.manifestPath,
      eventLogPath: fix.eventLogPath,
      toolUse: makeToolUse(),
      expected: makeExpected(),
    });
    assert.equal(score.score, 0);
    assert.equal(score.criteria.no_brain_corruption, 0);
    assert.ok(score.lint_errors.some((e) => e.includes('missing frontmatter')));
  } finally {
    t.cleanup();
  }
});

test('caseScore: gate no_brain_corruption fails when category invalid', () => {
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1', {
      themeBodies: {
        'bad-cat.md': makeThemeBody({ category: 'observation' }),
      },
    });
    const score = caseScore({
      cycleId: 'CY-1',
      benchRoot: t.root,
      manifestPath: fix.manifestPath,
      eventLogPath: fix.eventLogPath,
      toolUse: makeToolUse(),
      expected: makeExpected(),
    });
    assert.equal(score.score, 0);
    assert.equal(score.criteria.no_brain_corruption, 0);
    assert.ok(score.lint_errors.some((e) => e.includes('invalid category')));
  } finally {
    t.cleanup();
  }
});

// ---------- caseScore: weighted criteria ----------

test('caseScore: full pass returns score=1 and passed=true', () => {
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1');
    // Two themes, both valid + evidence-grounded.
    writeFileSync(
      join(t.brainRoot, 'projects', 'slugifier', 'themes', 'theme-1.md'),
      makeThemeBody({ category: 'pattern', evidence: [fix.eventLogPath] }),
    );
    writeFileSync(
      join(t.brainRoot, 'projects', 'slugifier', 'themes', 'theme-2.md'),
      makeThemeBody({ category: 'reference', evidence: [fix.archivePath] }),
    );
    const score = caseScore({
      cycleId: 'CY-1',
      benchRoot: t.root,
      manifestPath: fix.manifestPath,
      eventLogPath: fix.eventLogPath,
      toolUse: makeToolUse(),
      expected: makeExpected({ min_themes: 2 }),
    });
    assert.equal(score.score, 1);
    assert.equal(score.passed, true);
    assert.equal(score.criteria.themes_emitted, 1);
    assert.equal(score.criteria.themes_evidence_grounded, 1);
    assert.equal(score.criteria.theme_categories_balanced, 1);
    assert.equal(score.criteria.cycle_archived, 1);
    assert.equal(score.criteria.retro_three_sections, 1);
    assert.equal(score.criteria.brain_gaps_addressed, 1);
  } finally {
    t.cleanup();
  }
});

test('caseScore: themes_emitted=0 below min_themes', () => {
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1');
    writeFileSync(
      join(t.brainRoot, 'projects', 'slugifier', 'themes', 'only-one.md'),
      makeThemeBody({ evidence: [fix.eventLogPath] }),
    );
    const score = caseScore({
      cycleId: 'CY-1',
      benchRoot: t.root,
      manifestPath: fix.manifestPath,
      eventLogPath: fix.eventLogPath,
      toolUse: makeToolUse(),
      expected: makeExpected({ min_themes: 3 }),
    });
    assert.equal(score.criteria.themes_emitted, 0);
    // Score = 1 - WEIGHT_THEMES_EMITTED  (everything else passes).
    assert.equal(score.score, 1 - WEIGHT_THEMES_EMITTED);
  } finally {
    t.cleanup();
  }
});

test('caseScore: theme_categories_balanced=0 when wedge present but no antipattern', () => {
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1', {
      events:
        [
          JSON.stringify({ event_type: 'start' }),
          JSON.stringify({ event_type: 'end', message: 'ralph.end', metadata: { stop_reason: 'wedged' } }),
        ].join('\n') + '\n',
    });
    writeFileSync(
      join(t.brainRoot, 'projects', 'slugifier', 'themes', 'no-antipattern.md'),
      makeThemeBody({ category: 'pattern', evidence: [fix.eventLogPath] }),
    );
    const score = caseScore({
      cycleId: 'CY-1',
      benchRoot: t.root,
      manifestPath: fix.manifestPath,
      eventLogPath: fix.eventLogPath,
      toolUse: makeToolUse(),
      expected: makeExpected(),
    });
    assert.equal(score.criteria.theme_categories_balanced, 0);
  } finally {
    t.cleanup();
  }
});

test('caseScore: theme_categories_balanced=1 when wedge present and antipattern theme exists', () => {
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1', {
      events:
        [
          JSON.stringify({ event_type: 'start' }),
          JSON.stringify({ event_type: 'end', message: 'ralph.end', metadata: { stop_reason: 'wedged' } }),
        ].join('\n') + '\n',
    });
    writeFileSync(
      join(t.brainRoot, 'projects', 'slugifier', 'themes', 'wedge-antipattern.md'),
      makeThemeBody({ category: 'antipattern', evidence: [fix.eventLogPath] }),
    );
    const score = caseScore({
      cycleId: 'CY-1',
      benchRoot: t.root,
      manifestPath: fix.manifestPath,
      eventLogPath: fix.eventLogPath,
      toolUse: makeToolUse(),
      expected: makeExpected(),
    });
    assert.equal(score.criteria.theme_categories_balanced, 1);
  } finally {
    t.cleanup();
  }
});

test('caseScore: brain_gaps_addressed when fixture has gap_ids', () => {
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1', {
      retroBody:
        '## Self-reflection\nAddressed GAP-A.\n## User questions\nx\n## User feedback\ny\n',
    });
    writeFileSync(
      join(t.brainRoot, 'projects', 'slugifier', 'themes', 'theme-1.md'),
      makeThemeBody({ evidence: [fix.eventLogPath] }),
    );
    const score = caseScore({
      cycleId: 'CY-1',
      benchRoot: t.root,
      manifestPath: fix.manifestPath,
      eventLogPath: fix.eventLogPath,
      toolUse: makeToolUse(),
      expected: makeExpected({ brain_gap_ids: ['GAP-A'] }),
    });
    assert.equal(score.criteria.brain_gaps_addressed, 1);
  } finally {
    t.cleanup();
  }
});

// ---------- threshold ----------

test('caseScore: passes threshold at exactly 0.7', () => {
  // Construct a case where: themes_emitted + evidence_grounded + categories +
  // retro_sections + cycle_archived = 0.25 + 0.25 + 0.10 + 0.15 + 0.15 = 0.90
  // (brain_gaps fails, weight 0.10) → 0.90 ≥ 0.7 → pass.
  const t = setupBenchTree('CY-1');
  try {
    const fix = writeMinimalFixture(t, 'CY-1');
    writeFileSync(
      join(t.brainRoot, 'projects', 'slugifier', 'themes', 't.md'),
      makeThemeBody({ evidence: [fix.eventLogPath] }),
    );
    const score = caseScore({
      cycleId: 'CY-1',
      benchRoot: t.root,
      manifestPath: fix.manifestPath,
      eventLogPath: fix.eventLogPath,
      toolUse: makeToolUse(),
      expected: makeExpected({ brain_gap_ids: ['GAP-MISSING-FROM-CORPUS'] }),
    });
    assert.equal(score.criteria.brain_gaps_addressed, 0);
    assert.ok(score.passed, `expected score ≥ ${PASS_THRESHOLD}, got ${score.score}`);
    assert.equal(score.score, 1 - WEIGHT_BRAIN_GAPS);
  } finally {
    t.cleanup();
  }
});

// ---------- S6A — lintInvoked gate ----------

test('lintInvoked: 1 when reflector.lint-invoked event present', () => {
  assert.equal(
    lintInvoked([
      { phase: 'reflection', message: 'reflector.start' },
      { phase: 'reflection', message: 'reflector.lint-invoked' },
    ]),
    1,
  );
});

test('lintInvoked: 1 when reflector.lint-skipped event present', () => {
  assert.equal(
    lintInvoked([
      { phase: 'reflection', message: 'reflector.start' },
      { phase: 'reflection', message: 'reflector.lint-skipped' },
    ]),
    1,
  );
});

test('lintInvoked: 1 when reflector.lint-flagged event present', () => {
  assert.equal(
    lintInvoked([
      { phase: 'reflection', message: 'reflector.start' },
      { phase: 'reflection', message: 'reflector.lint-flagged' },
    ]),
    1,
  );
});

test('lintInvoked: 0 when reflector ran but no lint event followed', () => {
  assert.equal(
    lintInvoked([
      { phase: 'reflection', message: 'reflector.start' },
      { phase: 'reflection', message: 'reflector.end' },
    ]),
    0,
  );
});

test('lintInvoked: 1 (backward compat) when reflector phase never fired', () => {
  // Pre-S6A frozen fixture log path.
  assert.equal(
    lintInvoked([
      { phase: 'orchestrator', message: 'cycle.start' },
      { phase: 'orchestrator', message: 'cycle.end' },
    ]),
    1,
  );
});

// ---------- S6A — retentionAssigned gate ----------

test('retentionAssigned: 1 when retention is load-bearing', () => {
  const t = setupBenchTree('CY-1');
  try {
    const archivePath = join(t.brainRoot, '_raw', 'cycles', 'CY-1.md');
    writeFileSync(
      archivePath,
      [
        '---',
        'source_type: cycle',
        'cycle_id: CY-1',
        'ingested_at: 2026-05-23',
        'ingested_by: reflector',
        'retention: load-bearing',
        'cited_by: []',
        '---',
        '',
        'body',
      ].join('\n'),
    );
    assert.equal(retentionAssigned(archivePath), 1);
  } finally {
    t.cleanup();
  }
});

test('retentionAssigned: 1 for interesting + routine tiers', () => {
  const t = setupBenchTree('CY-1');
  try {
    for (const tier of ['interesting', 'routine']) {
      const archivePath = join(t.brainRoot, '_raw', 'cycles', `CY-${tier}.md`);
      writeFileSync(
        archivePath,
        [
          '---',
          'source_type: cycle',
          `retention: ${tier}`,
          '---',
          '',
        ].join('\n'),
      );
      assert.equal(retentionAssigned(archivePath), 1, `expected 1 for ${tier}`);
    }
  } finally {
    t.cleanup();
  }
});

test('retentionAssigned: 0 when retention is the placeholder "auto"', () => {
  const t = setupBenchTree('CY-1');
  try {
    const archivePath = join(t.brainRoot, '_raw', 'cycles', 'CY-1.md');
    writeFileSync(
      archivePath,
      ['---', 'source_type: cycle', 'retention: auto', '---', ''].join('\n'),
    );
    assert.equal(retentionAssigned(archivePath), 0);
  } finally {
    t.cleanup();
  }
});

test('retentionAssigned: 0 when retention value is invalid', () => {
  const t = setupBenchTree('CY-1');
  try {
    const archivePath = join(t.brainRoot, '_raw', 'cycles', 'CY-1.md');
    writeFileSync(
      archivePath,
      ['---', 'source_type: cycle', 'retention: garbage', '---', ''].join('\n'),
    );
    assert.equal(retentionAssigned(archivePath), 0);
  } finally {
    t.cleanup();
  }
});

test('retentionAssigned: 1 (backward compat) when retention key is absent', () => {
  const t = setupBenchTree('CY-1');
  try {
    const archivePath = join(t.brainRoot, '_raw', 'cycles', 'CY-1.md');
    writeFileSync(
      archivePath,
      ['---', 'source_type: cycle', 'ingested_by: reflector', '---', ''].join(
        '\n',
      ),
    );
    assert.equal(retentionAssigned(archivePath), 1);
  } finally {
    t.cleanup();
  }
});

test('retentionAssigned: 0 when archive file missing', () => {
  assert.equal(retentionAssigned('/nonexistent/path.md'), 0);
});

// ---------- S6B — recapEmitted gate ----------

test('recapEmitted: 1 when recap.md exists + non-empty + reflector fired', () => {
  const t = setupBenchTree('CY-recap');
  try {
    const recapPath = join(t.cycleLogDir, 'recap.md');
    writeFileSync(recapPath, '# Cycle recap — CY-recap\n\n## Outcome\n\nclosed.\n');
    assert.equal(
      recapEmitted(recapPath, [
        { phase: 'reflection', message: 'reflector.start' },
        { phase: 'reflection', message: 'reflector.end' },
      ]),
      1,
    );
  } finally {
    t.cleanup();
  }
});

test('recapEmitted: 0 when reflector fired but recap is missing', () => {
  const t = setupBenchTree('CY-recap');
  try {
    const recapPath = join(t.cycleLogDir, 'recap.md');
    // do NOT write recap.md
    assert.equal(
      recapEmitted(recapPath, [
        { phase: 'reflection', message: 'reflector.start' },
      ]),
      0,
    );
  } finally {
    t.cleanup();
  }
});

test('recapEmitted: 0 when recap.md is empty', () => {
  const t = setupBenchTree('CY-recap');
  try {
    const recapPath = join(t.cycleLogDir, 'recap.md');
    writeFileSync(recapPath, '   \n\n');
    assert.equal(
      recapEmitted(recapPath, [
        { phase: 'reflection', message: 'reflector.start' },
      ]),
      0,
    );
  } finally {
    t.cleanup();
  }
});

test('recapEmitted: 1 (backward compat) when reflector phase never fired', () => {
  const t = setupBenchTree('CY-recap');
  try {
    const recapPath = join(t.cycleLogDir, 'recap.md');
    assert.equal(
      recapEmitted(recapPath, [
        { phase: 'orchestrator', message: 'cycle.start' },
        { phase: 'orchestrator', message: 'cycle.end' },
      ]),
      1,
    );
  } finally {
    t.cleanup();
  }
});

test('weights sum to 1.0', () => {
  const total =
    WEIGHT_THEMES_EMITTED +
    WEIGHT_EVIDENCE_GROUNDED +
    WEIGHT_CATEGORIES_BALANCED +
    WEIGHT_CYCLE_ARCHIVED +
    WEIGHT_RETRO_SECTIONS +
    WEIGHT_BRAIN_GAPS;
  assert.equal(total, 1);
});
