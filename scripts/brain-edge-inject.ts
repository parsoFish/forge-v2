/**
 * brain-edge-inject — Stage 10 of brain-refinement-2026-05-23.
 *
 * Post-processes brain/forge-dev/graphify-out/graph.json to add `references` edges
 * derived from authored cross-references that graphify's pure-AST extractor
 * doesn't pick up:
 *
 *   1. brain/INDEX.md "## All themes (wikilink hub)" → one edge per [[slug]]
 *      pointing INDEX.md at every theme (makes INDEX a high-degree hub).
 *   2. Theme frontmatter `related_themes:` → one edge per slug (theme→theme).
 *   3. Theme body [[wikilinks]] in "## See also" sections (theme→theme),
 *      deduplicated against #2.
 *
 * Edges land in graphify's own JSON schema with confidence=EXTRACTED
 * (these are authored, not inferred). Idempotent — re-running produces
 * the same output.
 *
 * After this script runs, `graphify cluster-only .` re-clusters the graph
 * with the new edges; many theme communities collapse into the INDEX hub.
 *
 * Run from forge root:
 *   node --experimental-strip-types scripts/brain-edge-inject.ts
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import matter from 'gray-matter';

const FORGE = '/home/parso/forge';
const GRAPH_PATH = join(FORGE, 'brain/forge-dev/graphify-out/graph.json');
const INDEX_PATH = join(FORGE, 'brain/INDEX.md');

type Edge = {
  relation: string;
  confidence: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
  source_file: string;
  source_location: string;
  weight: number;
  source: string;
  target: string;
  confidence_score: number;
  context?: string;
};

type Graph = {
  directed: boolean;
  multigraph: boolean;
  graph: Record<string, unknown>;
  nodes: Array<{ id: string; label: string; source_file: string; source_location: string }>;
  links: Edge[];
  hyperedges?: unknown[];
  built_at_commit?: string;
};

function walkMarkdown(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walkMarkdown(p, out);
    else if (s.isFile() && p.endsWith('.md') && !p.endsWith('/README.md')) out.push(p);
  }
  return out;
}

function findThemeFiles(): string[] {
  const forgeThemes = walkMarkdown(join(FORGE, 'brain/forge/themes'));
  const projectsDir = join(FORGE, 'brain/projects');
  const projectThemes: string[] = [];
  for (const proj of readdirSync(projectsDir)) {
    try {
      const tdir = join(projectsDir, proj, 'themes');
      if (statSync(tdir).isDirectory()) walkMarkdown(tdir, projectThemes);
    } catch { /* no themes/ */ }
  }
  return [...forgeThemes, ...projectThemes];
}

/** Build a slug → file-node-id map by scanning the graph's L1 nodes. */
function buildSlugMap(graph: Graph): Map<string, { id: string; sourceFile: string }> {
  const map = new Map<string, { id: string; sourceFile: string }>();
  for (const n of graph.nodes) {
    if (n.source_location !== 'L1') continue;
    if (!n.source_file.endsWith('.md')) continue;
    const slug = basename(n.source_file, '.md');
    map.set(slug, { id: n.id, sourceFile: n.source_file });
  }
  return map;
}

/** Find the INDEX.md L1 node id. */
function findIndexNodeId(graph: Graph): string | null {
  for (const n of graph.nodes) {
    if (n.source_file === 'brain/INDEX.md' && n.source_location === 'L1') return n.id;
  }
  return null;
}

/** Parse [[slug]] wikilinks from a markdown string. Returns ordered slugs. */
function extractWikilinks(md: string): string[] {
  const out: string[] = [];
  const re = /\[\[([\w.\-]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) out.push(m[1]);
  return out;
}

function makeEdge(opts: {
  source: string;
  target: string;
  sourceFile: string;
  sourceLocation: string;
  relation?: string;
  context?: string;
}): Edge {
  return {
    relation: opts.relation ?? 'references',
    confidence: 'EXTRACTED',
    source_file: opts.sourceFile,
    source_location: opts.sourceLocation,
    weight: 1.0,
    source: opts.source,
    target: opts.target,
    confidence_score: 1.0,
    ...(opts.context ? { context: opts.context } : {}),
  };
}

function main() {
  const graph: Graph = JSON.parse(readFileSync(GRAPH_PATH, 'utf8'));
  const slugMap = buildSlugMap(graph);
  const indexId = findIndexNodeId(graph);
  if (!indexId) {
    console.error('FATAL: could not find INDEX.md node — has the graph been built?');
    process.exit(1);
  }

  // Existing-edge dedupe key: source|target|relation|context
  const existing = new Set<string>();
  for (const e of graph.links) {
    existing.add(`${e.source}|${e.target}|${e.relation}|${e.context ?? ''}`);
  }

  const newEdges: Edge[] = [];
  const stats = { fromIndex: 0, fromRelatedFrontmatter: 0, fromBodyWikilinks: 0, skippedUnknown: 0, skippedDup: 0 };

  // ─── 1. INDEX.md → every theme via the wikilink hub ───────────────────
  const indexBody = readFileSync(INDEX_PATH, 'utf8');
  const indexSlugs = extractWikilinks(indexBody);
  for (const slug of indexSlugs) {
    const target = slugMap.get(slug);
    if (!target) { stats.skippedUnknown++; continue; }
    const key = `${indexId}|${target.id}|references|index-hub`;
    if (existing.has(key)) { stats.skippedDup++; continue; }
    newEdges.push(makeEdge({
      source: indexId,
      target: target.id,
      sourceFile: 'brain/INDEX.md',
      sourceLocation: 'L1',
      relation: 'references',
      context: 'index-hub',
    }));
    existing.add(key);
    stats.fromIndex++;
  }

  // ─── 2. Theme frontmatter related_themes ─────────────────────────────
  // ─── 3. Theme body [[wikilinks]] ─────────────────────────────────────
  for (const themePath of findThemeFiles()) {
    const rawText = readFileSync(themePath, 'utf8');
    let fm: { data: Record<string, unknown>; content: string };
    try { fm = matter(rawText) as typeof fm; } catch { continue; }

    const slug = basename(themePath, '.md');
    const sourceFileRel = relative(FORGE, themePath);
    const sourceNode = slugMap.get(slug);
    if (!sourceNode) continue;

    // 2a. related_themes frontmatter
    const related = fm.data.related_themes;
    if (Array.isArray(related)) {
      for (const rt of related) {
        // Strip a stray ".md" suffix if an authoring tool included it.
        const targetSlug = String(rt).trim().replace(/\.md$/i, '');
        const target = slugMap.get(targetSlug);
        if (!target) { stats.skippedUnknown++; continue; }
        if (target.id === sourceNode.id) continue; // self
        const key = `${sourceNode.id}|${target.id}|related|frontmatter`;
        if (existing.has(key)) { stats.skippedDup++; continue; }
        newEdges.push(makeEdge({
          source: sourceNode.id,
          target: target.id,
          sourceFile: sourceFileRel,
          sourceLocation: 'L1',
          relation: 'related',
          context: 'frontmatter',
        }));
        existing.add(key);
        stats.fromRelatedFrontmatter++;
      }
    }

    // 2b. body [[wikilinks]] in ## See also (or anywhere in body)
    const bodyWikilinks = extractWikilinks(fm.content);
    for (const targetSlug of bodyWikilinks) {
      const target = slugMap.get(targetSlug);
      if (!target) { stats.skippedUnknown++; continue; }
      if (target.id === sourceNode.id) continue;
      // Dedupe against the related/frontmatter edge — same pair.
      const key = `${sourceNode.id}|${target.id}|related|wikilink`;
      const altKey = `${sourceNode.id}|${target.id}|related|frontmatter`;
      if (existing.has(key) || existing.has(altKey)) { stats.skippedDup++; continue; }
      newEdges.push(makeEdge({
        source: sourceNode.id,
        target: target.id,
        sourceFile: sourceFileRel,
        sourceLocation: 'L1',
        relation: 'related',
        context: 'wikilink',
      }));
      existing.add(key);
      stats.fromBodyWikilinks++;
    }
  }

  // ─── Merge into graph and write ─────────────────────────────────────
  graph.links.push(...newEdges);
  writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2), 'utf8');

  console.log(`Added ${newEdges.length} edges:`);
  console.log(`  ${stats.fromIndex.toString().padStart(4)} from INDEX hub`);
  console.log(`  ${stats.fromRelatedFrontmatter.toString().padStart(4)} from related_themes frontmatter`);
  console.log(`  ${stats.fromBodyWikilinks.toString().padStart(4)} from body [[wikilinks]]`);
  console.log(`Skipped:`);
  console.log(`  ${stats.skippedUnknown.toString().padStart(4)} unknown-slug targets`);
  console.log(`  ${stats.skippedDup.toString().padStart(4)} duplicates`);
  console.log(`Graph now: ${graph.nodes.length} nodes, ${graph.links.length} edges.`);
  console.log(`Run \`graphify cluster-only .\` from forge root to re-cluster with the new edges.`);
}

main();
