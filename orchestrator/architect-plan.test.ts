/**
 * Tests for orchestrator/architect-plan.ts — the PLAN.md operator artefact
 * renderer + feedback-comment parser. Stage S2A.
 *
 * Conventions:
 *  - Every test that touches disk uses a fresh `mkdtempSync` dir; nothing
 *    bleeds into the real `_queue/pending/` (per the destructive-instruction
 *    preserve-intent rule).
 *  - C19 (informational-only aggregate footprint) is pinned by an explicit
 *    no-language-from-this-set assertion.
 *  - C27 type discriminator: an exploration session round-trips through
 *    render → parse → render preserving the parameter_space / hypothesis /
 *    metric_command / locked_baselines fields.
 *  - C12 path layout: writePlanDoc emits exactly the path documented in
 *    contracts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  renderPlanDoc,
  renderPlanHtml,
  writePlanDoc,
  parseFeedbackComments,
  bundleFeedbackAsMarkdown,
  type ArchitectSession,
  type ProposedInitiative,
  type CouncilTranscript,
} from './architect-plan.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function fxTempdir(label: string): string {
  return mkdtempSync(join(tmpdir(), `forge-arch-plan-${label}-`));
}

function fxInitiative(overrides: Partial<ProposedInitiative> = {}): ProposedInitiative {
  return {
    initiative_id: 'INIT-2026-05-23-sample-init',
    project: 'sample',
    project_repo_path: '/tmp/projects/sample',
    title: 'Sample initiative',
    iteration_budget: 5,
    cost_budget_usd: 1.0,
    estimated_cost_usd: 0.25,
    features: [
      { feature_id: 'FEAT-1', title: 'Do the thing', depends_on: [] },
    ],
    body: '# Sample initiative\n\nThis is the manifest body.\n\n## Acceptance criteria\n\n- Given X, when Y, then Z.\n',
    ...overrides,
  };
}

function fxCouncilTranscript(overrides: Partial<CouncilTranscript> = {}): CouncilTranscript {
  return {
    flags: [],
    escalations: [],
    perCritic: [
      { critic: 'ceo', verdict: { flags: [], escalations: [] }, costUsd: 0.01 },
      { critic: 'eng', verdict: { flags: [], escalations: [] }, costUsd: 0.01 },
      { critic: 'design', verdict: { flags: [], escalations: [] }, costUsd: 0.01 },
      { critic: 'dx', verdict: { flags: [], escalations: [] }, costUsd: 0.01 },
    ],
    totalCostUsd: 0.04,
    ...overrides,
  };
}

function fxSession(overrides: Partial<ArchitectSession> = {}): ArchitectSession {
  return {
    session_id: '2026-05-23T10-15-00',
    project: 'sample',
    project_repo_path: '/tmp/projects/sample',
    vision: 'Add a sample feature for testing.',
    brain_context: [
      { path: 'brain/projects/sample/profile.md', summary: 'Project profile with taste signals.' },
    ],
    council: fxCouncilTranscript(),
    initiatives: [fxInitiative()],
    type: 'implementation',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. renderPlanDoc — basic shape
// ---------------------------------------------------------------------------

test('renderPlanDoc: produces a markdown document with all required sections', () => {
  const session = fxSession();
  const doc = renderPlanDoc(session);
  assert.match(doc, /^# Architect plan — 2026-05-23T10-15-00/m);
  // Cwc Amendment 1: brief + interview replaces the old "Vision recap" section
  assert.match(doc, /## Operator brief \+ interview/);
  assert.match(doc, /## Brain context/);
  assert.match(doc, /## Council transcript/);
  assert.match(doc, /## Proposed initiatives/);
  assert.match(doc, /## Aggregate footprint/);
  // Top-of-file verdict stub for the operator
  assert.match(doc, /<!-- verdict: approve \| revise \| reject -->/);
});

// ---------------------------------------------------------------------------
// 2. renderPlanDoc — embeds the manifest body verbatim
// ---------------------------------------------------------------------------

test('renderPlanDoc: embeds each proposed initiative manifest body verbatim', () => {
  const init = fxInitiative({
    initiative_id: 'INIT-2026-05-23-sample-x',
    body: '# Custom body marker\n\nSomething unique 9d7a-b3e2.\n',
  });
  const doc = renderPlanDoc(fxSession({ initiatives: [init] }));
  assert.match(doc, /Something unique 9d7a-b3e2/);
  assert.match(doc, /INIT-2026-05-23-sample-x/);
});

// ---------------------------------------------------------------------------
// 3. renderPlanDoc — C19 informational-only aggregate footprint
// ---------------------------------------------------------------------------

test('renderPlanDoc: aggregate footprint is informational only (C19 — no gate language)', () => {
  // Synthesise 20 initiatives to mimic the betterado drop.
  const initiatives: ProposedInitiative[] = [];
  for (let i = 1; i <= 20; i++) {
    initiatives.push(fxInitiative({
      initiative_id: `INIT-2026-05-23-bett-${String(i).padStart(2, '0')}`,
      title: `Initiative ${i}`,
      iteration_budget: 10,
      estimated_cost_usd: 26.7, // ≈$534 across 20
    }));
  }
  const doc = renderPlanDoc(fxSession({ project: 'betterado', initiatives }));
  // The footprint line must be present
  assert.match(doc, /## Aggregate footprint/);
  assert.match(doc, /informational/i, 'aggregate footprint frames itself as informational');
  // Total iteration budget surfaces
  assert.match(doc, /200/, 'rendered aggregate iteration budget (20 × 10)');
  // Total estimated cost surfaces (any of $534 / 534 / 533/534)
  assert.match(doc, /\$5\d\d/, 'rendered aggregate estimated cost (≈$534)');

  // The forbidden vocabulary (C19) must NOT appear in the footprint section.
  // Slice the doc to just the footprint section so we don't false-positive
  // on the proposed-initiatives table (which legitimately may use other terms).
  const footprintStart = doc.indexOf('## Aggregate footprint');
  const nextSection = doc.indexOf('\n## ', footprintStart + 1);
  const footprintBlock = doc.slice(footprintStart, nextSection >= 0 ? nextSection : undefined);
  assert.ok(!/\bgate\b/i.test(footprintBlock), `footprint block must not say "gate":\n${footprintBlock}`);
  assert.ok(!/\bthreshold\b/i.test(footprintBlock), `footprint block must not say "threshold":\n${footprintBlock}`);
  assert.ok(!/auto-?escalat/i.test(footprintBlock), `footprint block must not propose auto-escalation:\n${footprintBlock}`);
  assert.ok(!/aggregate_budget_declared/.test(footprintBlock), `footprint block must not reference the removed bench criterion:\n${footprintBlock}`);
});

// ---------------------------------------------------------------------------
// 4. renderPlanDoc — C27 exploration discriminator
// ---------------------------------------------------------------------------

test('renderPlanDoc: type: exploration surfaces parameter_space / hypothesis / metric_command / locked_baselines + iteration_budget marked as hint', () => {
  const session = fxSession({
    type: 'exploration',
    initiatives: [fxInitiative({
      initiative_id: 'INIT-2026-05-23-traf-sweep',
      exploration: {
        parameter_space: '- cp_spacing: [40, 50, 60, 70]\n- arrival_rate: [0.2, 0.4, 0.6]',
        hypothesis: 'CP spacing acts as a natural speed limit; mid-range maximises throughput.',
        metric_command: ['bash', '-lc', 'npm run grading'],
        locked_baselines: ['docs/baselines/frontier.md'],
      },
    })],
  });
  const doc = renderPlanDoc(session);
  assert.match(doc, /parameter_space/);
  assert.match(doc, /cp_spacing/);
  assert.match(doc, /hypothesis/i);
  assert.match(doc, /CP spacing acts as a natural speed limit/);
  assert.match(doc, /metric_command/);
  assert.match(doc, /npm run grading/);
  assert.match(doc, /locked_baselines/);
  assert.match(doc, /docs\/baselines\/frontier\.md/);
  // The hint-not-contract framing for exploration's iteration_budget
  assert.match(doc, /iteration budget:.*hint/i);
});

// ---------------------------------------------------------------------------
// 5. renderPlanDoc — C26 metrics block from .forge/project.json
// ---------------------------------------------------------------------------

test('renderPlanDoc: surfaces project metrics block (C26) when session provides it', () => {
  const session = fxSession({
    project_metrics: {
      command: ['bash', '-lc', 'npm run grading'],
      baselines_dir: 'docs/baselines/',
      tolerance_pct: 1.0,
    },
  });
  const doc = renderPlanDoc(session);
  assert.match(doc, /## Project metrics/);
  assert.match(doc, /npm run grading/);
  assert.match(doc, /docs\/baselines\//);
  assert.match(doc, /tolerance_pct.*1/);
});

// ---------------------------------------------------------------------------
// 6. parseFeedbackComments — top-of-file verdict
// ---------------------------------------------------------------------------

test('parseFeedbackComments: <!-- verdict: approve --> ⇒ verdict = "approve"', () => {
  const dir = fxTempdir('p1');
  const planPath = join(dir, 'PLAN.md');
  writeFileSync(planPath, '<!-- verdict: approve -->\n\n# Architect plan\n\nBody.\n');
  const { verdict, annotations } = parseFeedbackComments(planPath);
  assert.equal(verdict, 'approve');
  assert.deepEqual(annotations, []);
});

test('parseFeedbackComments: <!-- verdict: revise --> + 2 inline review comments', () => {
  const dir = fxTempdir('p2');
  const planPath = join(dir, 'PLAN.md');
  writeFileSync(
    planPath,
    [
      '<!-- verdict: revise -->',
      '',
      '# Architect plan',
      '',
      '## Proposed initiatives',
      '',
      '- INIT-A',
      '<!-- review: split this — too broad -->',
      '- INIT-B',
      '<!-- review: defer to phase 2 -->',
      '',
      'End.',
      '',
    ].join('\n'),
  );
  const { verdict, annotations } = parseFeedbackComments(planPath);
  assert.equal(verdict, 'revise');
  assert.equal(annotations.length, 2);
  assert.deepEqual(annotations.map((a) => a.text), [
    'split this — too broad',
    'defer to phase 2',
  ]);
  // Line numbers are 1-based
  assert.ok(annotations[0].line >= 1);
  assert.ok(annotations[1].line > annotations[0].line);
});

test('parseFeedbackComments: <!-- verdict: reject --> ⇒ verdict = "reject"', () => {
  const dir = fxTempdir('p3');
  const planPath = join(dir, 'PLAN.md');
  writeFileSync(planPath, '<!-- verdict: reject -->\n\n# Plan\n\n(operator changed their mind)\n');
  const { verdict } = parseFeedbackComments(planPath);
  assert.equal(verdict, 'reject');
});

test('parseFeedbackComments: missing verdict ⇒ verdict = null', () => {
  const dir = fxTempdir('p4');
  const planPath = join(dir, 'PLAN.md');
  writeFileSync(planPath, '# Plan\n\nNo verdict here yet.\n');
  const { verdict, annotations } = parseFeedbackComments(planPath);
  assert.equal(verdict, null);
  assert.deepEqual(annotations, []);
});

test('parseFeedbackComments: empty annotations are an empty array (not null)', () => {
  const dir = fxTempdir('p5');
  const planPath = join(dir, 'PLAN.md');
  writeFileSync(planPath, '<!-- verdict: approve -->\n# Plan\n\nLooks good.\n');
  const { annotations } = parseFeedbackComments(planPath);
  assert.ok(Array.isArray(annotations));
  assert.equal(annotations.length, 0);
});

// ---------------------------------------------------------------------------
// 7. writePlanDoc — C12 location
// ---------------------------------------------------------------------------

test('writePlanDoc: writes to <projectRoot>/_architect/<session-id>/PLAN.md per C12', () => {
  const dir = fxTempdir('w1');
  const projectRoot = join(dir, 'project-x');
  mkdirSync(projectRoot, { recursive: true });
  const session = fxSession({ session_id: '2026-05-23T11-22-33', project: 'project-x' });
  const path = writePlanDoc(session, projectRoot);
  assert.equal(path, resolve(projectRoot, '_architect', '2026-05-23T11-22-33', 'PLAN.md'));
  assert.ok(existsSync(path), 'PLAN.md was written');
  const body = readFileSync(path, 'utf8');
  assert.match(body, /# Architect plan — 2026-05-23T11-22-33/);
});

// ---------------------------------------------------------------------------
// 8. Round-trip: render → annotate → parse → re-render preserves manifest body
// ---------------------------------------------------------------------------

test('renderPlanDoc round-trip: rendered → annotated → parsed → re-rendered preserves manifest body', () => {
  const session = fxSession();
  const initial = renderPlanDoc(session);

  // Simulate the operator annotating + setting a revise verdict.
  const annotated = initial.replace(
    '<!-- verdict: approve | revise | reject -->',
    '<!-- verdict: revise -->',
  ).replace(
    '## Proposed initiatives',
    '## Proposed initiatives\n<!-- review: rename Sample initiative to Foo -->',
  );

  // Write to disk and parse.
  const dir = fxTempdir('rt');
  const planPath = join(dir, 'PLAN.md');
  writeFileSync(planPath, annotated);
  const { verdict, annotations } = parseFeedbackComments(planPath);

  assert.equal(verdict, 'revise');
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].text, 'rename Sample initiative to Foo');

  // Re-render the same session (parity: the manifest body is byte-stable).
  const reRendered = renderPlanDoc(session);
  // The manifest body marker should appear identically in both renders.
  const bodyMarker = 'This is the manifest body.';
  assert.ok(initial.includes(bodyMarker), 'initial render contains manifest body');
  assert.ok(reRendered.includes(bodyMarker), 're-render preserves manifest body');
});

// ---------------------------------------------------------------------------
// 9. bundleFeedbackAsMarkdown — produces a readable feedback.md body
// ---------------------------------------------------------------------------

test('bundleFeedbackAsMarkdown: produces a markdown list the council can read', () => {
  const md = bundleFeedbackAsMarkdown([
    { line: 12, text: 'split this — only queue INIT-01 + INIT-03 today' },
    { line: 27, text: 'defer the rest to phase 2' },
  ]);
  assert.match(md, /^# Operator feedback/m);
  assert.match(md, /line 12/);
  assert.match(md, /split this — only queue INIT-01 \+ INIT-03 today/);
  assert.match(md, /line 27/);
  assert.match(md, /defer the rest to phase 2/);
});

test('bundleFeedbackAsMarkdown: empty annotations ⇒ short notice', () => {
  const md = bundleFeedbackAsMarkdown([]);
  assert.match(md, /^# Operator feedback/m);
  assert.match(md, /no inline annotations/i);
});

// ---------------------------------------------------------------------------
// 10. renderPlanDoc — council transcript is faithfully embedded
// ---------------------------------------------------------------------------

test('renderPlanDoc: council escalations + flags surface in transcript section verbatim', () => {
  const session = fxSession({
    council: fxCouncilTranscript({
      flags: [{ id: 'missing-rollback', description: 'No rollback section', appliedFix: 'Added rollback note.' }],
      escalations: [{
        critic: 'ceo',
        question: 'One initiative or two?',
        options: [
          { label: 'one', rationale: 'easier review' },
          { label: 'two', rationale: 'parallel work' },
        ],
      }],
    }),
  });
  const doc = renderPlanDoc(session);
  // Per-critic blocks
  assert.match(doc, /### CEO critic/i);
  assert.match(doc, /### Eng critic/i);
  assert.match(doc, /### Design critic/i);
  assert.match(doc, /### DX critic/i);
  // Flag content
  assert.match(doc, /missing-rollback/);
  assert.match(doc, /No rollback section/);
  assert.match(doc, /Added rollback note/);
  // Escalation content
  assert.match(doc, /One initiative or two\?/);
  assert.match(doc, /easier review/);
  assert.match(doc, /parallel work/);
});

// ---------------------------------------------------------------------------
// 11. renderPlanDoc — brain context appears with greppable paths
// ---------------------------------------------------------------------------

test('renderPlanDoc: brain-context section lists every brain path + summary', () => {
  const session = fxSession({
    brain_context: [
      { path: 'brain/projects/sample/profile.md', summary: 'Project profile.' },
      { path: 'brain/forge/themes/pr-as-sole-review-window.md', summary: 'PR is the review window.' },
    ],
  });
  const doc = renderPlanDoc(session);
  assert.match(doc, /brain\/projects\/sample\/profile\.md/);
  assert.match(doc, /Project profile/);
  assert.match(doc, /brain\/forge\/themes\/pr-as-sole-review-window\.md/);
  assert.match(doc, /PR is the review window/);
});

// ---------------------------------------------------------------------------
// 12. Synthetic round-trip fixture — write a PLAN.md, parse it, confirm
//     manifest content is preserved across the pipe (AC5)
// ---------------------------------------------------------------------------

test('synthetic round-trip: writePlanDoc → parseFeedbackComments preserves manifest body', () => {
  const dir = fxTempdir('rt2');
  const projectRoot = join(dir, 'proj');
  mkdirSync(projectRoot, { recursive: true });
  const session = fxSession({ session_id: '2026-05-23T20-00-00' });
  const planPath = writePlanDoc(session, projectRoot);

  // Read the file back, set verdict + an annotation, write it back.
  const original = readFileSync(planPath, 'utf8');
  const annotated = original
    .replace('<!-- verdict: approve | revise | reject -->', '<!-- verdict: approve -->')
    .replace(
      'This is the manifest body.',
      'This is the manifest body.\n<!-- review: looks great -->',
    );
  writeFileSync(planPath, annotated);

  const { verdict, annotations } = parseFeedbackComments(planPath);
  assert.equal(verdict, 'approve');
  assert.equal(annotations.length, 1);
  assert.match(annotations[0].text, /looks great/);
  // Manifest body still present
  const after = readFileSync(planPath, 'utf8');
  assert.match(after, /This is the manifest body\./);
});

// ---------------------------------------------------------------------------
// 13. renderPlanDoc — multi-initiative table with depends-on edges
// ---------------------------------------------------------------------------

test('renderPlanDoc: proposed-initiatives table lists each initiative and dependency edges', () => {
  const session = fxSession({
    initiatives: [
      fxInitiative({ initiative_id: 'INIT-2026-05-23-a-foo', title: 'Foo' }),
      fxInitiative({
        initiative_id: 'INIT-2026-05-23-a-bar',
        title: 'Bar',
        depends_on_initiatives: ['INIT-2026-05-23-a-foo'],
      }),
    ],
  });
  const doc = renderPlanDoc(session);
  assert.match(doc, /INIT-2026-05-23-a-foo/);
  assert.match(doc, /INIT-2026-05-23-a-bar/);
  // Dependency edge surfaces in the table
  assert.match(doc, /INIT-2026-05-23-a-bar.*INIT-2026-05-23-a-foo/);
});

// ---------------------------------------------------------------------------
// 14. Cwc Amendment 1 — Operator brief + interview section
// ---------------------------------------------------------------------------

test('renderPlanDoc: empty interview rounds renders an "operator drafted directly" notice', () => {
  const doc = renderPlanDoc(fxSession({ interview: [] }));
  assert.match(doc, /## Operator brief \+ interview/);
  assert.match(doc, /### Interview/);
  assert.match(doc, /No interview rounds — operator drafted directly/);
});

test('renderPlanDoc: omitted interview field renders the same notice (defaults to no rounds)', () => {
  // Fixture has no `interview` field by default
  const doc = renderPlanDoc(fxSession());
  assert.match(doc, /No interview rounds — operator drafted directly/);
});

test('renderPlanDoc: interview rounds render as a Q&A table with operator answers', () => {
  const session = fxSession({
    interview: [
      { question: 'What is the scope edge?', answer: 'INIT-01 only; defer the rest.' },
      { question: 'What signals success?', answer: 'release_definition tests pass on first cycle.' },
      { question: 'Any prior attempts?', answer: '[operator skipped]' },
    ],
  });
  const doc = renderPlanDoc(session);
  // Table header present
  assert.match(doc, /\| # \| Question \| Operator answer \|/);
  // Each round surfaces both Q and A
  assert.match(doc, /What is the scope edge\?/);
  assert.match(doc, /INIT-01 only; defer the rest\./);
  assert.match(doc, /What signals success\?/);
  assert.match(doc, /release_definition tests pass on first cycle\./);
  assert.match(doc, /Any prior attempts\?/);
  assert.match(doc, /\[operator skipped\]/);
});

test('renderPlanDoc: interview answers containing | are escaped so the markdown table stays valid', () => {
  const session = fxSession({
    interview: [
      { question: 'Pick one: A | B | C?', answer: 'option | B' },
    ],
  });
  const doc = renderPlanDoc(session);
  // Pipes inside cells are escaped with backslash so the table parses
  assert.match(doc, /Pick one: A \\\| B \\\| C\?/);
  assert.match(doc, /option \\\| B/);
});

// ---------------------------------------------------------------------------
// 15. Cwc Amendment 2 — renderPlanHtml smoke + structural
// ---------------------------------------------------------------------------

test('renderPlanHtml: produces a self-contained HTML document with no external links', () => {
  const html = renderPlanHtml(fxSession());
  // Well-formed doctype + html
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<\/html>\s*$/);
  // Inline styles present, no external stylesheet
  assert.match(html, /<style>/);
  assert.ok(!/rel="stylesheet"/.test(html), 'no external stylesheet link');
  assert.ok(!/<script[^>]+src=/.test(html), 'no external script src');
  // Title carries session id + project
  assert.match(html, /<title>PLAN — 2026-05-23T10-15-00 — sample<\/title>/);
});

test('renderPlanHtml: includes the forge cycle diagram with brain band + user nodes', () => {
  const html = renderPlanHtml(fxSession());
  assert.match(html, /class="cycle"/);
  assert.match(html, /graphify brain/);
  assert.match(html, /class="node user this">architect/);
  assert.match(html, /class="node user">before\/after/);
  assert.match(html, /class="node user">reflect/);
  // The HTML page node mentioned in the diagram
  assert.match(html, /\+ html page/);
});

test('renderPlanHtml: surfaces vision + interview rounds as a table', () => {
  const html = renderPlanHtml(fxSession({
    vision: 'A bill-splitting app for friends.',
    interview: [
      { question: 'Login required?', answer: 'No — link-based only.' },
      { question: 'Settle up flow?', answer: 'Single tap, no currencies.' },
    ],
  }));
  assert.match(html, /A bill-splitting app for friends\./);
  assert.match(html, /<th>Question<\/th>/);
  assert.match(html, /Login required\?/);
  assert.match(html, /link-based only/);
  assert.match(html, /Settle up flow\?/);
  assert.match(html, /Single tap, no currencies\./);
});

test('renderPlanHtml: empty interview renders the "operator drafted directly" notice', () => {
  const html = renderPlanHtml(fxSession({ interview: [] }));
  assert.match(html, /No interview rounds — operator drafted directly\./);
  // The Q&A table should NOT be present in the interview section
  // (the council escalations section may still have <tr> elements, so we
  // can't assert globally — but the interview heading + empty-class notice is enough)
  assert.match(html, /<p class="empty">No interview rounds/);
});

test('renderPlanHtml: aggregate footprint renders a stacked bar with one segment per initiative', () => {
  const initiatives: ProposedInitiative[] = [];
  for (let i = 1; i <= 4; i++) {
    initiatives.push(fxInitiative({
      initiative_id: `INIT-2026-05-23-aggr-${i}`,
      iteration_budget: i,
    }));
  }
  const html = renderPlanHtml(fxSession({ initiatives }));
  // Section header carries the informational badge per C19
  assert.match(html, /Aggregate footprint <span class="badge">informational<\/span>/);
  // One <div class="seg"> per initiative (4 initiatives → 4 segments)
  const segs = html.match(/<div class="seg"/g) ?? [];
  assert.equal(segs.length, 4, `expected 4 stacked-bar segments, got ${segs.length}`);
  // Informational framing visible in the body (uses C19-safe vocabulary per
  // S2A-DECISIONS §11: avoids the words "gate", "threshold",
  // "auto-escalate/auto-escalation", and "aggregate_budget_declared" — even
  // in plain prose).
  assert.match(html, /Informational only\./);
  assert.match(html, /Forge does not enforce a budget or block at any number/);
  assert.match(html, /the operator decides/);
});

test('renderPlanHtml: C19 — aggregate footprint section uses none of the forbidden vocabulary', () => {
  const html = renderPlanHtml(fxSession({
    initiatives: [
      fxInitiative({ initiative_id: 'INIT-X-1', estimated_cost_usd: 100 }),
      fxInitiative({ initiative_id: 'INIT-X-2', estimated_cost_usd: 200 }),
    ],
  }));
  // Slice the footprint block from <h2>Aggregate footprint to the next <h2>
  const footprintStart = html.indexOf('Aggregate footprint');
  const nextH2 = html.indexOf('<h2', footprintStart + 1);
  const block = html.slice(footprintStart, nextH2 >= 0 ? nextH2 : html.length);
  assert.ok(!/\bthreshold\b/i.test(block), `footprint block must not say "threshold":\n${block}`);
  assert.ok(!/auto-?escalat/i.test(block), `footprint block must not propose auto-escalation:\n${block}`);
  assert.ok(!/aggregate_budget_declared/.test(block), `footprint block must not reference removed bench criterion:\n${block}`);
});

test('renderPlanHtml: exploration session surfaces parameter_space + hint badges (C27)', () => {
  const html = renderPlanHtml(fxSession({
    type: 'exploration',
    initiatives: [fxInitiative({
      initiative_id: 'INIT-2026-05-23-sweep',
      iteration_budget: 8,
      exploration: {
        parameter_space: '- cp_spacing: [40, 50, 60]\n- rate: [0.2, 0.4]',
        hypothesis: 'CP spacing acts as a natural speed limit.',
        metric_command: ['npm', 'run', 'grading'],
        locked_baselines: ['docs/baselines/frontier.md'],
      },
    })],
  }));
  assert.match(html, /class="badge warn">hint/i);
  assert.match(html, /cp_spacing/);
  assert.match(html, /CP spacing acts as a natural speed limit\./);
  assert.match(html, /npm run grading/);
  assert.match(html, /docs\/baselines\/frontier\.md/);
});

test('renderPlanHtml: escalation options render as cards (no naked bullet lists)', () => {
  const html = renderPlanHtml(fxSession({
    open_escalations: [{
      critic: 'ceo',
      question: 'One initiative or two?',
      options: [
        { label: 'one', rationale: 'easier review' },
        { label: 'two', rationale: 'parallel work' },
      ],
    }],
  }));
  // Critic chip + question + options block surface
  assert.match(html, /class="critic-chip">ceo</);
  assert.match(html, /One initiative or two\?/);
  assert.match(html, /class="option"/);
  assert.match(html, /<span class="label">one<\/span>/);
  assert.match(html, /<span class="rationale">easier review<\/span>/);
  assert.match(html, /<span class="label">two<\/span>/);
});

test('renderPlanHtml: HTML-escapes operator content so manifest body cannot break the page', () => {
  const html = renderPlanHtml(fxSession({
    vision: 'Build <thing> with "quotes" & ampersands.',
    initiatives: [fxInitiative({
      body: '# Title <h1> attack\n\n<script>alert("xss")</script>\nNormal content.\n',
    })],
  }));
  // Vision is escaped
  assert.match(html, /Build &lt;thing&gt; with &quot;quotes&quot; &amp; ampersands\./);
  // Manifest body is escaped — the literal "<script>" must NOT appear as raw HTML
  assert.ok(!/<script>alert\("xss"\)<\/script>/.test(html), 'XSS-style content must be escaped');
  assert.match(html, /&lt;script&gt;alert\(&quot;xss&quot;\)&lt;\/script&gt;/);
});

// ---------------------------------------------------------------------------
// 16. writePlanDoc — emits PLAN.html sibling next to PLAN.md (Amendment 2)
// ---------------------------------------------------------------------------

test('writePlanDoc: writes PLAN.html sibling alongside PLAN.md and council-transcript.md', () => {
  const dir = fxTempdir('w2');
  const projectRoot = join(dir, 'project-y');
  mkdirSync(projectRoot, { recursive: true });
  const session = fxSession({ session_id: '2026-05-24T00-00-00', project: 'project-y' });
  const planPath = writePlanDoc(session, projectRoot);

  const sessionDir = resolve(projectRoot, '_architect', '2026-05-24T00-00-00');
  assert.ok(existsSync(planPath), 'PLAN.md exists');
  assert.ok(existsSync(join(sessionDir, 'PLAN.html')), 'PLAN.html sibling exists');
  assert.ok(existsSync(join(sessionDir, 'council-transcript.md')), 'council-transcript.md sibling exists');

  const html = readFileSync(join(sessionDir, 'PLAN.html'), 'utf8');
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<title>PLAN — 2026-05-24T00-00-00 — project-y<\/title>/);
});
