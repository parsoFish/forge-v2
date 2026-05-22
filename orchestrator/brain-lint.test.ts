/**
 * Unit tests for brain-lint.ts.
 *
 * Each of the 7 checks (+ the warn-only contradictions stretch goal) gets at
 * least one positive (clean) and one negative (violation) case. Tests build a
 * tempdir brain corpus from minimal fixtures — they do not touch the live
 * brain.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkContamination,
  checkContradictions,
  checkFrontmatter,
  checkIndexSync,
  checkLengthSoftCap,
  checkOrphans,
  checkSourceLinks,
  checkStaleness,
  runBrainLint,
} from './brain-lint.ts';

// ---------- fixture builder ----------

type ThemeSpec = {
  /** Relative path under brain/ (e.g. `forge/themes/foo.md`). */
  path: string;
  /** Frontmatter as a partial object — title/description/category/created_at/updated_at default to valid values when omitted. */
  fm?: Partial<{
    title: string;
    description: string;
    category: string;
    created_at: string;
    updated_at: string;
    keywords: string[];
    related_themes: string[];
  }>;
  /** Body markdown after frontmatter. */
  body?: string;
};

type BrainFixtureSpec = {
  themes: ThemeSpec[];
  /** Extra files at arbitrary paths (e.g. `INDEX.md`, `forge/patterns.md`, `projects/<n>/profile.md`). */
  extra?: Array<{ path: string; content: string }>;
};

function buildBrainFixture(spec: BrainFixtureSpec): string {
  const root = mkdtempSync(join(tmpdir(), 'brain-lint-test-'));
  const brain = join(root, 'brain');
  mkdirSync(brain, { recursive: true });

  // INDEX.md must always exist for orphan/index-sync checks.
  if (!spec.extra?.some((e) => e.path === 'INDEX.md')) {
    writeFileSync(join(brain, 'INDEX.md'), '# Brain\n\nnavigation hub.\n');
  }

  // Forge category indexes — default to empty stubs so checkIndexSync has a target.
  for (const cat of ['patterns', 'antipatterns', 'decisions', 'operations', 'reference']) {
    const p = join(brain, 'forge', `${cat}.md`);
    mkdirSync(join(brain, 'forge'), { recursive: true });
    if (!spec.extra?.some((e) => e.path === `forge/${cat}.md`)) {
      writeFileSync(p, `# ${cat}\n`);
    }
  }
  mkdirSync(join(brain, 'forge', 'themes'), { recursive: true });
  mkdirSync(join(brain, 'projects'), { recursive: true });

  for (const t of spec.themes) {
    const file = join(brain, t.path);
    mkdirSync(join(file, '..'), { recursive: true });
    const fm = {
      title: t.fm?.title ?? `theme-${t.path}`,
      description: t.fm?.description ?? 'description text.',
      category: t.fm?.category ?? 'pattern',
      created_at: t.fm?.created_at ?? '2026-01-01T00:00:00Z',
      updated_at: t.fm?.updated_at ?? '2026-01-01T00:00:00Z',
      keywords: t.fm?.keywords ?? [],
      related_themes: t.fm?.related_themes ?? [],
    };
    const lines = ['---'];
    for (const [k, v] of Object.entries(fm)) {
      if (Array.isArray(v)) lines.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(', ')}]`);
      else lines.push(`${k}: ${v}`);
    }
    lines.push('---');
    lines.push('');
    lines.push(t.body ?? '# theme body');
    writeFileSync(file, lines.join('\n') + '\n');
  }

  for (const e of spec.extra ?? []) {
    const file = join(brain, e.path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, e.content);
  }

  return root;
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

// ---------- checkFrontmatter ----------

test('checkFrontmatter: clean theme produces no findings', () => {
  const root = buildBrainFixture({
    themes: [{ path: 'forge/themes/clean.md', fm: { category: 'pattern' } }],
  });
  try {
    const findings = checkFrontmatter(root);
    assert.equal(findings.filter((f) => f.file.endsWith('clean.md')).length, 0);
  } finally {
    cleanup(root);
  }
});

test('checkFrontmatter: rejects category outside the whitelist (snapshot/process/bug-candidate)', () => {
  const root = buildBrainFixture({
    themes: [
      { path: 'forge/themes/snap.md', fm: { category: 'snapshot' } },
      { path: 'forge/themes/proc.md', fm: { category: 'process' } },
      { path: 'forge/themes/bug.md', fm: { category: 'bug-candidate' } },
      { path: 'forge/themes/ok.md', fm: { category: 'pattern' } },
    ],
  });
  try {
    const findings = checkFrontmatter(root);
    const errors = findings.filter((f) => f.category === 'error');
    assert.equal(errors.length, 3, 'three category violations');
    assert.ok(errors.some((e) => e.file.endsWith('snap.md')));
    assert.ok(errors.some((e) => e.file.endsWith('proc.md')));
    assert.ok(errors.some((e) => e.file.endsWith('bug.md')));
    assert.ok(!errors.some((e) => e.file.endsWith('ok.md')));
  } finally {
    cleanup(root);
  }
});

test('checkFrontmatter: flags missing required field (description)', () => {
  const root = buildBrainFixture({ themes: [] });
  // Hand-write a theme with no description.
  const file = join(root, 'brain', 'forge', 'themes', 'no-desc.md');
  writeFileSync(
    file,
    `---
title: no-desc
category: pattern
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---

body.
`,
  );
  try {
    const findings = checkFrontmatter(root);
    const errors = findings.filter((f) => f.category === 'error' && f.file.endsWith('no-desc.md'));
    assert.ok(errors.length >= 1);
    assert.ok(errors.some((e) => /description/i.test(e.message)));
  } finally {
    cleanup(root);
  }
});

// ---------- checkIndexSync ----------

test('checkIndexSync: theme indexed in its category index produces no findings', () => {
  const root = buildBrainFixture({
    themes: [{ path: 'forge/themes/myp.md', fm: { category: 'pattern' } }],
    extra: [
      { path: 'forge/patterns.md', content: '# patterns\n\n- [`myp`](./themes/myp.md) — example.\n' },
    ],
  });
  try {
    const findings = checkIndexSync(root);
    assert.equal(findings.length, 0);
  } finally {
    cleanup(root);
  }
});

test('checkIndexSync: theme with category=pattern but missing from forge/patterns.md flags', () => {
  const root = buildBrainFixture({
    themes: [{ path: 'forge/themes/orphaned-pattern.md', fm: { category: 'pattern' } }],
  });
  try {
    const findings = checkIndexSync(root);
    assert.ok(findings.some((f) => f.file.endsWith('orphaned-pattern.md') && /index/i.test(f.message)));
  } finally {
    cleanup(root);
  }
});

// ---------- checkSourceLinks ----------

test('checkSourceLinks: resolved relative link produces no findings', () => {
  const root = buildBrainFixture({
    themes: [
      { path: 'forge/themes/a.md', fm: { category: 'pattern' }, body: '## Sources\n\n- [other](./b.md)\n' },
      { path: 'forge/themes/b.md', fm: { category: 'pattern' } },
    ],
  });
  try {
    const findings = checkSourceLinks(root);
    assert.equal(findings.filter((f) => f.file.endsWith('a.md')).length, 0);
  } finally {
    cleanup(root);
  }
});

test('checkSourceLinks: broken relative link errors', () => {
  const root = buildBrainFixture({
    themes: [
      { path: 'forge/themes/a.md', fm: { category: 'pattern' }, body: '## Sources\n\n- [gone](./does-not-exist.md)\n' },
    ],
  });
  try {
    const findings = checkSourceLinks(root);
    assert.ok(findings.some((f) => f.file.endsWith('a.md') && f.category === 'error'));
  } finally {
    cleanup(root);
  }
});

// ---------- checkStaleness ----------

test('checkStaleness: theme citing an existing path produces no error', () => {
  const root = buildBrainFixture({
    themes: [
      {
        path: 'forge/themes/cite.md',
        fm: { category: 'pattern' },
        body: '## Sources\n\n- `orchestrator/cycle.ts` — main cycle runner.\n',
      },
    ],
  });
  try {
    // Create the cited file at forge root so the staleness check sees it.
    mkdirSync(join(root, 'orchestrator'), { recursive: true });
    writeFileSync(join(root, 'orchestrator', 'cycle.ts'), '// stub\n');
    const findings = checkStaleness(root);
    assert.equal(findings.filter((f) => f.file.endsWith('cite.md') && f.category === 'error').length, 0);
  } finally {
    cleanup(root);
  }
});

test('checkStaleness: theme citing a deleted-in-project path flags', () => {
  const root = buildBrainFixture({
    themes: [
      {
        path: 'projects/myproj/themes/stale.md',
        fm: { category: 'antipattern' },
        body: '## Sources\n\n- `src/DeletedFile.ts` — was here.\n',
      },
    ],
    extra: [
      {
        path: 'projects/myproj/profile.md',
        content: '---\nproject: myproj\n---\n# myproj\n',
      },
    ],
  });
  try {
    // Project repo at <forgeRoot>/projects/myproj/ — exists but src/DeletedFile.ts does NOT.
    mkdirSync(join(root, 'projects', 'myproj', 'src'), { recursive: true });
    // No DeletedFile.ts on disk → staleness check should flag.
    const findings = checkStaleness(root);
    assert.ok(findings.some((f) => f.file.endsWith('stale.md') && /stale|missing|delet/i.test(f.message)));
  } finally {
    cleanup(root);
  }
});

// ---------- checkOrphans ----------

test('checkOrphans: theme reachable from a category index produces no finding', () => {
  const root = buildBrainFixture({
    themes: [{ path: 'forge/themes/reach.md', fm: { category: 'pattern' } }],
    extra: [
      { path: 'forge/patterns.md', content: '# patterns\n\n- [`reach`](./themes/reach.md) — yes.\n' },
    ],
  });
  try {
    const findings = checkOrphans(root);
    assert.equal(findings.filter((f) => f.file.endsWith('reach.md')).length, 0);
  } finally {
    cleanup(root);
  }
});

test('checkOrphans: theme not linked from any index flags', () => {
  const root = buildBrainFixture({
    themes: [{ path: 'forge/themes/lonely.md', fm: { category: 'pattern' } }],
  });
  try {
    const findings = checkOrphans(root);
    assert.ok(findings.some((f) => f.file.endsWith('lonely.md') && /orphan/i.test(f.message)));
  } finally {
    cleanup(root);
  }
});

// ---------- checkLengthSoftCap ----------

test('checkLengthSoftCap: short theme produces no finding', () => {
  const root = buildBrainFixture({
    themes: [{ path: 'forge/themes/short.md', fm: { category: 'pattern' }, body: '# x\n' }],
  });
  try {
    const findings = checkLengthSoftCap(root);
    assert.equal(findings.filter((f) => f.file.endsWith('short.md')).length, 0);
  } finally {
    cleanup(root);
  }
});

test('checkLengthSoftCap: > 100 lines errors; 61-99 lines warns', () => {
  const longBody = Array.from({ length: 110 }, (_, i) => `line ${i}`).join('\n');
  const midBody = Array.from({ length: 75 }, (_, i) => `line ${i}`).join('\n');
  const root = buildBrainFixture({
    themes: [
      { path: 'forge/themes/long.md', fm: { category: 'pattern' }, body: longBody },
      { path: 'forge/themes/mid.md', fm: { category: 'pattern' }, body: midBody },
    ],
  });
  try {
    const findings = checkLengthSoftCap(root);
    const longFinding = findings.find((f) => f.file.endsWith('long.md'));
    const midFinding = findings.find((f) => f.file.endsWith('mid.md'));
    assert.ok(longFinding && longFinding.category === 'error');
    assert.ok(midFinding && midFinding.category === 'flag');
  } finally {
    cleanup(root);
  }
});

// ---------- checkContamination ----------

test('checkContamination: clean project tree produces no findings', () => {
  const root = buildBrainFixture({
    themes: [],
    extra: [{ path: 'projects/realproj/profile.md', content: '# realproj\n' }],
  });
  try {
    const findings = checkContamination(root);
    assert.equal(findings.length, 0);
  } finally {
    cleanup(root);
  }
});

test('checkContamination: __chained_test_proj_* and __bench_* dirs error', () => {
  const root = buildBrainFixture({ themes: [] });
  mkdirSync(join(root, 'brain', 'projects', '__chained_test_proj_99999'), { recursive: true });
  mkdirSync(join(root, 'brain', 'projects', '__bench_xyz'), { recursive: true });
  try {
    const findings = checkContamination(root);
    assert.ok(findings.some((f) => f.file.includes('__chained_test_proj_99999') && f.category === 'error'));
    assert.ok(findings.some((f) => f.file.includes('__bench_xyz') && f.category === 'error'));
  } finally {
    cleanup(root);
  }
});

// ---------- checkContradictions (stretch, warn-only) ----------

test('checkContradictions: pattern + antipattern with overlapping keywords flags', () => {
  const root = buildBrainFixture({
    themes: [
      {
        path: 'forge/themes/x-pattern.md',
        fm: { category: 'pattern', keywords: ['k1', 'k2', 'k3'] },
      },
      {
        path: 'forge/themes/x-antipattern.md',
        fm: { category: 'antipattern', keywords: ['k1', 'k2', 'k3'] },
      },
    ],
  });
  try {
    const findings = checkContradictions(root);
    // Contradictions are warn-only — flag category.
    assert.ok(findings.some((f) => f.category === 'flag' && f.message.toLowerCase().includes('contradict')));
    // Never errors.
    assert.equal(findings.filter((f) => f.category === 'error').length, 0);
  } finally {
    cleanup(root);
  }
});

test('checkContradictions: pattern + antipattern with no keyword overlap produces no finding', () => {
  const root = buildBrainFixture({
    themes: [
      {
        path: 'forge/themes/y-pattern.md',
        fm: { category: 'pattern', keywords: ['a', 'b', 'c'] },
      },
      {
        path: 'forge/themes/y-antipattern.md',
        fm: { category: 'antipattern', keywords: ['d', 'e', 'f'] },
      },
    ],
  });
  try {
    const findings = checkContradictions(root);
    assert.equal(findings.filter((f) => f.message.toLowerCase().includes('contradict')).length, 0);
  } finally {
    cleanup(root);
  }
});

// ---------- runBrainLint (end-to-end) ----------

test('runBrainLint: full scope catches a mix of violations + clean themes', () => {
  const root = buildBrainFixture({
    themes: [
      { path: 'forge/themes/snap.md', fm: { category: 'snapshot' } }, // 1 category error
      { path: 'forge/themes/ok.md', fm: { category: 'pattern' } }, // orphan flag (not in patterns.md)
    ],
  });
  // Add a contamination dir.
  mkdirSync(join(root, 'brain', 'projects', '__chained_test_proj_1'), { recursive: true });
  try {
    const result = runBrainLint({ cwd: root, scope: 'full' });
    assert.ok(result.findings.some((f) => f.category === 'error' && /category/i.test(f.message)));
    assert.ok(result.findings.some((f) => f.category === 'error' && /contamination|__chained/i.test(f.message)));
    assert.ok(result.exitCode === 1, 'errors → exit 1');
  } finally {
    cleanup(root);
  }
});

test('runBrainLint: clean corpus exits 0', () => {
  const root = buildBrainFixture({
    themes: [{ path: 'forge/themes/c1.md', fm: { category: 'pattern' } }],
    extra: [
      { path: 'forge/patterns.md', content: '# patterns\n\n- [`c1`](./themes/c1.md) — yes.\n' },
      {
        path: 'INDEX.md',
        content: '# Brain\n\n- [c1](./forge/themes/c1.md)\n',
      },
    ],
  });
  try {
    const result = runBrainLint({ cwd: root, scope: 'full' });
    const errors = result.findings.filter((f) => f.category === 'error');
    assert.equal(errors.length, 0, `errors: ${JSON.stringify(errors)}`);
    assert.equal(result.exitCode, 0);
  } finally {
    cleanup(root);
  }
});

test('runBrainLint: single-file scope walks one file only', () => {
  const root = buildBrainFixture({
    themes: [
      { path: 'forge/themes/snap.md', fm: { category: 'snapshot' } },
      { path: 'forge/themes/proc.md', fm: { category: 'process' } },
    ],
  });
  try {
    const result = runBrainLint({
      cwd: root,
      scope: 'single-file',
      file: 'brain/forge/themes/snap.md',
    });
    const violationFiles = new Set(result.findings.map((f) => f.file));
    assert.ok(Array.from(violationFiles).every((f) => f.endsWith('snap.md')), 'only snap.md walked');
  } finally {
    cleanup(root);
  }
});

test('runBrainLint: forge-only scope skips project themes', () => {
  const root = buildBrainFixture({
    themes: [
      { path: 'forge/themes/forge-snap.md', fm: { category: 'snapshot' } },
      { path: 'projects/myproj/themes/proj-snap.md', fm: { category: 'snapshot' } },
    ],
    extra: [{ path: 'projects/myproj/profile.md', content: '# x\n' }],
  });
  try {
    const result = runBrainLint({ cwd: root, scope: 'forge-only' });
    assert.ok(result.findings.some((f) => f.file.endsWith('forge-snap.md')));
    assert.ok(!result.findings.some((f) => f.file.endsWith('proj-snap.md')));
  } finally {
    cleanup(root);
  }
});

test('runBrainLint: project-only scope walks only the named project', () => {
  const root = buildBrainFixture({
    themes: [
      { path: 'forge/themes/forge-snap.md', fm: { category: 'snapshot' } },
      { path: 'projects/p1/themes/p1-snap.md', fm: { category: 'snapshot' } },
      { path: 'projects/p2/themes/p2-snap.md', fm: { category: 'snapshot' } },
    ],
    extra: [
      { path: 'projects/p1/profile.md', content: '# p1\n' },
      { path: 'projects/p2/profile.md', content: '# p2\n' },
    ],
  });
  try {
    const result = runBrainLint({ cwd: root, scope: 'project-only', project: 'p1' });
    assert.ok(result.findings.some((f) => f.file.endsWith('p1-snap.md')));
    assert.ok(!result.findings.some((f) => f.file.endsWith('p2-snap.md')));
    assert.ok(!result.findings.some((f) => f.file.endsWith('forge-snap.md')));
  } finally {
    cleanup(root);
  }
});

test('runBrainLint: cleanup-dry-run scope reports contamination without errors', () => {
  const root = buildBrainFixture({ themes: [] });
  mkdirSync(join(root, 'brain', 'projects', '__chained_test_proj_42'), { recursive: true });
  try {
    const result = runBrainLint({ cwd: root, scope: 'cleanup-dry-run' });
    assert.ok(result.findings.some((f) => f.file.includes('__chained_test_proj_42')));
    // cleanup-dry-run is inventory-only — exit 0 unless deletion fails.
    assert.equal(result.exitCode, 0);
  } finally {
    cleanup(root);
  }
});
