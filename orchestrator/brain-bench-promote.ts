/**
 * `forge brain bench:promote --cycle <id>` — operator-gated promotion of
 * reflector-emitted bench-growth candidates into
 * `benchmarks/brain/questions.json`.
 *
 * Source: `_logs/<cycle-id>/brain-bench-candidates.jsonl`. Each line:
 *   {question, expected_sources, why_now, gap_id?, expected_keywords?}
 *
 * Flow (`runPromote`):
 *   1. Read candidates + snapshot the current questions.json (raw bytes).
 *   2. Enforce caps BEFORE prompting the operator:
 *      - per-cycle: ≤1 existing row with `source_cycle === <cycle-id>`.
 *      - monthly:   ≤4 existing rows whose `source_cycle` falls in the
 *                   current calendar month (manual-seed-* exempt).
 *   3. Walk each candidate. Prompt the operator: keep / drop (default) /
 *      edit. `edit` lets the operator override question text and
 *      expected_sources/keywords; the resulting row inherits the cycle's
 *      `source_cycle`.
 *   4. Append kept rows with sequential ids (`Q<n>`); write back.
 *   5. Run the bench-accuracy gate (injectable). If the accuracy is
 *      below 0.944 (CLAUDE.md published bar), revert: write the snapshot
 *      back byte-for-byte, return `{kind: 'reverted'}`.
 *
 * Why a separate, testable function: the CLI surface (cli.ts) just wires
 * argv → flags → runPromote → exit code. The interesting logic (caps,
 * snapshot+revert, sequencing) is pure and unit-tested in isolation.
 *
 * Operator UX:
 *   - Interactive: `readline` on process.stdin/stdout. No new deps.
 *   - Non-interactive (CI/test): inject a `promptOperator` returning the
 *     decision sequence.
 *
 * Per `feedback_destructive_instruction_preserve_intent`: nothing lands
 * silently — every candidate is operator-confirmed.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * One row written by the reflector to
 * `_logs/<cycle-id>/brain-bench-candidates.jsonl`. The operator can edit
 * any of these at promotion time.
 */
export type PromoteCandidate = {
  question: string;
  expected_sources: string[];
  /** Optional keyword bag; empty/absent ⇒ derive from question at promote time. */
  expected_keywords?: string[];
  /** Free text — why the reflector thinks this question is worth promoting. */
  why_now: string;
  /** Provenance link back to the gap row in brain-gaps.jsonl. */
  gap_id?: string;
  /** Optional scope hint (project name). */
  scope?: string | null;
};

/** A single operator choice on a candidate. */
export type PromoteDecision =
  | { action: 'keep' }
  | { action: 'drop' }
  | { action: 'edit'; edited: PromoteCandidate };

/** Operator surface — pure function so tests can stub deterministically. */
export type PromptOperator = (input: {
  candidate: PromoteCandidate;
  index: number;
  total: number;
}) => Promise<PromoteDecision>;

/**
 * Bench-accuracy gate. In production this reads the latest
 * `benchmarks/brain/results/*.json` (the most recent run's
 * `summary.accuracy`); in tests, stubbed. We deliberately do NOT shell
 * out to `npm run bench:brain` inside the promote CLI — that's ~$0.50+
 * per run; the operator runs it explicitly when prompted.
 */
export type RunBenchAccuracy = () => Promise<number>;

export type PromoteDeps = {
  promptOperator: PromptOperator;
  runBenchAccuracy: RunBenchAccuracy;
  /** Used to compute the "current month" for the monthly cap. Stubbed in tests. */
  nowIso: () => string;
};

export type RunPromoteInput = {
  cycleId: string;
  candidatesPath: string;
  questionsPath: string;
  deps: PromoteDeps;
};

export type RunPromoteResult =
  | { kind: 'ok'; promoted: number; ids: string[] }
  | { kind: 'cap-exceeded'; cap: 'per-cycle' | 'monthly'; reason: string }
  | { kind: 'reverted'; accuracy: number; floor: number; reason: string };

const ACCURACY_FLOOR = 0.944;
const PER_CYCLE_CAP = 1;
const MONTHLY_CAP = 4;

type QuestionRow = {
  id: string;
  question: string;
  expected_sources: string[];
  expected_keywords: string[];
  scope?: string | null;
  category?: string | null;
  source_cycle?: string | null;
};

/** Parse the JSONL candidates file. Missing → []. Malformed lines skipped. */
export function readCandidates(path: string): PromoteCandidate[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: PromoteCandidate[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as PromoteCandidate;
      if (typeof parsed.question === 'string' && Array.isArray(parsed.expected_sources)) {
        out.push(parsed);
      }
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/** Read questions.json. Throws on parse failure (caller decides). */
function readQuestions(path: string): QuestionRow[] {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`questions.json is not an array`);
  return parsed as QuestionRow[];
}

/**
 * Compute next sequential id `Q<n>`. We scan existing ids for the largest
 * `Q\d+` and add one. If none match, start at Q1.
 */
function nextId(rows: QuestionRow[]): string {
  let max = 0;
  for (const r of rows) {
    const m = /^Q(\d+)$/.exec(r.id ?? '');
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `Q${max + 1}`;
}

/** Extract the year-month prefix (`YYYY-MM`) from an ISO-8601 string. */
function yearMonth(iso: string): string {
  return iso.slice(0, 7);
}

/**
 * Count rows in this cycle / this month for cap enforcement. manual-seed-*
 * rows are exempt from the monthly cap (operator bootstrap, not the
 * candidate-flow we're throttling).
 */
function countByCycle(rows: QuestionRow[], cycleId: string): number {
  return rows.filter((r) => r.source_cycle === cycleId).length;
}

function countByMonth(rows: QuestionRow[], ym: string): number {
  return rows.filter((r) => {
    const sc = r.source_cycle;
    if (!sc) return false;
    if (sc.startsWith('manual-seed-')) return false;
    // Cycle ids are typically ISO-prefixed (`2026-05-23T...`); start of
    // the string is the date. If it doesn't look like a date, treat as
    // un-monthed (won't count toward the cap).
    return yearMonth(sc) === ym;
  }).length;
}

/**
 * Derive keywords from question text when the candidate didn't supply
 * any. Best-effort: lowercase, split on non-word, drop short stopwords,
 * dedupe, take ≤6.
 */
function deriveKeywords(question: string): string[] {
  const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
    'be', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'as', 'by',
    'what', 'when', 'where', 'why', 'how', 'does', 'do', 'did', 'this',
    'that', 'these', 'those', 'it', 'its', 'from', 'has', 'have', 'had',
    'one', 'two', 'into', 'between', 'about', 'over', 'under', 'than',
  ]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of question.toLowerCase().split(/[^a-z0-9_-]+/)) {
    if (!raw) continue;
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Promote candidates per the operator's per-row decisions, gated by caps
 * + accuracy floor. See module doc for flow.
 */
export async function runPromote(input: RunPromoteInput): Promise<RunPromoteResult> {
  const { cycleId, candidatesPath, questionsPath, deps } = input;

  const candidates = readCandidates(candidatesPath);
  // Snapshot for revert. Read once; never trust an in-memory rewrite.
  const snapshot = readFileSync(questionsPath);
  const existing = readQuestions(questionsPath);

  // ---- caps (pre-prompt) ---------------------------------------------------
  if (countByCycle(existing, cycleId) >= PER_CYCLE_CAP) {
    return {
      kind: 'cap-exceeded',
      cap: 'per-cycle',
      reason: `cycle ${cycleId} already has ${PER_CYCLE_CAP} promoted question(s); per-cycle cap is ${PER_CYCLE_CAP}.`,
    };
  }
  const ym = yearMonth(deps.nowIso());
  if (countByMonth(existing, ym) >= MONTHLY_CAP) {
    return {
      kind: 'cap-exceeded',
      cap: 'monthly',
      reason: `month ${ym} already has ${MONTHLY_CAP} promoted question(s) (excluding manual-seed-*); monthly cap is ${MONTHLY_CAP}.`,
    };
  }

  // ---- prompt + append -----------------------------------------------------
  if (candidates.length === 0) {
    return { kind: 'ok', promoted: 0, ids: [] };
  }

  const rows: QuestionRow[] = [...existing];
  const addedIds: string[] = [];
  let perCycleCount = countByCycle(rows, cycleId);

  for (let i = 0; i < candidates.length; i++) {
    if (perCycleCount >= PER_CYCLE_CAP) break; // silently stop appending; cap not exceeded
    const decision = await deps.promptOperator({
      candidate: candidates[i],
      index: i,
      total: candidates.length,
    });
    if (decision.action === 'drop') continue;
    const source = decision.action === 'edit' ? decision.edited : candidates[i];
    const id = nextId(rows);
    const row: QuestionRow = {
      id,
      question: source.question,
      expected_sources: source.expected_sources,
      expected_keywords:
        source.expected_keywords && source.expected_keywords.length > 0
          ? source.expected_keywords
          : deriveKeywords(source.question),
      scope: source.scope ?? null,
      category: null,
      source_cycle: cycleId,
    };
    rows.push(row);
    addedIds.push(id);
    perCycleCount += 1;
  }

  if (addedIds.length === 0) {
    // All dropped — file unchanged. Write only on actual append to keep
    // bytes identical (the "default drop preserves byte-identical" test
    // relies on this).
    return { kind: 'ok', promoted: 0, ids: [] };
  }

  writeFileSync(questionsPath, JSON.stringify(rows, null, 2));

  // ---- accuracy gate -------------------------------------------------------
  const accuracy = await deps.runBenchAccuracy();
  if (!(accuracy >= ACCURACY_FLOOR)) {
    // Revert byte-for-byte.
    writeFileSync(questionsPath, snapshot);
    return {
      kind: 'reverted',
      accuracy,
      floor: ACCURACY_FLOOR,
      reason: `bench accuracy ${(accuracy * 100).toFixed(1)}% below floor ${(ACCURACY_FLOOR * 100).toFixed(1)}%; reverted.`,
    };
  }

  return { kind: 'ok', promoted: addedIds.length, ids: addedIds };
}

// ---------------------------------------------------------------------------
// CLI surface — used by orchestrator/cli.ts when the operator types
//   forge brain bench:promote --cycle <id>
// ---------------------------------------------------------------------------

import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';

/**
 * Default interactive prompter — uses node:readline (built-in; no new deps).
 * Each candidate renders its fields, the operator types
 *   k | keep | y     → keep verbatim
 *   d | drop | n     → drop (default on empty input)
 *   e | edit         → re-prompts for question / sources / keywords
 * Anything else falls through to drop with a "treated as drop" note.
 */
export function makeInteractivePrompter(): PromptOperator {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  // Closing rl after the last prompt is the caller's responsibility; we
  // expose `closeInteractivePrompter()` below.
  promptCloser = () => {
    if (!closed) {
      rl.close();
      closed = true;
    }
  };
  return async ({ candidate, index, total }) => {
    process.stdout.write(`\n[${index + 1}/${total}] candidate\n`);
    process.stdout.write(`  question: ${candidate.question}\n`);
    process.stdout.write(`  expected_sources:\n`);
    for (const s of candidate.expected_sources) process.stdout.write(`    - ${s}\n`);
    if (candidate.why_now) process.stdout.write(`  why_now: ${candidate.why_now}\n`);
    if (candidate.gap_id) process.stdout.write(`  gap_id: ${candidate.gap_id}\n`);
    const answer = (await rl.question('keep / drop / edit (default: drop) > ')).trim().toLowerCase();
    if (answer === 'k' || answer === 'keep' || answer === 'y') return { action: 'keep' };
    if (answer === 'e' || answer === 'edit') {
      const q = (await rl.question(`  question [${candidate.question}] > `)).trim();
      const sourcesRaw = (await rl.question(`  expected_sources (comma-separated) [${candidate.expected_sources.join(', ')}] > `)).trim();
      const keywordsRaw = (await rl.question(`  expected_keywords (comma-separated) [] > `)).trim();
      const edited: PromoteCandidate = {
        question: q || candidate.question,
        expected_sources: sourcesRaw
          ? sourcesRaw.split(',').map((s) => s.trim()).filter(Boolean)
          : candidate.expected_sources,
        expected_keywords: keywordsRaw
          ? keywordsRaw.split(',').map((s) => s.trim()).filter(Boolean)
          : candidate.expected_keywords,
        why_now: candidate.why_now,
        gap_id: candidate.gap_id,
        scope: candidate.scope,
      };
      return { action: 'edit', edited };
    }
    // Default: drop.
    return { action: 'drop' };
  };
}

let promptCloser: (() => void) | undefined;

/** Optional cleanup the CLI can call after runPromote to close readline. */
export function closeInteractivePrompter(): void {
  if (promptCloser) promptCloser();
}

/**
 * Production accuracy gate — reads the latest results JSON under
 * `benchmarks/brain/results/`. Returns the accuracy in [0, 1]. Returns
 * `Infinity` (interpreted as "no data") if no result exists; this is
 * surfaced as a warning to the operator who must run the bench manually.
 */
export function makeLatestResultAccuracy(forgeRoot: string): RunBenchAccuracy {
  return async () => {
    const { readdirSync, statSync } = await import('node:fs');
    const resultsDir = resolve(forgeRoot, 'benchmarks', 'brain', 'results');
    if (!existsSync(resultsDir)) return Number.POSITIVE_INFINITY;
    let newest: { path: string; mtimeMs: number } | null = null;
    for (const name of readdirSync(resultsDir)) {
      if (!name.endsWith('.json')) continue;
      const p = resolve(resultsDir, name);
      try {
        const st = statSync(p);
        if (!newest || st.mtimeMs > newest.mtimeMs) newest = { path: p, mtimeMs: st.mtimeMs };
      } catch {
        /* skip */
      }
    }
    if (!newest) return Number.POSITIVE_INFINITY;
    try {
      const raw = readFileSync(newest.path, 'utf8');
      const parsed = JSON.parse(raw) as { summary?: { accuracy?: number } };
      const acc = parsed?.summary?.accuracy;
      return typeof acc === 'number' ? acc : Number.POSITIVE_INFINITY;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };
}
