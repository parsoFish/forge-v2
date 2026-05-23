/**
 * Pure-function tests for architect benchmark scoring. No SDK mocked here —
 * that's sdk.test.ts. These verify each rubric dimension and the gate
 * behaviour (invalid manifest → 0).
 *
 * Includes the S2B regrounded criteria:
 *   - project_context_lifted (0.30)
 *   - escalations_resolved (0.25)
 *   - downstream_pm_score (0.30)
 *   - specs_concrete_per_feature (0.10) — retained from prior bench, weight halved
 *   - brain_consulted_qualified (0.05) — current regex + existsSync existence check
 *   - manifest_valid (gate — unchanged)
 *
 * Per C19: NO `aggregate_budget_declared` criterion anywhere.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  brainConsultedQualified,
  caseScore,
  countAcceptanceHeadings,
  countGivenWhenThen,
  detectBoilerplateBlocks,
  escalationsResolved,
  loadManifestForScoring,
  PASS_THRESHOLD,
  projectContextLifted,
  scopeRightSized,
  specsConcrete,
  WEIGHT_BRAIN,
  WEIGHT_CONTEXT_LIFTED,
  WEIGHT_DOWNSTREAM_PM,
  WEIGHT_ESCALATIONS,
  WEIGHT_SPECS,
} from './scoring.ts';

const VALID_FRONTMATTER = [
  '---',
  'initiative_id: INIT-2026-05-08-oauth',
  'project: simplarr',
  'project_repo_path: /home/parso/projects/simplarr',
  'created_at: \'2026-05-08T16:00:00.000Z\'',
  'iteration_budget: 50',
  'cost_budget_usd: 25',
  'phase: pending',
  'features:',
  '  - feature_id: FEAT-1',
  '    title: Stub OAuth provider config',
  '    depends_on: []',
  '  - feature_id: FEAT-2',
  '    title: Wire login button',
  '    depends_on: [FEAT-1]',
  '---',
  '',
].join('\n');

function manifestWith(body: string): string {
  return VALID_FRONTMATTER + body;
}

test('weights sum to 1', () => {
  const sum = WEIGHT_CONTEXT_LIFTED + WEIGHT_ESCALATIONS + WEIGHT_DOWNSTREAM_PM + WEIGHT_SPECS + WEIGHT_BRAIN;
  assert.ok(Math.abs(sum - 1) < 1e-9, `expected weights to sum to 1, got ${sum}`);
});

test('loadManifestForScoring: valid manifest parses with no errors', () => {
  const r = loadManifestForScoring(manifestWith('# Body\n'));
  assert.notEqual(r.manifest, null);
  assert.deepEqual(r.errors, []);
  assert.equal(r.parseError, undefined);
});

test('loadManifestForScoring: malformed input yields parseError, no errors thrown', () => {
  const r = loadManifestForScoring('not a real manifest, no frontmatter');
  assert.equal(r.manifest, null);
  assert.notEqual(r.parseError, undefined);
});

test('loadManifestForScoring: missing budgets surface as validation errors', () => {
  const text = [
    '---',
    'initiative_id: INIT-2026-05-08-x',
    'project: x',
    'created_at: \'2026-05-08T16:00:00.000Z\'',
    'iteration_budget: 0',
    'cost_budget_usd: 0',
    'phase: pending',
    '---',
    '',
    'body',
  ].join('\n');
  const r = loadManifestForScoring(text);
  assert.notEqual(r.manifest, null);
  assert.ok(r.errors.some((e) => e.includes('iteration_budget')));
  assert.ok(r.errors.some((e) => e.includes('cost_budget_usd')));
});

test('scopeRightSized: in range = 1, out of range = 0', () => {
  assert.equal(scopeRightSized(2, { min_features: 1, max_features: 5 }), 1);
  assert.equal(scopeRightSized(6, { min_features: 1, max_features: 5 }), 0);
});

test('countGivenWhenThen: counts triads', () => {
  const body = 'Given X\nWhen Y\nThen Z\n\nGiven A\nWhen B\nThen C';
  assert.equal(countGivenWhenThen(body), 2);
});

test('countAcceptanceHeadings: matches ## / ### / bold', () => {
  const body = ['## Acceptance', 'x', '### Acceptance criteria', 'y'].join('\n');
  assert.equal(countAcceptanceHeadings(body), 2);
});

test('specsConcrete: passes when triads ≥ feature count', () => {
  const body = ['Given X', 'When Y', 'Then Z', '', 'Given A', 'When B', 'Then C'].join('\n');
  assert.equal(specsConcrete(body, 2), 1);
});

test('specsConcrete: fails when both signals are short', () => {
  assert.equal(specsConcrete('Given X When Y Then Z', 3), 0);
});

// --------------------- project_context_lifted ---------------------

test('detectBoilerplateBlocks: identifies a near-identical block across 3+ manifests', () => {
  const block = [
    '## Council constraints (binding — LLM-Council 2026-05-18)',
    '',
    '- Gate: go test passes + go build exits 0.',
    '- Per resource: 5 mock unit tests.',
    '- Docs: comprehensive.',
  ].join('\n');
  const a = '## Why\nA reason.\n\n' + block + '\n\n## Scope\nSome scope.';
  const b = '## Why\nAnother reason.\n\n' + block + '\n\n## Scope\nDifferent scope.';
  const c = '## Why\nThird reason.\n\n' + block + '\n\n## Scope\nMore.';

  const dupes = detectBoilerplateBlocks([a, b, c]);
  assert.ok(dupes.length >= 1, 'should detect at least one duplicate block');
  assert.ok(dupes[0]!.occurrences >= 3, 'duplicate seen in 3 manifests');
});

test('detectBoilerplateBlocks: ignores short blocks (<3 lines / <80 chars)', () => {
  const tinyBlock = '## TL;DR\nSmall.';
  const a = tinyBlock + '\n\n## Scope\nA';
  const b = tinyBlock + '\n\n## Scope\nB';
  const c = tinyBlock + '\n\n## Scope\nC';
  const dupes = detectBoilerplateBlocks([a, b, c]);
  assert.equal(dupes.length, 0, 'short blocks are not boilerplate signal');
});

test('detectBoilerplateBlocks: tolerates whitespace + casing variation', () => {
  const block1 = '## Council Notes\n\nFirst, the gate must pass.\nSecond, the docs must update.\nThird, the tests must run.';
  const block2 = '## council notes\n\nFirst,   the gate must pass.\nsecond, THE DOCS must update.\nThird, the tests must run.';
  const dupes = detectBoilerplateBlocks([
    `# A\n\n${block1}\n\n## More`,
    `# B\n\n${block2}\n\n## More`,
    `# C\n\n${block1}\n\n## More`,
  ]);
  assert.ok(dupes.length >= 1, 'near-identical blocks should match after normalisation');
});

test('projectContextLifted: passes when fewer than 3 manifests in session (criterion not applicable → pass)', () => {
  const score = projectContextLifted([manifestWith('## Body\nshort')], '');
  assert.equal(score, 1);
});

test('projectContextLifted: fails when 3+ manifests share a council-block verbatim and PLAN.md never references the brain', () => {
  const block = [
    '## Council constraints (binding)',
    '',
    '- Gate: go test passes + go build exits 0.',
    '- Per resource: 5 mock unit tests.',
    '- Docs comprehensive; never edit website/.',
    '- Fixtures inline if small, else testdata.',
    '- Additive & atomic; blocked initiatives do not cascade.',
  ].join('\n');
  const m1 = manifestWith(`## Why\nA\n\n${block}\n`);
  const m2 = manifestWith(`## Why\nB\n\n${block}\n`);
  const m3 = manifestWith(`## Why\nC\n\n${block}\n`);
  const planDoc = '# PLAN.md\n\nNo brain reference here.';
  assert.equal(projectContextLifted([m1, m2, m3], planDoc), 0);
});

test('projectContextLifted: passes when boilerplate is referenced via a brain link in PLAN.md instead of copy-pasted', () => {
  const block = [
    '## Council constraints (binding)',
    '',
    '- Gate: go test passes + go build exits 0.',
    '- Per resource: 5 mock unit tests.',
    '- Docs comprehensive; never edit website/.',
    '- Fixtures inline if small, else testdata.',
    '- Additive & atomic; blocked initiatives do not cascade.',
  ].join('\n');
  const m1 = manifestWith(`## Why\nA\n\nSee brain/projects/terraform-provider-betterado/themes/council-constraints.md for the binding constraints.`);
  const m2 = manifestWith(`## Why\nB\n\nSee brain/projects/terraform-provider-betterado/themes/council-constraints.md.`);
  const m3 = manifestWith(`## Why\nC\n\nSee brain/projects/terraform-provider-betterado/themes/council-constraints.md.`);
  const planDoc = [
    '# PLAN.md',
    '',
    '## Project context',
    'See brain/projects/terraform-provider-betterado/themes/council-constraints.md for shared council constraints.',
  ].join('\n');
  // No copy-pasted blocks in the manifests → no duplicate → pass.
  void block;
  assert.equal(projectContextLifted([m1, m2, m3], planDoc), 1);
});

// --------------------- escalations_resolved ---------------------

test('escalationsResolved: passes when there is no PLAN.md (criterion not applicable → pass)', () => {
  assert.equal(escalationsResolved(undefined), 1);
});

test('escalationsResolved: passes when every escalation has a review-comment resolution', () => {
  const planDoc = [
    '# PLAN.md',
    '',
    '## Open escalations',
    '',
    '- [ESC-1] Disagreement on whether to ship docs in v1.',
    '  <!-- review: defer docs to v2 — ship gates only -->',
    '',
    '- [ESC-2] Council unsure whether to split into two initiatives.',
    '  <!-- review: keep as one initiative; revisit if iteration_budget exceeded -->',
  ].join('\n');
  assert.equal(escalationsResolved(planDoc), 1);
});

test('escalationsResolved: passes when every escalation is explicitly deferred', () => {
  const planDoc = [
    '# PLAN.md',
    '',
    '## Open escalations',
    '',
    '- [ESC-1] Should we add a feature flag?',
    '  Deferred to backlog phase 2.',
    '',
    '- [ESC-2] Whether to inline fixtures or use testdata?',
    '  Deferred — re-evaluate after first cycle.',
  ].join('\n');
  assert.equal(escalationsResolved(planDoc), 1);
});

test('escalationsResolved: fails when an escalation is silently dropped (no review-comment, no defer marker)', () => {
  const planDoc = [
    '# PLAN.md',
    '',
    '## Open escalations',
    '',
    '- [ESC-1] Unresolved disagreement.',
    '  (just a description, no resolution)',
    '',
    '- [ESC-2] Another open question.',
    '  <!-- review: keep as-is -->',
  ].join('\n');
  assert.equal(escalationsResolved(planDoc), 0);
});

test('escalationsResolved: zero-escalation PLAN.md passes (nothing to resolve)', () => {
  const planDoc = [
    '# PLAN.md',
    '',
    '## Open escalations',
    '',
    '_None — council auto-resolved all critiques._',
  ].join('\n');
  assert.equal(escalationsResolved(planDoc), 1);
});

// --------------------- brain_consulted_qualified ---------------------

test('brainConsultedQualified: passes when ≥1 cited brain path resolves on disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-bench-brain-'));
  try {
    mkdirSync(join(root, 'brain', 'forge', 'themes'), { recursive: true });
    writeFileSync(join(root, 'brain', 'forge', 'themes', 'real.md'), '# real');

    assert.equal(
      brainConsultedQualified('Cited: brain/forge/themes/real.md', root),
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('brainConsultedQualified: fails when path is name-checked but not on disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-bench-brain-'));
  try {
    mkdirSync(join(root, 'brain'), { recursive: true });
    assert.equal(
      brainConsultedQualified('Cited: brain/forge/themes/imaginary.md', root),
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('brainConsultedQualified: fails when no brain path appears at all', () => {
  assert.equal(brainConsultedQualified('No brain mention here.', '/tmp'), 0);
});

test('brainConsultedQualified: passes when at least one of multiple paths resolves', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-bench-brain-'));
  try {
    mkdirSync(join(root, 'brain', 'forge', 'themes'), { recursive: true });
    writeFileSync(join(root, 'brain', 'forge', 'themes', 'one.md'), '# one');
    const body = 'See brain/forge/themes/zzz.md and brain/forge/themes/one.md.';
    assert.equal(brainConsultedQualified(body, root), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --------------------- downstream_pm_score wiring ---------------------

test('downstream_pm_score calls the frozen rubric, not scoring.ts', async () => {
  // Sanity: the frozen module exports caseScore and is byte-equivalent to the
  // pinned commit. We test the import path through scoring.ts → frozen.
  const frozen = await import('../project-manager/scoring.frozen.ts');
  assert.equal(typeof frozen.caseScore, 'function');
  assert.equal(frozen.PASS_THRESHOLD, 0.7);
  // Also confirm the frozen module is a literal copy (not a re-export of the
  // live scoring.ts) — its caseScore must be a distinct function reference.
  const live = await import('../project-manager/scoring.ts');
  assert.notEqual(frozen.caseScore, live.caseScore);
});

// --------------------- caseScore (full integration) ---------------------

test('caseScore: invalid manifest gates score to 0', () => {
  const text = [
    '---',
    'initiative_id: INIT-2026-05-08-x',
    'project: x',
    'created_at: \'2026-05-08T16:00:00.000Z\'',
    'iteration_budget: 0',
    'cost_budget_usd: 25',
    'phase: pending',
    'features:',
    '  - feature_id: FEAT-1',
    '    title: t',
    '    depends_on: []',
    '---',
    '',
    'Given a user When they act Then result. See brain/x.md',
  ].join('\n');
  const r = caseScore({ manifestText: text, expected: {} });
  assert.equal(r.criteria.manifest_valid, 0);
  assert.equal(r.score, 0);
  assert.equal(r.passed, false);
});

test('caseScore: full pass — all criteria satisfied', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-bench-caseScore-'));
  try {
    mkdirSync(join(root, 'brain', 'forge', 'themes'), { recursive: true });
    writeFileSync(join(root, 'brain', 'forge', 'themes', 'x.md'), '# x');
    const body = [
      '## Why',
      'See brain/forge/themes/x.md',
      '',
      '## FEAT-1',
      'Given a user',
      'When they click',
      'Then it logs in',
      '',
      '## FEAT-2',
      'Given a user',
      'When they revisit',
      'Then session persists',
    ].join('\n');
    const r = caseScore({
      manifestText: manifestWith(body),
      expected: { min_features: 2, max_features: 4 },
      forgeRoot: root,
    });
    assert.equal(r.criteria.manifest_valid, 1);
    assert.equal(r.criteria.specs_concrete_per_feature, 1);
    assert.equal(r.criteria.brain_consulted_qualified, 1);
    assert.equal(r.criteria.project_context_lifted, 1, 'single-manifest sessions auto-pass');
    assert.equal(r.criteria.escalations_resolved, 1, 'no PLAN.md → criterion N/A → pass');
    assert.ok(r.passed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('caseScore: never emits aggregate_budget_declared (C19)', () => {
  const r = caseScore({
    manifestText: manifestWith('# Body\nGiven X\nWhen Y\nThen Z\n\nGiven A\nWhen B\nThen C\nSee brain/x.md'),
    expected: { min_features: 2, max_features: 4 },
  });
  assert.equal('aggregate_budget_declared' in r.criteria, false);
  // Serialise — must not contain the key anywhere
  const blob = JSON.stringify(r);
  assert.equal(blob.includes('aggregate_budget_declared'), false);
});

test('caseScore: manifest without aggregate-spend info still passes if other criteria meet threshold (C19)', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-bench-noaggr-'));
  try {
    mkdirSync(join(root, 'brain', 'forge', 'themes'), { recursive: true });
    writeFileSync(join(root, 'brain', 'forge', 'themes', 'x.md'), '# x');
    const body = [
      'See brain/forge/themes/x.md.',
      'Given X',
      'When Y',
      'Then Z',
      '',
      'Given A',
      'When B',
      'Then C',
    ].join('\n');
    const r = caseScore({
      manifestText: manifestWith(body),
      expected: { min_features: 2, max_features: 4 },
      forgeRoot: root,
      // Deliberately no aggregate budget passed in.
    });
    // 0.30 (context-lifted) + 0.25 (escalations-resolved) + 0.10 (specs) + 0.05 (brain) = 0.70 (no downstream PM run)
    assert.ok(r.score >= PASS_THRESHOLD - 1e-9, `score should still pass without aggregate spend; got ${r.score}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PASS_THRESHOLD matches plan (0.7)', () => {
  assert.equal(PASS_THRESHOLD, 0.7);
});

// --------------------- discrimination test (key acceptance) ---------------------

test('discrimination: pre-S2A architect output on B1/B2 scores below 0.7', () => {
  // The pre-S2A baseline is a checked-in golden representative of the legacy
  // architect: one manifest per initiative, no PLAN.md, copy-pasted council
  // blocks across all initiatives. We instantiate B2 (3+ inits, boilerplate
  // duplication) and confirm it fails the new criteria.
  const baselineDir = resolve(import.meta.dirname, 'fixtures', 'betterado', 'baseline-pre-s2a');
  const manifests = readdirSync(baselineDir).filter((f) => f.endsWith('.md')).sort();
  assert.ok(manifests.length >= 3, 'B2 baseline must have 3+ manifests to exercise lifting');
  const texts = manifests.map((f) => readFileSync(resolve(baselineDir, f), 'utf8'));

  // Score the FIRST manifest with the session-aware criteria. The other
  // manifests get passed in via `siblings` so context-lifting can detect
  // the boilerplate.
  const r = caseScore({
    manifestText: texts[0]!,
    siblingManifests: texts.slice(1),
    expected: { min_features: 2, max_features: 5 },
    forgeRoot: resolve(import.meta.dirname, '..', '..'),
    // NO planDoc → escalations N/A; but context-lifting will trigger on
    // the boilerplate across siblings.
  });
  assert.ok(
    !r.passed,
    `pre-S2A baseline must score below ${PASS_THRESHOLD} on B2; got ${r.score} (criteria: ${JSON.stringify(r.criteria)})`,
  );
});

test('discrimination: post-S2A architect output on B2 (with PLAN.md + brain reference) scores at or above 0.7', () => {
  const refinedDir = resolve(import.meta.dirname, 'fixtures', 'betterado', 'refined-post-s2a');
  const manifests = readdirSync(refinedDir).filter((f) => f.endsWith('.md') && f !== 'PLAN.md').sort();
  assert.ok(manifests.length >= 3, 'B2 refined fixture must have 3+ manifests');
  const texts = manifests.map((f) => readFileSync(resolve(refinedDir, f), 'utf8'));
  const planDoc = readFileSync(resolve(refinedDir, 'PLAN.md'), 'utf8');

  const r = caseScore({
    manifestText: texts[0]!,
    siblingManifests: texts.slice(1),
    planDoc,
    expected: { min_features: 2, max_features: 5 },
    forgeRoot: resolve(import.meta.dirname, '..', '..'),
  });
  assert.ok(
    r.passed,
    `post-S2A refined fixture must score ≥ ${PASS_THRESHOLD}; got ${r.score} (criteria: ${JSON.stringify(r.criteria)})`,
  );
});
