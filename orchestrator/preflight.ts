/**
 * forge↔project contract preflight (US-4.1 / ADR-017).
 *
 * Checks a project directory against the six-clause contract derived
 * empirically from the trafficGame arc (brain theme
 * `forge-project-onboarding-contract`; retro §3 C1–C6). A project either
 * passes or forge declines, naming the failing clause.
 *
 * Pure: `runPreflight()` does filesystem reads + one `git`/npm-script
 * inspection and returns a structured report. No mutation, no network,
 * no SDK. The CLI wrapper (`orchestrator/cli.ts`) renders + sets exit code.
 *
 * Hard clauses (C1/C2/C4) fail the preflight (non-zero exit). C3/C5/C6 are
 * advisory — surfaced as warnings, not blockers — because (C3) source size
 * is a heuristic, (C5) constraint-doc presence can't prove the harness
 * honours them, and (C6) is structurally satisfied by forge post-Phase-6
 * (no auto-merge; the operator merges the PR).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, relative } from 'node:path';

export type ClauseId = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'BRAIN';

export type ClauseResult = {
  clause: ClauseId;
  title: string;
  /** Hard clauses fail the preflight; advisory clauses only warn. */
  hard: boolean;
  pass: boolean;
  detail: string;
};

export type PreflightReport = {
  projectDir: string;
  projectName: string;
  clauses: ClauseResult[];
  /** True iff every HARD clause passed. Drives the CLI exit code. */
  ok: boolean;
};

export type PreflightOptions = {
  /**
   * Forge root, used to locate the project's brain sub-wiki
   * (`brain/projects/<name>/profile.md`). Defaults to the parent of
   * `orchestrator/` (where this module lives).
   */
  forgeRoot?: string;
};

// --- documented heuristics (single source of truth) ---

// C1: a quality gate is "plausibly fast" if it is a single deterministic
// command. We cannot run it here (could be minutes / require deps), so the
// heuristic is structural: the declared command must be ONE command (no
// shell pipes/&&/; chaining) and must not invoke a known-slow umbrella
// (e2e/playwright/cypress as the *primary* test command — those are the
// 18k-LOC-suite smell that broke trafficGame's per-iteration gate).
const SLOW_GATE_MARKERS = ['playwright', 'cypress', 'e2e', 'integration'];

// C3: a source file is "egregiously oversized" past this many LOC. 800 is
// the same ceiling forge holds on its own tree (coverage-matrix SIMPL-LOC)
// and is a defensible default project size norm. Advisory unless a file is
// *extreme* (≥ 2× the ceiling — the Game.ts-at-1732 class of god-file that
// made work items collide), which is reported but still non-fatal: the
// operator may have a justified exception and the PM's coupling detector is
// the real runtime guard.
const C3_SOFT_LOC = 800;
const C3_EXTREME_LOC = C3_SOFT_LOC * 2;
const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java'];
const C3_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', 'vendor',
  '.forge', 'test-results', '__pycache__', '.venv', 'target',
]);

// C2: forge scratch the project .gitignore MUST exclude (else every cycle
// commits orchestration state into the PR — the W4 reviewer-confusion bug).
const SCRATCH_PATHS = ['.forge/', 'AGENT.md', 'PROMPT.md', 'fix_plan.md'];

export function runPreflight(
  projectDir: string,
  opts: PreflightOptions = {},
): PreflightReport {
  const dir = resolve(projectDir);
  const projectName = dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
  const forgeRoot = opts.forgeRoot ?? resolve(import.meta.dirname, '..');

  const clauses: ClauseResult[] = [
    checkC1(dir),
    checkC2(dir),
    checkC3(dir),
    checkC4(dir, projectName, forgeRoot),
    checkC5(dir),
    checkC6(dir),
    checkBrainStaleness(dir, projectName, forgeRoot),
  ];

  const ok = clauses.filter((c) => c.hard).every((c) => c.pass);
  return { projectDir: dir, projectName, clauses, ok };
}

// --- C1: fast, trustworthy quality gate (HARD) ---

function checkC1(dir: string): ClauseResult {
  const base = { clause: 'C1' as const, title: 'Fast, trustworthy quality gate', hard: true };
  const declared = readQualityGateCmd(dir);
  if (!declared) {
    return {
      ...base,
      pass: false,
      detail:
        'no deterministic test command — need a package.json "test" script or a ' +
        'quality_gate_cmd in the project (none found)',
    };
  }
  const { source, cmd } = declared;
  const lowered = cmd.toLowerCase();
  // Heuristic: a single command, no shell chaining.
  const chained = /(\|\||&&|;|\|)/.test(cmd);
  const slowMarker = SLOW_GATE_MARKERS.find((m) => lowered.includes(m));
  if (chained) {
    return {
      ...base,
      pass: false,
      detail: `${source} chains multiple commands ("${cmd}") — the gate must be ONE deterministic command`,
    };
  }
  if (slowMarker) {
    return {
      ...base,
      pass: false,
      detail:
        `${source} ("${cmd}") looks slow/non-deterministic (contains "${slowMarker}"). ` +
        'The per-iteration gate must be ~≤10s — split a fast unit suite out as the test command.',
    };
  }
  return { ...base, pass: true, detail: `${source}: "${cmd}" (single command, no slow-suite marker)` };
}

// --- C2: scratch hygiene (HARD) ---

function checkC2(dir: string): ClauseResult {
  const base = { clause: 'C2' as const, title: 'Scratch hygiene (.gitignore excludes forge scratch)', hard: true };
  const giPath = join(dir, '.gitignore');
  if (!existsSync(giPath)) {
    return { ...base, pass: false, detail: 'no .gitignore — forge scratch (.forge/, AGENT.md, PROMPT.md, fix_plan.md) would be committed into the PR' };
  }
  const lines = readFileSync(giPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const missing = SCRATCH_PATHS.filter(
    (p) => !lines.some((l) => l === p || l === p.replace(/\/$/, '') || l === `/${p}`),
  );
  if (missing.length > 0) {
    return { ...base, pass: false, detail: `.gitignore does not exclude: ${missing.join(', ')}` };
  }
  return { ...base, pass: true, detail: `.gitignore excludes all forge scratch (${SCRATCH_PATHS.join(', ')})` };
}

// --- C3: decomposed source under the project's size norm (ADVISORY) ---

function checkC3(dir: string): ClauseResult {
  const base = { clause: 'C3' as const, title: 'Decomposed source (no god-files)', hard: false };
  const offenders: string[] = [];
  let extreme = false;
  for (const file of walkSource(dir)) {
    const loc = readFileSync(file, 'utf8').split('\n').length;
    if (loc > C3_SOFT_LOC) {
      offenders.push(`${relative(dir, file)}:${loc}`);
      if (loc >= C3_EXTREME_LOC) extreme = true;
    }
  }
  if (offenders.length === 0) {
    return { ...base, pass: true, detail: `no source file > ${C3_SOFT_LOC} LOC` };
  }
  const shown = offenders.slice(0, 5).join(', ');
  return {
    ...base,
    pass: false,
    detail:
      `${offenders.length} file(s) > ${C3_SOFT_LOC} LOC (${shown}${offenders.length > 5 ? ', …' : ''})` +
      (extreme
        ? ` — at least one is ≥ ${C3_EXTREME_LOC} LOC (god-file class; work items will collide). Advisory, but strongly recommend extracting before unattended runs.`
        : ' — advisory; the PM coupling detector is the runtime guard.'),
  };
}

// --- C4: machine-consumable architecture context (HARD) ---

function checkC4(dir: string, projectName: string, forgeRoot: string): ClauseResult {
  const base = { clause: 'C4' as const, title: 'Machine-readable architecture context', hard: true };
  const roadmap = join(dir, 'roadmap.md');
  const brainProfile = resolve(forgeRoot, 'brain', 'projects', projectName, 'profile.md');
  const hasRoadmap = existsSync(roadmap);
  const hasBrain = existsSync(brainProfile);
  if (hasRoadmap && hasBrain) {
    return { ...base, pass: true, detail: `roadmap.md + brain sub-wiki present (brain/projects/${projectName}/profile.md)` };
  }
  const missing: string[] = [];
  if (!hasRoadmap) missing.push('roadmap.md (in project root)');
  if (!hasBrain) missing.push(`brain/projects/${projectName}/profile.md (brain sub-wiki)`);
  return {
    ...base,
    pass: false,
    detail: `missing ${missing.join(' and ')} — the architect/PM have no queryable structure and will hallucinate paths`,
  };
}

// --- C5: locked-core mandates the harness honours (ADVISORY) ---

function checkC5(dir: string): ClauseResult {
  const base = { clause: 'C5' as const, title: 'Locked-core constraints declared', hard: false };
  const candidates = ['CLAUDE.md', 'AGENTS.md', '.forge/constraints.md', 'CONSTRAINTS.md'];
  const found = candidates.find((c) => existsSync(join(dir, c)));
  if (found) {
    return {
      ...base,
      pass: true,
      detail: `${found} present (operator declared constraints; forge honours git-ownership / no-test-tampering per the doc)`,
    };
  }
  return {
    ...base,
    pass: false,
    detail:
      `no constraints doc (${candidates.join(' / ')}). Advisory: forge cannot honour locked-core ` +
      'mandates it was never told about — strongly recommend a CLAUDE.md.',
  };
}

// --- C6: a satisfiable merge model (ADVISORY — forge-side-satisfied) ---

function checkC6(dir: string): ClauseResult {
  const base = { clause: 'C6' as const, title: 'Satisfiable merge model', hard: false };
  // Post-Phase-6 this clause is structurally satisfied by FORGE: the review
  // phase produces a demo-embedded PR and STOPS; the operator merges in
  // GitHub (no auto-merge). The only project-side requirement is a GitHub
  // remote so there is a PR surface to merge.
  const remote = gitRemoteUrl(dir);
  if (remote && /github\.com/i.test(remote)) {
    return {
      ...base,
      pass: true,
      detail: `forge-side-satisfied (Phase-6: no auto-merge, operator merges the PR). Project has a GitHub remote: ${remote}`,
    };
  }
  return {
    ...base,
    pass: false,
    detail:
      'forge-side-satisfied for the merge model, BUT no GitHub remote found — there is no PR surface ' +
      'for the operator to merge. Add a GitHub `origin` remote. (Advisory.)',
  };
}

// --- helpers ---

function readQualityGateCmd(dir: string): { source: string; cmd: string } | null {
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
      const t = pkg.scripts?.test;
      if (t && t.trim() && !/no test specified/i.test(t)) {
        return { source: 'package.json "test"', cmd: t.trim() };
      }
    } catch {
      /* malformed package.json — fall through to other signals */
    }
  }
  // A project may declare a quality_gate_cmd in a forge sidecar instead of
  // (or in addition to) package.json — mirror the manifest's field name.
  const sidecar = join(dir, '.forge', 'quality_gate_cmd');
  if (existsSync(sidecar)) {
    const cmd = readFileSync(sidecar, 'utf8').trim();
    if (cmd) return { source: '.forge/quality_gate_cmd', cmd };
  }
  return null;
}

/**
 * Advisory (never blocks): scan the project's brain themes for cited
 * `src/…` / `tests/…` source paths that no longer exist in the project
 * repo. A theme citing deleted/renamed files is the failure mode that
 * silently thrashed the PM (2026-05-18): the PM reads the brain first,
 * ingests a model that contradicts the actual tree, and burns its whole
 * budget unable to reconcile. This surfaces the contradiction BEFORE a
 * cycle, so the operator can reconcile the theme (the reflection phase
 * normally does this, but by-hand project changes skip it).
 *
 * WARN only — themes legitimately reference history; the operator judges.
 */
function checkBrainStaleness(
  dir: string,
  projectName: string,
  forgeRoot: string,
): ClauseResult {
  const base = {
    clause: 'BRAIN' as const,
    title: 'Brain freshness (themes cite live source paths)',
    hard: false,
  };
  const themesDir = resolve(forgeRoot, 'brain', 'projects', projectName, 'themes');
  if (!existsSync(themesDir)) {
    return { ...base, pass: true, detail: 'no project brain themes to check' };
  }
  // Match worktree-relative source tokens in markdown links or inline code,
  // including the `…/projects/<name>/src/…` link form themes use — we only
  // flag the high-signal `src/` and `tests/` code paths with a file ext.
  const pathRe = /(?:^|[("`\s/])((?:src|tests)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+)/g;
  const missing = new Map<string, string>(); // citedPath -> first theme file
  let themeFiles: string[] = [];
  try {
    themeFiles = readdirSync(themesDir).filter((f) => f.endsWith('.md'));
  } catch {
    return { ...base, pass: true, detail: 'project themes unreadable — skipped' };
  }
  for (const f of themeFiles) {
    let content: string;
    try {
      content = readFileSync(join(themesDir, f), 'utf8');
    } catch {
      continue;
    }
    for (const m of content.matchAll(pathRe)) {
      const cited = m[1];
      if (missing.has(cited)) continue;
      if (!existsSync(join(dir, cited))) missing.set(cited, f);
    }
  }
  if (missing.size === 0) {
    return {
      ...base,
      pass: true,
      detail: `all src/tests paths cited by ${themeFiles.length} theme(s) exist in the project`,
    };
  }
  const sample = [...missing.entries()]
    .slice(0, 6)
    .map(([p, f]) => `${p} (${f})`)
    .join('; ');
  return {
    ...base,
    pass: false,
    detail:
      `${missing.size} brain-cited source path(s) no longer exist — theme(s) may be stale and ` +
      `will mislead the planner (PM/architect read the brain first). Reconcile against the code ` +
      `(or run a reflection pass). Sample: ${sample}`,
  };
}

function walkSource(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (C3_SKIP_DIRS.has(e)) continue;
      const p = join(cur, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (SOURCE_EXTS.some((x) => e.endsWith(x)) && !e.endsWith('.d.ts')) out.push(p);
    }
  }
  return out;
}

function gitRemoteUrl(dir: string): string | null {
  try {
    return execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

/** Render a human-facing per-clause report. Returned, not printed (the CLI prints). */
export function formatPreflightReport(r: PreflightReport): string {
  const lines: string[] = [];
  lines.push(`forge preflight — ${r.projectName}  (${r.projectDir})`);
  lines.push('');
  for (const c of r.clauses) {
    const mark = c.pass ? 'PASS' : c.hard ? 'FAIL' : 'WARN';
    lines.push(`  ${mark}  ${c.clause} ${c.title}`);
    lines.push(`        ${c.detail}`);
  }
  lines.push('');
  if (r.ok) {
    const warns = r.clauses.filter((c) => !c.pass && !c.hard).length;
    lines.push(
      warns > 0
        ? `CONTRACT MET (hard clauses pass; ${warns} advisory warning(s) — review before unattended runs).`
        : 'CONTRACT MET — forge can progress this project unattended.',
    );
  } else {
    const failed = r.clauses.filter((c) => c.hard && !c.pass).map((c) => c.clause);
    lines.push(`CONTRACT NOT MET — forge declines. Failing hard clause(s): ${failed.join(', ')}.`);
  }
  return lines.join('\n');
}
