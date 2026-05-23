/**
 * Brain-lint — structural integrity checks on the brain corpus.
 *
 * CLI: `forge brain lint [--scope <s>] [--project <name>] [--file <path>] [--cycle <id>] [--fix]`
 *
 * Implements the 9 checks from `docs/planning/2026-05-20-refinement/01-brain.md`
 * §"Brain-lint design", per `brain/LINT.md`:
 *
 *   1. checkFrontmatter        — required fields + category whitelist
 *   2. checkIndexSync          — themes appear in their category index exactly once
 *   3. checkSourceLinks        — every link in `## Sources` and every wikilink resolves
 *   4. checkStaleness          — cited *project* paths still exist (resolved via project profile)
 *   5. checkOrphans            — themes reachable from INDEX.md → category index → theme
 *   6. checkLengthSoftCap      — > 60 lines warn; > 100 lines error
 *   7. checkContamination      — `__chained_test_proj_*` and `__bench_*` dirs error
 *   8. checkContradictions     — warn-only stretch: pattern+antipattern with overlapping keywords
 *   9. checkCleanupCandidates  — retention frontmatter triage (archived/stale themes)
 *  (+ checkGraphFreshness per C21 — flags when graph.json's build SHA lags HEAD)
 *
 * Each check is a pure function `(forgeRoot) => Finding[]`. The CLI aggregates,
 * prints a human-readable report, and exits non-zero iff ≥1 error.
 *
 * Per CONTRACTS.md C7, scopes: `full | forge-only | project-only | single-file |
 * cycle-touched-themes | cleanup-dry-run`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, basename } from 'node:path';
// gray-matter has no usable types; we treat the default export as `any` for parsing.
// The structure we use is well-defined: `{ data, content }`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import matter from 'gray-matter';

// ---------- types ----------

export type FindingCategory = 'auto-fix' | 'flag' | 'error';

export type Finding = {
  category: FindingCategory;
  file: string; // absolute path
  message: string;
  /** Optional check name for grouping in output. */
  check?: string;
};

export type Scope =
  | 'full'
  | 'forge-only'
  | 'project-only'
  | 'single-file'
  | 'cycle-touched-themes'
  | 'cleanup-dry-run';

export type RunBrainLintOptions = {
  cwd: string;
  scope: Scope;
  project?: string;
  file?: string; // relative to cwd
  cycle?: string;
  fix?: boolean;
};

export type RunBrainLintResult = {
  findings: Finding[];
  exitCode: 0 | 1;
};

const ALLOWED_CATEGORIES = new Set([
  'pattern',
  'antipattern',
  'decision',
  'operation',
  'reference',
]);

const REQUIRED_FRONTMATTER_FIELDS = [
  'title',
  'description',
  'category',
  'created_at',
  'updated_at',
];

const CATEGORY_TO_INDEX_FILE: Record<string, string> = {
  pattern: 'patterns.md',
  antipattern: 'antipatterns.md',
  decision: 'decisions.md',
  operation: 'operations.md',
  reference: 'reference.md',
};

// ---------- helpers ----------

function readThemeFiles(brainRoot: string): string[] {
  const files: string[] = [];
  if (!existsSync(brainRoot)) return files;

  // forge/themes/
  const forgeThemes = join(brainRoot, 'forge', 'themes');
  if (existsSync(forgeThemes)) {
    for (const entry of readdirSync(forgeThemes)) {
      if (entry === 'README.md' || !entry.endsWith('.md')) continue;
      files.push(join(forgeThemes, entry));
    }
  }

  // projects/<n>/themes/
  const projectsRoot = join(brainRoot, 'projects');
  if (existsSync(projectsRoot)) {
    for (const proj of readdirSync(projectsRoot)) {
      const themes = join(projectsRoot, proj, 'themes');
      if (!existsSync(themes)) continue;
      try {
        if (!statSync(themes).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const entry of readdirSync(themes)) {
        if (entry === 'README.md' || !entry.endsWith('.md')) continue;
        files.push(join(themes, entry));
      }
    }
  }

  return files;
}

/**
 * Lenient frontmatter parser. Tries gray-matter first; on YAML failure (e.g.
 * unquoted `:` in a description value), falls back to a regex line-by-line
 * extractor that captures `key: value` pairs without YAML-spec strictness.
 * This means lint can still surface frontmatter findings (missing fields,
 * bad category) on themes that gray-matter would reject — failing-closed
 * would hide the very class of violations we want to find.
 */
function parseTheme(file: string): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
  content: string;
  raw: string;
} | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const { data, content } = matter(raw);
    return { data, content, raw };
  } catch {
    // Fallback: split on first two `---` lines.
    const lines = raw.split('\n');
    if (lines[0]?.trim() !== '---') {
      return { data: {}, content: raw, raw };
    }
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        end = i;
        break;
      }
    }
    if (end < 0) {
      return { data: {}, content: raw, raw };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: Record<string, any> = {};
    for (let i = 1; i < end; i++) {
      const line = lines[i];
      const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (m) {
        data[m[1]] = m[2].trim();
      }
    }
    const content = lines.slice(end + 1).join('\n');
    return { data, content, raw };
  }
}

function projectOfTheme(file: string, brainRoot: string): string | null {
  const rel = relative(brainRoot, file);
  const parts = rel.split(/[/\\]/);
  if (parts[0] === 'projects' && parts[2] === 'themes') {
    return parts[1] ?? null;
  }
  return null;
}

// ---------- checkFrontmatter ----------

export function checkFrontmatter(forgeRoot: string): Finding[] {
  const findings: Finding[] = [];
  const brainRoot = join(forgeRoot, 'brain');
  for (const file of readThemeFiles(brainRoot)) {
    const parsed = parseTheme(file);
    if (!parsed) {
      findings.push({
        category: 'error',
        file,
        message: 'unparseable frontmatter (gray-matter failed)',
        check: 'checkFrontmatter',
      });
      continue;
    }
    const { data } = parsed;
    for (const field of REQUIRED_FRONTMATTER_FIELDS) {
      if (data[field] === undefined || data[field] === null || data[field] === '') {
        findings.push({
          category: 'error',
          file,
          message: `missing required frontmatter field: ${field}`,
          check: 'checkFrontmatter',
        });
      }
    }
    if (data.category && !ALLOWED_CATEGORIES.has(String(data.category))) {
      findings.push({
        category: 'error',
        file,
        message: `category "${data.category}" not in whitelist {${[...ALLOWED_CATEGORIES].join('|')}}`,
        check: 'checkFrontmatter',
      });
    }
    if (data.created_at && data.updated_at) {
      try {
        const c = new Date(String(data.created_at)).getTime();
        const u = new Date(String(data.updated_at)).getTime();
        if (!Number.isNaN(c) && !Number.isNaN(u) && c > u) {
          findings.push({
            category: 'error',
            file,
            message: 'created_at > updated_at',
            check: 'checkFrontmatter',
          });
        }
      } catch {
        /* ignore parse failure; not load-bearing */
      }
    }
  }
  return findings;
}

// ---------- checkIndexSync ----------

function readIndexEntries(indexFile: string): string[] {
  if (!existsSync(indexFile)) return [];
  const body = readFileSync(indexFile, 'utf8');
  // Match links of shape ./themes/<slug>.md or themes/<slug>.md
  const slugs: string[] = [];
  const re = /\(\.?\.?\/?(?:themes\/)([a-zA-Z0-9._-]+?)(?:\.md)?\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    slugs.push(m[1]);
  }
  // Also accept bare-style: [`<slug>`](./themes/<slug>.md) — captured by re above already.
  return slugs;
}

export function checkIndexSync(forgeRoot: string): Finding[] {
  const findings: Finding[] = [];
  const brainRoot = join(forgeRoot, 'brain');

  for (const file of readThemeFiles(brainRoot)) {
    const parsed = parseTheme(file);
    if (!parsed) continue;
    const cat = String(parsed.data.category ?? '');
    if (!ALLOWED_CATEGORIES.has(cat)) continue; // checkFrontmatter handles the bad-category case
    const indexFile = CATEGORY_TO_INDEX_FILE[cat];
    if (!indexFile) continue;

    const project = projectOfTheme(file, brainRoot);
    const indexPath = project
      ? join(brainRoot, 'projects', project, indexFile)
      : join(brainRoot, 'forge', indexFile);

    if (!existsSync(indexPath)) {
      findings.push({
        category: 'flag',
        file,
        message: `category index missing: ${relative(forgeRoot, indexPath)}`,
        check: 'checkIndexSync',
      });
      continue;
    }
    const slug = basename(file, '.md');
    const entries = readIndexEntries(indexPath);
    const hit = entries.filter((e) => e === slug).length;
    if (hit === 0) {
      findings.push({
        category: 'flag',
        file,
        message: `not listed in category index: ${relative(forgeRoot, indexPath)}`,
        check: 'checkIndexSync',
      });
    } else if (hit > 1) {
      findings.push({
        category: 'flag',
        file,
        message: `listed ${hit} times in category index: ${relative(forgeRoot, indexPath)}`,
        check: 'checkIndexSync',
      });
    }
  }

  return findings;
}

// ---------- checkSourceLinks ----------

/** Extract relative-link targets and wikilink slugs from a theme body. */
function extractLinks(body: string): { relLinks: string[]; wikilinks: string[] } {
  const relLinks: string[] = [];
  const wikilinks: string[] = [];

  // Markdown links: [text](path)
  const mdRe = /\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(body)) !== null) {
    const target = m[1].split(' ')[0].trim();
    if (target.startsWith('http://') || target.startsWith('https://')) continue;
    if (target.startsWith('#')) continue;
    if (target.startsWith('mailto:')) continue;
    // Strip anchor fragments.
    const path = target.split('#')[0];
    if (path) relLinks.push(path);
  }

  // Wikilinks: [[slug]]
  const wikiRe = /\[\[([^\]]+)\]\]/g;
  while ((m = wikiRe.exec(body)) !== null) {
    wikilinks.push(m[1].trim());
  }

  return { relLinks, wikilinks };
}

export function checkSourceLinks(forgeRoot: string): Finding[] {
  const findings: Finding[] = [];
  const brainRoot = join(forgeRoot, 'brain');

  for (const file of readThemeFiles(brainRoot)) {
    const parsed = parseTheme(file);
    if (!parsed) continue;
    const dir = dirname(file);
    const { relLinks, wikilinks } = extractLinks(parsed.content);

    for (const link of relLinks) {
      // Resolve relative to the theme file.
      const target = resolve(dir, link);
      if (!existsSync(target)) {
        findings.push({
          category: 'error',
          file,
          message: `broken link: ${link}`,
          check: 'checkSourceLinks',
        });
      }
    }

    for (const slug of wikilinks) {
      // Try forge/themes/<slug>.md and projects/<*>/themes/<slug>.md.
      const candidates = [join(brainRoot, 'forge', 'themes', `${slug}.md`)];
      const projectsRoot = join(brainRoot, 'projects');
      if (existsSync(projectsRoot)) {
        for (const proj of readdirSync(projectsRoot)) {
          candidates.push(join(projectsRoot, proj, 'themes', `${slug}.md`));
        }
      }
      const hit = candidates.some((c) => existsSync(c));
      if (!hit) {
        findings.push({
          category: 'error',
          file,
          message: `broken wikilink: [[${slug}]]`,
          check: 'checkSourceLinks',
        });
      }
    }
  }

  return findings;
}

// ---------- checkStaleness ----------

/**
 * For each theme citing a path in `## Sources` (or anywhere in the body):
 * - For project themes (`brain/projects/<n>/themes/<file>.md`): resolve the
 *   project repo path as `<forgeRoot>/projects/<n>/`. If the path exists, OK.
 *   If the path is missing AND the project repo exists, flag as stale.
 * - For forge themes: resolve relative to `<forgeRoot>/`. Flag missing files
 *   that look like source paths.
 *
 * Citations are detected as backtick-wrapped paths that look like file paths:
 *   `src/foo.ts` `orchestrator/cycle.ts` `tests/x.test.ts`
 */
function extractCitedPaths(content: string): string[] {
  const out: string[] = [];
  // Backtick-wrapped path-looking strings.
  const re = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const s = m[1].trim();
    // Heuristic: looks like a path (has a / and a . extension) and doesn't look
    // like a code snippet (no spaces, no parens).
    if (s.includes('/') && /\.[a-zA-Z0-9]+$/.test(s) && !s.includes(' ') && !s.includes('(')) {
      out.push(s);
    }
  }
  return out;
}

export function checkStaleness(forgeRoot: string): Finding[] {
  const findings: Finding[] = [];
  const brainRoot = join(forgeRoot, 'brain');

  for (const file of readThemeFiles(brainRoot)) {
    const parsed = parseTheme(file);
    if (!parsed) continue;
    const cited = extractCitedPaths(parsed.content);
    if (cited.length === 0) continue;

    const project = projectOfTheme(file, brainRoot);
    const projectRepo = project ? resolve(forgeRoot, 'projects', project) : null;

    for (const p of cited) {
      // Skip URLs and absolute-system paths.
      if (p.startsWith('http://') || p.startsWith('https://')) continue;
      if (p.startsWith('/')) continue;

      // Skip references to forge brain paths themselves — those are linked,
      // and checkSourceLinks already handles those.
      if (p.startsWith('brain/')) continue;
      if (p.startsWith('docs/') || p.startsWith('orchestrator/') || p.startsWith('skills/') || p.startsWith('benchmarks/') || p.startsWith('loops/')) {
        // Forge-internal path. Resolve against forge root.
        const target = resolve(forgeRoot, p);
        if (!existsSync(target)) {
          findings.push({
            category: 'flag',
            file,
            message: `stale citation (missing): ${p}`,
            check: 'checkStaleness',
          });
        }
        continue;
      }

      // Project-scoped path: must have a project repo to check against.
      if (!project) continue;
      if (!projectRepo || !existsSync(projectRepo)) continue; // no tree to verify

      const target = resolve(projectRepo, p);
      if (!existsSync(target)) {
        findings.push({
          category: 'flag',
          file,
          message: `stale citation (missing in project): ${p}`,
          check: 'checkStaleness',
        });
      }
    }
  }

  return findings;
}

// ---------- checkOrphans ----------

function collectIndexLinkTargets(brainRoot: string): Set<string> {
  const targets = new Set<string>();
  const indexFiles: string[] = [];

  const topIndex = join(brainRoot, 'INDEX.md');
  if (existsSync(topIndex)) indexFiles.push(topIndex);

  const forgeDir = join(brainRoot, 'forge');
  if (existsSync(forgeDir)) {
    for (const entry of readdirSync(forgeDir)) {
      if (entry.endsWith('.md')) indexFiles.push(join(forgeDir, entry));
    }
  }

  const projectsRoot = join(brainRoot, 'projects');
  if (existsSync(projectsRoot)) {
    for (const proj of readdirSync(projectsRoot)) {
      const projDir = join(projectsRoot, proj);
      try {
        if (!statSync(projDir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const entry of readdirSync(projDir)) {
        if (entry.endsWith('.md')) indexFiles.push(join(projDir, entry));
      }
    }
  }

  for (const f of indexFiles) {
    let body: string;
    try {
      body = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const dir = dirname(f);
    // Markdown links pointing at .md files under themes/ or forge/themes or projects/.../themes
    const mdRe = /\[[^\]]*\]\(([^)]+\.md[^)]*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = mdRe.exec(body)) !== null) {
      const target = m[1].split('#')[0].trim();
      const resolved = resolve(dir, target);
      targets.add(resolved);
    }
  }

  return targets;
}

export function checkOrphans(forgeRoot: string): Finding[] {
  const findings: Finding[] = [];
  const brainRoot = join(forgeRoot, 'brain');
  const reachable = collectIndexLinkTargets(brainRoot);
  for (const file of readThemeFiles(brainRoot)) {
    if (!reachable.has(file)) {
      findings.push({
        category: 'flag',
        file,
        message: 'orphan: not linked from INDEX.md or any category/profile index',
        check: 'checkOrphans',
      });
    }
  }
  return findings;
}

// ---------- checkLengthSoftCap ----------

export function checkLengthSoftCap(forgeRoot: string): Finding[] {
  const findings: Finding[] = [];
  const brainRoot = join(forgeRoot, 'brain');
  for (const file of readThemeFiles(brainRoot)) {
    let body: string;
    try {
      body = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // Count newlines (raw, including frontmatter).
    const lines = body.split('\n').length;
    if (lines > 100) {
      findings.push({
        category: 'error',
        file,
        message: `theme too long: ${lines} lines (hard cap 100)`,
        check: 'checkLengthSoftCap',
      });
    } else if (lines > 60) {
      findings.push({
        category: 'flag',
        file,
        message: `theme over soft cap: ${lines} lines (> 60)`,
        check: 'checkLengthSoftCap',
      });
    }
  }
  return findings;
}

// ---------- checkContamination ----------

const CONTAMINATION_PATTERNS = [/^__chained_test_proj_/, /^__bench_/];

export function checkContamination(forgeRoot: string): Finding[] {
  const findings: Finding[] = [];
  const brainRoot = join(forgeRoot, 'brain');
  const projectsRoot = join(brainRoot, 'projects');
  if (!existsSync(projectsRoot)) return findings;
  for (const entry of readdirSync(projectsRoot)) {
    if (CONTAMINATION_PATTERNS.some((p) => p.test(entry))) {
      findings.push({
        category: 'error',
        file: join(projectsRoot, entry),
        message: `contamination dir from bench: ${entry}`,
        check: 'checkContamination',
      });
    }
  }
  return findings;
}

// ---------- checkCleanupCandidates (S6A — retention-aware) ----------

/**
 * S6A — surface cleanup candidates by reading each cycle archive's
 * `retention` frontmatter (written by the reflector + post-processed by
 * `orchestrator/cycle-retention.ts`). Tiers:
 *
 *   - `routine`     ⇒ Tier B (archive-and-summarise eligible if older
 *                     than CLEANUP_ROUTINE_MIN_AGE_DAYS).
 *   - `load-bearing` ⇒ Tier C (never auto). Surfaced as info-level so the
 *                     operator can see it in cleanup-dry-run output.
 *   - `interesting` ⇒ tier-A-ish (keep verbatim; not a cleanup candidate).
 *   - missing       ⇒ "pre-S6A archive, manual triage".
 *
 * Only fires when scope is `cleanup-dry-run` (caller-filtered in
 * `filterFindingsByScope`). All findings are `flag` category — this check
 * never errors.
 */
const CLEANUP_ROUTINE_MIN_AGE_DAYS = 30;

export function checkCleanupCandidates(forgeRoot: string): Finding[] {
  const findings: Finding[] = [];
  const cyclesDir = join(forgeRoot, 'brain', '_raw', 'cycles');
  if (!existsSync(cyclesDir)) return findings;
  let entries: string[];
  try {
    entries = readdirSync(cyclesDir);
  } catch {
    return findings;
  }
  const nowMs = Date.now();
  const ageMs = CLEANUP_ROUTINE_MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
  for (const file of entries) {
    if (!file.endsWith('.md')) continue;
    const full = join(cyclesDir, file);
    let raw: string;
    try {
      raw = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    let mtimeMs: number;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      mtimeMs = nowMs;
    }
    const fmEnd = raw.indexOf('\n---', 4);
    if (fmEnd === -1) {
      findings.push({
        category: 'flag',
        file: full,
        message: 'cleanup: pre-S6A archive, manual triage (no frontmatter)',
        check: 'checkCleanupCandidates',
      });
      continue;
    }
    const fmBlock = raw.slice(4, fmEnd);
    let retention: string | null = null;
    for (const line of fmBlock.split(/\r?\n/)) {
      const m = line.match(/^retention:\s*(.*)$/);
      if (m) {
        retention = m[1].trim();
        break;
      }
    }
    if (!retention || retention === 'auto') {
      findings.push({
        category: 'flag',
        file: full,
        message: 'cleanup: pre-S6A archive or placeholder retention, manual triage',
        check: 'checkCleanupCandidates',
      });
      continue;
    }
    if (retention === 'load-bearing') {
      findings.push({
        category: 'flag',
        file: full,
        message: 'cleanup: tier-C (load-bearing — never auto)',
        check: 'checkCleanupCandidates',
      });
      continue;
    }
    if (retention === 'routine' && nowMs - mtimeMs > ageMs) {
      findings.push({
        category: 'flag',
        file: full,
        message: `cleanup: tier-B (routine, > ${CLEANUP_ROUTINE_MIN_AGE_DAYS} days old — archive-and-summarise eligible)`,
        check: 'checkCleanupCandidates',
      });
    }
    // `interesting` and recent `routine`: not surfaced.
  }
  return findings;
}

// ---------- checkContradictions (warn-only stretch) ----------

export function checkContradictions(forgeRoot: string): Finding[] {
  const findings: Finding[] = [];
  const brainRoot = join(forgeRoot, 'brain');

  type ThemeMeta = {
    file: string;
    category: string;
    keywords: string[];
  };

  const themes: ThemeMeta[] = [];
  for (const file of readThemeFiles(brainRoot)) {
    const parsed = parseTheme(file);
    if (!parsed) continue;
    const kw = Array.isArray(parsed.data.keywords) ? parsed.data.keywords.map(String) : [];
    themes.push({ file, category: String(parsed.data.category ?? ''), keywords: kw });
  }

  const seen = new Set<string>();
  for (let i = 0; i < themes.length; i++) {
    for (let j = i + 1; j < themes.length; j++) {
      const a = themes[i];
      const b = themes[j];
      const aIsPattern = a.category === 'pattern' || a.file.includes('-pattern');
      const aIsAnti = a.category === 'antipattern' || a.file.includes('-antipattern');
      const bIsPattern = b.category === 'pattern' || b.file.includes('-pattern');
      const bIsAnti = b.category === 'antipattern' || b.file.includes('-antipattern');
      const opposing = (aIsPattern && bIsAnti) || (aIsAnti && bIsPattern);
      if (!opposing) continue;

      const overlap = a.keywords.filter((k) => b.keywords.includes(k));
      if (overlap.length >= 3) {
        const key = [a.file, b.file].sort().join('::');
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          category: 'flag',
          file: a.file,
          message: `possible contradiction with ${relative(forgeRoot, b.file)} (${overlap.length} keyword overlaps: ${overlap.slice(0, 5).join(', ')})`,
          check: 'checkContradictions',
        });
      }
    }
  }

  return findings;
}

// ---------- runBrainLint ----------

function filterFindingsByScope(
  findings: Finding[],
  opts: RunBrainLintOptions,
): Finding[] {
  const brainRoot = join(opts.cwd, 'brain');
  switch (opts.scope) {
    case 'full':
      return findings;
    case 'forge-only': {
      const forgePrefix = join(brainRoot, 'forge') + '/';
      return findings.filter((f) => f.file.startsWith(forgePrefix) || f.file.startsWith(join(brainRoot, 'forge') + '\\'));
    }
    case 'project-only': {
      if (!opts.project) return findings;
      const prefix = join(brainRoot, 'projects', opts.project) + '/';
      const prefixWin = join(brainRoot, 'projects', opts.project) + '\\';
      return findings.filter((f) => f.file.startsWith(prefix) || f.file.startsWith(prefixWin));
    }
    case 'single-file': {
      if (!opts.file) return findings;
      const target = resolve(opts.cwd, opts.file);
      return findings.filter((f) => f.file === target);
    }
    case 'cycle-touched-themes': {
      if (!opts.cycle) return findings;
      const cycleId = opts.cycle;
      // Re-walk themes; only keep findings whose theme references this cycle.
      const touched = new Set<string>();
      for (const file of readThemeFiles(brainRoot)) {
        let body: string;
        try {
          body = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        if (body.includes(`_raw/cycles/${cycleId}`) || body.includes(cycleId)) {
          touched.add(file);
        }
      }
      return findings.filter((f) => touched.has(f.file));
    }
    case 'cleanup-dry-run':
      // Inventory-only: surface contamination + orphans + length warnings, no errors.
      return findings;
    default:
      return findings;
  }
}

export function runBrainLint(opts: RunBrainLintOptions): RunBrainLintResult {
  // Run all checks. The scope filter is applied afterwards.
  const allFindings: Finding[] = [
    ...checkFrontmatter(opts.cwd),
    ...checkIndexSync(opts.cwd),
    ...checkSourceLinks(opts.cwd),
    ...checkStaleness(opts.cwd),
    ...checkOrphans(opts.cwd),
    ...checkLengthSoftCap(opts.cwd),
    ...checkContamination(opts.cwd),
    ...checkContradictions(opts.cwd),
    // S6A — cleanup-candidates only contributes when scope is
    // `cleanup-dry-run`; filterFindingsByScope drops everything else.
    ...(opts.scope === 'cleanup-dry-run' ? checkCleanupCandidates(opts.cwd) : []),
  ];

  let findings = filterFindingsByScope(allFindings, opts);

  // cleanup-dry-run never errors — it is inventory.
  if (opts.scope === 'cleanup-dry-run') {
    findings = findings.map((f) =>
      f.category === 'error' ? { ...f, category: 'flag' as FindingCategory } : f,
    );
  }

  // --fix mode: apply auto-fixes for safe categories.
  if (opts.fix) {
    // Currently we do not auto-rewrite categories (Tier B per the standing
    // destructive-instruction rule). The only auto-fix kind we ship is
    // INDEX.md regeneration, which is a separate CLI surface
    // (`forge brain index --write`). Document and leave as a no-op stub so
    // operator-confirm remains the gating step.
  }

  const hasError = findings.some((f) => f.category === 'error');
  return { findings, exitCode: hasError ? 1 : 0 };
}

// ---------- pretty-print ----------

function formatFindings(findings: Finding[], cwd: string): string {
  if (findings.length === 0) return '(no findings)';
  const errors = findings.filter((f) => f.category === 'error');
  const flags = findings.filter((f) => f.category === 'flag');
  const fixes = findings.filter((f) => f.category === 'auto-fix');
  const out: string[] = [];
  for (const [label, group] of [
    ['ERRORS', errors],
    ['FLAGS', flags],
    ['AUTO-FIXES', fixes],
  ] as const) {
    if (group.length === 0) continue;
    out.push(`## ${label} (${group.length})`);
    for (const f of group) {
      out.push(`- [${f.check ?? 'check'}] ${relative(cwd, f.file)}: ${f.message}`);
    }
    out.push('');
  }
  out.push(`Summary: ${errors.length} error(s), ${flags.length} flag(s), ${fixes.length} auto-fix(es).`);
  return out.join('\n');
}

// ---------- CLI entry ----------

function parseArgs(argv: string[]): RunBrainLintOptions {
  const opts: RunBrainLintOptions = {
    cwd: resolve(import.meta.dirname, '..'),
    scope: 'full',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scope') {
      const v = argv[++i];
      const allowed: Scope[] = [
        'full',
        'forge-only',
        'project-only',
        'single-file',
        'cycle-touched-themes',
        'cleanup-dry-run',
      ];
      if (!allowed.includes(v as Scope)) {
        throw new Error(`unknown --scope: ${v}`);
      }
      opts.scope = v as Scope;
    } else if (a === '--project') {
      opts.project = argv[++i];
    } else if (a === '--file') {
      opts.file = argv[++i];
    } else if (a === '--cycle') {
      opts.cycle = argv[++i];
    } else if (a === '--fix') {
      opts.fix = true;
    } else if (a === '--cwd') {
      opts.cwd = resolve(argv[++i]);
    }
  }
  return opts;
}

const isCli = process.argv[1] && process.argv[1].endsWith('brain-lint.ts');
if (isCli) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const result = runBrainLint(opts);
    process.stdout.write(formatFindings(result.findings, opts.cwd) + '\n');
    process.exit(result.exitCode);
  } catch (err) {
    process.stderr.write(`brain-lint: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
