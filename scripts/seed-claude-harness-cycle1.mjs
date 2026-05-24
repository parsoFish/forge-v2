#!/usr/bin/env node
/**
 * One-off bootstrap script: assembles the architect session for
 * claude-harness cycle 1 and writes PLAN.md + a draft manifest under
 * projects/claude-harness/_architect/<session>/.
 *
 * This deliberately SKIPS runCouncil() for cycle 1 — the project is
 * trivial, the operator IS the architect (per the claude-harness
 * autonomous arrangement), and the council's value-add (catching
 * cross-cutting ambiguity) doesn't apply here. The skip is documented
 * inline in the council transcript so future-me can revisit if
 * cycle 2 reveals it was the wrong call.
 *
 * Run from /home/parso/forge.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  writePlanDoc,
  sessionPaths,
} from '../cli/architect-plan.ts';

const FORGE_ROOT = resolve(import.meta.dirname, '..');
const PROJECT = 'claude-harness';
const PROJECT_ROOT = resolve(FORGE_ROOT, 'projects', PROJECT);

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SESSION_ID = stamp;                          // e.g. 2026-05-24T16-30-00
const today = stamp.slice(0, 10);                  // 2026-05-24
const INITIATIVE_ID = `INIT-${today}-claude-trail-scaffold`;

// ----------------------------------------------------------------------
// Session content
// ----------------------------------------------------------------------

const session = {
  session_id: SESSION_ID,
  project: PROJECT,
  project_repo_path: PROJECT_ROOT,

  vision: `claude-trail — a TypeScript CLI that consolidates everything
forge knows about a single initiative into one markdown trail doc.
Reads on-disk state only (the cycle's events.jsonl, the brain themes,
the worktree's git history). The CLI runs from inside the
claude-harness project directory and outputs markdown to stdout.
Cycle 1 lands the single-cycle happy-path shape; failed cycles,
send-back rounds, and multi-cycle aggregation are explicitly deferred
to cycles 2 + 3.`,

  // Per cwc Amendment 1, the architect interview is mandatory (≥1
  // AskUserQuestion round). For the claude-harness autonomous
  // arrangement the operator IS the architect (per the project
  // profile), so the interview is conducted inline by claude in the
  // same session — questions asked, answers chosen as the operator,
  // recorded here for the auditor.
  interview: [
    {
      question:
        'Forge already has cli/cycle-recap.ts (writes _logs/<id>/recap.md ' +
        'with Outcome / Stats / Themes / Brain gaps / Lint / Links per cycle) ' +
        'and cli/metrics.ts (cost rollups). Should claude-trail (a) duplicate / ' +
        'replace recap, (b) extend recap, or (c) be orthogonal (per-INITIATIVE ' +
        'across multiple cycles, debug-oriented audience)?',
      answer:
        '(c) orthogonal. recap is per-CYCLE, deterministic, fixed sections, ' +
        'operator-facing. claude-trail is per-INITIATIVE, debug-oriented, ' +
        'audience is claude debugging cycles. Cycle 1 ships single-cycle ' +
        '(matches recap surface) but is structured so cycle 3 can naturally ' +
        'extend to multi-cycle without redesign.',
    },
    {
      question:
        'What makes cycle 1 "done"? Just "outputs markdown", or a specific ' +
        'set of sections checked against a frozen golden file?',
      answer:
        'Frozen golden file. The reviewer should be able to diff the CLI ' +
        'output against tests/fixtures/golden/INIT-FIXTURE-1.trail.md and see ' +
        'zero diff. Acceptance is binary, no taste judgement.',
    },
    {
      question:
        'What does "everything forge knows" mean at the edges in cycle 1 — ' +
        'failed cycles, send-back rounds, reflection-only re-runs?',
      answer:
        'Cycle 1 scope: ONE cycle, ONE initiative, happy-path verdict=approve. ' +
        'Failed cycles + send-back rounds + cross-cycle aggregation defer to ' +
        'cycle 2 + 3. cycle 1 just needs to read a single cycle\'s _logs/<id>/ ' +
        'tree + brain themes mentioning the initiative + git log of the cycle\'s ' +
        'commits.',
    },
    {
      question:
        'Output shape — section order + flags?',
      answer:
        'Fixed sections in order: # Trail / ## Summary (one paragraph: outcome ' +
        '+ verdict + total cost) / ## Phases (chronological event list grouped ' +
        'by phase) / ## Themes consulted (file paths + one-line summary) / ' +
        '## Files touched (git diff --name-only). Markdown only, stdout only, ' +
        'no flags for cycle 1 (positional initiative-id arg).',
    },
    {
      question:
        'Dependencies — std-lib only, or are gray-matter / globby OK?',
      answer:
        'std-lib only for cycle 1. If gray-matter is unavoidable for brain ' +
        'frontmatter, declare it in the manifest body as an escalation. ' +
        'Default: no runtime deps.',
    },
  ],

  brain_context: [
    {
      path: 'brain/projects/claude-harness/profile.md',
      summary:
        'Project profile — operator is claude, language TS, no network, ' +
        'std-lib preferred, node:test for tests.',
    },
    {
      path: 'cli/cycle-recap.ts',
      summary:
        'Prior art — forge already writes _logs/<id>/recap.md per cycle. ' +
        'Sections: Outcome, Stats, Themes, Brain gaps, Lint, Links. ' +
        'claude-trail is orthogonal (per-INITIATIVE, debug-oriented).',
    },
    {
      path: 'cli/metrics.ts',
      summary:
        'Prior art — summariseCycle(cycleId) rolls up total cost + per-phase ' +
        '+ per-skill from events.jsonl. claude-trail can import this instead ' +
        'of re-deriving.',
    },
    {
      path: 'docs/planning/2026-05-24-claude-harness/CYCLE-1-SEED.md',
      summary: 'The operator-authored seed for this cycle.',
    },
  ],

  // Deliberate scope cut for cycle 1 — see file header. The shape
  // matches what the CLI ingester expects; an empty critic chain is a
  // valid "council didn't surface anything to escalate" result.
  council: {
    flags: [],
    escalations: [],
    perCritic: [],
    totalCostUsd: 0,
  },

  initiatives: [
    {
      initiative_id: INITIATIVE_ID,
      project: PROJECT,
      project_repo_path: PROJECT_ROOT,
      title: 'claude-trail scaffold + single-cycle trail',
      iteration_budget: 5,
      cost_budget_usd: 5.0,
      estimated_cost_usd: 4.0,
      features: [
        {
          feature_id: 'FEAT-1',
          title: 'CLI scaffold + events.jsonl phase rollup',
          depends_on: [],
        },
        {
          feature_id: 'FEAT-2',
          title: 'Brain themes section (filter by initiative_id mention)',
          depends_on: ['FEAT-1'],
        },
        {
          feature_id: 'FEAT-3',
          title: 'Files touched section (git log + diff --name-only)',
          depends_on: ['FEAT-1'],
        },
      ],
      body: INITIATIVE_BODY(),
    },
  ],

  type: 'implementation',
};

function INITIATIVE_BODY() {
  return `# ${INITIATIVE_ID} — claude-trail scaffold + single-cycle trail

> First cycle of the claude-harness project. See
> [\`docs/planning/2026-05-24-claude-harness/PROPOSAL.md\`](../../../docs/planning/2026-05-24-claude-harness/PROPOSAL.md)
> and the [seed](../../../docs/planning/2026-05-24-claude-harness/CYCLE-1-SEED.md).

## What this initiative ships

\`claude-trail <initiative-id>\` — a TypeScript CLI that reads a single
forge cycle's on-disk state (events.jsonl, brain themes, git log) and
emits a markdown trail doc to stdout. Sections in fixed order:

1. \`# Trail — <initiative-id>\` (title)
2. \`## Summary\` — one paragraph: outcome + verdict + total cost
3. \`## Phases\` — chronological per-phase event lists
4. \`## Themes consulted\` — brain theme paths + one-line summaries
5. \`## Files touched\` — git diff --name-only across the cycle's commits

## Features

### FEAT-1 — CLI scaffold + events.jsonl phase rollup

Build \`src/cli.ts\` (entry point), \`src/trail.ts\` (composes the
markdown), \`src/events.ts\` (events.jsonl reader + per-phase rollup).
The CLI parses \`process.argv\` for the positional \`<initiative-id>\`,
resolves it to a cycle dir under \`_logs/<...>\`, and emits sections 1+2+3.

**WI-level acceptance** (per WI):
- \`npm test\` passes for the WI's added tests.
- The WI's created files appear under \`src/\` or \`tests/\`.

### FEAT-2 — Brain themes section

Add \`src/brain.ts\` that walks \`brain/\` (read by relative path from
the CLI's invocation cwd), finds themes whose body text mentions the
target initiative_id, and emits section 4.

### FEAT-3 — Files touched section

Add \`src/git.ts\` that runs \`git log\` + \`git diff --name-only\`
against the cycle's worktree path (recorded in the cycle's events as
\`worktree_path\` on the cycle.start event) and emits section 5.

## Acceptance — cycle 1 binary criteria

A single test, one fixture, one golden:

- GIVEN \`tests/fixtures/cycle-INIT-FIXTURE-1/\` exists with a frozen
  events.jsonl, brain themes slice, and git log JSON dump
- WHEN \`node --experimental-strip-types src/cli.ts INIT-FIXTURE-1\`
  runs from inside the fixture's enclosing tempdir
- THEN stdout matches \`tests/fixtures/INIT-FIXTURE-1.trail.golden.md\`
  byte-for-byte

This is the WHOLE bar for cycle 1. Failed cycles, send-back rounds,
multi-cycle aggregation are out of scope.

## Out of scope (deferred to cycle 2/3)

- \`--since <cycle-id>\` flag (cross-cycle).
- Failure-mode summary across retries.
- PR metadata section.
- Cost-per-skill breakdown.
- Any flags whatsoever — positional only for cycle 1.

## Constraints from the project profile

- TypeScript, \`--experimental-strip-types\`. No build step.
- \`node:test\` for tests; no jest / vitest / mocha.
- No runtime dependencies. \`devDependencies\` for \`@types/node\` is fine.
- No network calls at runtime.
- One npm package; source under \`src/\`, tests under \`tests/\`.
`;
}

// ----------------------------------------------------------------------
// Write
// ----------------------------------------------------------------------

const paths = sessionPaths(PROJECT_ROOT, SESSION_ID);
mkdirSync(paths.sessionDir, { recursive: true });
mkdirSync(paths.manifestsDir, { recursive: true });

// Write PLAN.md + sibling council-transcript.md + (cwc) PLAN.html.
const planPath = writePlanDoc(session, PROJECT_ROOT);
console.log(`PLAN.md  → ${planPath}`);

// Write the draft manifest (architect commit --approve promotes this).
const manifestBody = buildManifestFile(session.initiatives[0]);
const manifestPath = join(paths.manifestsDir, `${INITIATIVE_ID}.md`);
writeFileSync(manifestPath, manifestBody);
console.log(`manifest → ${manifestPath}`);
console.log(`\nSession id: ${SESSION_ID}`);
console.log(`Next:  cd /home/parso/forge && forge architect commit ${SESSION_ID} --project ${PROJECT}`);

function buildManifestFile(init) {
  // Hand-render the YAML frontmatter to avoid an extra dep. Matches
  // orchestrator/manifest.ts:parseManifest expectations.
  const lines = [
    '---',
    'type: implementation',
    `initiative_id: ${init.initiative_id}`,
    `project: ${init.project}`,
    `project_repo_path: ${init.project_repo_path}`,
    `created_at: '${new Date().toISOString()}'`,
    `iteration_budget: ${init.iteration_budget}`,
    `cost_budget_usd: ${init.cost_budget_usd}`,
    'phase: pending',
    'origin: architect',
    'features:',
  ];
  for (const f of init.features) {
    lines.push(`  - feature_id: ${f.feature_id}`);
    lines.push(`    title: ${JSON.stringify(f.title)}`);
    lines.push(`    depends_on: [${f.depends_on.map((d) => JSON.stringify(d)).join(', ')}]`);
  }
  lines.push('---', '', init.body);
  return lines.join('\n');
}
