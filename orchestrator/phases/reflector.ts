/**
 * Reflection phase runner. Extracted from cycle.ts (Phase 3.4c step 2).
 *
 * Runs after a successful merge to extract patterns from the cycle's event
 * log + merged tree into brain themes. Behaviour is identical to the prior
 * in-cycle implementation — this module only relocates the code so the
 * orchestration spine stays thin.
 *
 * S6A — after the agent exits successfully, this module additionally:
 *   1. runs `brain-lint --scope cycle-touched-themes --cycle <id>` and
 *      surfaces the outcome on a new sibling `lint_status` field of
 *      `CycleResult` (per CONTRACTS.md C8 — NOT a new `reflection_status`
 *      enum value);
 *   2. tags the cycle archive (`brain/_raw/cycles/<id>.md`) with a
 *      `retention` tier + `cited_by` list so plan 01's cleanup pass has
 *      a load-bearing signal for which archives to keep vs. summarise.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

import type { EventLogger, EventLogEntry } from '../logging.ts';
import { parseManifest } from '../manifest.ts';
import {
  REFLECTOR_ALLOWED_TOOLS,
  REFLECTOR_DISALLOWED_TOOLS,
  REFLECTOR_MODEL,
  buildReflectorSystemPrompt,
  renderReflectorUserPrompt,
  tallyToolUse as tallyReflectorToolUse,
  type ReflectorToolUseSummary,
} from '../reflector-invocation.ts';
import {
  recordBrainGateResult,
  type CycleInput,
  type LintStatus,
  type ReflectionStatus,
  type ReflectorPhaseResult,
} from '../cycle-context.ts';
import { runBrainLint, type RunBrainLintResult } from '../brain-lint.ts';
import {
  assignRetention,
  collectCitedBy,
  patchArchiveFrontmatter,
  type ThemeMeta,
  type RetentionTag,
} from '../cycle-retention.ts';

/**
 * Defaults for the live reflector invocation. The reflector is a one-shot SDK
 * call (not a Ralph loop) that consumes the cycle's event log + manifest +
 * merged tree and emits brain theme writes. The bench's 5-fixture median is
 * ~$0.74/run; the live cap gives 2x headroom for richer real cycles.
 */
const REFLECTOR_LIVE_MAX_TURNS = 60;
const REFLECTOR_LIVE_MAX_BUDGET_USD = 1.5;

/**
 * Optional injectables for testing. The brain-lint runner is the only one
 * that needs DI in the wild — tests want to stub clean / flagged / missing
 * outcomes without touching disk. The SDK query is reused as-is from the
 * production codepath; tests that need a stub agent call into the
 * orchestrator via the bench's existing SDK harness (benchmarks/reflection/sdk.ts).
 */
/**
 * SDK-query shape we depend on. Loosened from the SDK's full `Query` type
 * (which the SDK exports as a complex class with `interrupt`, `setModel`,
 * etc.) so test stubs can supply a simple async generator. The real
 * production path passes `sdkQuery` directly via `as unknown` cast.
 */
export type ReflectorSdkQuery = (input: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<unknown>;

export type ReflectorDeps = {
  brainLint?: (opts: { cwd: string; cycleId: string }) => RunBrainLintResult;
  sdkQuery?: ReflectorSdkQuery;
};

/**
 * Reflection phase. Runs after a successful merge to extract patterns from the
 * cycle's event log + merged tree into brain themes. Closes the learning loop.
 *
 * Failure mode: log-and-continue. A thrown reflector returns
 * `reflection_status: 'failed'` but does not propagate — the merge already
 * happened in `runReviewer`, and reflection cannot un-merge.
 *
 * Live invocation contract is shared with the bench via
 * orchestrator/reflector-invocation.ts (single source of truth).
 */
export async function runReflector(
  input: CycleInput,
  logger: EventLogger,
  deps: ReflectorDeps = {},
): Promise<ReflectorPhaseResult> {
  const start = logger.emit({
    initiative_id: input.initiativeId,
    phase: 'reflection',
    skill: 'reflector',
    event_type: 'start',
    input_refs: [input.manifestPath, logger.logFilePath],
    output_refs: [],
    message: 'reflector.start',
  });
  const startedAtMs = Date.now();

  const forgeRoot = resolve(import.meta.dirname, '..', '..');
  const cycleId = logger.cycleId;
  const cycleLogDir = resolve(forgeRoot, '_logs', cycleId);

  // Reflection runs after the reviewer merged the initiative, which moves the
  // manifest from `_queue/in-flight/` to `_queue/done/`. The cycle was kicked
  // off with the in-flight path, so we look up the current location before
  // reading. Fall back to the original path so this stays compatible with
  // bench harnesses that point directly at a stable manifest.
  const manifestPath = resolveCurrentManifestPath(input.manifestPath, forgeRoot);

  let projectName: string;
  let origin: 'architect' | 'human-directed' = 'architect';
  try {
    const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
    projectName = manifest.project;
    // G6: carry the cohort tag onto reflector.end so a reflection-cohort
    // reader (autonomous vs hand-directed) can split retros the same way
    // `forge metrics` splits cycles.
    origin = manifest.origin;
  } catch (err) {
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'reflection',
      skill: 'reflector',
      event_type: 'error',
      input_refs: [manifestPath],
      output_refs: [],
      message: 'reflector.manifest-unreadable',
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    return { reflection_status: 'failed', lint_status: 'skipped' };
  }

  const systemPrompt = buildReflectorSystemPrompt(forgeRoot);
  const cycleArchivePath = resolve(forgeRoot, 'brain', '_raw', 'cycles', `${cycleId}.md`);
  const themesDir = resolve(forgeRoot, 'brain', 'projects', projectName, 'themes');
  // F-07: ensure brain destination dirs exist before invoking the SDK; the
  // reflector writes here directly. A first-time project (no themes/ yet) or
  // a fresh forge install (no brain/_raw/cycles/) would otherwise see ENOENT
  // inside the agent and silently log-and-continue-fail.
  mkdirSync(resolve(forgeRoot, 'brain', '_raw', 'cycles'), { recursive: true });
  mkdirSync(themesDir, { recursive: true });
  // F-12: touch brain-gaps.jsonl if absent. The reflector's user prompt
  // points it at this file; the bench fixtures pre-populate it. In live
  // cycles, gaps are agent-driven (brain-query SKILL writes to it). For the
  // production path, an empty file is a valid signal of "no gaps recorded
  // this cycle" — better than ENOENT bouncing the agent's Read attempt.
  // A real orchestrator-side gap producer is deferred to pass-3 (would
  // require post-cycle event-log scanning).
  const brainGapsPath = resolve(cycleLogDir, 'brain-gaps.jsonl');
  if (!existsSync(brainGapsPath)) {
    mkdirSync(cycleLogDir, { recursive: true });
    writeFileSync(brainGapsPath, '');
  }
  const prompt = renderReflectorUserPrompt({
    initiativeId: input.initiativeId,
    cycleId,
    manifestRelPath: manifestPath,
    eventLogRelPath: logger.logFilePath,
    brainGapsRelPath: resolve(cycleLogDir, 'brain-gaps.jsonl'),
    mergedTreeRelPath: input.projectRepoPath,
    projectName,
    userQuestionsRelPath: resolve(cycleLogDir, 'user-questions.md'),
    userFeedbackRelPath: resolve(cycleLogDir, 'user-feedback.md'),
    retroRelPath: resolve(cycleLogDir, 'retro.md'),
    cycleArchiveRelPath: cycleArchivePath,
    themesDirRelPath: themesDir,
  });

  const options: Record<string, unknown> = {
    cwd: forgeRoot,
    systemPrompt,
    model: REFLECTOR_MODEL,
    permissionMode: 'acceptEdits',
    allowedTools: [...REFLECTOR_ALLOWED_TOOLS],
    disallowedTools: [...REFLECTOR_DISALLOWED_TOOLS],
    maxTurns: REFLECTOR_LIVE_MAX_TURNS,
    maxBudgetUsd: REFLECTOR_LIVE_MAX_BUDGET_USD,
  };

  const toolUseSummary: ReflectorToolUseSummary = {
    brainReads: 0,
    themeWrites: 0,
    retroWrites: 0,
    bashCalls: 0,
  };
  let costUsd = 0;
  let durationMs = 0;
  let resultSubtype: string | undefined;

  const queryImpl: ReflectorSdkQuery =
    deps.sdkQuery ?? (sdkQuery as unknown as ReflectorSdkQuery);
  try {
    for await (const msg of queryImpl({ prompt, options })) {
      if (typeof msg !== 'object' || msg === null) continue;
      const m = msg as {
        type?: string;
        message?: { content?: Array<{ type?: string; name?: string; input?: unknown }> };
        subtype?: string;
        total_cost_usd?: number;
        duration_ms?: number;
      };
      if (m.type === 'assistant') {
        tallyReflectorToolUse(m.message, toolUseSummary);
        continue;
      }
      if (m.type !== 'result') continue;
      if (typeof m.duration_ms === 'number') durationMs = m.duration_ms;
      if (typeof m.total_cost_usd === 'number') costUsd = m.total_cost_usd;
      resultSubtype = m.subtype ?? 'success';
      break;
    }
  } catch (err) {
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'reflection',
      skill: 'reflector',
      event_type: 'error',
      input_refs: [logger.logFilePath],
      output_refs: [],
      message: 'reflector.crashed',
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    return { reflection_status: 'failed', lint_status: 'skipped' };
  }

  // F-13: brain-first gate for reflector. Log-and-continue style — reflector
  // failures don't propagate (the merge already happened). The
  // reflection_status field surfaces the failure to telemetry.
  if (
    !recordBrainGateResult('reflection', 'reflector', toolUseSummary.brainReads, {
      initiativeId: input.initiativeId,
      logger,
      parentEventId: start.event_id,
    })
  ) {
    return { reflection_status: 'failed', lint_status: 'skipped' };
  }

  // S6A — retention tagging. Compute retention tier from the cycle's events
  // + the themes the reflector just wrote, then patch the archive's
  // frontmatter (overwriting the agent's placeholder).
  const retention = computeAndApplyRetention({
    forgeRoot,
    projectName,
    cycleId,
    cycleArchivePath,
    themesDir,
    logFilePath: logger.logFilePath,
    sinceMs: startedAtMs,
  });
  logger.emit({
    initiative_id: input.initiativeId,
    parent_event_id: start.event_id,
    phase: 'reflection',
    skill: 'reflector',
    event_type: 'log',
    input_refs: [cycleArchivePath],
    output_refs: [cycleArchivePath],
    message: 'reflector.retention-assigned',
    metadata: {
      retention: retention.retention,
      cited_by_count: retention.citedBy.length,
      archive_patched: retention.patched,
    },
  });

  // S6A — brain-lint trigger. Run AFTER themes + archive are written so the
  // cycle-touched-themes scope sees the full delta. Informational only —
  // a flagged result does NOT change reflection_status (C8 + plan 06).
  const lintStatus = runPostReflectionLint({
    forgeRoot,
    cycleId,
    cycleLogDir,
    logger,
    initiativeId: input.initiativeId,
    parentEventId: start.event_id,
    brainLint: deps.brainLint,
  });

  // S5 / refinement #6 — brain-bench-growth candidate emit. Best-effort:
  // a write failure is logged but does not block close. The candidate file
  // is the input the operator-driven `forge brain bench:promote` reads.
  const candidateCount = emitBenchCandidates({
    forgeRoot,
    cycleId,
    cycleLogDir,
    themesDir,
    projectName,
    sinceMs: startedAtMs,
    logger,
    initiativeId: input.initiativeId,
    parentEventId: start.event_id,
  });

  logger.emit({
    initiative_id: input.initiativeId,
    parent_event_id: start.event_id,
    phase: 'reflection',
    skill: 'reflector',
    event_type: 'end',
    input_refs: [logger.logFilePath, manifestPath],
    output_refs: [resolve(cycleLogDir, 'retro.md')],
    cost_usd: costUsd,
    duration_ms: durationMs,
    message: 'reflector.end',
    metadata: {
      status: 'closed',
      project: projectName,
      origin,
      result_subtype: resultSubtype,
      tool_use: toolUseSummary,
      lint_status: lintStatus,
      retention: retention.retention,
      bench_candidates_emitted: candidateCount,
    },
  });
  return { reflection_status: 'closed', lint_status: lintStatus };
}

/**
 * Compute retention + cited_by for this cycle and write them into the
 * archive frontmatter. Best-effort: a missing archive (the agent failed to
 * write it) is logged but does not block return — the retention value is
 * still useful telemetry on the reflector.end event.
 */
function computeAndApplyRetention(opts: {
  forgeRoot: string;
  projectName: string;
  cycleId: string;
  cycleArchivePath: string;
  themesDir: string;
  logFilePath: string;
  sinceMs: number;
}): { retention: RetentionTag; citedBy: string[]; patched: boolean } {
  const events = readEventLog(opts.logFilePath);
  const themesWritten = listFreshThemes(opts.themesDir, opts.sinceMs);
  const retention = assignRetention(events, themesWritten);
  const citedBy = collectCitedBy({
    forgeRoot: opts.forgeRoot,
    projectName: opts.projectName,
    cycleId: opts.cycleId,
    sinceMs: opts.sinceMs,
  });
  const patched = patchArchiveFrontmatter(opts.cycleArchivePath, retention, citedBy);
  return { retention, citedBy, patched };
}

/**
 * Read the structured event log and return parsed entries. Best-effort —
 * malformed lines are skipped, a missing file returns []. Same semantics
 * as the failure-classifier's reader (orchestrator/cycle.ts).
 */
function readEventLog(logFilePath: string): EventLogEntry[] {
  const out: EventLogEntry[] = [];
  if (!existsSync(logFilePath)) return out;
  let raw: string;
  try {
    raw = readFileSync(logFilePath, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as EventLogEntry);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/**
 * List theme files the reflector wrote this pass (mtime >= sinceMs).
 * Returns minimal metadata for the retention heuristic.
 */
function listFreshThemes(themesDir: string, sinceMs: number): ThemeMeta[] {
  if (!existsSync(themesDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(themesDir);
  } catch {
    return [];
  }
  const out: ThemeMeta[] = [];
  for (const file of entries) {
    if (!file.endsWith('.md')) continue;
    const full = resolve(themesDir, file);
    try {
      const st = statSync(full);
      if (st.mtimeMs < sinceMs) continue;
      const raw = readFileSync(full, 'utf8');
      out.push({ path: full, category: extractCategory(raw) });
    } catch {
      /* skip */
    }
  }
  return out;
}

function extractCategory(themeBody: string): string | null {
  // Minimal frontmatter extractor mirroring benchmarks/reflection/scoring.ts.
  if (!themeBody.startsWith('---\n') && !themeBody.startsWith('---\r\n')) return null;
  const end = themeBody.indexOf('\n---', 4);
  if (end === -1) return null;
  const block = themeBody.slice(4, end);
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^category:\s*(.*)$/);
    if (m) {
      let v = m[1].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      return v || null;
    }
  }
  return null;
}

/**
 * Trigger the post-reflection brain-lint pass over cycle-touched themes.
 *
 * Per C8 + plan 06: `lint_status: 'flagged'` does NOT block
 * `reflection_status: 'closed'`. Errors are surfaced through the
 * `reflector.lint-flagged` event + `_logs/<id>/brain-lint.md` artefact so
 * the next cycle / operator can act on them.
 */
function runPostReflectionLint(opts: {
  forgeRoot: string;
  cycleId: string;
  cycleLogDir: string;
  logger: EventLogger;
  initiativeId: string;
  parentEventId?: string;
  brainLint?: (opts: { cwd: string; cycleId: string }) => RunBrainLintResult;
}): LintStatus {
  const { forgeRoot, cycleId, cycleLogDir, logger, initiativeId, parentEventId, brainLint } = opts;
  const lintImpl =
    brainLint ??
    ((o: { cwd: string; cycleId: string }) =>
      runBrainLint({ cwd: o.cwd, scope: 'cycle-touched-themes', cycle: o.cycleId, fix: false }));

  let result: RunBrainLintResult;
  try {
    result = lintImpl({ cwd: forgeRoot, cycleId });
  } catch (err) {
    // Lint module reachable but threw — per S6A-DECISIONS.md "Failure mode",
    // surface as 'flagged' with a `lint-internal-error` reason.
    const reason = err instanceof Error ? err.message : String(err);
    if (/cannot find module|MODULE_NOT_FOUND|ENOENT.*brain-lint/i.test(reason)) {
      logger.emit({
        initiative_id: initiativeId,
        parent_event_id: parentEventId,
        phase: 'reflection',
        skill: 'reflector',
        event_type: 'log',
        input_refs: [],
        output_refs: [],
        message: 'reflector.lint-skipped',
        metadata: { reason: 'executable-missing', error: reason },
      });
      return 'skipped';
    }
    logger.emit({
      initiative_id: initiativeId,
      parent_event_id: parentEventId,
      phase: 'reflection',
      skill: 'reflector',
      event_type: 'log',
      input_refs: [],
      output_refs: [],
      message: 'reflector.lint-flagged',
      metadata: { reason: 'lint-internal-error', error: reason, findings_count: 0 },
    });
    return 'flagged';
  }

  if (result.exitCode === 0) {
    // Clean — emit an invoked event + a stub report for operator-facing
    // discoverability ("lint ran, nothing to report").
    writeLintReport(cycleLogDir, result.findings, forgeRoot);
    logger.emit({
      initiative_id: initiativeId,
      parent_event_id: parentEventId,
      phase: 'reflection',
      skill: 'reflector',
      event_type: 'log',
      input_refs: [],
      output_refs: [resolve(cycleLogDir, 'brain-lint.md')],
      message: 'reflector.lint-invoked',
      metadata: { result: 'clean', findings_count: result.findings.length },
    });
    return 'clean';
  }

  // exitCode === 1 → errors present
  writeLintReport(cycleLogDir, result.findings, forgeRoot);
  const errorFindings = result.findings.filter((f) => f.category === 'error').length;
  logger.emit({
    initiative_id: initiativeId,
    parent_event_id: parentEventId,
    phase: 'reflection',
    skill: 'reflector',
    event_type: 'log',
    input_refs: [],
    output_refs: [resolve(cycleLogDir, 'brain-lint.md')],
    message: 'reflector.lint-flagged',
    metadata: { findings_count: errorFindings, total_findings: result.findings.length },
  });
  return 'flagged';
}

/**
 * Write a human-readable lint report to `_logs/<cycle-id>/brain-lint.md`.
 * Always writes a file — even a clean run gets `(no findings)` so the
 * presence of the file is a reliable "lint ran" signal in operator-facing
 * tooling (S6B recap, future notification path).
 */
function writeLintReport(
  cycleLogDir: string,
  findings: RunBrainLintResult['findings'],
  forgeRoot: string,
): void {
  try {
    mkdirSync(cycleLogDir, { recursive: true });
    const path = resolve(cycleLogDir, 'brain-lint.md');
    if (findings.length === 0) {
      writeFileSync(path, '# Brain-lint report\n\n(no findings)\n');
      return;
    }
    const errors = findings.filter((f) => f.category === 'error');
    const flags = findings.filter((f) => f.category === 'flag');
    const fixes = findings.filter((f) => f.category === 'auto-fix');
    const lines: string[] = ['# Brain-lint report', ''];
    for (const [label, group] of [
      ['Errors', errors],
      ['Flags', flags],
      ['Auto-fixes', fixes],
    ] as const) {
      if (group.length === 0) continue;
      lines.push(`## ${label} (${group.length})`, '');
      for (const f of group) {
        const rel = f.file.startsWith(forgeRoot + '/') ? f.file.slice(forgeRoot.length + 1) : f.file;
        lines.push(`- [${f.check ?? 'check'}] ${rel}: ${f.message}`);
      }
      lines.push('');
    }
    lines.push(
      `Summary: ${errors.length} error(s), ${flags.length} flag(s), ${fixes.length} auto-fix(es).`,
      '',
    );
    writeFileSync(path, lines.join('\n'));
  } catch {
    /* best-effort */
  }
}

/**
 * Resolve the current location of an initiative's manifest. The reviewer
 * moves the manifest from `_queue/in-flight/` to `_queue/done/` (or
 * `_queue/ready-for-review/`) on completion. Reflection runs *after* the
 * move, so reading the original `input.manifestPath` ENOENTs every real
 * cycle. We look at the queue's terminal states first, then fall back to
 * the original path so bench harnesses (which pass a stable, non-queue path)
 * still work.
 */
function resolveCurrentManifestPath(originalPath: string, forgeRoot: string): string {
  if (existsSync(originalPath)) return originalPath;
  const filename = basename(originalPath);
  const candidates = [
    resolve(forgeRoot, '_queue', 'done', filename),
    resolve(forgeRoot, '_queue', 'ready-for-review', filename),
    resolve(forgeRoot, '_queue', 'failed', filename),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return originalPath;
}

/**
 * S5 / refinement #6 — emit brain-bench-growth candidates.
 *
 * One candidate row per qualifying gap. A gap qualifies iff this cycle
 * wrote at least one theme file (mtime >= sinceMs) under the project's
 * themes/ dir or under brain/forge/themes/, AND the gap's question
 * intersects (via shared keywords) with the written theme's title /
 * frontmatter keywords. Cycles that wrote zero themes emit zero
 * candidates; cycles whose gaps were not filled emit zero candidates.
 *
 * Heuristic intentionally conservative — false positives waste operator
 * time; false negatives just mean the question never enters the
 * promote pipeline (a future cycle hits the same gap and tries again).
 *
 * The output file `_logs/<cycle-id>/brain-bench-candidates.jsonl` is the
 * single input to `forge brain bench:promote`.
 */
function emitBenchCandidates(opts: {
  forgeRoot: string;
  cycleId: string;
  cycleLogDir: string;
  themesDir: string;
  projectName: string;
  sinceMs: number;
  logger: EventLogger;
  initiativeId: string;
  parentEventId?: string;
}): number {
  const { forgeRoot, cycleId, cycleLogDir, themesDir, projectName, sinceMs } = opts;
  const candidatesPath = resolve(cycleLogDir, 'brain-bench-candidates.jsonl');

  try {
    const gaps = readBrainGaps(resolve(cycleLogDir, 'brain-gaps.jsonl'));
    if (gaps.length === 0) {
      // Nothing to consider. Touch an empty file so the operator + downstream
      // tooling can tell "ran but no candidates" from "never ran".
      mkdirSync(cycleLogDir, { recursive: true });
      writeFileSync(candidatesPath, '');
      return 0;
    }
    const projectThemes = listFreshThemes(themesDir, sinceMs);
    const forgeThemes = listFreshThemes(resolve(forgeRoot, 'brain', 'forge', 'themes'), sinceMs);
    const writtenThemes = [...projectThemes, ...forgeThemes];
    if (writtenThemes.length === 0) {
      // No themes this cycle ⇒ no gaps filled ⇒ no candidates.
      mkdirSync(cycleLogDir, { recursive: true });
      writeFileSync(candidatesPath, '');
      return 0;
    }
    // Build a {theme-path -> keyword-set} lookup once per pass.
    const themeKeywords = new Map<string, Set<string>>();
    for (const t of writtenThemes) {
      themeKeywords.set(t.path, extractThemeKeywords(t.path));
    }

    const lines: string[] = [];
    for (const gap of gaps) {
      const matched = matchGapToTheme(gap.query, themeKeywords);
      if (matched.length === 0) continue;
      const candidate = {
        question: gap.query,
        expected_sources: matched.map((p) => relativeToForge(p, forgeRoot)),
        why_now: `this cycle wrote ${matched.length} theme(s) addressing the gap; promotion would make the question testable.`,
        gap_id: gap.gap_id,
        scope: projectName,
      };
      lines.push(JSON.stringify(candidate));
    }
    mkdirSync(cycleLogDir, { recursive: true });
    writeFileSync(candidatesPath, lines.length === 0 ? '' : lines.join('\n') + '\n');
    if (lines.length > 0) {
      opts.logger.emit({
        initiative_id: opts.initiativeId,
        parent_event_id: opts.parentEventId,
        phase: 'reflection',
        skill: 'reflector',
        event_type: 'log',
        input_refs: [resolve(cycleLogDir, 'brain-gaps.jsonl')],
        output_refs: [candidatesPath],
        message: 'reflector.bench-candidates-emitted',
        metadata: { count: lines.length, cycle_id: cycleId },
      });
    }
    return lines.length;
  } catch (err) {
    // Best-effort. A failure here must not change reflection close.
    opts.logger.emit({
      initiative_id: opts.initiativeId,
      parent_event_id: opts.parentEventId,
      phase: 'reflection',
      skill: 'reflector',
      event_type: 'log',
      input_refs: [],
      output_refs: [],
      message: 'reflector.bench-candidates-failed',
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    return 0;
  }
}

type GapRow = { gap_id?: string; query: string };

/**
 * Parse brain-gaps.jsonl (one JSON object per line). Tolerates a missing
 * file, empty lines, and malformed lines. Only rows with a string `query`
 * are kept.
 */
function readBrainGaps(path: string): GapRow[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: GapRow[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const query =
        typeof parsed.query === 'string'
          ? parsed.query
          : typeof parsed.question === 'string'
          ? parsed.question
          : null;
      if (!query) continue;
      const gap_id = typeof parsed.gap_id === 'string' ? parsed.gap_id : undefined;
      out.push({ gap_id, query });
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Tokenise a string for the gap-vs-theme intersection check. Mirrors the
 * bench's keyword tokenizer at low cost: lowercase, split on non-word,
 * drop stopwords + <3 char tokens, dedupe.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
  'be', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'as', 'by',
  'what', 'when', 'where', 'why', 'how', 'does', 'do', 'did', 'this',
  'that', 'these', 'those', 'it', 'its', 'from', 'has', 'have', 'had',
  'into', 'between', 'about', 'over', 'under', 'than', 'should', 'shall',
  'will', 'must', 'can', 'could', 'would', 'may', 'might',
]);

function tokenise(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_-]+/)) {
    if (!raw) continue;
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * Extract a theme's keyword set from its frontmatter `keywords:` field +
 * its title. Reads the file synchronously; on failure returns an empty
 * set. Cheap (one file per fresh theme; typically ≤5 per cycle).
 */
function extractThemeKeywords(path: string): Set<string> {
  try {
    const raw = readFileSync(path, 'utf8');
    const keywords = new Set<string>();
    // Frontmatter block.
    if (raw.startsWith('---\n') || raw.startsWith('---\r\n')) {
      const end = raw.indexOf('\n---', 4);
      if (end > 0) {
        const block = raw.slice(4, end);
        const kwLine = block.split(/\r?\n/).find((l) => /^keywords:/.test(l));
        if (kwLine) {
          // keywords: [a, b, c]  OR  keywords:\n  - a\n  - b
          const inline = kwLine.match(/\[(.*)\]/);
          if (inline) {
            for (const t of inline[1].split(',')) {
              const v = t.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
              if (v) keywords.add(v);
            }
          }
        }
        const titleLine = block.split(/\r?\n/).find((l) => /^title:/.test(l));
        if (titleLine) {
          for (const t of tokenise(titleLine.replace(/^title:\s*/, ''))) keywords.add(t);
        }
      }
    }
    // First H1 also folds in.
    const firstH1 = raw.split(/\r?\n/).find((l) => l.startsWith('# '));
    if (firstH1) for (const t of tokenise(firstH1.slice(2))) keywords.add(t);
    return keywords;
  } catch {
    return new Set();
  }
}

/**
 * Return the paths of themes whose keyword set shares ≥ 2 tokens with the
 * gap's query. Two is the minimum that meaningfully reduces false
 * positives: a single shared "token" (e.g. "brain") matches almost every
 * gap; two shared tokens implies a topic overlap.
 */
function matchGapToTheme(query: string, themeKeywords: Map<string, Set<string>>): string[] {
  const qTokens = tokenise(query);
  const hits: string[] = [];
  for (const [path, kw] of themeKeywords) {
    let shared = 0;
    for (const t of qTokens) {
      if (kw.has(t)) {
        shared += 1;
        if (shared >= 2) break;
      }
    }
    if (shared >= 2) hits.push(path);
  }
  return hits;
}

function relativeToForge(absPath: string, forgeRoot: string): string {
  return absPath.startsWith(forgeRoot + '/') ? absPath.slice(forgeRoot.length + 1) : absPath;
}

// Re-export the legacy ReflectionStatus type for ergonomic imports.
export type { ReflectionStatus };
