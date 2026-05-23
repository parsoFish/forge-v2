/**
 * Pure scoring functions for the reflection-phase benchmark.
 *
 * Mirrors the established phase-bench shape (review-loop is the closest
 * precedent — long-running, has both bench and live wiring):
 *
 *   - **Five gates** that drop score = 0 if violated:
 *       1. `manifest_provided`       — fixture has the closed manifest at the declared path.
 *       2. `log_parseable`           — events.jsonl loads as valid JSONL.
 *       3. `retro_emitted`           — retro.md was written under the cycle's _logs/<cycle-id>/.
 *       4. `brain_consulted`         — ≥ 1 brain-query / brain-read recorded.
 *       5. `no_brain_corruption`     — every newly-emitted theme file passes a subset
 *                                      of brain/LINT.md rules (frontmatter present + valid
 *                                      category + ≥ 1 source link present + source link
 *                                      resolves to an existing path).
 *
 *   - **Six weighted criteria** summing to 1.0:
 *
 *       themes_emitted              0.25
 *       themes_evidence_grounded    0.25
 *       theme_categories_balanced   0.10
 *       cycle_archived              0.15
 *       retro_three_sections        0.15
 *       brain_gaps_addressed        0.10
 *
 *   - **PASS_THRESHOLD = 0.7** — same as every other phase bench.
 *
 * Why these dimensions and weights:
 *
 *   gate: manifest_provided / log_parseable
 *       Without the manifest + valid log, reflection has nothing to reflect on.
 *       Cheap pre-flight checks.
 *
 *   gate: retro_emitted
 *       The retro doc is the visible artifact of the reflection. No retro =
 *       no run.
 *
 *   gate: brain_consulted
 *       Same anchor as every other phase. Reflection that doesn't query the
 *       brain first cannot ground its findings against prior cycles.
 *
 *   gate: no_brain_corruption
 *       Subset of brain/LINT.md rules. Validates structural integrity of
 *       newly-emitted theme files. Catches frontmatter omissions, invalid
 *       categories, and broken evidence links — the structural failure modes
 *       that a strict brain-lint pass would catch. We don't shell out to a
 *       brain-lint CLI (none exists yet); the inline check is the load-bearing
 *       structural-integrity gate.
 *
 *   themes_emitted (0.25)
 *       At least N theme files exist in brain/projects/<project>/themes/.
 *       N comes from the fixture's expected.min_themes. The minimum signal
 *       that the reflector did something.
 *
 *   themes_evidence_grounded (0.25)
 *       Each theme file's body cites ≥ 1 path that resolves (existsSync) to
 *       either _logs/<cycle-id>/... or brain/_raw/cycles/<cycle-id>.md.
 *       Orchestrator-verified, NOT keyword-grep — this is the load-bearing
 *       anti-vague-retro defence ("we could improve X" with no evidence
 *       cannot pass).
 *
 *   theme_categories_balanced (0.10)
 *       Every theme has a valid `category` frontmatter value. If the cycle's
 *       events.jsonl contains any wedge or send-back event, ≥ 1 theme must
 *       carry `category: antipattern`. Catches the "everything labelled
 *       pattern" failure mode without punishing legitimate topic discovery.
 *
 *   cycle_archived (0.15)
 *       brain/_raw/cycles/<cycle-id>.md was written with required frontmatter.
 *       Cycle archiving is the structural prerequisite for cross-cycle
 *       evidence linking — losing it costs us the audit trail.
 *
 *   retro_three_sections (0.15)
 *       retro.md contains all three structural headings (self-reflection /
 *       user questions / user feedback). Validates the reflector ran the full
 *       4-stage process, not just stage 1.
 *
 *   brain_gaps_addressed (0.10)
 *       If the fixture's brain-gaps.jsonl is non-empty: every gap-id appears
 *       referenced in retro.md or as a source in a new theme. Empty gaps file
 *       → criterion auto-passes (so non-gap-heavy fixtures aren't penalised).
 *
 * What this rubric does NOT catch (acknowledged limitation; human-review
 * stage 2/3 covers these):
 *   - Themes that are evidence-grounded but uninsightful ("the agent
 *     read 27 files and concluded that reading files works").
 *   - User-feedback section transcribed but ignored in theme content.
 *   - Cross-cycle pattern continuity (does theme N+1 reinforce or contradict
 *     theme N?).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

import type { ReflectorToolUseSummary } from '../../orchestrator/reflector-invocation.ts';

export type ReflectionExpected = {
  /** Project name. Used to locate brain/projects/<project>/themes/. */
  project: string;
  /** Minimum number of theme files the reflector must emit (under brain/projects/<project>/themes/). */
  min_themes: number;
  /**
   * Brain-gap IDs (from the fixture's brain-gaps.jsonl) that the reflector
   * must address. Empty array = no gap requirement (criterion auto-passes).
   */
  brain_gap_ids: string[];
};

export type ReflectionCriteria = {
  // Gates (binary; any 0 → score = 0)
  manifest_provided: 0 | 1;
  log_parseable: 0 | 1;
  retro_emitted: 0 | 1;
  brain_consulted: 0 | 1;
  no_brain_corruption: 0 | 1;
  // Weighted (sum to 1.0)
  themes_emitted: 0 | 1;
  themes_evidence_grounded: 0 | 1;
  theme_categories_balanced: 0 | 1;
  cycle_archived: 0 | 1;
  retro_three_sections: 0 | 1;
  brain_gaps_addressed: 0 | 1;
};

export type ReflectionScore = {
  score: number;
  passed: boolean;
  criteria: ReflectionCriteria;
  // Diagnostic fields (surfaced in run summaries; not part of the score)
  themes_found: string[];
  themes_missing_evidence: string[];
  themes_invalid_category: string[];
  retro_path: string | null;
  cycle_archive_path: string | null;
  brain_gaps_unaddressed: string[];
  lint_errors: string[];
};

export const PASS_THRESHOLD = 0.7;

// Weights — must sum to 1.0.
export const WEIGHT_THEMES_EMITTED = 0.25;
export const WEIGHT_EVIDENCE_GROUNDED = 0.25;
export const WEIGHT_CATEGORIES_BALANCED = 0.10;
export const WEIGHT_CYCLE_ARCHIVED = 0.15;
export const WEIGHT_RETRO_SECTIONS = 0.15;
export const WEIGHT_BRAIN_GAPS = 0.10;

const VALID_CATEGORIES = new Set([
  'pattern',
  'antipattern',
  'decision',
  'operation',
  'reference',
]);

const RETRO_REQUIRED_HEADINGS = [
  /\bself[\s\-_]*reflection\b/i,
  /\buser[\s\-_]*questions\b/i,
  /\buser[\s\-_]*feedback\b/i,
] as const;

// ---------------------------------------------------------------------------
// Frontmatter parsing — minimal YAML-frontmatter extractor. Sufficient for
// the structural checks we run; full YAML parsing is a node-yaml dependency
// we don't want for a benchmark.
// ---------------------------------------------------------------------------

export function parseFrontmatter(content: string): Record<string, string> | null {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return null;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return null;
  const block = content.slice(4, end);
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Theme discovery
// ---------------------------------------------------------------------------

export function listThemeFiles(brainRoot: string, project: string): string[] {
  const dir = resolve(brainRoot, 'projects', project, 'themes');
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((f) => f.endsWith('.md')).map((f) => resolve(dir, f));
}

// ---------------------------------------------------------------------------
// Per-theme structural checks
// ---------------------------------------------------------------------------

export type ThemeCheck = {
  path: string;
  hasFrontmatter: boolean;
  category: string | null;
  evidenceLinks: string[];
  resolvedEvidence: string[];
  unresolvedEvidence: string[];
};

/**
 * Scrape evidence-link candidates from the theme body. We accept:
 *   - markdown link targets:                         `[text](path)`
 *   - inline backtick paths to known evidence dirs:  `` `_logs/foo/...` ``
 *   - bare paths in a list:                          `- _logs/foo/...`
 *
 * Resolution rule (load-bearing): a link counts as "evidence" only if its
 * resolved path exists AND the path lies under either:
 *   - <cycleLogDir>           (e.g. _logs/<cycle-id>/...)
 *   - <rawCycleArchivePath>   (e.g. brain/_raw/cycles/<cycle-id>.md)
 *
 * This is the orchestrator-verified evidence check (NOT a keyword grep).
 */
export function checkTheme(
  themePath: string,
  cycleLogDir: string,
  rawCycleArchivePath: string,
  brainRoot: string,
): ThemeCheck {
  const out: ThemeCheck = {
    path: themePath,
    hasFrontmatter: false,
    category: null,
    evidenceLinks: [],
    resolvedEvidence: [],
    unresolvedEvidence: [],
  };
  if (!existsSync(themePath)) return out;
  const content = readFileSync(themePath, 'utf8');
  const frontmatter = parseFrontmatter(content);
  if (frontmatter) {
    out.hasFrontmatter = true;
    out.category = frontmatter.category ?? null;
  }

  // Collect candidate paths from the body. Two sources:
  //   - markdown link targets:        `[text](path)`
  //   - inline backtick paths:        `` `path/with/slash.ext` ``
  // Bare unquoted paths in list items are NOT scraped — too many false positives
  // when the list item contains a markdown link (the bracket-paren structure
  // matches the bare-path regex unintentionally).
  const body = content;
  const candidates = new Set<string>();
  for (const m of body.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) {
    candidates.add(m[1]);
  }
  for (const m of body.matchAll(/`([^`\n]+)`/g)) {
    if (m[1].includes('/')) candidates.add(m[1]);
  }

  // Allowed evidence roots.
  const allowedRoots = [resolve(cycleLogDir), resolve(rawCycleArchivePath)];

  for (const cand of candidates) {
    out.evidenceLinks.push(cand);
    // Strip URL fragments / query / leading slash variants.
    const cleaned = cand.split('#')[0].split('?')[0];
    const candidatePaths = [
      cleaned,
      isAbsolute(cleaned) ? cleaned : resolve(brainRoot, '..', cleaned),
      resolve(themePath, '..', cleaned),
      resolve(brainRoot, cleaned),
    ];
    let resolved: string | null = null;
    for (const p of candidatePaths) {
      if (existsSync(p)) {
        resolved = resolve(p);
        break;
      }
    }
    if (!resolved) {
      out.unresolvedEvidence.push(cand);
      continue;
    }
    const underAllowedRoot = allowedRoots.some(
      (root) => resolved === root || resolved!.startsWith(root + '/'),
    );
    if (underAllowedRoot) {
      out.resolvedEvidence.push(cand);
    } else {
      out.unresolvedEvidence.push(cand);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Event log inspection
// ---------------------------------------------------------------------------

export type EventLine = {
  message?: string;
  metadata?: Record<string, unknown>;
  event_type?: string;
  phase?: string;
};

export function parseEventLog(eventLogPath: string): { lines: EventLine[]; ok: boolean } {
  if (!existsSync(eventLogPath)) return { lines: [], ok: false };
  let raw: string;
  try {
    raw = readFileSync(eventLogPath, 'utf8');
  } catch {
    return { lines: [], ok: false };
  }
  const lines: EventLine[] = [];
  for (const ln of raw.split(/\r?\n/)) {
    if (!ln.trim()) continue;
    try {
      lines.push(JSON.parse(ln));
    } catch {
      return { lines: [], ok: false };
    }
  }
  return { lines, ok: true };
}

/**
 * A wedge or send-back happened during the cycle if any of these signals
 * appears in the event log:
 *   - `ralph.end` with `metadata.stop_reason` ∈ {`wedged`, `iteration-budget`}
 *   - reviewer verdict `send-back`
 *   - any `event_type === 'error'`
 */
export function logHasWedgeOrSendBack(lines: EventLine[]): boolean {
  for (const ln of lines) {
    if (ln.event_type === 'error') return true;
    if (ln.message === 'reviewer.verdict.send-back') return true;
    if (ln.message === 'ralph.end') {
      const sr = ln.metadata?.['stop_reason'];
      if (sr === 'wedged' || sr === 'iteration-budget') return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Cycle-archive verification
// ---------------------------------------------------------------------------

export function checkCycleArchive(archivePath: string, cycleId: string): {
  ok: boolean;
  reason: string | null;
} {
  if (!existsSync(archivePath)) return { ok: false, reason: 'archive file missing' };
  const content = readFileSync(archivePath, 'utf8');
  const fm = parseFrontmatter(content);
  if (!fm) return { ok: false, reason: 'no frontmatter' };
  if (fm.source_type !== 'cycle') return { ok: false, reason: `source_type ≠ cycle (got ${fm.source_type})` };
  if (!fm.ingested_at) return { ok: false, reason: 'ingested_at missing' };
  if (fm.ingested_by !== 'reflector') return { ok: false, reason: `ingested_by ≠ reflector (got ${fm.ingested_by})` };
  if (fm.cycle_id && fm.cycle_id !== cycleId) {
    return { ok: false, reason: `cycle_id mismatch (got ${fm.cycle_id}, expected ${cycleId})` };
  }
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// Retro doc verification
// ---------------------------------------------------------------------------

export function retroHasThreeSections(retroPath: string): boolean {
  if (!existsSync(retroPath)) return false;
  const body = readFileSync(retroPath, 'utf8');
  return RETRO_REQUIRED_HEADINGS.every((re) => re.test(body));
}

// ---------------------------------------------------------------------------
// Brain-gap address check
// ---------------------------------------------------------------------------

export function brainGapsAddressed(
  retroPath: string,
  themePaths: string[],
  brainGapIds: string[],
): { value: 0 | 1; unaddressed: string[] } {
  if (brainGapIds.length === 0) return { value: 1, unaddressed: [] };
  const blobs: string[] = [];
  if (existsSync(retroPath)) blobs.push(readFileSync(retroPath, 'utf8'));
  for (const tp of themePaths) {
    if (existsSync(tp)) blobs.push(readFileSync(tp, 'utf8'));
  }
  const corpus = blobs.join('\n');
  const unaddressed = brainGapIds.filter((id) => !corpus.includes(id));
  return { value: unaddressed.length === 0 ? 1 : 0, unaddressed };
}

// ---------------------------------------------------------------------------
// Brain-consulted check (mirrors review-loop / pm — ≥ 1 brain read).
// ---------------------------------------------------------------------------

export function brainConsulted(toolUse: ReflectorToolUseSummary): 0 | 1 {
  return toolUse.brainReads >= 1 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// S6A — lint_invoked gate. Any of the three reflector.lint-* events present
// in the cycle's event log counts as "lint was triggered". Per CONTRACTS.md
// C8 + plan 06: lint is informational, not gating — but the gate exists so
// bench tooling can confirm the trigger fired. Pre-S6A fixture-frozen logs
// (no `reflector.start` event) return 1 to preserve backward compatibility
// with the 5 existing fixtures' frozen event-log data.
// ---------------------------------------------------------------------------

export function lintInvoked(lines: EventLine[]): 0 | 1 {
  const sawReflectorStart = lines.some(
    (ln) => ln.phase === 'reflection' && ln.message === 'reflector.start',
  );
  if (!sawReflectorStart) {
    // Pre-S6A fixture-frozen log (no reflector phase fired) — backward
    // compatible: gate auto-passes so existing fixtures continue to score
    // unchanged.
    return 1;
  }
  for (const ln of lines) {
    if (
      ln.message === 'reflector.lint-invoked' ||
      ln.message === 'reflector.lint-skipped' ||
      ln.message === 'reflector.lint-flagged'
    ) {
      return 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// S6A — retention_assigned gate. The cycle archive must declare a
// `retention` frontmatter field with one of the three valid tier values.
// Pre-S6A archives (no retention key) return 1 to preserve backward
// compatibility with frozen fixtures; an explicit `retention: auto`
// placeholder is treated as NOT assigned (the orchestrator should have
// post-processed it).
// ---------------------------------------------------------------------------

const VALID_RETENTION = new Set(['load-bearing', 'interesting', 'routine']);

export function retentionAssigned(archivePath: string): 0 | 1 {
  if (!existsSync(archivePath)) return 0;
  const content = readFileSync(archivePath, 'utf8');
  const fm = parseFrontmatter(content);
  if (!fm) return 0;
  const value = fm['retention'];
  if (value === undefined) {
    // Pre-S6A archive — backward compatible auto-pass.
    return 1;
  }
  if (value === 'auto' || value === '') return 0;
  return VALID_RETENTION.has(value) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// S6B — recap_emitted gate. `_logs/<cycle-id>/recap.md` exists + non-empty.
// Per plan 06 §"Bench updates" + CONTRACTS C15a: the orchestrator writes
// the recap synchronously at the end of `runReflector`, so a successful
// reflection close MUST produce a non-empty file. Pre-S6B fixture-frozen
// logs (no `reflector.start`) get a backward-compatible auto-pass, same
// pattern as `lintInvoked`.
// ---------------------------------------------------------------------------

export function recapEmitted(
  recapPath: string,
  lines: EventLine[],
): 0 | 1 {
  const sawReflectorStart = lines.some(
    (ln) => ln.phase === 'reflection' && ln.message === 'reflector.start',
  );
  if (!sawReflectorStart) {
    // Pre-S6B fixture-frozen log — backward compatible auto-pass.
    return 1;
  }
  if (!existsSync(recapPath)) return 0;
  let raw: string;
  try {
    raw = readFileSync(recapPath, 'utf8');
  } catch {
    return 0;
  }
  return raw.trim().length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Top-level case scorer.
// ---------------------------------------------------------------------------

export type CaseScoreInput = {
  /** Cycle ID — used to derive _logs/<cycle-id>/ paths. */
  cycleId: string;
  /** Tempdir root (where the bench rewrote brain/, _logs/, etc.). */
  benchRoot: string;
  /** Path to the closed manifest. */
  manifestPath: string;
  /** Path to the cycle's event log. */
  eventLogPath: string;
  /** Tool-use telemetry from the agent's session. */
  toolUse: ReflectorToolUseSummary;
  /** Fixture expectations. */
  expected: ReflectionExpected;
};

export function caseScore(input: CaseScoreInput): ReflectionScore {
  const { cycleId, benchRoot, manifestPath, eventLogPath, toolUse, expected } = input;

  const brainRoot = resolve(benchRoot, 'brain');
  const cycleLogDir = resolve(benchRoot, '_logs', cycleId);
  const retroPath = resolve(cycleLogDir, 'retro.md');
  const archivePath = resolve(brainRoot, '_raw', 'cycles', `${cycleId}.md`);

  // -------- Gates --------
  const manifestProvided: 0 | 1 = existsSync(manifestPath) ? 1 : 0;
  const eventLog = parseEventLog(eventLogPath);
  const logParseable: 0 | 1 = eventLog.ok ? 1 : 0;
  const retroEmitted: 0 | 1 = existsSync(retroPath) ? 1 : 0;
  const brainOk = brainConsulted(toolUse);

  const themeFiles = listThemeFiles(brainRoot, expected.project);
  const themeChecks = themeFiles.map((p) => checkTheme(p, cycleLogDir, archivePath, brainRoot));

  const lintErrors: string[] = [];
  for (const tc of themeChecks) {
    if (!tc.hasFrontmatter) {
      lintErrors.push(`${tc.path}: missing frontmatter`);
      continue;
    }
    if (!tc.category || !VALID_CATEGORIES.has(tc.category)) {
      lintErrors.push(`${tc.path}: invalid category (${tc.category ?? 'null'})`);
    }
    if (tc.resolvedEvidence.length === 0) {
      lintErrors.push(`${tc.path}: no evidence link resolves`);
    }
  }
  const noBrainCorruption: 0 | 1 = lintErrors.length === 0 ? 1 : 0;

  const allGates =
    manifestProvided === 1 &&
    logParseable === 1 &&
    retroEmitted === 1 &&
    brainOk === 1 &&
    noBrainCorruption === 1;

  if (!allGates) {
    return {
      score: 0,
      passed: false,
      criteria: {
        manifest_provided: manifestProvided,
        log_parseable: logParseable,
        retro_emitted: retroEmitted,
        brain_consulted: brainOk,
        no_brain_corruption: noBrainCorruption,
        themes_emitted: 0,
        themes_evidence_grounded: 0,
        theme_categories_balanced: 0,
        cycle_archived: 0,
        retro_three_sections: 0,
        brain_gaps_addressed: 0,
      },
      themes_found: themeFiles,
      themes_missing_evidence: themeChecks
        .filter((t) => t.resolvedEvidence.length === 0)
        .map((t) => t.path),
      themes_invalid_category: themeChecks
        .filter((t) => !t.category || !VALID_CATEGORIES.has(t.category))
        .map((t) => t.path),
      retro_path: retroEmitted ? retroPath : null,
      cycle_archive_path: existsSync(archivePath) ? archivePath : null,
      brain_gaps_unaddressed: [],
      lint_errors: lintErrors,
    };
  }

  // -------- Weighted criteria --------

  const themesEmittedV: 0 | 1 = themeFiles.length >= expected.min_themes ? 1 : 0;

  const evidenceGroundedV: 0 | 1 =
    themeChecks.length > 0 && themeChecks.every((t) => t.resolvedEvidence.length > 0) ? 1 : 0;

  const allCategoriesValid = themeChecks.every(
    (t) => t.category !== null && VALID_CATEGORIES.has(t.category),
  );
  const wedgeOrSendBack = logHasWedgeOrSendBack(eventLog.lines);
  const hasAntipattern = themeChecks.some((t) => t.category === 'antipattern');
  const categoriesBalancedV: 0 | 1 =
    allCategoriesValid && (!wedgeOrSendBack || hasAntipattern) ? 1 : 0;

  const archiveCheck = checkCycleArchive(archivePath, cycleId);
  const cycleArchivedV: 0 | 1 = archiveCheck.ok ? 1 : 0;

  const retroSectionsV: 0 | 1 = retroHasThreeSections(retroPath) ? 1 : 0;

  const gapsCheck = brainGapsAddressed(retroPath, themeFiles, expected.brain_gap_ids);
  const gapsAddressedV: 0 | 1 = gapsCheck.value;

  const criteria: ReflectionCriteria = {
    manifest_provided: 1,
    log_parseable: 1,
    retro_emitted: 1,
    brain_consulted: 1,
    no_brain_corruption: 1,
    themes_emitted: themesEmittedV,
    themes_evidence_grounded: evidenceGroundedV,
    theme_categories_balanced: categoriesBalancedV,
    cycle_archived: cycleArchivedV,
    retro_three_sections: retroSectionsV,
    brain_gaps_addressed: gapsAddressedV,
  };

  const score =
    WEIGHT_THEMES_EMITTED * themesEmittedV +
    WEIGHT_EVIDENCE_GROUNDED * evidenceGroundedV +
    WEIGHT_CATEGORIES_BALANCED * categoriesBalancedV +
    WEIGHT_CYCLE_ARCHIVED * cycleArchivedV +
    WEIGHT_RETRO_SECTIONS * retroSectionsV +
    WEIGHT_BRAIN_GAPS * gapsAddressedV;

  return {
    score,
    passed: score >= PASS_THRESHOLD,
    criteria,
    themes_found: themeFiles,
    themes_missing_evidence: themeChecks
      .filter((t) => t.resolvedEvidence.length === 0)
      .map((t) => t.path),
    themes_invalid_category: themeChecks
      .filter((t) => !t.category || !VALID_CATEGORIES.has(t.category))
      .map((t) => t.path),
    retro_path: retroPath,
    cycle_archive_path: archiveCheck.ok ? archivePath : null,
    brain_gaps_unaddressed: gapsCheck.unaddressed,
    lint_errors: lintErrors,
  };
}

