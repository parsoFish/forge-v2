/**
 * closure-check — the single objective definition of "forge is done".
 *
 * Parses _meta/iteration/coverage-matrix.md and evaluates every row at
 * the running tier. Exit 0 iff all evaluated rows pass. The autonomous
 * loop uses `--tier=fast` as its per-iteration quality gate; `--tier=full`
 * (adds benches + runtime goals) is the final closure gate.
 *
 * Dependency-free (Node stdlib only). Run:
 *   node --experimental-strip-types _meta/iteration/closure-check.ts [--tier=fast|full]
 *
 * Guardrail: this is tooling ABOUT the forge repo, not forge runtime.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const MATRIX = resolve(import.meta.dirname, 'coverage-matrix.md');
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '_meta', '_logs', '_worktrees', '_queue', 'brain',
]);

type Tier = 'fast' | 'full';
type Row = { id: string; obligation: string; kind: string; arg: string; tier: Tier };
type Result = { id: string; pass: boolean; reason: string };

function parseTier(): Tier {
  const a = process.argv.find((x) => x.startsWith('--tier='));
  const t = a ? a.split('=')[1] : 'fast';
  return t === 'full' ? 'full' : 'fast';
}

function parseMatrix(): Row[] {
  const md = readFileSync(MATRIX, 'utf8');
  const rows: Row[] = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^\|\s*([A-Za-z0-9.\-]+)\s*\|(.+)\|\s*(cmd|grep-absent|grep-present|file-absent|file-present|loc-max|pending)\s*\|(.+)\|\s*(fast|full)\s*\|$/);
    if (!m) continue;
    if (m[1] === 'id') continue;
    rows.push({
      id: m[1].trim(),
      obligation: m[2].trim(),
      kind: m[3].trim(),
      arg: m[4].trim().replace(/^`|`$/g, '').replace(/`/g, ''),
      tier: m[5].trim() as Tier,
    });
  }
  return rows;
}

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (EXCLUDE_DIRS.has(e)) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((x) => e.endsWith(x))) out.push(p);
  }
  return out;
}

function grepCount(pattern: string, globs: string[]): number {
  // Fixed-string search across given path roots; code + doc extensions.
  const exts = ['.ts', '.tsx', '.js', '.md', '.json', '.tmpl'];
  let count = 0;
  for (const g of globs) {
    const root = resolve(ROOT, g);
    const files = existsSync(root) && statSync(root).isDirectory()
      ? walk(root, exts)
      : existsSync(root) ? [root] : [];
    for (const f of files) {
      const body = readFileSync(f, 'utf8');
      if (body.includes(pattern)) count += body.split('\n').filter((l) => l.includes(pattern)).length;
    }
  }
  return count;
}

function evalRow(r: Row): Result {
  try {
    if (r.kind === 'pending') return { id: r.id, pass: false, reason: `pending (${r.arg})` };

    if (r.kind === 'cmd') {
      execSync(r.arg, { cwd: ROOT, stdio: 'pipe', timeout: 20 * 60_000 });
      return { id: r.id, pass: true, reason: 'cmd exit 0' };
    }

    if (r.kind === 'file-absent' || r.kind === 'file-present') {
      const there = existsSync(resolve(ROOT, r.arg));
      const want = r.kind === 'file-present';
      return { id: r.id, pass: there === want, reason: `${r.arg} ${there ? 'exists' : 'absent'}` };
    }

    if (r.kind === 'grep-absent' || r.kind === 'grep-present') {
      const [pat, globStr] = r.arg.split('::').map((s) => s.trim());
      const n = grepCount(pat, globStr.split(/\s+/));
      const pass = r.kind === 'grep-absent' ? n === 0 : n > 0;
      return { id: r.id, pass, reason: `${n} match(es) for "${pat}"` };
    }

    if (r.kind === 'loc-max') {
      const [nStr, globStr] = r.arg.split('::').map((s) => s.trim());
      const max = Number(nStr);
      const offenders: string[] = [];
      for (const g of globStr.split(/\s+/)) {
        for (const f of walk(resolve(ROOT, g), ['.ts'])) {
          if (f.endsWith('.test.ts') || f.endsWith('.tmpl')) continue;
          const loc = readFileSync(f, 'utf8').split('\n').length;
          if (loc > max) offenders.push(`${f.replace(ROOT + '/', '')}:${loc}`);
        }
      }
      return { id: r.id, pass: offenders.length === 0, reason: offenders.length ? `>${max}: ${offenders.join(', ')}` : `all ≤ ${max}` };
    }

    return { id: r.id, pass: false, reason: `unknown kind ${r.kind}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n').slice(-3).join(' ') : String(e);
    return { id: r.id, pass: false, reason: `error: ${msg.slice(0, 240)}` };
  }
}

function main(): void {
  const tier = parseTier();
  const rows = parseMatrix().filter((r) => (tier === 'full' ? true : r.tier === 'fast'));
  const results = rows.map(evalRow);
  const unmet = results.filter((r) => !r.pass);

  console.log(`\nclosure-check --tier=${tier}  (${rows.length} obligations)\n`);
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'UNMET'}  ${r.id.padEnd(14)} ${r.reason}`);
  }
  console.log(`\n${results.length - unmet.length}/${results.length} met.`);
  if (unmet.length) {
    console.log(`UNMET: ${unmet.map((u) => u.id).join(', ')}`);
    process.exit(1);
  }
  console.log('CLOSURE GATE GREEN — forge is done at this tier.');
  process.exit(0);
}

main();
