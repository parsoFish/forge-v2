/**
 * Pure scoring functions for the review-loop (stage 1 — review-prep) benchmark.
 * Kept separate from score.ts (the runner) so they are trivially unit-testable
 * without mocking the SDK or shelling out to recorders.
 *
 * Mirrors the established phase-bench shape:
 *   - **Two gates** that drop score = 0 if violated:
 *       1. `quality_gates_pass` — orchestrator-verified, never trust the agent's claim.
 *       2. `pr_only_when_green` — agent wrote pr-description.md but gates were red.
 *   - Seven weighted criteria summing to 1.0.
 *   - PASS_THRESHOLD = 0.7 (matches every other phase bench).
 *
 * Why these dimensions and weights:
 *
 *   gate: quality_gates_pass
 *       The reviewer's first job is to verify the developer-loop's output is
 *       functional. If gates are red, no demo or PR draft is meaningful.
 *
 *   gate: pr_only_when_green
 *       Structurally prevents "report green when not green" — the agent cannot
 *       satisfy any other criterion by drafting a PR against a broken branch.
 *
 *   demo_recording_present (0.15)
 *       Binary check: file exists, magic bytes valid for mp4/webm/gif/zip,
 *       size > floor. Necessary but not sufficient — the AC keyword check
 *       handles the "5-second black canvas" cheat.
 *
 *   demo_exercises_acceptance_criteria (0.20)
 *       Heuristic keyword presence: each WI's `then`-clause keywords appear
 *       in the demo source script. Same shape as PM's `no_hidden_coupling`
 *       check — keyword presence, not proof. The load-bearing addition the
 *       plan agent flagged.
 *
 *   pr_description_why_not_what (0.20)
 *       Has `## Why` / `## What` / `## How` / `## Demo` sections. Why ≥ 50 chars.
 *       The diff shows what; the description must explain why.
 *
 *   pr_description_length_floor (0.10)
 *       Total body > 300 chars. Catches the laziest failure mode (3-line PR).
 *
 *   pr_links_demo (0.10)
 *       PR body contains a markdown link resolving to a path under
 *       `.forge/demos/<initiative-id>/`. The Demo section without a link is
 *       a missed handoff.
 *
 *   merge_strategy_respected (≈0.167, was 0.15 pre-redistribution)
 *       If `Parents:` block present in body, the agent's `gh pr create`
 *       command (captured by the bench, not actually executed) does NOT
 *       include `--squash`. Defends the squash-merge-stacked-prs antipattern.
 *
 *   (Phase 4.2) The former `brain_consulted` criterion (0.10) was removed:
 *   per F-41 / theme `brain-read-policy` the reviewer no longer reads the
 *   brain by design, so scoring it was a false-red. Its weight was
 *   redistributed proportionally across the six surviving criteria (see the
 *   WEIGHT_* block below); each weight = its raw pre-redistribution value
 *   divided by 0.90, so the rubric still sums to 1.0.
 *
 * What this rubric does NOT catch (acknowledged limitation; human-review
 * stage covers these):
 *   - Hallucinated demo content (video looks plausible but doesn't actually
 *     exercise the WI). Keyword presence is a heuristic.
 *   - PR description with correct sections but lying about the diff.
 *   - Demo recorded against a stale build of the worktree.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import type { WorkItem } from '../../orchestrator/work-item.ts';

export type ReviewerExpected = {
  /** Project type — informs which recording-tool the agent should use. */
  project_type: 'browser' | 'cli' | 'lib' | 'rest';
  /** Argv-style command run by the bench to verify quality gates post-agent. */
  quality_gate_cmd: string[];
  /** Whether the fixture is set up as a stacked PR (parents present). */
  is_stacked_pr: boolean;
  /** Min recording file size in bytes (50 KB default — anything smaller is suspicious). */
  min_recording_bytes?: number;
  /** Min PR body length in chars (300 default). */
  min_pr_body_chars?: number;
  /** Min `## Why` section length in chars (50 default). */
  min_why_chars?: number;
};

export type ReviewerCriteria = {
  // Gates
  quality_gates_pass: 0 | 1;
  pr_only_when_green: 0 | 1;
  // Weighted
  demo_recording_present: 0 | 1;
  demo_exercises_acceptance_criteria: 0 | 1;
  pr_description_why_not_what: 0 | 1;
  pr_description_length_floor: 0 | 1;
  pr_links_demo: 0 | 1;
  merge_strategy_respected: 0 | 1;
};

export type ReviewerScore = {
  score: number;
  passed: boolean;
  criteria: ReviewerCriteria;
  // Diagnostic fields
  pr_body_chars: number;
  why_chars: number;
  demo_recording_path: string | null;
  demo_recording_bytes: number;
  demo_source_path: string | null;
  ac_keywords_missing: string[];
  pr_description_present: boolean;
};

export const PASS_THRESHOLD = 0.7;

// Weights — must sum to 1.
//
// Phase 4.2 (drift correction): the `brain_consulted` criterion (formerly
// WEIGHT_BRAIN = 0.10) was REMOVED. Per F-41 / theme `brain-read-policy`, the
// reviewer no longer reads the brain by design — its job is verify +
// write-PR anchored on the git log / diff / spec already in the worktree, and
// the brain-first runtime gate was stripped from the live review-loop
// (reviewer.ts F-41c). Keeping the criterion was a HIGH false-red: a *correct*
// reviewer scored 0 on it and lost 0.10, which could flip pass→fail at the
// 0.7 gate.
//
// The freed 0.10 is redistributed **proportionally** across the six
// surviving criteria so the rubric still sums to 1.0 and each criterion keeps
// its relative importance. The proportional factor is exactly 1 / 0.90 (the
// pre-redistribution surviving total): each weight = its raw
// pre-redistribution value / 0.90.
//
// Naively assigning all six as `raw / 0.90` makes them sum to
// 1.0000000000000002 in IEEE-754 (repeating-decimal rounding), which would
// trip the exact-equality happy-path assertion. So five weights are the
// division and the sixth (MERGE_STRATEGY) is the **exact float complement**
// `1 - (sum of the other five)` — the proportional intent is preserved (the
// residual it absorbs is < 1e-16, far below any scoring threshold) and the
// six sum to exactly 1.0.
const RAW_DEMO_RECORDING = 0.15;
const RAW_DEMO_EXERCISES_ACS = 0.2;
const RAW_PR_WHY_NOT_WHAT = 0.2;
const RAW_PR_LENGTH_FLOOR = 0.1;
const RAW_PR_LINKS_DEMO = 0.1;
const RAW_SURVIVING_SUM = 0.9; // 0.15+0.20+0.20+0.10+0.10+0.15 (pre-redistribution)

// Proportional redistribution: each weight = raw / 0.90. Resulting nominal
// shares — DEMO_RECORDING 1/6 (≈0.1667), DEMO_EXERCISES_ACS 2/9 (≈0.2222),
// PR_WHY_NOT_WHAT 2/9 (≈0.2222), PR_LENGTH_FLOOR 1/9 (≈0.1111),
// PR_LINKS_DEMO 1/9 (≈0.1111), MERGE_STRATEGY 1/6 (≈0.1667) — sum = 1.0.
export const WEIGHT_DEMO_RECORDING = RAW_DEMO_RECORDING / RAW_SURVIVING_SUM;
export const WEIGHT_DEMO_EXERCISES_ACS = RAW_DEMO_EXERCISES_ACS / RAW_SURVIVING_SUM;
export const WEIGHT_PR_WHY_NOT_WHAT = RAW_PR_WHY_NOT_WHAT / RAW_SURVIVING_SUM;
export const WEIGHT_PR_LENGTH_FLOOR = RAW_PR_LENGTH_FLOOR / RAW_SURVIVING_SUM;
export const WEIGHT_PR_LINKS_DEMO = RAW_PR_LINKS_DEMO / RAW_SURVIVING_SUM;
// Exact float complement → the six weights sum to exactly 1.0 (no drift).
export const WEIGHT_MERGE_STRATEGY =
  1 -
  (WEIGHT_DEMO_RECORDING +
    WEIGHT_DEMO_EXERCISES_ACS +
    WEIGHT_PR_WHY_NOT_WHAT +
    WEIGHT_PR_LENGTH_FLOOR +
    WEIGHT_PR_LINKS_DEMO);

// Defaults
const DEFAULT_MIN_RECORDING_BYTES = 50 * 1024; // 50 KB
const DEFAULT_MIN_PR_BODY_CHARS = 300;
const DEFAULT_MIN_WHY_CHARS = 50;

const RECORDING_EXTENSIONS = ['mp4', 'webm', 'gif', 'trace.zip'] as const;
const SOURCE_EXTENSIONS = ['tape', 'spec.ts'] as const;

/** Recognised magic bytes for the supported recording containers. */
function looksLikeRecording(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  let buf: Buffer;
  try {
    const fd = readFileSync(filePath);
    buf = fd.subarray(0, 16);
  } catch {
    return false;
  }
  if (buf.length < 4) return false;
  // mp4 / m4v: bytes 4..7 = 'ftyp'
  if (buf.length >= 8 && buf.subarray(4, 8).toString('ascii') === 'ftyp') return true;
  // webm: starts with 0x1A 0x45 0xDF 0xA3 (EBML)
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true;
  // gif: starts with "GIF8"
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return true;
  // zip (Playwright trace.zip): starts with PK\x03\x04
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return true;
  return false;
}

/**
 * Find the first existing recording file in the demo bundle directory.
 * Tries every supported extension, returns the path + size, or null/0 if none.
 */
export function findRecording(demoDir: string): { path: string; bytes: number } | null {
  if (!existsSync(demoDir)) return null;
  for (const ext of RECORDING_EXTENSIONS) {
    const candidate = resolve(demoDir, `recording.${ext}`);
    if (existsSync(candidate)) {
      const bytes = statSync(candidate).size;
      return { path: candidate, bytes };
    }
  }
  return null;
}

/** Find the first existing demo source file in the bundle directory. */
export function findDemoSource(demoDir: string): string | null {
  if (!existsSync(demoDir)) return null;
  for (const ext of SOURCE_EXTENSIONS) {
    const candidate = resolve(demoDir, `source.${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function demoRecordingPresent(
  demoDir: string,
  minBytes: number = DEFAULT_MIN_RECORDING_BYTES,
): { value: 0 | 1; path: string | null; bytes: number } {
  const found = findRecording(demoDir);
  if (!found) return { value: 0, path: null, bytes: 0 };
  if (found.bytes < minBytes) return { value: 0, path: found.path, bytes: found.bytes };
  if (!looksLikeRecording(found.path)) return { value: 0, path: found.path, bytes: found.bytes };
  return { value: 1, path: found.path, bytes: found.bytes };
}

/**
 * Tokenise a `then`-clause into keywords. Strips short common stopwords and
 * non-alphanumerics; keeps anything ≥ 4 chars. Lowercase comparison.
 */
const STOPWORDS = new Set([
  'that', 'with', 'this', 'from', 'when', 'then', 'into', 'over', 'than', 'each',
  'have', 'will', 'been', 'were', 'they', 'them', 'their', 'these', 'those',
  'must', 'should', 'value', 'after', 'before', 'while', 'which', 'where',
  'returns', 'return', 'output', 'input', 'because',
]);

export function extractKeywords(thenClause: string): string[] {
  return thenClause
    .toLowerCase()
    .replace(/[^a-z0-9_\-]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

export function demoExercisesAcceptanceCriteria(
  demoSourcePath: string | null,
  workItems: WorkItem[],
): { value: 0 | 1; missing: string[] } {
  if (!demoSourcePath || !existsSync(demoSourcePath)) {
    return { value: 0, missing: ['<no source file>'] };
  }
  const sourceBlob = readFileSync(demoSourcePath, 'utf8').toLowerCase();

  // For each work item, check whether AT LEAST ONE then-clause keyword appears
  // in the source. We use OR-within-AC and AND-across-WIs: every WI must have
  // some textual evidence in the demo, but we don't require every keyword.
  const missing: string[] = [];
  for (const wi of workItems) {
    let evidenceFound = false;
    for (const ac of wi.acceptance_criteria) {
      const keywords = extractKeywords(ac.then);
      if (keywords.length === 0) {
        // AC has no scoreable keywords — skip (don't penalise).
        evidenceFound = true;
        break;
      }
      if (keywords.some((kw) => sourceBlob.includes(kw))) {
        evidenceFound = true;
        break;
      }
    }
    if (!evidenceFound) missing.push(wi.work_item_id);
  }
  return { value: missing.length === 0 ? 1 : 0, missing };
}

const REQUIRED_PR_SECTIONS = ['## Why', '## What', '## How', '## Demo'] as const;

export function prDescriptionWhyNotWhat(
  prBody: string,
  minWhyChars: number = DEFAULT_MIN_WHY_CHARS,
): { value: 0 | 1; whyChars: number } {
  for (const section of REQUIRED_PR_SECTIONS) {
    if (!prBody.includes(section)) return { value: 0, whyChars: 0 };
  }
  // Extract the Why section content (between ## Why and the next ## heading).
  const whyMatch = prBody.match(/##\s+Why\s*\n([\s\S]*?)(?:\n##\s+|$)/);
  const whyText = whyMatch ? whyMatch[1].trim() : '';
  if (whyText.length < minWhyChars) return { value: 0, whyChars: whyText.length };
  return { value: 1, whyChars: whyText.length };
}

export function prDescriptionLengthFloor(
  prBody: string,
  minChars: number = DEFAULT_MIN_PR_BODY_CHARS,
): 0 | 1 {
  return prBody.length >= minChars ? 1 : 0;
}

export function prLinksDemo(prBody: string, initiativeId: string): 0 | 1 {
  // Match any markdown link whose target contains `.forge/demos/<initiative-id>`.
  const linkRegex = /\[[^\]]+\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(prBody)) !== null) {
    const target = match[1];
    if (target.includes(`.forge/demos/${initiativeId}`) || target.includes(`.forge/demos/${initiativeId}/`)) {
      return 1;
    }
  }
  return 0;
}

/**
 * Stacked-PR squash detection. If the body contains a `Parents:` block, the
 * merge command must NOT include `--squash`. The bench captures the agent's
 * intended merge strategy from the body (or absence of squash-marker), since
 * the agent never actually invokes `gh pr create` in bench mode.
 *
 * Convention: if the body explicitly says `Merge strategy: squash` while
 * `Parents:` is present, that's the violation. Absent any merge-strategy
 * marker, default is safe (no squash → criterion = 1).
 */
export function mergeStrategyRespected(prBody: string): 0 | 1 {
  const hasParents = /\n\s*Parents:\s*\n|^\s*Parents:\s*\n/m.test(prBody);
  if (!hasParents) return 1; // not a stacked PR → no constraint
  // Agent declares squash explicitly → violation.
  if (/Merge\s+strategy:\s*squash/i.test(prBody)) return 0;
  if (/```[^\n]*\n[^`]*--squash[^`]*```/.test(prBody)) return 0;
  if (/`gh\s+pr\s+merge[^`]*--squash[^`]*`/.test(prBody)) return 0;
  return 1;
}

// Phase 4.2 (drift correction): `brainConsulted()` was removed. The reviewer
// no longer reads the brain by design (F-41 / theme `brain-read-policy`), so
// scoring "≥ 1 brain read" was a false-red. Tool-use telemetry is still
// captured by the runner (score.ts surfaces it in CaseResult.tool_use for
// observability) — it is just no longer a scored criterion.

export type CaseScoreInput = {
  /** Path to the worktree (where pr-description.md and demos/ live). */
  worktreePath: string;
  /** Initiative ID — used to find the demo bundle and the PR-link target. */
  initiativeId: string;
  /** Completed work items the agent reviewed. AC keywords come from these. */
  workItems: WorkItem[];
  expected: ReviewerExpected;
  /** Did the orchestrator-verified quality-gate command pass post-agent? */
  qualityGatesPassed: boolean;
};

export function caseScore(input: CaseScoreInput): ReviewerScore {
  const { worktreePath, initiativeId, workItems, expected, qualityGatesPassed } = input;

  const prDescriptionPath = resolve(worktreePath, '.forge', 'pr-description.md');
  const prDescriptionPresent = existsSync(prDescriptionPath);
  const prBody = prDescriptionPresent ? readFileSync(prDescriptionPath, 'utf8') : '';

  const demoDir = resolve(worktreePath, '.forge', 'demos', initiativeId);

  // Gate 1: quality_gates_pass
  if (!qualityGatesPassed) {
    return zeroScore({
      quality_gates_pass: 0,
      pr_only_when_green: prDescriptionPresent ? 0 : 1,
      pr_body_chars: prBody.length,
      pr_description_present: prDescriptionPresent,
      demo_recording_path: findRecording(demoDir)?.path ?? null,
      demo_recording_bytes: findRecording(demoDir)?.bytes ?? 0,
      demo_source_path: findDemoSource(demoDir),
      ac_keywords_missing: [],
    });
  }

  // Gate 2: pr_only_when_green — gates passed AND pr-description present is fine.
  // pr_only_when_green = 0 ONLY when gates failed but pr-description was written.
  // Since we're past gate 1 here, gates passed → pr_only_when_green is satisfied.
  const prOnlyWhenGreen: 0 | 1 = 1;

  // If gates pass but no PR description was emitted, the run is effectively a
  // failed review-prep. Score 0 across the rubric.
  if (!prDescriptionPresent) {
    return zeroScore({
      quality_gates_pass: 1,
      pr_only_when_green: 1,
      pr_body_chars: 0,
      pr_description_present: false,
      demo_recording_path: findRecording(demoDir)?.path ?? null,
      demo_recording_bytes: findRecording(demoDir)?.bytes ?? 0,
      demo_source_path: findDemoSource(demoDir),
      ac_keywords_missing: [],
    });
  }

  const recording = demoRecordingPresent(demoDir, expected.min_recording_bytes);
  const demoSource = findDemoSource(demoDir);
  const acExercise = demoExercisesAcceptanceCriteria(demoSource, workItems);
  const whyCheck = prDescriptionWhyNotWhat(prBody, expected.min_why_chars);
  const lengthOk = prDescriptionLengthFloor(prBody, expected.min_pr_body_chars);
  const linkOk = prLinksDemo(prBody, initiativeId);
  const mergeOk = mergeStrategyRespected(prBody);

  const criteria: ReviewerCriteria = {
    quality_gates_pass: 1,
    pr_only_when_green: prOnlyWhenGreen,
    demo_recording_present: recording.value,
    demo_exercises_acceptance_criteria: acExercise.value,
    pr_description_why_not_what: whyCheck.value,
    pr_description_length_floor: lengthOk,
    pr_links_demo: linkOk,
    merge_strategy_respected: mergeOk,
  };

  const score =
    WEIGHT_DEMO_RECORDING * criteria.demo_recording_present +
    WEIGHT_DEMO_EXERCISES_ACS * criteria.demo_exercises_acceptance_criteria +
    WEIGHT_PR_WHY_NOT_WHAT * criteria.pr_description_why_not_what +
    WEIGHT_PR_LENGTH_FLOOR * criteria.pr_description_length_floor +
    WEIGHT_PR_LINKS_DEMO * criteria.pr_links_demo +
    WEIGHT_MERGE_STRATEGY * criteria.merge_strategy_respected;

  return {
    score,
    passed: score >= PASS_THRESHOLD,
    criteria,
    pr_body_chars: prBody.length,
    why_chars: whyCheck.whyChars,
    demo_recording_path: recording.path,
    demo_recording_bytes: recording.bytes,
    demo_source_path: demoSource,
    ac_keywords_missing: acExercise.missing,
    pr_description_present: true,
  };
}

function zeroScore(diag: {
  quality_gates_pass: 0 | 1;
  pr_only_when_green: 0 | 1;
  pr_body_chars: number;
  pr_description_present: boolean;
  demo_recording_path: string | null;
  demo_recording_bytes: number;
  demo_source_path: string | null;
  ac_keywords_missing: string[];
}): ReviewerScore {
  return {
    score: 0,
    passed: false,
    criteria: {
      quality_gates_pass: diag.quality_gates_pass,
      pr_only_when_green: diag.pr_only_when_green,
      demo_recording_present: 0,
      demo_exercises_acceptance_criteria: 0,
      pr_description_why_not_what: 0,
      pr_description_length_floor: 0,
      pr_links_demo: 0,
      merge_strategy_respected: 0,
    },
    pr_body_chars: diag.pr_body_chars,
    why_chars: 0,
    demo_recording_path: diag.demo_recording_path,
    demo_recording_bytes: diag.demo_recording_bytes,
    demo_source_path: diag.demo_source_path,
    ac_keywords_missing: diag.ac_keywords_missing,
    pr_description_present: diag.pr_description_present,
  };
}
