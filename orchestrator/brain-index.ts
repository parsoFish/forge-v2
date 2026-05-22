/**
 * Brain navigation-index loader AND regenerator.
 *
 * Two surfaces:
 *
 *   loadBrainIndex(opts) — prompt-prefix loader. Reads existing index files +
 *                          glues them into one cache-friendly string. Used by
 *                          phases that want the navigation prefix at prompt time.
 *
 *   regenerateBrainIndex(opts) — rebuilds `brain/INDEX.md` from the filesystem
 *                                (theme counts + per-project sub-wiki listing
 *                                pulled from each `profile.md`). Idempotent;
 *                                byte-stable on identical input.
 *
 * The CLI surface is `forge brain index [--write]` — print by default,
 * regenerate INDEX.md with `--write`. The legacy `--scope <project>` flag is
 * preserved for `loadBrainIndex` (cache-friendly prefix mode).
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
// gray-matter parses frontmatter from `profile.md` for the sub-wiki one-liner.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import matter from 'gray-matter';

export type BrainCategory = 'pattern' | 'antipattern' | 'decision' | 'operation' | 'reference';

export type LoadBrainIndexOptions = {
  /** Forge root. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Project scope. When set, also loads `brain/projects/<scope>/{profile,patterns,antipatterns,decisions}.md`. */
  scope?: string | null;
  /** Category narrowing. When set, only loads `brain/INDEX.md` + the matching forge category index — keeps the prefix small enough that small models can find candidates without scanning 5×. */
  category?: BrainCategory | null;
};

const FORGE_CATEGORY_INDEXES = [
  'brain/INDEX.md',
  'brain/forge/patterns.md',
  'brain/forge/antipatterns.md',
  'brain/forge/decisions.md',
  'brain/forge/operations.md',
  'brain/forge/reference.md',
] as const;

const CATEGORY_TO_INDEX: Record<BrainCategory, string> = {
  pattern: 'brain/forge/patterns.md',
  antipattern: 'brain/forge/antipatterns.md',
  decision: 'brain/forge/decisions.md',
  operation: 'brain/forge/operations.md',
  reference: 'brain/forge/reference.md',
};

const PROJECT_INDEX_FILES = [
  'profile.md',
  'patterns.md',
  'antipatterns.md',
  'decisions.md',
] as const;

export function loadBrainIndex(opts: LoadBrainIndexOptions = {}): string {
  const cwd = opts.cwd ?? process.cwd();
  const sections: string[] = [];

  if (opts.category) {
    sections.push(renderSection(cwd, 'brain/INDEX.md'));
    sections.push(renderSection(cwd, CATEGORY_TO_INDEX[opts.category]));
  } else {
    for (const rel of FORGE_CATEGORY_INDEXES) {
      sections.push(renderSection(cwd, rel));
    }
  }

  if (opts.scope) {
    for (const file of PROJECT_INDEX_FILES) {
      const rel = `brain/projects/${opts.scope}/${file}`;
      const full = resolve(cwd, rel);
      if (existsSync(full)) sections.push(renderSection(cwd, rel));
    }
  }

  return sections.join('\n\n---\n\n');
}

function renderSection(cwd: string, rel: string): string {
  const full = resolve(cwd, rel);
  if (!existsSync(full)) return `<!-- BRAIN INDEX: ${rel} (missing) -->`;
  const body = readFileSync(full, 'utf8').trimEnd();
  return `<!-- BRAIN INDEX: ${rel} -->\n${body}`;
}

// ===========================================================================
// regenerator — `forge brain index --write`
// ===========================================================================

export type RegenerateBrainIndexOptions = {
  /** Forge root. Defaults to `process.cwd()`. */
  cwd?: string;
  /** If true, write the result to brain/INDEX.md; otherwise return the string. */
  write?: boolean;
};

export type RegenerateBrainIndexResult = {
  /** Regenerated INDEX.md content. */
  content: string;
  /** Absolute path the content was (or would be) written to. */
  path: string;
  /** True if INDEX.md was actually written (different from previous content). */
  changed: boolean;
  /** Inventory stats (handy for callers that want to log them). */
  stats: {
    forgeThemeCount: number;
    projectThemeCount: number;
    rawCount: number;
    projects: Array<{ name: string; description: string }>;
  };
};

function countMarkdownFiles(dir: string, opts: { exclude?: Set<string> } = {}): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir)) {
    if (opts.exclude?.has(entry)) continue;
    if (entry.endsWith('.md')) n += 1;
  }
  return n;
}

function countAllRawSources(rawRoot: string): number {
  if (!existsSync(rawRoot)) return 0;
  let n = 0;
  const stack: string[] = [rawRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (entry.endsWith('.md')) {
        n += 1;
      }
    }
  }
  return n;
}

function readProjectDescription(profilePath: string): string {
  if (!existsSync(profilePath)) return '';
  try {
    const raw = readFileSync(profilePath, 'utf8');
    const { data, content } = matter(raw);
    // Prefer the first non-heading, non-empty paragraph as the "one-paragraph hook".
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    const first = lines[0] ?? '';
    // Truncate to one sentence (or 200 chars).
    const sentence = first.split(/(?<=\.|\?|!)\s/)[0];
    const desc = sentence.length > 200 ? sentence.slice(0, 200).trimEnd() + '…' : sentence;
    return desc || String(data.description ?? '');
  } catch {
    return '';
  }
}

function inventoryProjects(brainRoot: string): Array<{ name: string; description: string }> {
  const projectsRoot = join(brainRoot, 'projects');
  if (!existsSync(projectsRoot)) return [];
  const out: Array<{ name: string; description: string }> = [];
  for (const entry of readdirSync(projectsRoot).sort()) {
    const dir = join(projectsRoot, entry);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    // Skip contamination dirs — they should be scrubbed, not listed.
    if (/^__/.test(entry)) continue;
    // Need a profile.md to be a "real" sub-wiki.
    const profile = join(dir, 'profile.md');
    if (!existsSync(profile)) continue;
    out.push({ name: entry, description: readProjectDescription(profile) });
  }
  return out;
}

export function regenerateBrainIndex(
  opts: RegenerateBrainIndexOptions = {},
): RegenerateBrainIndexResult {
  const cwd = opts.cwd ?? process.cwd();
  const brainRoot = join(cwd, 'brain');
  const indexPath = join(brainRoot, 'INDEX.md');

  const forgeThemeCount = countMarkdownFiles(join(brainRoot, 'forge', 'themes'), {
    exclude: new Set(['README.md']),
  });
  const projects = inventoryProjects(brainRoot);
  let projectThemeCount = 0;
  for (const p of projects) {
    projectThemeCount += countMarkdownFiles(join(brainRoot, 'projects', p.name, 'themes'), {
      exclude: new Set(['README.md']),
    });
  }
  const rawCount = countAllRawSources(join(brainRoot, '_raw'));

  const projectListing = projects
    .map((p) =>
      `- [${p.name}](./projects/${p.name}/profile.md)${p.description ? ` — ${p.description}` : ''}`,
    )
    .join('\n');

  const content = `# Brain — Meta-Index

> The brain is forge's persistent memory. This is the navigation hub: from here, drill into a category index → a theme page → the raw sources behind it.

**Status:** Generated by \`forge brain index --write\`. The brain holds **${forgeThemeCount} forge-level theme pages**, **${projectThemeCount} project-level theme pages** (across ${projects.length} sub-wikis), **${rawCount} raw sources** (\`_raw/docs/\`, \`_raw/web/\`, \`_raw/v1-wiki/\`, \`_raw/cycles/\`, \`_raw/projects/\`), and a benchmark question set. See [\`docs/seeding-plan.md\`](../docs/seeding-plan.md) and [\`log.md\`](./log.md).

## How to use this wiki

1. Start here. Pick a category or project below.
2. Open the category index — it lists theme pages with one-line descriptions.
3. Open a theme page — it summarises the topic in 15-40 lines and links to raw sources.
4. Follow raw links into [\`_raw/\`](./_raw/) when the theme page isn't enough.
5. For keyword search across raw: \`grep -r '<term>' brain/_raw/\`.

## Forge-system knowledge

- [Patterns](./forge/patterns.md) — proven approaches that work.
- [Antipatterns](./forge/antipatterns.md) — proven approaches that don't.
- [Decisions](./forge/decisions.md) — ADRs and the reasoning behind durable choices.
- [Operations](./forge/operations.md) — how to run / monitor / recover the system.
- [Reference](./forge/reference.md) — system overviews, profiles, comparisons, glossaries.

## Per-project sub-wikis

Each project has a \`profile.md\` (who / what / taste / hard-constraints) and a \`themes/\` directory with project-specific patterns, antipatterns, and decisions.

${projectListing}

## Conventions

- **Three layers**: \`_raw/\` (immutable raw sources) → \`forge/themes/\` and \`projects/<name>/themes/\` (15-40-line theme pages indexing the raw layer) → category index pages and this INDEX (pure navigation).
- **No long summaries** — many small theme pages > few large summaries (Karpathy).
- **Theme page format** — see [\`forge/themes/README.md\`](./forge/themes/README.md).
- **Lint rules** — see [\`LINT.md\`](./LINT.md).
- **Operations log** — append significant operations to [\`log.md\`](./log.md).

## Maintenance

- \`forge brain index --write\` — regenerate this file from the filesystem.
- \`forge brain lint\` — run structural integrity checks; flags orphans, malformed frontmatter, broken citations, contamination, oversized themes.
- \`brain-query\` / \`brain-ingest\` skills — query the brain / ingest new sources.
`;

  let changed = false;
  if (opts.write) {
    let prev = '';
    if (existsSync(indexPath)) prev = readFileSync(indexPath, 'utf8');
    if (prev !== content) {
      writeFileSync(indexPath, content);
      changed = true;
    }
  }

  return {
    content,
    path: indexPath,
    changed,
    stats: {
      forgeThemeCount,
      projectThemeCount,
      rawCount,
      projects,
    },
  };
}

// ---------- CLI entry ----------

const isCli = process.argv[1] && process.argv[1].endsWith('brain-index.ts');
if (isCli) {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const cwdIdx = argv.indexOf('--cwd');
  const cwd = cwdIdx >= 0 ? resolve(argv[cwdIdx + 1]) : resolve(import.meta.dirname, '..');

  // If `--scope <project>` is given (legacy loadBrainIndex behaviour), use the
  // prompt-prefix loader.
  const scopeIdx = argv.indexOf('--scope');
  if (scopeIdx >= 0 && !write) {
    const scope = argv[scopeIdx + 1] ?? null;
    process.stdout.write(loadBrainIndex({ cwd, scope }) + '\n');
    process.exit(0);
  }

  try {
    const result = regenerateBrainIndex({ cwd, write });
    if (write) {
      process.stdout.write(
        `brain-index: ${result.changed ? 'updated' : 'unchanged'} ${result.path}\n` +
          `  ${result.stats.forgeThemeCount} forge themes, ` +
          `${result.stats.projectThemeCount} project themes, ` +
          `${result.stats.rawCount} raw sources, ` +
          `${result.stats.projects.length} sub-wikis\n`,
      );
    } else {
      process.stdout.write(result.content);
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`brain-index: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
