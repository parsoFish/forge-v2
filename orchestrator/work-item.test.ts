/**
 * Tests for the work-item module — parse, validate, serialise, write,
 * cycle/coupling detection. Mirrors the manifest.test.ts shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseWorkItem,
  serializeWorkItem,
  validateWorkItem,
  validateWorkItemSet,
  writeWorkItem,
  readWorkItemsFromDir,
  detectHiddenCoupling,
  type WorkItem,
} from './work-item.ts';

function fixture(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    work_item_id: 'WI-1',
    feature_id: 'FEAT-1',
    initiative_id: 'INIT-2026-05-08-demo',
    status: 'pending',
    depends_on: [],
    acceptance_criteria: [
      { given: 'a request', when: 'the handler runs', then: 'it returns 200' },
    ],
    files_in_scope: ['src/handler.ts'],
    estimated_iterations: 2,
    body: 'Implement the handler.',
    ...overrides,
  };
}

test('serializeWorkItem → parseWorkItem round-trips frontmatter and body', () => {
  const w = fixture();
  const md = serializeWorkItem(w);
  assert.match(md, /^---\n/);
  assert.match(md, /work_item_id: WI-1/);
  assert.match(md, /feature_id: FEAT-1/);
  assert.match(md, /Implement the handler/);

  const parsed = parseWorkItem(md);
  assert.equal(parsed.work_item_id, 'WI-1');
  assert.equal(parsed.feature_id, 'FEAT-1');
  assert.equal(parsed.initiative_id, 'INIT-2026-05-08-demo');
  assert.equal(parsed.status, 'pending');
  assert.equal(parsed.acceptance_criteria.length, 1);
  assert.equal(parsed.acceptance_criteria[0]!.given, 'a request');
  assert.deepEqual(parsed.files_in_scope, ['src/handler.ts']);
  assert.equal(parsed.estimated_iterations, 2);
});

test('validateWorkItem: passes a clean work item', () => {
  assert.deepEqual(validateWorkItem(fixture()), []);
});

test('validateWorkItem: rejects malformed work_item_id', () => {
  const errors = validateWorkItem(fixture({ work_item_id: 'WIE-1' }));
  assert.ok(errors.some((e) => e.includes('work_item_id') && e.includes('WI-')), `got ${JSON.stringify(errors)}`);
});

test('validateWorkItem: rejects malformed feature_id', () => {
  const errors = validateWorkItem(fixture({ feature_id: 'F-1' }));
  assert.ok(errors.some((e) => e.includes('feature_id') && e.includes('FEAT-')));
});

test('validateWorkItem: rejects malformed initiative_id', () => {
  const errors = validateWorkItem(fixture({ initiative_id: 'INIT-x' }));
  assert.ok(errors.some((e) => e.includes('initiative_id')));
});

test('validateWorkItem: rejects empty acceptance_criteria', () => {
  const errors = validateWorkItem(fixture({ acceptance_criteria: [] }));
  assert.ok(errors.some((e) => e.includes('acceptance_criteria')));
});

test('validateWorkItem: rejects empty given/when/then in acceptance_criteria', () => {
  const errors = validateWorkItem(fixture({
    acceptance_criteria: [{ given: 'x', when: '', then: 'y' }],
  }));
  assert.ok(errors.some((e) => e.includes('when')));
});

test('validateWorkItem: rejects empty files_in_scope', () => {
  const errors = validateWorkItem(fixture({ files_in_scope: [] }));
  assert.ok(errors.some((e) => e.includes('files_in_scope')));
});

test('validateWorkItem: rejects absolute path in files_in_scope', () => {
  const errors = validateWorkItem(fixture({ files_in_scope: ['/etc/passwd'] }));
  assert.ok(errors.some((e) => e.includes('worktree-relative')));
});

test('validateWorkItem: rejects parent-traversal in files_in_scope', () => {
  const errors = validateWorkItem(fixture({ files_in_scope: ['../escape.ts'] }));
  assert.ok(errors.some((e) => e.includes("'..'")));
});

test('validateWorkItem: rejects estimated_iterations <= 0', () => {
  assert.ok(validateWorkItem(fixture({ estimated_iterations: 0 })).some((e) => e.includes('estimated_iterations')));
  assert.ok(validateWorkItem(fixture({ estimated_iterations: -1 })).some((e) => e.includes('estimated_iterations')));
});

test('validateWorkItem: rejects self-dependency', () => {
  const errors = validateWorkItem(fixture({ depends_on: ['WI-1'] }));
  assert.ok(errors.some((e) => e.includes('self')));
});

test('validateWorkItem: rejects depends_on referring to unknown WI when set provided', () => {
  const errors = validateWorkItem(fixture({ depends_on: ['WI-99'] }), {
    knownWorkItemIds: new Set(['WI-1', 'WI-2']),
  });
  assert.ok(errors.some((e) => e.includes('WI-99')));
});

test('validateWorkItem: rejects feature_id missing from manifest set', () => {
  const errors = validateWorkItem(fixture({ feature_id: 'FEAT-9' }), {
    knownFeatureIds: new Set(['FEAT-1', 'FEAT-2']),
  });
  assert.ok(errors.some((e) => e.includes('FEAT-9')));
});

test('validateWorkItemSet: rejects duplicate work_item_ids', () => {
  const a = fixture({ work_item_id: 'WI-1' });
  const b = fixture({ work_item_id: 'WI-1', files_in_scope: ['src/other.ts'] });
  const { setErrors } = validateWorkItemSet([a, b]);
  assert.ok(setErrors.some((e) => e.includes('duplicate')));
});

test('validateWorkItemSet: rejects dependency cycles', () => {
  const a = fixture({ work_item_id: 'WI-1', depends_on: ['WI-2'], files_in_scope: ['a.ts'] });
  const b = fixture({ work_item_id: 'WI-2', depends_on: ['WI-1'], files_in_scope: ['b.ts'] });
  const { setErrors } = validateWorkItemSet([a, b]);
  assert.ok(setErrors.some((e) => e.toLowerCase().includes('cycle')));
});

test('detectHiddenCoupling: flags pairs touching a shared file with no edge', () => {
  const a = fixture({ work_item_id: 'WI-1', files_in_scope: ['src/shared.ts'] });
  const b = fixture({ work_item_id: 'WI-2', files_in_scope: ['src/shared.ts'], depends_on: [] });
  const pairs = detectHiddenCoupling([a, b]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.a, 'WI-1');
  assert.equal(pairs[0]!.b, 'WI-2');
  assert.deepEqual(pairs[0]!.sharedFiles, ['src/shared.ts']);
});

test('detectHiddenCoupling: does not flag pairs already linked transitively', () => {
  const a = fixture({ work_item_id: 'WI-1', files_in_scope: ['src/shared.ts'] });
  const b = fixture({ work_item_id: 'WI-2', files_in_scope: ['src/other.ts'], depends_on: ['WI-1'] });
  const c = fixture({ work_item_id: 'WI-3', files_in_scope: ['src/shared.ts'], depends_on: ['WI-2'] });
  const pairs = detectHiddenCoupling([a, b, c]);
  assert.equal(pairs.length, 0, `unexpected pairs: ${JSON.stringify(pairs)}`);
});

test('detectHiddenCoupling: does not flag direct dependency edge', () => {
  const a = fixture({ work_item_id: 'WI-1', files_in_scope: ['src/shared.ts'] });
  const b = fixture({ work_item_id: 'WI-2', files_in_scope: ['src/shared.ts'], depends_on: ['WI-1'] });
  assert.deepEqual(detectHiddenCoupling([a, b]), []);
});

test('detectHiddenCoupling: collapses multiple shared files into one pair', () => {
  const a = fixture({ work_item_id: 'WI-1', files_in_scope: ['src/a.ts', 'src/b.ts'] });
  const b = fixture({ work_item_id: 'WI-2', files_in_scope: ['src/a.ts', 'src/b.ts'] });
  const pairs = detectHiddenCoupling([a, b]);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0]!.sharedFiles.sort(), ['src/a.ts', 'src/b.ts']);
});

test('writeWorkItem: writes a parseable file under .forge/work-items/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-wi-'));
  try {
    const out = writeWorkItem(fixture(), dir);
    assert.ok(existsSync(out), `expected file at ${out}`);
    assert.ok(out.includes(join('.forge', 'work-items', 'WI-1.md')), `got ${out}`);
    const parsed = parseWorkItem(readFileSync(out, 'utf8'));
    assert.equal(parsed.work_item_id, 'WI-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeWorkItem: refuses to write an invalid work item', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-wi-'));
  try {
    const bad = fixture({ work_item_id: 'not-an-id' });
    assert.throws(() => writeWorkItem(bad, dir), /work_item_id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readWorkItemsFromDir: returns empty when dir missing', () => {
  const result = readWorkItemsFromDir('/nonexistent/path/should/not/exist');
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.parseErrors, {});
});

test('readWorkItemsFromDir: parses all .md files except _graph.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-wi-'));
  try {
    writeWorkItem(fixture({ work_item_id: 'WI-1' }), dir);
    writeWorkItem(fixture({ work_item_id: 'WI-2', files_in_scope: ['src/other.ts'] }), dir);
    writeFileSync(join(dir, '.forge', 'work-items', '_graph.md'), '# graph');

    const { items, parseErrors } = readWorkItemsFromDir(join(dir, '.forge', 'work-items'));
    assert.equal(items.length, 2);
    assert.deepEqual(parseErrors, {});
    assert.deepEqual(items.map((i) => i.work_item_id).sort(), ['WI-1', 'WI-2']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseWorkItem: throws on missing required field', () => {
  const md = `---\nfeature_id: FEAT-1\n---\n\nbody`;
  assert.throws(() => parseWorkItem(md), /work_item_id/);
});
