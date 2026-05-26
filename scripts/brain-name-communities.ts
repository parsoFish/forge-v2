/**
 * brain-name-communities — Stage 11 of brain-refinement-2026-05-23.
 *
 * Reads brain/forge-dev/graphify-out/graph.json + .graphify_labels.json, picks the
 * top-N most representative nodes per community, asks Claude (Haiku, via
 * the Claude Agent SDK — OAuth auth on the operator's Max plan, no API
 * key required) to propose a 2-4 word semantic name for each, then writes
 * the updated labels file back.
 *
 * The labels file format is { "<community_id>": "<name>", ... } —
 * graphify's own schema. `graphify cluster-only .` afterwards regenerates
 * the GRAPH_REPORT.md with the new names.
 *
 * Cost: ~$0.15–0.30 over ~300 communities (Haiku, batched ~20 per call).
 * Idempotent: only renames communities still labelled "Community N".
 *
 * Run from forge root:
 *   node --experimental-strip-types scripts/brain-name-communities.ts
 *   node --experimental-strip-types scripts/brain-name-communities.ts --force  # rename all
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const FORGE = '/home/parso/forge';
const GRAPH_PATH = join(FORGE, 'brain/forge-dev/graphify-out/graph.json');
const LABELS_PATH = join(FORGE, 'brain/forge-dev/graphify-out/.graphify_labels.json');
const BATCH_SIZE = 20;
const NODES_PER_COMMUNITY = 8;

type Node = { id: string; label: string; source_file: string; community: number };
type Graph = { nodes: Node[]; links: Array<{ source: string; target: string }> };

const force = process.argv.includes('--force');

function summariseCommunity(nodes: Node[]): { topLabels: string[]; topFiles: string[] } {
  // Most "representative" = file-level (L1) nodes + the headings with highest in-degree.
  const fileNodes = nodes.filter((n) => n.source_file && !n.label.startsWith('code:'));
  // Dedupe source files
  const files = new Set<string>();
  const topFiles: string[] = [];
  for (const n of fileNodes) {
    if (!files.has(n.source_file)) {
      files.add(n.source_file);
      topFiles.push(n.source_file);
    }
    if (topFiles.length >= NODES_PER_COMMUNITY) break;
  }
  const topLabels = nodes
    .filter((n) => !n.label.startsWith('code:'))
    .slice(0, NODES_PER_COMMUNITY)
    .map((n) => n.label);
  return { topLabels, topFiles };
}

async function namesForBatch(
  batch: Array<{ id: number; topLabels: string[]; topFiles: string[] }>,
): Promise<Record<string, string>> {
  const prompt = [
    'You are naming clusters in a knowledge graph of the "forge" agentic-orchestration codebase.',
    'For each cluster below, propose a SHORT semantic name: 2-4 words, lowercase except acronyms,',
    'no punctuation, no underscores or hyphens. Examples: "ralph loop runtime", "review verdict providers",',
    '"brain wiki schema", "PM work-item format".',
    '',
    'Reply with ONLY a JSON object mapping cluster id → name. No prose, no markdown fence.',
    '',
    'Clusters:',
    ...batch.map((b) => {
      const labels = b.topLabels.slice(0, 6).map((l) => l.slice(0, 60)).join(' | ');
      const files = b.topFiles.slice(0, 4).join(' | ');
      return `\n[${b.id}]\n  labels: ${labels}\n  files: ${files}`;
    }),
  ].join('\n');

  const iter = query({
    prompt,
    options: { model: 'claude-haiku-4-5', maxTurns: 1, allowedTools: [] },
  });
  let text = '';
  for await (const msg of iter) {
    if (msg.type === 'assistant') {
      for (const block of (msg.message?.content ?? [])) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((block as any).type === 'text') text += (block as any).text;
      }
    }
  }
  // Tolerate optional markdown code fence
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const parsed = JSON.parse(stripped);
    return parsed;
  } catch (e) {
    console.error(`Batch parse failed for ids [${batch.map((b) => b.id).join(',')}]; raw:\n${text.slice(0, 400)}`);
    return {};
  }
}

async function main() {
  const graph: Graph = JSON.parse(readFileSync(GRAPH_PATH, 'utf8'));
  const labels: Record<string, string> = JSON.parse(readFileSync(LABELS_PATH, 'utf8'));

  // Group nodes by community id
  const byCommunity = new Map<number, Node[]>();
  for (const n of graph.nodes) {
    if (typeof n.community !== 'number') continue;
    if (!byCommunity.has(n.community)) byCommunity.set(n.community, []);
    byCommunity.get(n.community)!.push(n);
  }

  // Skip communities already labelled non-default unless --force.
  const targets: Array<{ id: number; topLabels: string[]; topFiles: string[] }> = [];
  for (const [id, nodes] of byCommunity) {
    const cur = labels[String(id)];
    const isDefault = !cur || /^community\s+\d+$/i.test(cur);
    if (!isDefault && !force) continue;
    targets.push({ id, ...summariseCommunity(nodes) });
  }
  console.log(`Total communities: ${byCommunity.size}`);
  console.log(`To name: ${targets.length}${force ? ' (--force: rename all)' : ' (default only)'}`);

  let total = 0;
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    process.stdout.write(`  batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(targets.length / BATCH_SIZE)} (${batch.length}) ... `);
    const names = await namesForBatch(batch);
    let added = 0;
    for (const b of batch) {
      const proposed = names[String(b.id)];
      if (typeof proposed === 'string' && proposed.trim()) {
        labels[String(b.id)] = proposed.trim();
        added++;
      }
    }
    total += added;
    process.stdout.write(`${added}/${batch.length} named\n`);
    // Write incrementally so a crash doesn't lose progress.
    writeFileSync(LABELS_PATH, JSON.stringify(labels, null, 2), 'utf8');
  }
  console.log(`\nNamed ${total} communities. Labels file updated: ${LABELS_PATH}`);
  console.log(`Run \`graphify cluster-only .\` to regenerate GRAPH_REPORT.md with the new names.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
