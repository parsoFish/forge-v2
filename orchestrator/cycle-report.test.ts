/**
 * Tests for orchestrator/cycle-report.ts. The report builder consumes a
 * variety of inputs (event log, manifest, work-item snapshots, brain themes,
 * git refs); these tests build synthetic fixtures and verify the markdown
 * output contains the load-bearing sections.
 *
 * Real-cycle output is also exercised end-to-end via the W4 trial run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCycleReport, writeCycleReport } from './cycle-report.ts';

function setupFixture(): { forgeRoot: string; cycleId: string; cleanup: () => void } {
  const forgeRoot = mkdtempSync(join(tmpdir(), 'forge-report-'));
  const cycleId = '2026-05-10T12-00-00_INIT-2026-05-10-fixture';
  const initiativeId = 'INIT-2026-05-10-fixture';
  const cycleLogDir = join(forgeRoot, '_logs', cycleId);
  mkdirSync(cycleLogDir, { recursive: true });
  mkdirSync(join(forgeRoot, '_queue', 'done'), { recursive: true });
  mkdirSync(join(forgeRoot, 'brain', 'projects', 'demo', 'themes'), { recursive: true });
  mkdirSync(join(forgeRoot, 'brain', '_raw', 'cycles'), { recursive: true });

  // Manifest in done/.
  writeFileSync(
    join(forgeRoot, '_queue', 'done', `${initiativeId}.md`),
    `---
initiative_id: ${initiativeId}
project: demo
project_repo_path: /tmp/demo-fixture
created_at: 2026-05-10T12:00:00Z
iteration_budget: 5
cost_budget_usd: 1.5
phase: done
quality_gate_cmd:
  - npm
  - test
features:
  - feature_id: FEAT-1
    title: Add helper utility
    depends_on: []
---

# Add helper utility

## Why

We need a helper to support feature X.

## Acceptance

- Function works as documented.
`,
  );

  // Event log.
  const events = [
    {
      event_id: 'EV_1', cycle_id: cycleId, started_at: '2026-05-10T12:00:00Z',
      initiative_id: initiativeId, phase: 'orchestrator', skill: 'cycle',
      event_type: 'start', input_refs: [], output_refs: [], message: 'cycle.start',
    },
    {
      event_id: 'EV_2', cycle_id: cycleId, started_at: '2026-05-10T12:01:00Z',
      initiative_id: initiativeId, phase: 'project-manager', skill: 'project-manager',
      event_type: 'start', input_refs: [], output_refs: [],
    },
    {
      event_id: 'EV_3', cycle_id: cycleId, started_at: '2026-05-10T12:02:00Z',
      initiative_id: initiativeId, phase: 'project-manager', skill: 'project-manager',
      event_type: 'end', input_refs: [], output_refs: [],
      cost_usd: 0.45, duration_ms: 60000,
      metadata: { tool_use: { brainReads: 3 } },
    },
    {
      event_id: 'EV_4', cycle_id: cycleId, started_at: '2026-05-10T12:03:00Z',
      initiative_id: initiativeId, phase: 'review-loop', skill: 'reviewer',
      event_type: 'log', input_refs: [], output_refs: [], message: 'reviewer.verdict.approve',
    },
    {
      event_id: 'EV_5', cycle_id: cycleId, started_at: '2026-05-10T12:04:00Z',
      initiative_id: initiativeId, phase: 'review-loop', skill: 'reviewer',
      event_type: 'log', input_refs: [], output_refs: ['https://github.com/x/y/pull/1'],
      message: 'reviewer.merged',
    },
    {
      event_id: 'EV_6', cycle_id: cycleId, started_at: '2026-05-10T12:05:00Z',
      initiative_id: initiativeId, phase: 'orchestrator', skill: 'cycle',
      event_type: 'end', input_refs: [], output_refs: [], message: 'cycle.end',
      duration_ms: 300000, metadata: { status: 'merged', reflection_status: 'closed' },
    },
  ];
  writeFileSync(
    join(cycleLogDir, 'events.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );

  // Work-items snapshot.
  const wiDir = join(cycleLogDir, 'work-items-snapshot');
  mkdirSync(wiDir, { recursive: true });
  writeFileSync(
    join(wiDir, 'WI-1.md'),
    `---
work_item_id: WI-1
feature_id: FEAT-1
initiative_id: ${initiativeId}
status: complete
depends_on: []
acceptance_criteria:
  - given: "an input X"
    when: "the helper is called"
    then: "the output is Y"
files_in_scope:
  - src/helper.ts
estimated_iterations: 1
---

# WI-1: Add the helper

Implement the helper as specified.
`,
  );
  writeFileSync(
    join(wiDir, '_graph.md'),
    '```mermaid\ngraph TD\n  WI-1["Add helper"]\n```\n',
  );

  // A brain theme written within the cycle window. Set the file's mtime to
  // a timestamp inside the synthetic cycle's [start, end+5min] window so the
  // builder picks it up (mtime comparison, not frontmatter-date comparison).
  const themePath = join(forgeRoot, 'brain', 'projects', 'demo', 'themes', '2026-05-10-test-theme.md');
  writeFileSync(
    themePath,
    `---
title: Test theme
description: A theme captured during the test cycle
category: pattern
created_at: 2026-05-10T12:04:30Z
updated_at: 2026-05-10T12:04:30Z
---

# Test theme

Body text.
`,
  );
  const themeMtime = new Date('2026-05-10T12:04:30Z');
  utimesSync(themePath, themeMtime, themeMtime);

  // Retro.
  writeFileSync(
    join(cycleLogDir, 'retro.md'),
    '# Retro\n\n## Self-reflection\n\nIt went well.\n',
  );

  // Profile.
  writeFileSync(
    join(forgeRoot, 'brain', 'projects', 'demo', 'profile.md'),
    `---
project: demo
---

# Demo project

Demo project for the report fixture. Used in tests.
`,
  );

  return {
    forgeRoot,
    cycleId,
    cleanup: () => rmSync(forgeRoot, { recursive: true, force: true }),
  };
}

test('buildCycleReport: emits all load-bearing sections for a successful cycle', () => {
  const { forgeRoot, cycleId, cleanup } = setupFixture();
  try {
    const md = buildCycleReport({ cycleId, forgeRoot });

    // Header
    assert.match(md, /Cycle Report/);
    assert.match(md, /Status:.*merged/);
    assert.match(md, /Reflection:.*closed/);
    assert.match(md, /github\.com\/x\/y\/pull\/1/);
    assert.match(md, /Total cost.*\$0\.45/);

    // What was asked
    assert.match(md, /What was asked/);
    assert.match(md, /Add helper utility/);
    assert.match(md, /\| `FEAT-1` \| Add helper utility/);

    // Decomposition
    assert.match(md, /How the system decomposed it/);
    assert.match(md, /WI-1.*Add the helper/);
    assert.match(md, /GIVEN.*WHEN.*THEN/);
    assert.match(md, /```mermaid/);

    // Trajectory
    assert.match(md, /Trajectory/);
    assert.match(md, /\| `project-manager` \| \$0\.45 \|/);
    assert.match(md, /3 brain read/);
    assert.match(md, /reviewer\.merged/);

    // Verification
    assert.match(md, /PR merged/);
    assert.match(md, /github\.com/);

    // Brain learning
    assert.match(md, /Brain learning/);
    assert.match(md, /Test theme/);

    // Appendix
    assert.match(md, /Appendix/);
    assert.match(md, /events\.jsonl/);
    assert.match(md, /retro\.md/);
  } finally {
    cleanup();
  }
});

test('buildCycleReport: handles missing event log gracefully', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-report-empty-'));
  try {
    const md = buildCycleReport({ cycleId: 'nonexistent', forgeRoot: dir });
    assert.match(md, /no events found/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildCycleReport: handles missing manifest gracefully', () => {
  const forgeRoot = mkdtempSync(join(tmpdir(), 'forge-report-noman-'));
  try {
    const cycleId = '2026-05-10T00-00-00_INIT-orphan';
    const cycleLogDir = join(forgeRoot, '_logs', cycleId);
    mkdirSync(cycleLogDir, { recursive: true });
    const events = [
      {
        event_id: 'EV_1', cycle_id: cycleId, started_at: '2026-05-10T00:00:00Z',
        initiative_id: 'INIT-orphan', phase: 'orchestrator', skill: 'cycle',
        event_type: 'start', input_refs: [], output_refs: [], message: 'cycle.start',
      },
      {
        event_id: 'EV_2', cycle_id: cycleId, started_at: '2026-05-10T00:01:00Z',
        initiative_id: 'INIT-orphan', phase: 'orchestrator', skill: 'cycle',
        event_type: 'error', input_refs: [], output_refs: [], message: 'cycle.error',
      },
    ];
    writeFileSync(
      join(cycleLogDir, 'events.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
    const md = buildCycleReport({ cycleId, forgeRoot });
    assert.match(md, /Status:.*failed/);
    assert.match(md, /manifest unavailable/i);
  } finally {
    rmSync(forgeRoot, { recursive: true, force: true });
  }
});

test('writeCycleReport: writes the markdown to _logs/<cycleId>/report.md', () => {
  const { forgeRoot, cycleId, cleanup } = setupFixture();
  try {
    const path = writeCycleReport({ cycleId, forgeRoot });
    assert.match(path, /report\.md$/);
    assert.ok(existsSync(path));
    const content = readFileSync(path, 'utf8');
    assert.match(content, /Cycle Report/);
  } finally {
    cleanup();
  }
});
