/**
 * `--source=<golden|chained>` switch shared by every per-phase `score.ts`.
 *
 * Default (`golden`, or flag absent): the isolated bench runs UNCHANGED
 * against its hand-frozen golden fixtures — one rubric set, default input
 * source. The isolated benches stay byte-for-byte intact.
 *
 * `--source=chained`: instead of invoking the SDK against golden fixtures,
 * the phase `score.ts` reads the most recent `benchmarks/chained/results/`
 * run and prints THIS phase's already-computed slice (the chained harness
 * scored it with this exact same `scoring.ts:caseScore`). This is purely a
 * read of an existing artifact set — no new rubric, no SDK call, no golden
 * fixture touched. It exists so an operator can ask "how did <phase> score
 * on the chained (generated) inputs?" without re-running the chain.
 *
 * One rubric set, two input sources (US-6.2 / brain theme
 * `chained-phase-benchmarks`).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export type BenchSource = 'golden' | 'chained';

/** Parse `--source=golden|chained` from argv. Default `golden`. */
export function parseSource(argv: string[] = process.argv): BenchSource {
  const a = argv.find((x) => x.startsWith('--source='));
  const v = a ? a.split('=')[1] : 'golden';
  return v === 'chained' ? 'chained' : 'golden';
}

type ChainedCase = {
  id: string;
  chain_passed: boolean;
  phases: Record<
    string,
    { score: number; passed: boolean; criteria: Record<string, number> } | null
  >;
};

type ChainedResults = { phase: string; ran_at: string; cases: ChainedCase[] };

const FORGE_ROOT = resolve(import.meta.dirname, '..', '..');

/** Newest `benchmarks/chained/results/*.json`, or null if none exist yet. */
export function latestChainedResults(): ChainedResults | null {
  const dir = resolve(FORGE_ROOT, 'benchmarks', 'chained', 'results');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (files.length === 0) return null;
  try {
    return JSON.parse(
      readFileSync(resolve(dir, files[files.length - 1]), 'utf8'),
    ) as ChainedResults;
  } catch {
    return null;
  }
}

/**
 * Print the requested phase's slice of the latest chained run and exit.
 * `phaseKey` is the key under each chained case's `phases` object
 * (`architect | project_manager | developer_loop | review_loop |
 * reflection`).
 *
 * Called by a phase `score.ts` ONLY when `--source=chained`. Never touches
 * the golden path. Exits 0 if the slice exists, 1 otherwise (so CI can tell
 * "the chain hasn't produced this phase" apart from "this phase failed").
 */
export function emitChainedSliceAndExit(
  phaseKey: 'architect' | 'project_manager' | 'developer_loop' | 'review_loop' | 'reflection',
  isoPhaseName: string,
): never {
  const res = latestChainedResults();
  if (res === null) {
    process.stdout.write(
      `[${isoPhaseName}] --source=chained: no benchmarks/chained/results/ yet — run \`npm run bench:chained\` first.\n`,
    );
    process.exit(1);
  }
  const slice = res.cases.map((c) => ({
    id: c.id,
    phase: phaseKey,
    chain_passed: c.chain_passed,
    result: c.phases[phaseKey],
  }));
  const scored = slice.filter((s) => s.result !== null);
  const passed = scored.filter((s) => s.result!.passed).length;
  process.stdout.write(
    JSON.stringify(
      {
        phase: isoPhaseName,
        source: 'chained',
        chained_ran_at: res.ran_at,
        cases: slice,
        summary: {
          total: scored.length,
          passed,
          failed: scored.length - passed,
          note:
            'Scored by the SAME scoring.ts:caseScore as the golden path, ' +
            'over chained (generated) inputs. No chained-only rubric.',
        },
      },
      null,
      2,
    ) + '\n',
  );
  process.exit(scored.length > 0 && passed === scored.length ? 0 : 1);
}
