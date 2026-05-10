/**
 * Cycle report builder — produces a human-facing markdown narrative of one
 * cycle's run, written to `_logs/<cycleId>/report.md`.
 *
 * Generated automatically as the last step of every cycle (from cycle.ts),
 * and re-generatable on demand via `forge report <cycle-id>`. Reads only
 * durable artefacts (events.jsonl + queue manifests + brain themes + git
 * refs + the work-items / demo snapshots), so it works after the worktree
 * has been cleaned up.
 *
 * Sections:
 *   1. Header — initiative, status, duration, cost, key links
 *   2. What was asked — manifest body, features
 *   3. How the system decomposed it — work-item list + Mermaid graph
 *   4. Baseline state — git rev, project profile, files-in-scope baseline
 *   5. What landed — git diff, file-by-file change summary
 *   6. Trajectory — phase-by-phase events with cost annotation
 *   7. Verification — quality gate, tests, PR url
 *   8. Brain learning — themes captured + gaps logged
 *   9. Appendix — links to all evidence
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type { EventLogEntry } from './logging.ts';
import { summariseCycle, type CycleMetrics } from './metrics.ts';
import { parseManifest, type InitiativeManifest } from './manifest.ts';
import { parseWorkItem, type WorkItem } from './work-item.ts';

export type CycleReportInput = {
  cycleId: string;
  /** Forge root, defaults to cwd. */
  forgeRoot?: string;
};

/**
 * Render the cycle report markdown. Pure-ish — reads from disk but does no
 * mutation. Returns the markdown body. `writeCycleReport()` wraps this and
 * persists to `_logs/<cycleId>/report.md`.
 */
export function buildCycleReport(input: CycleReportInput): string {
  const forgeRoot = resolve(input.forgeRoot ?? process.cwd());
  const cycleId = input.cycleId;
  const cycleLogDir = resolve(forgeRoot, '_logs', cycleId);

  const events = loadEvents(cycleLogDir);
  if (events.length === 0) {
    return [
      `# Cycle Report — \`${cycleId}\``,
      '',
      `_(no events found at \`_logs/${cycleId}/events.jsonl\`)_`,
      '',
    ].join('\n');
  }

  const initiativeId = events[0].initiative_id;
  const manifest = loadManifest(forgeRoot, initiativeId);
  const metrics = summariseCycle(cycleId, resolve(forgeRoot, '_logs'));
  const wis = loadWorkItemsSnapshot(cycleLogDir);
  const cycleEnd = events.find((e) => e.phase === 'orchestrator' && e.event_type === 'end' && e.message === 'cycle.end');
  const cycleErr = events.find((e) => e.phase === 'orchestrator' && e.event_type === 'error');
  const status = (cycleEnd?.metadata?.status as string) ?? (cycleErr ? 'failed' : 'unknown');
  const reflectionStatus = (cycleEnd?.metadata?.reflection_status as string) ?? 'skipped';
  const cycleStartedAt = events[0].started_at;
  const cycleEndedAt = (cycleEnd ?? cycleErr)?.started_at ?? events[events.length - 1].started_at;
  const cycleDurationMs = cycleEnd?.duration_ms ?? new Date(cycleEndedAt).getTime() - new Date(cycleStartedAt).getTime();

  const mergedEvent = events.find((e) => e.message === 'reviewer.merged');
  const prUrl = mergedEvent?.output_refs?.[0] ?? null;

  const sections = [
    renderHeader({
      cycleId,
      initiativeId,
      manifest,
      status,
      reflectionStatus,
      cycleStartedAt,
      cycleEndedAt,
      cycleDurationMs,
      metrics,
      prUrl,
    }),
    renderInitiative(manifest),
    renderDecomposition(wis),
    renderDecompositionGraph(cycleLogDir),
    renderBaseline(forgeRoot, manifest, events),
    renderChanges(forgeRoot, manifest, cycleId, events),
    renderTrajectory(events, metrics),
    renderVerification(events, manifest, prUrl, cycleLogDir),
    renderBrainLearning(forgeRoot, manifest, cycleStartedAt, cycleEndedAt, cycleLogDir),
    renderAppendix(cycleLogDir, forgeRoot, manifest, prUrl, cycleId),
  ];
  return sections.filter(Boolean).join('\n\n') + '\n';
}

/** Build the report and write it to `_logs/<cycleId>/report.md`. */
export function writeCycleReport(input: CycleReportInput): string {
  const forgeRoot = resolve(input.forgeRoot ?? process.cwd());
  const cycleLogDir = resolve(forgeRoot, '_logs', input.cycleId);
  const md = buildCycleReport(input);
  const outPath = resolve(cycleLogDir, 'report.md');
  writeFileSync(outPath, md);
  return outPath;
}

// ---------- data loaders ----------

function loadEvents(cycleLogDir: string): EventLogEntry[] {
  const path = join(cycleLogDir, 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as EventLogEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is EventLogEntry => e !== null);
}

function loadManifest(forgeRoot: string, initiativeId: string): InitiativeManifest | null {
  const filename = `${initiativeId}.md`;
  const candidates = [
    resolve(forgeRoot, '_queue', 'done', filename),
    resolve(forgeRoot, '_queue', 'ready-for-review', filename),
    resolve(forgeRoot, '_queue', 'failed', filename),
    resolve(forgeRoot, '_queue', 'in-flight', filename),
    resolve(forgeRoot, '_queue', 'pending', filename),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return parseManifest(readFileSync(p, 'utf8'));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function loadWorkItemsSnapshot(cycleLogDir: string): WorkItem[] {
  const dir = join(cycleLogDir, 'work-items-snapshot');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== '_graph.md')
    .sort()
    .map((f) => {
      try {
        return parseWorkItem(readFileSync(join(dir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter((w): w is WorkItem => w !== null);
}

function loadGraphMermaid(cycleLogDir: string): string | null {
  const p = join(cycleLogDir, 'work-items-snapshot', '_graph.md');
  if (!existsSync(p)) return null;
  const content = readFileSync(p, 'utf8');
  // Extract the first ```mermaid ... ``` block; if absent, return whole file.
  const match = content.match(/```mermaid\n([\s\S]*?)\n```/);
  return match ? match[1] : content;
}

// ---------- section renderers ----------

function renderHeader(args: {
  cycleId: string;
  initiativeId: string;
  manifest: InitiativeManifest | null;
  status: string;
  reflectionStatus: string;
  cycleStartedAt: string;
  cycleEndedAt: string;
  cycleDurationMs: number;
  metrics: CycleMetrics;
  prUrl: string | null;
}): string {
  const project = args.manifest?.project ?? '?';
  const titleLine =
    args.manifest && args.manifest.body
      ? extractFirstHeading(args.manifest.body) ?? args.initiativeId
      : args.initiativeId;
  const statusEmoji =
    args.status === 'merged'
      ? '🟢'
      : args.status === 'ready-for-review'
        ? '🟡'
        : args.status === 'send-back-cap-exhausted'
          ? '🟠'
          : '🔴';
  const lines: string[] = [
    `# Cycle Report — ${titleLine}`,
    '',
    `${statusEmoji} **Status:** \`${args.status}\` · Reflection: \`${args.reflectionStatus}\``,
    '',
    '| | |',
    '|---|---|',
    `| **Initiative** | \`${args.initiativeId}\` |`,
    `| **Project** | \`${project}\` |`,
    `| **Cycle ID** | \`${args.cycleId}\` |`,
    `| **Started** | ${args.cycleStartedAt} |`,
    `| **Ended** | ${args.cycleEndedAt} |`,
    `| **Duration** | ${formatDuration(args.cycleDurationMs)} |`,
    `| **Total cost** | $${args.metrics.total_cost_usd.toFixed(2)} |`,
    `| **Errors recorded** | ${args.metrics.errors} |`,
    args.prUrl ? `| **Pull request** | ${args.prUrl} |` : '',
  ].filter((l) => l !== '');
  return lines.join('\n');
}

function renderInitiative(manifest: InitiativeManifest | null): string {
  if (!manifest) return '## What was asked\n\n_(manifest unavailable)_';
  const featureRows = manifest.features
    .map((f) => `| \`${f.feature_id}\` | ${f.title} | ${f.depends_on.length === 0 ? '_(none)_' : f.depends_on.map((d) => `\`${d}\``).join(', ')} |`)
    .join('\n');
  return [
    '## What was asked',
    '',
    `**Iteration budget:** ${manifest.iteration_budget} · **Cost budget:** $${manifest.cost_budget_usd.toFixed(2)} · **Quality gate:** \`${manifest.quality_gate_cmd?.join(' ') ?? '(default — npm test)'}\``,
    '',
    '### Initiative spec',
    '',
    manifest.body.trim(),
    '',
    '### Features (architect output)',
    '',
    featureRows.length > 0
      ? ['| Feature | Title | Depends on |', '|---|---|---|', featureRows].join('\n')
      : '_(no features in manifest)_',
  ].join('\n');
}

function renderDecomposition(wis: WorkItem[]): string {
  if (wis.length === 0) {
    return '## How the system decomposed it (PM phase)\n\n_(no work-item snapshot — PM may not have run, or the cycle pre-dates the snapshotter)_';
  }
  const lines: string[] = ['## How the system decomposed it (PM phase)', ''];
  lines.push(`The PM agent produced **${wis.length} work item(s)**:`);
  lines.push('');
  for (const wi of wis) {
    const deps = wi.depends_on.length === 0 ? '_(parallel — no dependencies)_' : wi.depends_on.map((d) => `\`${d}\``).join(', ');
    const acLines = wi.acceptance_criteria
      .map((ac, i) => `${i + 1}. **GIVEN** ${ac.given.trim()} · **WHEN** ${ac.when.trim()} · **THEN** ${ac.then.trim()}`)
      .join('\n');
    const filesInScope = wi.files_in_scope.length === 0
      ? '_(none listed)_'
      : wi.files_in_scope.map((f) => `\`${f}\``).join(', ');
    lines.push(`### \`${wi.work_item_id}\` — ${extractFirstHeading(wi.body) ?? '(untitled)'}`);
    lines.push('');
    lines.push(`**Status:** \`${wi.status}\` · **Depends on:** ${deps} · **Estimated iterations:** ${wi.estimated_iterations} · **Files in scope:** ${filesInScope}`);
    lines.push('');
    lines.push('**Acceptance criteria:**');
    lines.push('');
    lines.push(acLines || '_(none)_');
    lines.push('');
  }
  return lines.join('\n');
}

function renderDecompositionGraph(cycleLogDir: string): string {
  const mermaid = loadGraphMermaid(cycleLogDir);
  if (!mermaid) return '';
  return ['### Dependency graph', '', '```mermaid', mermaid.trim(), '```'].join('\n');
}

function renderBaseline(forgeRoot: string, manifest: InitiativeManifest | null, events: EventLogEntry[]): string {
  const lines: string[] = ['## Baseline (project state at cycle start)', ''];
  if (!manifest) {
    lines.push('_(manifest unavailable; baseline cannot be inferred)_');
    return lines.join('\n');
  }
  const repo = manifest.project_repo_path;
  // Find baseline = "main as of cycle.start". For a successful merge, this
  // is the first parent of the merge commit (the pre-merge tip of main).
  // For non-merged cycles, "main" today is the same as cycle-start main.
  const baseline = computeBaselineRev(repo, manifest.initiative_id);
  const profile = loadProjectProfile(forgeRoot, manifest.project);
  const fileCount = countFiles(repo, manifest.project);

  lines.push(`**Repository:** \`${repo}\``);
  if (baseline) lines.push(`**Baseline commit:** \`${baseline}\``);
  if (fileCount !== null) lines.push(`**Tracked files at baseline:** ${fileCount}`);
  if (profile) {
    lines.push('');
    lines.push('**Project profile (excerpt from `brain/projects/<name>/profile.md`):**');
    lines.push('');
    lines.push('> ' + profile.split('\n').slice(0, 3).join('\n> '));
  }
  // Note unused param (rendered earlier but reserved if we want timeline data).
  void events;
  return lines.join('\n');
}

function renderChanges(
  forgeRoot: string,
  manifest: InitiativeManifest | null,
  cycleId: string,
  events: EventLogEntry[],
): string {
  const lines: string[] = ['## What landed (effective changes)', ''];
  if (!manifest) {
    lines.push('_(manifest unavailable)_');
    return lines.join('\n');
  }
  const repo = manifest.project_repo_path;
  const branch = `forge/${manifest.initiative_id}`;

  // For a merged initiative, diff is "main^..main" (assuming the merge
  // commit is at HEAD). For a ready-for-review or failed state, the branch
  // may still exist locally; we try `branch ... main` first.
  const diff = computeDeliveredDiff(repo, branch);
  if (diff === null) {
    lines.push('_(unable to compute diff — repository or branch unavailable)_');
    return lines.join('\n');
  }
  if (diff.statLines.length === 0) {
    lines.push('_(no committed file changes detected)_');
    return lines.join('\n');
  }

  lines.push('### File-by-file summary');
  lines.push('');
  lines.push('```');
  lines.push(diff.statLines.join('\n'));
  lines.push('```');
  lines.push('');
  lines.push(`**Total**: ${diff.filesChanged} file(s), +${diff.insertions} −${diff.deletions} lines.`);
  lines.push('');

  // Render the unified diff (truncated to keep the report scannable).
  if (diff.unified) {
    const truncated = diff.unified.length > 4000;
    lines.push('### Unified diff (first 4 KB)');
    lines.push('');
    lines.push('```diff');
    lines.push(truncated ? diff.unified.slice(0, 4000) + '\n... (truncated)' : diff.unified);
    lines.push('```');
  }

  // Note unused params (reserved for richer renderings later).
  void cycleId;
  void events;
  void forgeRoot;
  return lines.join('\n');
}

function renderTrajectory(events: EventLogEntry[], metrics: CycleMetrics): string {
  const lines: string[] = ['## Trajectory (per-phase timeline)', ''];

  // Per-phase summary table.
  const phaseRows: string[] = [];
  for (const phase of ['project-manager', 'developer-loop', 'review-loop', 'reflection'] as const) {
    const m = metrics.per_phase[phase];
    if (!m) continue;
    phaseRows.push(`| \`${phase}\` | $${m.cost_usd.toFixed(2)} | ${m.iterations} | ${formatDuration(m.duration_ms)} |`);
  }
  if (phaseRows.length > 0) {
    lines.push('| Phase | Cost | Iterations | Duration |');
    lines.push('|---|---|---|---|');
    lines.push(...phaseRows);
    lines.push('');
  }

  // Brain reads per phase (extracted from end-event metadata).
  const brainReadsRow: string[] = [];
  for (const e of events) {
    if (e.event_type !== 'end' && e.event_type !== 'error') continue;
    const tu = (e.metadata?.tool_use ?? null) as { brainReads?: number } | null;
    if (tu && typeof tu.brainReads === 'number') {
      const subj = (e.metadata?.work_item_id as string) ?? '';
      brainReadsRow.push(`- \`${e.skill}\`${subj ? ` (${subj})` : ''}: ${tu.brainReads} brain read(s)`);
    }
  }
  if (brainReadsRow.length > 0) {
    lines.push('### Brain consultation per phase');
    lines.push('');
    lines.push(...brainReadsRow);
    lines.push('');
  }

  // Key event timeline (start/end/error/notable logs).
  const keyEvents = events.filter(
    (e) =>
      e.event_type === 'start' ||
      e.event_type === 'end' ||
      e.event_type === 'error' ||
      (e.event_type === 'log' && /verdict|merged|skipped/.test(e.message ?? '')),
  );
  if (keyEvents.length > 0) {
    lines.push('### Key events');
    lines.push('');
    lines.push('| Time | Phase | Skill | Type | Message |');
    lines.push('|---|---|---|---|---|');
    for (const e of keyEvents.slice(0, 50)) {
      const t = (e.started_at ?? '').slice(11, 19); // HH:MM:SS
      lines.push(
        `| ${t} | ${e.phase} | ${e.skill}${e.iteration ? ` (iter ${e.iteration})` : ''} | \`${e.event_type}\` | ${e.message ?? '—'} |`,
      );
    }
    if (keyEvents.length > 50) lines.push(`| ... | ... | ... | ... | _(+${keyEvents.length - 50} more)_ |`);
  }
  return lines.join('\n');
}

function renderVerification(
  events: EventLogEntry[],
  manifest: InitiativeManifest | null,
  prUrl: string | null,
  cycleLogDir: string,
): string {
  const lines: string[] = ['## Verification', ''];
  if (manifest) {
    const qg = manifest.quality_gate_cmd?.join(' ') ?? '(default: npm test if package.json exists)';
    lines.push(`**Quality gate command:** \`${qg}\``);
  }

  // Look for the gate's summary on the merged event metadata.
  const merged = events.find((e) => e.message === 'reviewer.merged');
  if (merged) {
    lines.push('');
    lines.push('**PR merged.** Quality gate passed before merge (orchestrator-verified between reviewer iterations).');
    if (prUrl) lines.push(`**PR:** ${prUrl}`);
  } else {
    const sendBackCap = events.find((e) => e.message === 'reviewer.send-back-cap-exhausted');
    if (sendBackCap) {
      lines.push('');
      lines.push('⚠️ Send-back cap exhausted. PR draft exists; manifest is in `_queue/ready-for-review/` for manual operator pickup via `forge review <id>`.');
    } else {
      lines.push('');
      lines.push('_(no merge event recorded for this cycle)_');
    }
  }

  // Demo bundle from snapshot.
  const demoDir = join(cycleLogDir, 'demo');
  if (existsSync(demoDir)) {
    lines.push('');
    lines.push('### Demo bundle');
    lines.push('');
    const files = readdirSync(demoDir).map((f) => `- [\`${f}\`](demo/${f})`);
    lines.push(...files);
  }

  // PR description draft from snapshot.
  const prDescPath = join(cycleLogDir, 'pr-description.md');
  if (existsSync(prDescPath)) {
    lines.push('');
    lines.push('### PR description draft');
    lines.push('');
    lines.push(readFileSync(prDescPath, 'utf8').trim());
  }

  return lines.join('\n');
}

function renderBrainLearning(
  forgeRoot: string,
  manifest: InitiativeManifest | null,
  cycleStartedAt: string,
  cycleEndedAt: string,
  cycleLogDir: string,
): string {
  const lines: string[] = ['## Brain learning (cycle-over-cycle improvement signal)', ''];
  if (!manifest) {
    lines.push('_(project unknown; cannot locate themes)_');
    return lines.join('\n');
  }

  const startMs = new Date(cycleStartedAt).getTime();
  const endMs = new Date(cycleEndedAt).getTime() + 5 * 60_000; // +5min slack for reflector to write
  const themesDir = resolve(forgeRoot, 'brain', 'projects', manifest.project, 'themes');
  const newThemes: Array<{ path: string; title: string; description: string; category: string }> = [];

  if (existsSync(themesDir)) {
    for (const f of readdirSync(themesDir).filter((f) => f.endsWith('.md'))) {
      const path = join(themesDir, f);
      const stat = statSync(path);
      if (stat.mtimeMs >= startMs && stat.mtimeMs <= endMs) {
        const content = readFileSync(path, 'utf8');
        const fm = extractFrontmatter(content);
        newThemes.push({
          path,
          title: fm.title ?? f,
          description: fm.description ?? '',
          category: fm.category ?? '?',
        });
      }
    }
  }

  if (newThemes.length === 0) {
    lines.push('_(no new themes captured this cycle)_');
  } else {
    lines.push(`**${newThemes.length} new theme(s) captured:**`);
    lines.push('');
    for (const t of newThemes) {
      const rel = `brain/projects/${manifest.project}/themes/${basename(t.path)}`;
      lines.push(`- **[${t.title}](${rel})** _(${t.category})_ — ${t.description}`);
    }
  }

  // Brain gaps.
  const gapsPath = join(cycleLogDir, 'brain-gaps.jsonl');
  if (existsSync(gapsPath)) {
    const gapLines = readFileSync(gapsPath, 'utf8').split('\n').filter(Boolean);
    if (gapLines.length > 0) {
      lines.push('');
      lines.push(`**Brain gaps logged this cycle:** ${gapLines.length}`);
    }
  }
  return lines.join('\n');
}

function renderAppendix(
  cycleLogDir: string,
  forgeRoot: string,
  manifest: InitiativeManifest | null,
  prUrl: string | null,
  cycleId: string,
): string {
  const lines: string[] = ['## Appendix — evidence files', ''];
  const candidates = [
    { label: 'Event log', path: join(cycleLogDir, 'events.jsonl') },
    { label: 'Retro', path: join(cycleLogDir, 'retro.md') },
    { label: 'User questions (reflector stage 2)', path: join(cycleLogDir, 'user-questions.md') },
    { label: 'User feedback (reflector stage 3)', path: join(cycleLogDir, 'user-feedback.md') },
    { label: 'Brain gaps', path: join(cycleLogDir, 'brain-gaps.jsonl') },
    { label: 'Work-items snapshot', path: join(cycleLogDir, 'work-items-snapshot') },
    { label: 'Demo bundle', path: join(cycleLogDir, 'demo') },
    { label: 'PR description draft', path: join(cycleLogDir, 'pr-description.md') },
  ];
  for (const c of candidates) {
    if (existsSync(c.path)) {
      const rel = c.path.replace(forgeRoot + '/', '');
      lines.push(`- **${c.label}** — \`${rel}\``);
    }
  }
  if (manifest) {
    const cycleArchive = resolve(forgeRoot, 'brain', '_raw', 'cycles', `${cycleId}.md`);
    if (existsSync(cycleArchive)) {
      lines.push(`- **Cycle archive** — \`brain/_raw/cycles/${cycleId}.md\``);
    }
  }
  if (prUrl) lines.push(`- **Pull request** — ${prUrl}`);
  return lines.join('\n');
}

// ---------- helpers ----------

function extractFirstHeading(markdown: string): string | null {
  const match = markdown.match(/^#+\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function extractFrontmatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function formatDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function computeBaselineRev(repo: string, initiativeId: string): string | null {
  if (!existsSync(resolve(repo, '.git'))) return null;
  // Strategy:
  //   1. `git merge-base main forge/<initiativeId>` — the actual point
  //      main was at when the worktree was created. Works for merged,
  //      unmerged, and partially-merged cycles, and is robust to
  //      concurrent commits on main during the cycle.
  //   2. `main^1` — first parent of main's HEAD. Correct only for
  //      successfully-merged cycles where the merge commit is at HEAD.
  //   3. `main` — last resort; reports the current tip (less informative).
  const branch = `forge/${initiativeId}`;
  const candidates: Array<[string, string[]]> = [
    ['merge-base', ['merge-base', 'main', branch]],
    ['pre-merge-parent', ['rev-parse', 'main^1']],
    ['main-tip', ['rev-parse', 'main']],
  ];
  for (const [, args] of candidates) {
    try {
      const out = execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' });
      const sha = out.trim();
      if (sha) return sha.slice(0, 12);
    } catch {
      /* try next */
    }
  }
  return null;
}

function computeDeliveredDiff(
  repo: string,
  branch: string,
): { statLines: string[]; filesChanged: number; insertions: number; deletions: number; unified: string | null } | null {
  if (!existsSync(resolve(repo, '.git'))) return null;
  // Try the merged-into-main case first: HEAD of main vs main^.
  const ranges = [
    `${branch}..main`,
    `main^..main`,
    `main..${branch}`,
  ];
  for (const range of ranges) {
    try {
      const stat = execFileSync('git', ['diff', '--stat', range], {
        cwd: repo,
        stdio: 'pipe',
        encoding: 'utf8',
      }).trim();
      if (!stat) continue;

      const numstat = execFileSync('git', ['diff', '--numstat', range], {
        cwd: repo,
        stdio: 'pipe',
        encoding: 'utf8',
      }).trim();
      const numLines = numstat.split('\n').filter(Boolean);
      const insertions = numLines.reduce((acc, l) => acc + parsePositiveInt(l.split('\t')[0]), 0);
      const deletions = numLines.reduce((acc, l) => acc + parsePositiveInt(l.split('\t')[1]), 0);

      const unified = (() => {
        try {
          return execFileSync('git', ['diff', range], {
            cwd: repo,
            stdio: 'pipe',
            encoding: 'utf8',
          });
        } catch {
          return null;
        }
      })();

      return {
        statLines: stat.split('\n'),
        filesChanged: numLines.length,
        insertions,
        deletions,
        unified,
      };
    } catch {
      /* try next range */
    }
  }
  return null;
}

function parsePositiveInt(s: string | undefined): number {
  if (!s) return 0;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function loadProjectProfile(forgeRoot: string, project: string): string | null {
  const path = resolve(forgeRoot, 'brain', 'projects', project, 'profile.md');
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf8');
  // Strip frontmatter, return first non-blank prose paragraph.
  const stripped = content.replace(/^---\n[\s\S]*?\n---\n*/, '');
  const paragraphs = stripped.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  // Prefer the first paragraph after the title heading.
  const skip = paragraphs[0]?.startsWith('#') ? 1 : 0;
  return paragraphs[skip]?.trim() ?? null;
}

function countFiles(repo: string, project: string): number | null {
  if (!existsSync(resolve(repo, '.git'))) return null;
  try {
    const out = execFileSync('git', ['ls-files'], { cwd: repo, stdio: 'pipe', encoding: 'utf8' });
    return out.split('\n').filter(Boolean).length;
  } catch {
    void project;
    return null;
  }
}

