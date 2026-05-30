/**
 * Architect plan-doc operator artefact — renderer + feedback parser + writer.
 *
 * Stage S2A of the 2026-05-20 refinement batch. The architect's terminal step
 * is no longer "write manifests to `_queue/pending/`" — it's "write `PLAN.md`
 * (+ sibling `PLAN.html`) to `<projectRepoPath>/_architect/<session-id>/` for
 * the operator to review."
 *
 * Contracts honoured:
 *  - C12  — PLAN.md location is `<projectRoot>/_architect/<session-id>/PLAN.md`.
 *  - C19  — aggregate footprint is INFORMATIONAL ONLY (no gate, no threshold,
 *           no auto-escalation). The renderer pins this in the section title
 *           and body language; the test suite asserts the vocabulary.
 *  - C26  — if the session carries a `project_metrics` block (from
 *           `.forge/project.json`), the rendered PLAN.md surfaces the metric
 *           command + baselines_dir + tolerance alongside the manifest.
 *  - C27  — every session carries `type: 'implementation' | 'exploration'`.
 *           Exploration manifests render `parameter_space` + `hypothesis` +
 *           `metric_command` + `locked_baselines` and label `iteration_budget`
 *           as a hint not a contract.
 *
 * Cwc amendments (2026-05-24, see S2A-CWC-AMENDMENTS.md):
 *  - Amendment 1: the rendered "Operator brief + interview" section captures
 *    a paraphrase paragraph (session.vision) + a Q&A table from any
 *    `AskUserQuestion` rounds the architect ran (session.interview).
 *  - Amendment 2: `renderPlanHtml(session)` emits a zero-dep, single-file,
 *    inline-CSS HTML viewer next to PLAN.md. PLAN.md remains the only parse
 *    target; PLAN.html is read-only.
 *
 * Pure I/O surface:
 *  - `renderPlanDoc(session)`           — returns markdown string
 *  - `renderPlanHtml(session)`          — returns HTML string
 *  - `writePlanDoc(session, root)`      — returns PLAN.md path (also writes PLAN.html + council-transcript.md)
 *
 * The PLAN is reviewed + approved on the in-UI `/architect/<sid>` plan gate
 * (ADR 020/023); the operator's verdict comes through the bridge, not via
 * PLAN.md HTML-comment annotations (that CLI input flow was retired).
 */

import { writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { Flag, Escalation, CriticVerdict, OptionVisual } from '../skills/architect-llm-council/council.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InitiativeType = 'implementation' | 'exploration';

export type ProposedFeature = {
  feature_id: string;
  title: string;
  depends_on: string[];
};

export type ExplorationFields = {
  /** Markdown bullet list describing the parameter space. */
  parameter_space: string;
  /** One-line hypothesis the exploration is testing. */
  hypothesis: string;
  /** The metric command (same shape as `quality_gate_cmd`). */
  metric_command: string[];
  /** Paths to the baseline files this exploration is measured against. */
  locked_baselines: string[];
};

export type ProposedInitiative = {
  initiative_id: string;
  project: string;
  project_repo_path: string;
  title: string;
  iteration_budget: number;
  cost_budget_usd: number;
  /** Optional informational cost estimate surfaced in the aggregate footprint (C19). */
  estimated_cost_usd?: number;
  features: ProposedFeature[];
  /** Initiative-level dependencies on other initiatives (mirrors manifest.ts). */
  depends_on_initiatives?: string[];
  /** Raw manifest body — preserved verbatim in the PLAN.md drawer. */
  body: string;
  /** Set when this initiative is C27 `type: exploration`. */
  exploration?: ExplorationFields;
};

export type ProjectMetrics = {
  command: string[];
  baselines_dir: string;
  tolerance_pct?: number;
};

export type CouncilTranscript = {
  flags: Flag[];
  escalations: Escalation[];
  perCritic: { critic: string; verdict: CriticVerdict; costUsd: number }[];
  totalCostUsd: number;
};

export type BrainContextEntry = {
  /** Path under `brain/` that was consulted. */
  path: string;
  /** One-line summary of why this entry was relevant. */
  summary: string;
};

/** One round of the front-of-architect `AskUserQuestion` interview (cwc Amendment 1). */
export type InterviewRound = {
  /** The question the architect asked. */
  question: string;
  /** The operator's chosen answer; or `[operator skipped]` if they declined. */
  answer: string;
};

export type ArchitectSession = {
  /** `YYYY-MM-DDTHH-mm-ss`. */
  session_id: string;
  /** Project name (matches `manifest.project`). */
  project: string;
  /** Path to the project repo on disk. */
  project_repo_path: string;
  /** The operator's vision / brief, paraphrased back. */
  vision: string;
  /**
   * Interview Q&A rounds the architect ran with `AskUserQuestion` before
   * drafting (cwc Amendment 1). Empty array = no rounds, operator drafted
   * directly. The architect SKILL mandates ≥1 round in practice; the
   * renderer renders an empty array as `_no interview rounds — operator
   * drafted directly_`.
   */
  interview?: InterviewRound[];
  /** Brain entries the architect consulted while drafting. */
  brain_context: BrainContextEntry[];
  /** Raw council output (flags / escalations / per-critic + total cost). */
  council: CouncilTranscript;
  /** One or more drafted initiatives — NOT yet written to `_queue/pending/`. */
  initiatives: ProposedInitiative[];
  /** C27 discriminator. Defaults to `implementation` when undefined. */
  type?: InitiativeType;
  /** C26: when the project has a `metrics` block in `.forge/project.json`. */
  project_metrics?: ProjectMetrics;
  /** Optional list of unresolved taste decisions the operator must settle. */
  open_escalations?: Escalation[];
};

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const VERDICT_PLACEHOLDER = '<!-- verdict: approve | revise | reject -->';

export function renderPlanDoc(session: ArchitectSession): string {
  const type: InitiativeType = session.type ?? 'implementation';
  const parts: string[] = [];

  // Operator-edited verdict marker — placed at the very top so a grep for
  // `<!-- verdict:` is trivially first-hit. Order matters: the operator
  // edits the inner text but should never need to scroll.
  parts.push(VERDICT_PLACEHOLDER);
  parts.push('');
  parts.push(`# Architect plan — ${session.session_id}`);
  parts.push('');
  parts.push(`- Project: \`${session.project}\``);
  parts.push(`- Repo: \`${session.project_repo_path}\``);
  parts.push(`- Initiative type: \`${type}\``);
  parts.push('');

  // Operator quick-start — the plan is reviewed + approved on the in-UI plan gate.
  parts.push(
    '> **Operator review.** This plan is presented on the `/architect/' + session.session_id +
      '` screen in the forge UI. Read each section there, resolve the council\'s design ' +
      'decisions, and click **approve**, **revise**, or **reject** — the runner finalizes ' +
      'your verdict, promoting the manifests to the queue only on approve.',
  );
  parts.push('');

  // --- Operator brief + interview (cwc Amendment 1) ---
  parts.push('## Operator brief + interview');
  parts.push('');
  parts.push(session.vision.trim());
  parts.push('');
  parts.push('### Interview');
  parts.push('');
  const rounds = session.interview ?? [];
  if (rounds.length === 0) {
    parts.push('_No interview rounds — operator drafted directly._');
  } else {
    parts.push('| # | Question | Operator answer |');
    parts.push('|---|---|---|');
    rounds.forEach((r, i) => {
      const q = r.question.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      const a = r.answer.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      parts.push(`| ${i + 1} | ${q} | ${a} |`);
    });
  }
  parts.push('');

  // --- Brain context ---
  parts.push('## Brain context');
  parts.push('');
  if (session.brain_context.length === 0) {
    parts.push('_No brain entries consulted (brain-gap event emitted)._');
  } else {
    for (const entry of session.brain_context) {
      parts.push(`- \`${entry.path}\` — ${entry.summary}`);
    }
  }
  parts.push('');

  // --- Council transcript (aggregate flags + escalations, then one block per critic) ---
  parts.push('## Council transcript');
  parts.push('');
  parts.push(`Total cost: \`$${session.council.totalCostUsd.toFixed(4)}\``);
  parts.push('');

  // Aggregate flags (auto-applied across the council)
  if (session.council.flags.length > 0) {
    parts.push('### Flags (auto-applied)');
    parts.push('');
    for (const f of session.council.flags) {
      parts.push(`- \`${f.id}\` — ${f.description}. _Applied:_ ${f.appliedFix}`);
    }
    parts.push('');
  }

  // Aggregate escalations (de-duplicated across the council)
  if (session.council.escalations.length > 0) {
    parts.push('### Escalations (taste decisions surfaced)');
    parts.push('');
    for (const e of session.council.escalations) {
      parts.push(`- (${e.critic}) ${e.question}`);
      for (const o of e.options) {
        parts.push(`  - **${o.label}** — ${o.rationale}`);
      }
    }
    parts.push('');
  }

  for (const cr of session.council.perCritic) {
    parts.push(`### ${capitaliseCritic(cr.critic)} critic`);
    parts.push('');
    parts.push(`Cost: \`$${cr.costUsd.toFixed(4)}\``);
    parts.push('');
    if (cr.verdict.flags.length === 0) {
      parts.push('- _no mechanical flags_');
    } else {
      parts.push('**Flags (auto-resolved):**');
      parts.push('');
      for (const f of cr.verdict.flags) {
        parts.push(`- \`${f.id}\` — ${f.description}. _Applied:_ ${f.appliedFix}`);
      }
    }
    parts.push('');
    if (cr.verdict.escalations.length === 0) {
      parts.push('- _no taste escalations_');
    } else {
      parts.push('**Escalations (taste decisions):**');
      parts.push('');
      for (const e of cr.verdict.escalations) {
        parts.push(`- ${e.question}`);
        for (const o of e.options) {
          parts.push(`  - **${o.label}** — ${o.rationale}`);
        }
      }
    }
    parts.push('');
  }

  // --- Proposed initiatives ---
  parts.push('## Proposed initiatives');
  parts.push('');
  parts.push('| ID | Title | Features | Iteration budget | Depends on |');
  parts.push('|---|---|---|---|---|');
  for (const init of session.initiatives) {
    const dep = (init.depends_on_initiatives ?? []).join(', ') || '—';
    const budgetLabel = type === 'exploration'
      ? `${init.iteration_budget} (hint, not contract)`
      : String(init.iteration_budget);
    parts.push(
      `| \`${init.initiative_id}\` | ${init.title} | ${init.features.length} | ${budgetLabel} | ${dep} |`,
    );
  }
  parts.push('');

  // Per-initiative drawer with the full manifest body
  for (const init of session.initiatives) {
    parts.push(`### ${init.initiative_id} — drawer`);
    parts.push('');
    if (type === 'exploration' && init.exploration) {
      const ex = init.exploration;
      parts.push('**Exploration fields (C27):**');
      parts.push('');
      parts.push(`- iteration budget: ${init.iteration_budget} (hint, not contract — C27 L9)`);
      parts.push('- `parameter_space`:');
      parts.push('');
      for (const line of ex.parameter_space.split('\n')) {
        parts.push(`  ${line}`);
      }
      parts.push('');
      parts.push(`- \`hypothesis\`: ${ex.hypothesis}`);
      parts.push(`- \`metric_command\`: \`${ex.metric_command.join(' ')}\``);
      parts.push('- `locked_baselines`:');
      for (const b of ex.locked_baselines) {
        parts.push(`  - \`${b}\``);
      }
      parts.push('');
    }
    parts.push('```markdown');
    parts.push(init.body.trimEnd());
    parts.push('```');
    parts.push('');
  }

  // --- Project metrics (C26) ---
  if (session.project_metrics) {
    const m = session.project_metrics;
    parts.push('## Project metrics (per .forge/project.json)');
    parts.push('');
    parts.push(`- \`command\`: \`${m.command.join(' ')}\``);
    parts.push(`- \`baselines_dir\`: \`${m.baselines_dir}\``);
    if (typeof m.tolerance_pct === 'number') {
      parts.push(`- \`tolerance_pct\`: \`${m.tolerance_pct}\``);
    }
    parts.push('');
  }

  // --- Aggregate footprint (C19 — informational only) ---
  parts.push('## Aggregate footprint (informational)');
  parts.push('');
  parts.push(
    '_This block surfaces the **informational** footprint of the proposed initiatives — ' +
      'how many cycles + dollars they would consume if every one were queued today. ' +
      'It is informational only; forge does not enforce a budget or block at any number._',
  );
  parts.push('');
  const totalIterations = session.initiatives.reduce((s, i) => s + i.iteration_budget, 0);
  const knownCostInitiatives = session.initiatives.filter((i) => typeof i.estimated_cost_usd === 'number');
  const totalEstimatedCost = knownCostInitiatives.reduce((s, i) => s + (i.estimated_cost_usd ?? 0), 0);
  parts.push(`- Initiatives proposed: **${session.initiatives.length}**`);
  parts.push(`- Total iteration budget: **${totalIterations}**`);
  if (knownCostInitiatives.length === session.initiatives.length && session.initiatives.length > 0) {
    parts.push(`- Total estimated cost: **$${totalEstimatedCost.toFixed(2)}**`);
  } else if (knownCostInitiatives.length > 0) {
    parts.push(
      `- Total estimated cost (partial — ${knownCostInitiatives.length}/${session.initiatives.length} initiatives have estimates): **$${totalEstimatedCost.toFixed(2)}**`,
    );
  }
  if (type === 'exploration') {
    parts.push(
      '- _Note: this is an exploration initiative — iteration budgets are hints, not contracts (C27)._',
    );
  }
  parts.push('');

  // --- Open escalations (operator must resolve) ---
  const open = session.open_escalations ?? [];
  if (open.length > 0) {
    parts.push('## Open escalations');
    parts.push('');
    parts.push('_These taste decisions the council surfaced are unresolved. Resolve each inline ' +
      'with `<!-- review: ... -->` before approving, or explicitly defer in your verdict._');
    parts.push('');
    for (const e of open) {
      parts.push(`- (${e.critic}) ${e.question}`);
      for (const o of e.options) {
        parts.push(`  - **${o.label}** — ${o.rationale}`);
      }
    }
    parts.push('');
  }

  // --- Footer breadcrumb ---
  parts.push('---');
  parts.push('');
  parts.push(
    `_Generated by the architect runner on ${new Date().toISOString()}. ` +
      'Reviewed + approved on the `/architect` screen in the forge UI._',
  );
  parts.push('');

  return parts.join('\n');
}

function capitaliseCritic(name: string): string {
  if (name === 'dx') return 'DX';
  if (name === 'ceo') return 'CEO';
  return name[0]?.toUpperCase() + name.slice(1);
}

// ---------------------------------------------------------------------------
// HTML render (cwc Amendment 2)
// ---------------------------------------------------------------------------

/**
 * HTML-escape a string. Used for any session-derived content interpolated
 * into the PLAN.html template — the manifest bodies, vision text, interview
 * answers, council flags etc all flow through this.
 */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Phase C — render an option's visual (mockup / diagram / code) for the
 * comparative panel. `mockup-html` goes in a sandboxed iframe (no scripts, no
 * same-origin); diagram/code render as preformatted text to stay zero-dep.
 */
function renderOptionVisual(v?: OptionVisual): string {
  if (!v || v.kind === 'none' || !v.content) return '';
  const cap = v.caption ? `<div class="cap">${esc(v.caption)}</div>` : '';
  if (v.kind === 'mockup-html') {
    return `<div class="opt-visual"><iframe class="mockup" sandbox="" title="mockup" srcdoc="${esc(v.content)}"></iframe>${cap}</div>`;
  }
  if (v.kind === 'code') {
    const lang = v.language ? ` data-lang="${esc(v.language)}"` : '';
    return `<div class="opt-visual"><pre class="code"${lang}><code>${esc(v.content)}</code></pre>${cap}</div>`;
  }
  return `<div class="opt-visual"><pre class="diagram">${esc(v.content)}</pre>${cap}</div>`;
}

function renderTradeoffs(t?: { pros?: string[]; cons?: string[] }): string {
  const pros = t?.pros ?? [];
  const cons = t?.cons ?? [];
  if (pros.length === 0 && cons.length === 0) return '';
  return `<ul class="tradeoffs">${pros.map((p) => `<li class="pro">${esc(p)}</li>`).join('')}${cons.map((c) => `<li class="con">${esc(c)}</li>`).join('')}</ul>`;
}

/**
 * Phase C — one escalated decision as a comparative panel: the question + its
 * 2-4 options side by side, each a selectable card with rationale, tradeoffs,
 * and the option's visual. The radio is purely visual in the static file; the
 * in-UI gate (Phase D) wires selection to the commit. `data-*` mirrors the
 * decision/option identity for the gate + automation.
 */
function renderEscalationCard(e: Escalation, i: number): string {
  const name = `decision-${i}`;
  const opts = e.options
    .map(
      (o) => `      <label class="option" data-option-label="${esc(o.label)}" data-option-visual-kind="${esc(o.visual?.kind ?? 'none')}">
        <div class="opt-head"><input type="radio" name="${esc(name)}" value="${esc(o.label)}"><span class="label">${esc(o.label)}</span></div>
        <div class="rationale">${esc(o.rationale)}</div>
        ${renderTradeoffs(o.tradeoffs)}
        ${renderOptionVisual(o.visual)}
      </label>`,
    )
    .join('\n');
  return `    <div class="escalation" data-decision="${i}" data-escalation-id="esc-${i}" data-escalation-question="${esc(e.question)}">
      <div class="q"><span class="critic-chip">${esc(e.critic)}</span>${esc(e.question)}</div>
      <div class="options">
${opts}
      </div>
    </div>`;
}

/**
 * Render a feature dependency graph as inline SVG. Replaces the
 * informational cycle-diagram (operator pushback 2026-05-23: irrelevant —
 * the operator knows where they are in the cycle). The graph IS the value
 * markdown can't render: visual topology of feature edges, hover-revealed
 * titles, root highlighting.
 *
 * Layout algorithm: simple level-by-topo layout. Each feature's level =
 * 1 + max(level of its depends_on). Features at the same level stack
 * vertically. Edges drawn as orthogonal polylines with arrowheads.
 *
 * Sizing keeps within the page's max-width (1100px) for typical session
 * shapes (≤6 features). Wider shapes get horizontal scroll via the
 * wrapper's `overflow-x: auto`.
 */
function renderFeatureDepGraphSvg(init: ProposedInitiative): string {
  const features = init.features;
  if (features.length === 0) {
    return '<p class="empty">No features.</p>';
  }

  // Topological levels: feature.level = 1 + max(level of deps within this init).
  // Deps that reference unknown FEAT-ids (shouldn't happen for valid manifests)
  // are skipped silently — the layout still renders.
  const idToFeat = new Map(features.map((f) => [f.feature_id, f]));
  const levels = new Map<string, number>();
  const compute = (id: string, stack: Set<string>): number => {
    const cached = levels.get(id);
    if (cached !== undefined) return cached;
    if (stack.has(id)) return 0; // cycle protection (shouldn't happen)
    stack.add(id);
    const f = idToFeat.get(id);
    if (!f) return 0;
    const depLevels = f.depends_on.filter((d) => idToFeat.has(d)).map((d) => compute(d, stack));
    const lvl = depLevels.length === 0 ? 0 : Math.max(...depLevels) + 1;
    stack.delete(id);
    levels.set(id, lvl);
    return lvl;
  };
  for (const f of features) compute(f.feature_id, new Set());

  // Bucket features by level for vertical placement.
  const byLevel = new Map<number, ProposedFeature[]>();
  for (const f of features) {
    const lvl = levels.get(f.feature_id) ?? 0;
    const bucket = byLevel.get(lvl) ?? [];
    bucket.push(f);
    byLevel.set(lvl, bucket);
  }
  const maxLevel = Math.max(...levels.values());
  const maxRowsInAnyLevel = Math.max(...Array.from(byLevel.values()).map((b) => b.length));

  // Layout constants.
  const NODE_W = 200;
  const NODE_H = 56;
  const COL_GAP = 70;
  const ROW_GAP = 22;
  const PADDING = 16;
  const COLS = maxLevel + 1;
  const ROWS = maxRowsInAnyLevel;

  const width = PADDING * 2 + COLS * NODE_W + (COLS - 1) * COL_GAP;
  const height = PADDING * 2 + ROWS * NODE_H + (ROWS - 1) * ROW_GAP;

  // Compute each feature's (x, y) center.
  const positions = new Map<string, { x: number; y: number }>();
  for (let lvl = 0; lvl <= maxLevel; lvl++) {
    const bucket = byLevel.get(lvl) ?? [];
    const x = PADDING + lvl * (NODE_W + COL_GAP) + NODE_W / 2;
    const totalH = bucket.length * NODE_H + (bucket.length - 1) * ROW_GAP;
    const yStart = PADDING + (height - PADDING * 2 - totalH) / 2 + NODE_H / 2;
    bucket.forEach((f, idx) => {
      positions.set(f.feature_id, { x, y: yStart + idx * (NODE_H + ROW_GAP) });
    });
  }

  // Render node rects + labels.
  const nodes = features.map((f) => {
    const p = positions.get(f.feature_id)!;
    const isRoot = f.depends_on.length === 0;
    const titleTrim = f.title.length > 28 ? f.title.slice(0, 27) + '…' : f.title;
    return `    <g>
      <title>${esc(f.feature_id)}: ${esc(f.title)}</title>
      <rect class="node-box${isRoot ? ' root' : ''}" x="${p.x - NODE_W / 2}" y="${p.y - NODE_H / 2}" width="${NODE_W}" height="${NODE_H}" rx="4" ry="4"/>
      <text class="node-id" x="${p.x - NODE_W / 2 + 10}" y="${p.y - 8}">${esc(f.feature_id)}</text>
      <text class="node-title" x="${p.x - NODE_W / 2 + 10}" y="${p.y + 12}">${esc(titleTrim)}</text>
    </g>`;
  }).join('\n');

  // Render edges with arrowheads.
  const edges: string[] = [];
  for (const f of features) {
    const to = positions.get(f.feature_id);
    if (!to) continue;
    for (const depId of f.depends_on) {
      const from = positions.get(depId);
      if (!from) continue;
      const x1 = from.x + NODE_W / 2;
      const y1 = from.y;
      const x2 = to.x - NODE_W / 2 - 6; // leave room for arrowhead
      const y2 = to.y;
      const midX = (x1 + x2) / 2;
      edges.push(
        `    <path class="edge" d="M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}" marker-end="url(#arrow)"/>`,
      );
    }
  }

  return `<svg class="dep-graph" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path class="arrowhead" d="M 0 0 L 10 5 L 0 10 z"/>
      </marker>
    </defs>
${edges.join('\n')}
${nodes}
  </svg>`;
}

/**
 * Render a self-contained HTML viewer for the architect session. Zero
 * external deps — single HTML file, inline CSS, no JS framework. The
 * operator opens this in their browser; annotations still happen in
 * PLAN.md.
 *
 * cwc Amendment 2 + 2026-05-23 dogfood pushback: the cycle position diagram
 * was dropped (operator already knows where they are). Replaced with an
 * actual visual feature dependency graph (inline SVG) per initiative —
 * the genuine HTML value markdown can't render.
 */
export function renderPlanHtml(session: ArchitectSession): string {
  const type: InitiativeType = session.type ?? 'implementation';
  const rounds = session.interview ?? [];
  const totalIterations = session.initiatives.reduce((s, i) => s + i.iteration_budget, 0);
  const knownCost = session.initiatives.filter((i) => typeof i.estimated_cost_usd === 'number');
  const totalEstimated = knownCost.reduce((s, i) => s + (i.estimated_cost_usd ?? 0), 0);
  const open = session.open_escalations ?? [];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PLAN — ${esc(session.session_id)} — ${esc(session.project)}</title>
<style>
  /* Unified with the forge-ui dark stage so PLAN/DEMO + the live view share
     one theme inside the same app. Dark-only (the app has no light mode). */
  :root {
    --bg: #0a0e14;
    --fg: #e6edf3;
    --muted: #8b949e;
    --border: #21262d;
    --accent: #1f6feb;
    --brain: #d2a8ff;
    --user: #2ea043;
    --warn: #d29922;
    --code-bg: #0a0f16;
    --card-bg: #11161d;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2rem 1.5rem 4rem;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: var(--fg);
    background: var(--bg);
    line-height: 1.55;
    max-width: 1100px;
    margin-left: auto;
    margin-right: auto;
  }
  h1 { font-size: 1.75rem; margin: 0 0 0.25rem; letter-spacing: -0.01em; }
  h2 { font-size: 1.25rem; margin: 2.25rem 0 0.75rem; letter-spacing: -0.005em; }
  h3 { font-size: 1rem; margin: 1.25rem 0 0.5rem; }
  .meta { color: var(--muted); font-size: 0.85rem; margin-bottom: 1.5rem; }
  .meta code { background: var(--code-bg); padding: 0.1rem 0.35rem; border-radius: 3px; }
  .notice {
    background: var(--card-bg);
    border-left: 3px solid var(--accent);
    padding: 0.75rem 1rem;
    margin: 1rem 0 1.5rem;
    border-radius: 3px;
    font-size: 0.9rem;
  }
  .notice code { background: var(--code-bg); padding: 0.1rem 0.35rem; border-radius: 3px; }
  /* Feature dependency graph */
  .dep-graph-wrap {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1rem;
    margin: 0.75rem 0 1.25rem;
    overflow-x: auto;
  }
  .dep-graph-title { font-size: 0.85rem; color: var(--muted); margin-bottom: 0.5rem; }
  svg.dep-graph { display: block; min-width: 100%; }
  svg.dep-graph .node-box { fill: var(--bg); stroke: var(--border); stroke-width: 1; }
  svg.dep-graph .node-box.root { stroke: var(--accent); stroke-width: 2; }
  svg.dep-graph .node-id { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace; font-size: 11px; font-weight: 600; fill: var(--accent); }
  svg.dep-graph .node-title { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 11px; fill: var(--fg); }
  svg.dep-graph .edge { fill: none; stroke: var(--muted); stroke-width: 1.4; }
  svg.dep-graph .arrowhead { fill: var(--muted); }
  /* Tables */
  table { width: 100%; border-collapse: collapse; margin: 0.5rem 0 1rem; }
  th, td {
    padding: 0.5rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
    font-size: 0.9rem;
  }
  th { font-weight: 600; color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
  /* Footprint bar */
  .footprint {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1rem;
  }
  .footprint .bar {
    display: flex;
    width: 100%;
    height: 1.5rem;
    border-radius: 3px;
    overflow: hidden;
    margin: 0.5rem 0;
    background: var(--code-bg);
  }
  .footprint .seg {
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-size: 0.7rem;
    font-weight: 500;
    text-shadow: 0 0 2px rgba(0,0,0,0.5);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    padding: 0 0.25rem;
  }
  .footprint .summary { color: var(--muted); font-size: 0.85rem; margin-top: 0.25rem; }
  .footprint .info { color: var(--muted); font-size: 0.8rem; font-style: italic; margin-top: 0.5rem; }
  /* Escalation cards */
  .escalations { display: grid; gap: 1rem; }
  .escalation {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1rem;
  }
  .escalation .q {
    font-weight: 600;
    margin-bottom: 0.5rem;
  }
  .escalation .critic-chip {
    display: inline-block;
    font-size: 0.7rem;
    background: var(--accent);
    color: white;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    margin-right: 0.5rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .escalation .options {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 0.75rem;
    margin-top: 0.75rem;
    align-items: start;
  }
  .escalation .option {
    display: block;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.7rem 0.85rem;
    font-size: 0.85rem;
    cursor: pointer;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .escalation .option:hover { border-color: var(--accent); }
  .escalation .option:has(input:checked) { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .escalation .option .opt-head { display: flex; align-items: center; gap: 0.45rem; margin-bottom: 0.35rem; }
  .escalation .option .label { font-weight: 600; }
  .escalation .option .rationale { color: var(--muted); }
  .escalation .option .tradeoffs { list-style: none; padding: 0; margin: 0.5rem 0 0; font-size: 0.78rem; display: grid; gap: 0.15rem; }
  .escalation .option .tradeoffs .pro::before { content: '✓'; color: #2ea043; margin-right: 0.35rem; }
  .escalation .option .tradeoffs .con::before { content: '✕'; color: #cf222e; margin-right: 0.35rem; }
  .escalation .option .opt-visual { margin-top: 0.6rem; }
  .escalation .option .opt-visual iframe.mockup {
    width: 100%; height: 168px; border: 1px solid var(--border); border-radius: 5px; background: #0d1117;
  }
  .escalation .option .opt-visual pre.code,
  .escalation .option .opt-visual pre.diagram {
    background: var(--card-bg); border: 1px solid var(--border); border-radius: 5px;
    padding: 0.55rem 0.65rem; font-size: 0.72rem; line-height: 1.4; overflow: auto; max-height: 190px; margin: 0;
  }
  .escalation .option .opt-visual .cap { color: var(--muted); font-size: 0.72rem; font-style: italic; margin-top: 0.3rem; }
  /* Drawers */
  details {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem 1rem;
    margin: 0.5rem 0;
  }
  details summary {
    cursor: pointer;
    font-weight: 500;
    padding: 0.25rem 0;
  }
  details[open] summary { margin-bottom: 0.5rem; }
  pre {
    background: var(--code-bg);
    padding: 0.75rem 1rem;
    border-radius: 4px;
    overflow-x: auto;
    font-size: 0.8rem;
    line-height: 1.45;
  }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace; }
  ul, ol { padding-left: 1.5rem; }
  .empty { color: var(--muted); font-style: italic; }
  .badge {
    display: inline-block;
    background: var(--code-bg);
    color: var(--muted);
    padding: 0.1rem 0.5rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  }
  .badge.user { background: var(--user); color: white; }
  .badge.warn { background: var(--warn); color: white; }
</style>
</head>
<body>
  <h1>Architect plan — ${esc(session.session_id)}</h1>
  <div class="meta">
    Project <code>${esc(session.project)}</code>
    · Initiative type <code>${esc(type)}</code>
    · Repo <code>${esc(session.project_repo_path)}</code>
  </div>

  <div class="notice">
    <strong>This is a read-only viewer.</strong> Review the plan on the
    <code>/architect/${esc(session.session_id)}</code> screen in the forge UI and
    approve / revise / reject there.
  </div>

  <h2>Feature dependency graph</h2>
${session.initiatives.map((init) => `  <div class="dep-graph-wrap">
    ${session.initiatives.length > 1 ? `<div class="dep-graph-title"><code>${esc(init.initiative_id)}</code> — ${esc(init.title)}</div>` : ''}
    ${renderFeatureDepGraphSvg(init)}
  </div>`).join('\n')}

  <h2>Operator brief + interview</h2>
  <p>${esc(session.vision.trim()).replace(/\n+/g, '</p><p>')}</p>
  <h3>Interview</h3>
  ${rounds.length === 0
    ? '<p class="empty">No interview rounds — operator drafted directly.</p>'
    : `<table>
    <thead><tr><th>#</th><th>Question</th><th>Operator answer</th></tr></thead>
    <tbody>
${rounds.map((r, i) => `      <tr><td>${i + 1}</td><td>${esc(r.question)}</td><td>${esc(r.answer)}</td></tr>`).join('\n')}
    </tbody>
  </table>`}

  <h2>Brain context</h2>
  ${session.brain_context.length === 0
    ? '<p class="empty">No brain entries consulted (brain-gap event emitted).</p>'
    : `<ul>
${session.brain_context.map((e) => `    <li><code>${esc(e.path)}</code> — ${esc(e.summary)}</li>`).join('\n')}
  </ul>`}

  <h2>Council transcript</h2>
  <p class="meta">Total cost <code>$${session.council.totalCostUsd.toFixed(4)}</code></p>
  ${session.council.perCritic.map((cr) => `
  <details>
    <summary>${esc(capitaliseCritic(cr.critic))} critic — $${cr.costUsd.toFixed(4)}</summary>
    ${cr.verdict.flags.length === 0
      ? '<p class="empty">No mechanical flags.</p>'
      : `<h3>Flags (auto-resolved)</h3><ul>${cr.verdict.flags.map((f) => `<li><code>${esc(f.id)}</code> — ${esc(f.description)}. <em>Applied:</em> ${esc(f.appliedFix)}</li>`).join('')}</ul>`}
    ${cr.verdict.escalations.length === 0
      ? '<p class="empty">No taste escalations.</p>'
      : `<h3>Escalations</h3>${cr.verdict.escalations.map((e) => `<div class="escalation"><div class="q">${esc(e.question)}</div><div class="options">${e.options.map((o) => `<div class="option"><span class="label">${esc(o.label)}</span><span class="rationale">${esc(o.rationale)}</span></div>`).join('')}</div></div>`).join('')}`}
  </details>`).join('')}

  <h2>Proposed initiatives</h2>
  <table>
    <thead><tr><th>ID</th><th>Title</th><th>Features</th><th>Iteration budget</th><th>Depends on</th></tr></thead>
    <tbody>
${session.initiatives.map((i) => {
    const dep = (i.depends_on_initiatives ?? []).join(', ') || '—';
    const budgetLabel = type === 'exploration'
      ? `${i.iteration_budget} <span class="badge warn">hint</span>`
      : String(i.iteration_budget);
    return `      <tr><td><code>${esc(i.initiative_id)}</code></td><td>${esc(i.title)}</td><td>${i.features.length}</td><td>${budgetLabel}</td><td>${esc(dep)}</td></tr>`;
  }).join('\n')}
    </tbody>
  </table>

  ${session.initiatives.map((i) => `
  <details>
    <summary>${esc(i.initiative_id)} — ${esc(i.title)} (manifest body)</summary>
    ${type === 'exploration' && i.exploration ? `
    <h3>Exploration fields (C27)</h3>
    <ul>
      <li>iteration budget: ${i.iteration_budget} <span class="badge warn">hint, not contract</span></li>
      <li><code>hypothesis</code>: ${esc(i.exploration.hypothesis)}</li>
      <li><code>metric_command</code>: <code>${esc(i.exploration.metric_command.join(' '))}</code></li>
      <li><code>locked_baselines</code>: ${i.exploration.locked_baselines.map((b) => `<code>${esc(b)}</code>`).join(', ')}</li>
    </ul>
    <h4>Parameter space</h4>
    <pre>${esc(i.exploration.parameter_space)}</pre>` : ''}
    <h3>Manifest body</h3>
    <pre>${esc(i.body.trimEnd())}</pre>
  </details>`).join('')}

  ${session.project_metrics ? `
  <h2>Project metrics <span class="badge">.forge/project.json</span></h2>
  <ul>
    <li><code>command</code>: <code>${esc(session.project_metrics.command.join(' '))}</code></li>
    <li><code>baselines_dir</code>: <code>${esc(session.project_metrics.baselines_dir)}</code></li>
    ${typeof session.project_metrics.tolerance_pct === 'number'
      ? `<li><code>tolerance_pct</code>: <code>${session.project_metrics.tolerance_pct}</code></li>`
      : ''}
  </ul>` : ''}

  <h2>Aggregate footprint <span class="badge">informational</span></h2>
  <div class="footprint">
    <div class="summary">${session.initiatives.length} initiative${session.initiatives.length === 1 ? '' : 's'} · total iteration budget <strong>${totalIterations}</strong>${knownCost.length === session.initiatives.length && session.initiatives.length > 0 ? ` · total estimated cost <strong>$${totalEstimated.toFixed(2)}</strong>` : knownCost.length > 0 ? ` · partial estimated cost <strong>$${totalEstimated.toFixed(2)}</strong> (${knownCost.length}/${session.initiatives.length} initiatives have estimates)` : ''}</div>
    <div class="bar" role="img" aria-label="Iteration budget split across proposed initiatives">
${session.initiatives.map((i, idx) => {
    const pct = totalIterations > 0 ? (i.iteration_budget / totalIterations) * 100 : 0;
    const hue = (idx * 47) % 360;
    return `      <div class="seg" style="flex: ${i.iteration_budget}; background: hsl(${hue}, 55%, 50%);" title="${esc(i.initiative_id)} — ${i.iteration_budget} iterations">${pct >= 8 ? esc(i.initiative_id.replace(/^INIT-\d{4}-\d{2}-\d{2}-/, '')) : ''}</div>`;
  }).join('\n')}
    </div>
    <div class="info">Informational only. Forge does not enforce a budget or block at any number; the operator decides.${type === 'exploration' ? ' Exploration initiative: iteration budgets are hints, not contracts (C27).' : ''}</div>
  </div>

  ${open.length === 0 ? '' : `
  <h2>Design decisions</h2>
  <p class="meta">The council surfaced these taste decisions. Compare the options side by side — pick the one you want for each on the <code>/architect</code> plan gate; your selection is applied at approval.</p>
  <div class="escalations" data-section="design-decisions" data-decision-count="${open.length}">
${open.map((e, i) => renderEscalationCard(e, i)).join('\n')}
  </div>`}

  <hr style="margin: 3rem 0 1.5rem; border: none; border-top: 1px solid var(--border);">
  <div class="meta">
    Generated by the architect runner on ${new Date().toISOString()}.
    Reviewed + approved on the <code>/architect/${esc(session.session_id)}</code> screen.
  </div>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write PLAN.md (+ sibling PLAN.html + sibling council-transcript.md) for a
 * session. Returns the absolute path to the written `PLAN.md`. Creates the
 * parent directory as needed. C12: location is `<projectRoot>/_architect/<sid>/`.
 *
 * Three artefacts per session:
 *  - `PLAN.md`               — operator's annotation surface (parsed by the CLI)
 *  - `PLAN.html`             — read-only rich viewer (cwc Amendment 2)
 *  - `council-transcript.md` — raw council output, audit / machine-parse
 */
export function writePlanDoc(session: ArchitectSession, projectRoot: string): string {
  const sessionDir = resolve(projectRoot, '_architect', session.session_id);
  if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
  const planPath = join(sessionDir, 'PLAN.md');
  writeFileSync(planPath, renderPlanDoc(session));
  // Sibling rich viewer (cwc Amendment 2). Operator opens in browser; never
  // read back as input — PLAN.md is the only parse target.
  const htmlPath = join(sessionDir, 'PLAN.html');
  writeFileSync(htmlPath, renderPlanHtml(session));
  // Raw council transcript for auditability — referenced by PLAN.md's drawer
  // but kept separate so PLAN.md stays human-readable and the transcript
  // stays machine-parseable.
  const transcriptPath = join(sessionDir, 'council-transcript.md');
  writeFileSync(transcriptPath, renderCouncilTranscript(session));
  return planPath;
}

function renderCouncilTranscript(session: ArchitectSession): string {
  const lines: string[] = [];
  lines.push(`# Council transcript — ${session.session_id}`);
  lines.push('');
  lines.push(`Total cost: $${session.council.totalCostUsd.toFixed(4)}`);
  lines.push('');
  for (const cr of session.council.perCritic) {
    lines.push(`## ${capitaliseCritic(cr.critic)} (cost $${cr.costUsd.toFixed(4)})`);
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(cr.verdict, null, 2));
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Convenience: read the session dir layout (used by the CLI)
// ---------------------------------------------------------------------------

export type SessionPaths = {
  sessionDir: string;
  planPath: string;
  transcriptPath: string;
  feedbackPath: string;
  manifestsDir: string;
};

export function sessionPaths(projectRoot: string, sessionId: string): SessionPaths {
  const sessionDir = resolve(projectRoot, '_architect', sessionId);
  return {
    sessionDir,
    planPath: join(sessionDir, 'PLAN.md'),
    transcriptPath: join(sessionDir, 'council-transcript.md'),
    feedbackPath: join(sessionDir, 'feedback.md'),
    manifestsDir: join(sessionDir, 'manifests'),
  };
}

/**
 * Move a session dir to `_architect/_archived/<session-id>/`. Used by the
 * CLI on `reject`. Returns the archived path.
 */
export function archiveSessionDir(projectRoot: string, sessionId: string): string {
  const { sessionDir } = sessionPaths(projectRoot, sessionId);
  if (!existsSync(sessionDir)) {
    throw new Error(`archiveSessionDir: session dir not found: ${sessionDir}`);
  }
  const archivedRoot = resolve(projectRoot, '_architect', '_archived');
  if (!existsSync(archivedRoot)) mkdirSync(archivedRoot, { recursive: true });
  const target = join(archivedRoot, sessionId);
  // Use rename. node:fs renameSync requires same filesystem — within a
  // project repo that's always satisfied.
  if (existsSync(target)) {
    throw new Error(`archiveSessionDir: target already exists: ${target}`);
  }
  // Ensure parent of target exists (it does — we just created it).
  if (!existsSync(dirname(target))) mkdirSync(dirname(target), { recursive: true });
  renameSync(sessionDir, target);
  return target;
}
