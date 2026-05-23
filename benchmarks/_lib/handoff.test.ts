/**
 * Tests for benchmarks/_lib/handoff.ts — round-trip read of a synthetic
 * architect-result dir, latest-run resolution, missing-fixture error,
 * and PM-handoff parsing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadArchitectHandoff, loadPmHandoff } from './handoff.ts';

function makeForgeRootWithArchitectResults(): {
  forgeRoot: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'forge-handoff-test-'));
  const runDir = join(root, 'benchmarks', 'architect', 'results', '2026-01-15T10-00-00-000Z');
  mkdirSync(join(runDir, 'B1-betterado-substrate-only'), { recursive: true });
  writeFileSync(
    join(runDir, 'B1-betterado-substrate-only', 'manifest.md'),
    '---\ninitiative_id: INIT-X\n---\nbody',
  );
  writeFileSync(
    join(runDir, 'B1-betterado-substrate-only', 'plan-doc.md'),
    '# PLAN.md\n',
  );
  writeFileSync(
    join(runDir, 'B1-betterado-substrate-only', 'council-transcript.md'),
    '### CEO critic\n...',
  );
  return {
    forgeRoot: root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('loadArchitectHandoff: round-trips manifest + plan-doc + council transcript', () => {
  const { forgeRoot, cleanup } = makeForgeRootWithArchitectResults();
  try {
    const h = loadArchitectHandoff('B1-betterado-substrate-only', { forgeRoot });
    assert.ok(h.manifestText.includes('initiative_id: INIT-X'));
    assert.ok(h.planDoc.startsWith('# PLAN.md'));
    assert.ok(h.councilTranscript.includes('### CEO critic'));
  } finally {
    cleanup();
  }
});

test('loadArchitectHandoff: resolves the latest run by lexicographic order', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-handoff-test-'));
  try {
    const older = join(root, 'benchmarks', 'architect', 'results', '2025-01-01T00-00-00-000Z');
    const newer = join(root, 'benchmarks', 'architect', 'results', '2026-12-31T23-59-59-999Z');
    mkdirSync(join(older, 'A'), { recursive: true });
    mkdirSync(join(newer, 'A'), { recursive: true });
    writeFileSync(join(older, 'A', 'manifest.md'), 'OLDER');
    writeFileSync(join(newer, 'A', 'manifest.md'), 'NEWER');
    const h = loadArchitectHandoff('A', { forgeRoot: root });
    assert.equal(h.manifestText, 'NEWER');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadArchitectHandoff: pinning to a specific runId reads that dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-handoff-test-'));
  try {
    const older = join(root, 'benchmarks', 'architect', 'results', '2025-01-01T00-00-00-000Z');
    const newer = join(root, 'benchmarks', 'architect', 'results', '2026-12-31T23-59-59-999Z');
    mkdirSync(join(older, 'A'), { recursive: true });
    mkdirSync(join(newer, 'A'), { recursive: true });
    writeFileSync(join(older, 'A', 'manifest.md'), 'OLDER');
    writeFileSync(join(newer, 'A', 'manifest.md'), 'NEWER');
    const h = loadArchitectHandoff('A', {
      forgeRoot: root,
      runId: '2025-01-01T00-00-00-000Z',
    });
    assert.equal(h.manifestText, 'OLDER');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadArchitectHandoff: throws when fixture dir is missing', () => {
  const { forgeRoot, cleanup } = makeForgeRootWithArchitectResults();
  try {
    assert.throws(
      () => loadArchitectHandoff('NONEXISTENT', { forgeRoot }),
      /no architect handoff for fixture 'NONEXISTENT'/,
    );
  } finally {
    cleanup();
  }
});

test('loadArchitectHandoff: throws when no results dir exists at all', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-handoff-test-'));
  try {
    assert.throws(
      () => loadArchitectHandoff('X', { forgeRoot: root }),
      /no architect bench results found/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadArchitectHandoff: optional plan-doc/council-transcript default to empty string', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-handoff-test-'));
  try {
    const runDir = join(root, 'benchmarks', 'architect', 'results', '2026-01-15T10-00-00-000Z');
    mkdirSync(join(runDir, 'Z'), { recursive: true });
    writeFileSync(join(runDir, 'Z', 'manifest.md'), 'manifest only');
    const h = loadArchitectHandoff('Z', { forgeRoot: root });
    assert.equal(h.manifestText, 'manifest only');
    assert.equal(h.planDoc, '');
    assert.equal(h.councilTranscript, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadPmHandoff: round-trips work items, graph, and quality-gate command', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-handoff-test-'));
  try {
    const fixtureDir = join(
      root,
      'benchmarks',
      'project-manager',
      'results',
      '2026-01-15T10-00-00-000Z',
      'handoff',
      'B1-betterado-substrate-only',
    );
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      join(fixtureDir, 'WI-1.md'),
      [
        '---',
        'work_item_id: WI-1',
        'feature_id: FEAT-1',
        'initiative_id: INIT-2026-05-18-betterado-01-release-def-test-substrate',
        'status: pending',
        'depends_on: []',
        'acceptance_criteria:',
        '  - given: a thing',
        '    when: something happens',
        '    then: it works',
        'files_in_scope:',
        '  - path/to/file.go',
        'estimated_iterations: 1',
        '---',
        '',
        'body',
      ].join('\n'),
    );
    writeFileSync(join(fixtureDir, '_graph.md'), '```mermaid\ngraph TD\n  WI-1\n```');
    writeFileSync(
      join(fixtureDir, '_quality-gate.json'),
      JSON.stringify(['go', 'test', './azuredevops/internal/service/release/...']),
    );

    const h = loadPmHandoff('B1-betterado-substrate-only', { forgeRoot: root });
    assert.equal(h.workItems.length, 1);
    assert.equal(h.workItems[0]!.work_item_id, 'WI-1');
    assert.ok(h.graph.includes('graph TD'));
    assert.deepEqual(h.qualityGateCmd, ['go', 'test', './azuredevops/internal/service/release/...']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadPmHandoff: throws when results dir is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-handoff-test-'));
  try {
    assert.throws(
      () => loadPmHandoff('X', { forgeRoot: root }),
      /no project-manager bench results found/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadPmHandoff: quality-gate cmd defaults to empty array when not present', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-handoff-test-'));
  try {
    const fixtureDir = join(
      root,
      'benchmarks',
      'project-manager',
      'results',
      '2026-01-15T10-00-00-000Z',
      'handoff',
      'X',
    );
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, '_graph.md'), 'graph');
    const h = loadPmHandoff('X', { forgeRoot: root });
    assert.deepEqual(h.qualityGateCmd, []);
    assert.equal(h.workItems.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
