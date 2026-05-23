/**
 * Pure scoring functions for the architect benchmark.
 *
 * S2B regrounding (per plan 02 §"Benchmark regrounding", per CONTRACTS.md
 * C10/C10a/C19):
 *
 *   gate: manifest_valid (0 or 1; if 0, total = 0)
 *
 *   project_context_lifted      (0.30)
 *       For sessions with ≥3 proposed initiatives, repeated boilerplate
 *       blocks (≥3 lines, ≥80 chars) appearing verbatim across 3+ manifests
 *       must be lifted into a brain reference. A session with fewer than 3
 *       manifests auto-passes (criterion N/A).
 *
 *   escalations_resolved        (0.25)
 *       Every council-surfaced escalation in PLAN.md ("## Open escalations"
 *       block) has either a `<!-- review: ... -->` comment OR an explicit
 *       defer marker ("Deferred", "Backlog phase 2", etc). If no PLAN.md
 *       is supplied OR PLAN.md has no escalations, criterion auto-passes.
 *
 *   downstream_pm_score         (0.30)
 *       Loads the **frozen** PM-bench rubric (scoring.frozen.ts, per C10a)
 *       and runs it against the bench harness-supplied PM artefacts. If
 *       the bench did not run a downstream PM, this defaults to N/A (1).
 *       The pin to scoring.frozen.ts means PM-bench iteration cannot
 *       perturb architect-bench scores.
 *
 *   specs_concrete_per_feature  (0.10)  — retained, weight halved.
 *   brain_consulted_qualified   (0.05)  — current `brain/` regex + on-disk
 *                                          existsSync check (≥1 cited path
 *                                          must resolve).
 *
 * Per CONTRACTS.md C19, there is **no** `aggregate_budget_declared`
 * criterion. The aggregate-spend footprint is informational only in
 * PLAN.md, never scored.
 *
 * Weights sum to 1.0; pass threshold 0.7 (same as the brain bench / prior
 * architect bench).
 */

import { existsSync, statSync } from 'node:fs';
import { resolve as resolvePath, isAbsolute } from 'node:path';

import { parseManifest, validateManifest, type InitiativeManifest } from '../../orchestrator/manifest.ts';
import {
  caseScore as pmFrozenCaseScore,
  type PmExpected,
  type PmScore,
} from '../project-manager/scoring.frozen.ts';
import type { WorkItem } from '../../orchestrator/work-item.ts';

export type ArchitectExpected = {
  /** Inclusive lower bound on feature count. Default 1. */
  min_features?: number;
  /** Inclusive upper bound on feature count. Default 5. */
  max_features?: number;
};

/**
 * Downstream PM input — the bench harness collects PM artefacts (work items
 * + graph) for the first manifest in a session and hands them in. When
 * absent, downstream_pm_score is N/A (treated as 1.0).
 */
export type DownstreamPmInput = {
  workItems: WorkItem[];
  graphText: string | null;
  expected: PmExpected;
};

export type CaseScoreInput = {
  /** First initiative manifest in the session (always required). */
  manifestText: string;
  /** Other manifests in the same architect session — enables project_context_lifted. */
  siblingManifests?: string[];
  /** PLAN.md text, if the architect emitted one — drives escalations_resolved. */
  planDoc?: string;
  /** Council transcript text — currently informational only; not scored. */
  councilTranscript?: string;
  /** Downstream PM artefacts, if the bench ran the cross-phase round-trip. */
  downstreamPm?: DownstreamPmInput;
  expected: ArchitectExpected;
  /** Forge root for brain-existence check; defaults to repo root. */
  forgeRoot?: string;
};

export type ArchitectCriteria = {
  manifest_valid: number;                  // gate, 0 or 1
  project_context_lifted: number;          // 0 or 1
  escalations_resolved: number;            // 0 or 1
  downstream_pm_score: number;             // 0 to 1 (fractional — passes through PM rubric)
  specs_concrete_per_feature: number;      // 0 or 1
  brain_consulted_qualified: number;       // 0 or 1
};

export type ArchitectScore = {
  score: number;                           // weighted in [0, 1]
  passed: boolean;                         // score >= PASS_THRESHOLD
  criteria: ArchitectCriteria;
  manifest_errors: string[];               // from validateManifest
  feature_count: number;
  /** When downstream PM was run, the full PM score; otherwise null. */
  downstream_pm_detail: PmScore | null;
};

export const PASS_THRESHOLD = 0.7;

// Weights — must sum to 1. Highest weights on the criteria that catch the
// failure modes the S2B reground was motivated by.
export const WEIGHT_CONTEXT_LIFTED = 0.30;
export const WEIGHT_ESCALATIONS = 0.25;
export const WEIGHT_DOWNSTREAM_PM = 0.30;
export const WEIGHT_SPECS = 0.10;
export const WEIGHT_BRAIN = 0.05;

// Boilerplate-detection tuning constants. Blocks shorter than these are
// not signal — they're routine TL;DR-shaped boilerplate that's expected to
// be short and not worth lifting.
const BOILERPLATE_MIN_LINES = 3;
const BOILERPLATE_MIN_CHARS = 80;
const BOILERPLATE_MIN_OCCURRENCES = 3;

/**
 * Parse and validate. Returns the parsed manifest plus validateManifest errors.
 * Throws only on unparseable input; validation errors are returned as data.
 */
export function loadManifestForScoring(
  content: string,
): { manifest: InitiativeManifest | null; errors: string[]; parseError?: string } {
  let manifest: InitiativeManifest;
  try {
    manifest = parseManifest(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { manifest: null, errors: [], parseError: message };
  }
  const errors = validateManifest(manifest);
  return { manifest, errors };
}

/** Feature count within [min, max] inclusive. Retained for informational use. */
export function scopeRightSized(featureCount: number, expected: ArchitectExpected): number {
  const min = expected.min_features ?? 1;
  const max = expected.max_features ?? 5;
  return featureCount >= min && featureCount <= max ? 1 : 0;
}

/**
 * Every feature has acceptance criteria expressed in its body.
 * Same logic as the pre-S2B `specsConcrete` — weight is halved per the plan.
 */
export function specsConcrete(body: string, featureCount: number): number {
  if (featureCount === 0) return 0;
  const triads = countGivenWhenThen(body);
  const headings = countAcceptanceHeadings(body);
  return Math.max(triads, headings) >= featureCount ? 1 : 0;
}

export function countGivenWhenThen(body: string): number {
  const re = /(?:^|[\s\n*\->(])given\b[\s\S]{0,400}?\bwhen\b[\s\S]{0,400}?\bthen\b/gi;
  return (body.match(re) ?? []).length;
}

export function countAcceptanceHeadings(body: string): number {
  const re = /^\s*(?:#{2,6}\s+|\*\*\s*)acceptance(?:\s+criteria)?(?:\s*\*\*)?\s*:?\s*$/gim;
  return (body.match(re) ?? []).length;
}

/**
 * Body cites at least one brain/ path AND that path resolves on disk under
 * `forgeRoot`. Stops the architect from name-checking a path that doesn't
 * exist (an antipattern observed in pre-S2A cycles).
 */
export function brainConsultedQualified(body: string, forgeRoot: string): number {
  // Strip code fences first so commented examples don't count as citations.
  const stripped = body.replace(/```[\s\S]*?```/g, '');
  const paths = stripped.match(/\bbrain\/[\w./-]+\.md\b/gi) ?? [];
  if (paths.length === 0) return 0;
  for (const raw of paths) {
    const rel = raw.replace(/[.,)]+$/, ''); // trim trailing punctuation
    const abs = isAbsolute(rel) ? rel : resolvePath(forgeRoot, rel);
    if (existsSync(abs)) {
      try {
        if (statSync(abs).isFile()) return 1;
      } catch {
        /* fall through */
      }
    }
  }
  return 0;
}

// --------------------- boilerplate detection ---------------------

export type BoilerplateBlock = {
  hash: string;
  preview: string;          // first ~80 chars of the block, for diagnostics
  occurrences: number;
};

/**
 * Find blocks (delimited by `## ` H2 headings) that appear verbatim across
 * `BOILERPLATE_MIN_OCCURRENCES` or more manifest bodies. Normalisation:
 *   - lowercase
 *   - collapse runs of whitespace to single spaces
 *   - drop trailing/leading whitespace
 *   - strip path-like tokens (so the "go test ./azuredevops/internal/..."
 *     difference between INIT-01 and INIT-03 doesn't defeat detection)
 *
 * Returns a list of {hash, preview, occurrences} for every block over the
 * threshold. Returns [] when the input is too small to even apply (< 3 manifests).
 */
export function detectBoilerplateBlocks(manifestBodies: string[]): BoilerplateBlock[] {
  if (manifestBodies.length < BOILERPLATE_MIN_OCCURRENCES) return [];

  const blockCounts = new Map<string, { count: number; preview: string }>();
  // For each manifest, count each unique block exactly once (a block
  // appearing twice within one manifest still counts as occurrence=1 for
  // that manifest — we care about cross-manifest duplication).
  for (const body of manifestBodies) {
    const blocks = splitIntoBlocks(extractMarkdownBody(body));
    const seenInThis = new Set<string>();
    for (const block of blocks) {
      if (!isBoilerplateSized(block)) continue;
      const hash = normaliseBlock(block);
      if (seenInThis.has(hash)) continue;
      seenInThis.add(hash);
      const existing = blockCounts.get(hash);
      if (existing) {
        existing.count += 1;
      } else {
        blockCounts.set(hash, { count: 1, preview: block.slice(0, 80).replace(/\s+/g, ' ').trim() });
      }
    }
  }

  const out: BoilerplateBlock[] = [];
  for (const [hash, { count, preview }] of blockCounts.entries()) {
    if (count >= BOILERPLATE_MIN_OCCURRENCES) {
      out.push({ hash, preview, occurrences: count });
    }
  }
  return out;
}

function extractMarkdownBody(manifestText: string): string {
  // If there's frontmatter, drop it. Otherwise treat the whole text as body.
  const m = manifestText.match(/^---[\s\S]*?\n---\n([\s\S]*)$/);
  return m ? m[1]! : manifestText;
}

function splitIntoBlocks(body: string): string[] {
  // Split on H2 headings. Keep the heading with its block (it's part of the
  // block's signal — e.g. "## Council constraints").
  const lines = body.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (current.length > 0) blocks.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  return blocks.map((b) => b.trim()).filter((b) => b.length > 0);
}

function isBoilerplateSized(block: string): boolean {
  const nonEmptyLines = block.split(/\r?\n/).filter((l) => l.trim() !== '').length;
  return nonEmptyLines >= BOILERPLATE_MIN_LINES && block.length >= BOILERPLATE_MIN_CHARS;
}

function normaliseBlock(block: string): string {
  return block
    .toLowerCase()
    .replace(/`[^`]*`/g, ' ')                 // strip inline code (handles `go test ./...` paths)
    .replace(/\b[\w./-]*\/[\w./-]+\b/g, ' ')  // strip slash-bearing path-like tokens
    .replace(/\s+/g, ' ')
    .trim();
}

// --------------------- project_context_lifted ---------------------

/**
 * `manifestTexts` is the full list of manifests in the architect session
 * (NOT just the one being scored — the criterion is session-level). When
 * the session has ≥3 manifests AND ≥1 boilerplate block is detected AND
 * PLAN.md does not lift the duplication via a brain reference, the criterion
 * fails.
 */
export function projectContextLifted(manifestTexts: string[], planDoc: string): number {
  if (manifestTexts.length < BOILERPLATE_MIN_OCCURRENCES) {
    // Criterion not applicable — narrow sessions auto-pass.
    return 1;
  }
  const duplicates = detectBoilerplateBlocks(manifestTexts);
  if (duplicates.length === 0) return 1;

  // Lifted = PLAN.md references at least one brain path AND the manifests
  // themselves are no longer copy-pasting the boilerplate (which is the
  // signal we just measured). If duplicates exist AND PLAN.md cites a brain
  // path for shared context, we treat the duplication as a known cost and
  // pass. Otherwise fail.
  //
  // (Stricter alternative: require the boilerplate to be ABSENT from the
  // manifests entirely. Rejected — refined manifests may still carry a
  // short callback to the brain doc; we measure intent via PLAN.md.)
  if (planDocReferencesBrain(planDoc)) {
    return 1;
  }
  return 0;
}

function planDocReferencesBrain(planDoc: string): boolean {
  if (!planDoc) return false;
  return /\bbrain\/[\w./-]+\.md\b/i.test(planDoc);
}

// --------------------- escalations_resolved ---------------------

/**
 * Locate the "Open escalations" section in PLAN.md. Every escalation line
 * (top-level list item, dash- or bullet-prefixed under that section) must
 * have either a `<!-- review: -->` HTML-comment or an explicit defer marker
 * within its block.
 *
 * Returns 1 if every escalation is resolved, or there are no escalations
 * to resolve, or PLAN.md is undefined (criterion N/A). Returns 0 only on a
 * concrete silent-drop.
 */
export function escalationsResolved(planDoc: string | undefined): number {
  if (planDoc === undefined) return 1;

  const section = extractEscalationsSection(planDoc);
  if (section === null) return 1; // no escalations heading → N/A → pass

  const escalations = parseEscalationItems(section);
  if (escalations.length === 0) return 1;

  for (const esc of escalations) {
    if (!isEscalationResolved(esc)) return 0;
  }
  return 1;
}

function extractEscalationsSection(planDoc: string): string | null {
  const re = /^##\s+(open\s+escalations|escalations)\s*$/im;
  const m = planDoc.match(re);
  if (!m) return null;
  const start = m.index! + m[0].length;
  // End at next H2, or end of doc.
  const rest = planDoc.slice(start);
  const nextH2 = rest.match(/^##\s+/m);
  return nextH2 ? rest.slice(0, nextH2.index!) : rest;
}

/**
 * Parse the escalations section into individual items, grouped by their
 * top-level list bullet. Each item's text includes any indented sub-lines
 * (continuation lines, resolution comments).
 */
function parseEscalationItems(section: string): string[] {
  const lines = section.split(/\r?\n/);
  const items: string[] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    if (/^\s*-\s+/.test(line)) {
      // Start of a new bullet at indent 0 (or close to it).
      const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (indent === 0) {
        if (current !== null) items.push(current.join('\n'));
        current = [line];
        continue;
      }
    }
    if (current !== null) current.push(line);
  }
  if (current !== null) items.push(current.join('\n'));

  // Filter out filler ("_None — ..._" style placeholders).
  return items.filter((it) => !/^[\s\-_]*\bnone\b/i.test(it));
}

function isEscalationResolved(item: string): boolean {
  if (/<!--\s*review\s*:/i.test(item)) return true;
  if (/\bdeferred?\b/i.test(item)) return true;
  if (/\bbacklog\s+phase\b/i.test(item)) return true;
  return false;
}

// --------------------- downstream_pm_score ---------------------

/**
 * Pass-through to the FROZEN PM-bench rubric. The frozen pin is in
 * scoring.frozen.ts (per CONTRACTS.md C10a). When the bench harness did
 * not run a downstream PM (no input supplied), the criterion is N/A and
 * scored as 1.0.
 */
export function downstreamPmScore(input: DownstreamPmInput | undefined): { score: number; detail: PmScore | null } {
  if (input === undefined) {
    return { score: 1, detail: null };
  }
  const detail = pmFrozenCaseScore({
    workItems: input.workItems,
    graphText: input.graphText,
    expected: input.expected,
  });
  // We propagate the PM's fractional score, not its 0/1 pass.
  return { score: detail.score, detail };
}

// --------------------- caseScore (integration) ---------------------

export function caseScore(input: CaseScoreInput): ArchitectScore {
  const forgeRoot = input.forgeRoot ?? resolvePath(import.meta.dirname, '..', '..');

  const { manifest, errors, parseError } = loadManifestForScoring(input.manifestText);

  if (parseError !== undefined || manifest === null) {
    return {
      score: 0,
      passed: false,
      criteria: {
        manifest_valid: 0,
        project_context_lifted: 0,
        escalations_resolved: 0,
        downstream_pm_score: 0,
        specs_concrete_per_feature: 0,
        brain_consulted_qualified: 0,
      },
      manifest_errors: parseError !== undefined ? [parseError] : ['parseManifest returned null'],
      feature_count: 0,
      downstream_pm_detail: null,
    };
  }

  const manifest_valid = errors.length === 0 ? 1 : 0;
  const featureCount = manifest.features.length;

  // Gate: invalid manifest → score 0 regardless of other dimensions.
  if (manifest_valid === 0) {
    return {
      score: 0,
      passed: false,
      criteria: {
        manifest_valid: 0,
        project_context_lifted: 0,
        escalations_resolved: 0,
        downstream_pm_score: 0,
        specs_concrete_per_feature: 0,
        brain_consulted_qualified: 0,
      },
      manifest_errors: errors,
      feature_count: featureCount,
      downstream_pm_detail: null,
    };
  }

  const siblings = input.siblingManifests ?? [];
  const sessionManifests = [input.manifestText, ...siblings];

  const specs = specsConcrete(manifest.body, featureCount);
  const brain = brainConsultedQualified(manifest.body, forgeRoot);
  const contextLifted = projectContextLifted(sessionManifests, input.planDoc ?? '');
  const escalations = escalationsResolved(input.planDoc);
  const { score: pmScore, detail: pmDetail } = downstreamPmScore(input.downstreamPm);

  const criteria: ArchitectCriteria = {
    manifest_valid: 1,
    project_context_lifted: contextLifted,
    escalations_resolved: escalations,
    downstream_pm_score: pmScore,
    specs_concrete_per_feature: specs,
    brain_consulted_qualified: brain,
  };

  const score =
    WEIGHT_CONTEXT_LIFTED * criteria.project_context_lifted +
    WEIGHT_ESCALATIONS * criteria.escalations_resolved +
    WEIGHT_DOWNSTREAM_PM * criteria.downstream_pm_score +
    WEIGHT_SPECS * criteria.specs_concrete_per_feature +
    WEIGHT_BRAIN * criteria.brain_consulted_qualified;

  return {
    score,
    passed: score >= PASS_THRESHOLD,
    criteria,
    manifest_errors: errors,
    feature_count: featureCount,
    downstream_pm_detail: pmDetail,
  };
}
