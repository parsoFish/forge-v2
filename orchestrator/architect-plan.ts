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
 * Annotation format (operator-edits-this-file flow):
 *  - Top-of-file:  `<!-- verdict: approve | revise | reject -->`
 *  - Inline:       `<!-- review: free text up to next --> -->`
 *
 * These mirror the proven `pr-as-sole-review-window` pattern from the
 * reviewer phase — HTML comments are invisible in rendered markdown, easy to
 * grep, and don't perturb the manifest body content.
 *
 * Pure I/O surface:
 *  - `renderPlanDoc(session)`           — returns markdown string
 *  - `renderPlanHtml(session)`          — returns HTML string
 *  - `writePlanDoc(session, root)`      — returns PLAN.md path (also writes PLAN.html + council-transcript.md)
 *  - `parseFeedbackComments(planPath)`  — returns { verdict, annotations }
 *  - `bundleFeedbackAsMarkdown(anns)`   — returns markdown feedback.md body
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { Flag, Escalation, CriticVerdict } from '../skills/architect-llm-council/council.ts';

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

export type Verdict = 'approve' | 'revise' | 'reject';

export type Annotation = {
  /** 1-based line number where the `<!-- review: ... -->` comment appeared. */
  line: number;
  text: string;
};

export type FeedbackParseResult = {
  verdict: Verdict | null;
  annotations: Annotation[];
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

  // Operator quick-start. We avoid an inline literal `<!-- review: ... -->`
  // here because the parser would mistake it for an annotation; we describe
  // the marker shape in prose instead. The template form of the verdict
  // marker IS shown verbatim at the top of the file — the parser ignores
  // it because the inner text is the placeholder `approve | revise | reject`
  // (none of the three concrete verdict tokens).
  parts.push(
    '> **Operator review.** Read each section. Leave inline notes by adding an HTML ' +
      'comment of the form `(left-angle bang dash dash review:` your text `dash dash right-angle)` on its own line beside any item. ' +
      'Set the verdict at the top of this file by replacing the placeholder with ' +
      '`approve`, `revise`, or `reject`. Then run ' +
      `\`forge architect commit ${session.session_id}\` (or pass \`--via-pr\` for PR-comment review).`,
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
    `_Generated by the architect skill on ${new Date().toISOString()}. ` +
      'Edit this file in place; commit with `forge architect commit ' +
      `${session.session_id}\`._`,
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
 * Render a self-contained HTML viewer for the architect session. Zero
 * external deps — single HTML file, inline CSS, no JS framework. The
 * operator opens this in their browser; annotations still happen in
 * PLAN.md.
 *
 * The diagram mirrors the operator's hand-drawn forge cycle:
 *   architect (user) → initiative (+ html page) → feats → work items
 *                  → initiative branch → before/after demo+pr (user) → reflect (user)
 *   with graphify brain hovering above.
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
  :root {
    --bg: #fafaf7;
    --fg: #1d1d1f;
    --muted: #6a6a6f;
    --border: #d8d8d2;
    --accent: #5a4cad;
    --brain: #ad6fff;
    --user: #1a8a52;
    --warn: #c47a1e;
    --code-bg: #f1efe9;
    --card-bg: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #161617;
      --fg: #ececec;
      --muted: #9a9a9a;
      --border: #2d2d31;
      --accent: #a293ff;
      --brain: #c79bff;
      --user: #6dd2a0;
      --warn: #e0a35a;
      --code-bg: #1f1f22;
      --card-bg: #1d1d1f;
    }
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
  /* Forge cycle diagram */
  .cycle {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    margin: 1.25rem 0 2rem;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1.25rem 1rem;
    overflow-x: auto;
  }
  .cycle .brain-band {
    align-self: center;
    background: var(--brain);
    color: white;
    padding: 0.4rem 1.25rem;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 500;
    margin-bottom: 1rem;
    letter-spacing: 0.02em;
  }
  .cycle .flow {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: nowrap;
    min-width: 0;
  }
  .cycle .node {
    background: var(--bg);
    border: 1px solid var(--border);
    padding: 0.45rem 0.6rem;
    border-radius: 4px;
    font-size: 0.78rem;
    text-align: center;
    min-width: 70px;
    position: relative;
    white-space: nowrap;
  }
  .cycle .node.user::before {
    content: "👤";
    position: absolute;
    top: -1.2rem;
    left: 50%;
    transform: translateX(-50%);
    font-size: 0.9rem;
  }
  .cycle .node.this {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent);
  }
  .cycle .arrow { color: var(--muted); font-size: 1rem; flex-shrink: 0; }
  .cycle .stack {
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: stretch;
    min-width: 70px;
  }
  .cycle .stack .node { padding: 0.25rem 0.4rem; font-size: 0.7rem; }
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
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .escalation .option {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.6rem 0.75rem;
    font-size: 0.85rem;
  }
  .escalation .option .label { font-weight: 600; display: block; margin-bottom: 0.2rem; }
  .escalation .option .rationale { color: var(--muted); }
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
    <strong>This is a read-only viewer.</strong> Annotate the sibling
    <code>PLAN.md</code> with <code>&lt;!-- review: ... --&gt;</code> comments and set the
    top-of-file <code>&lt;!-- verdict: approve | revise | reject --&gt;</code>, then run
    <code>forge architect commit ${esc(session.session_id)}</code>.
  </div>

  <h2>Where this sits in the forge cycle</h2>
  <div class="cycle">
    <div class="brain-band">graphify brain</div>
    <div class="flow">
      <div class="node user this">architect</div>
      <span class="arrow">→</span>
      <div class="stack">
        <div class="node">initiative</div>
        <div class="node">+ html page</div>
      </div>
      <span class="arrow">→</span>
      <div class="stack">
        <div class="node">feat</div>
        <div class="node">feat</div>
        <div class="node">feat</div>
      </div>
      <span class="arrow">→</span>
      <div class="stack">
        <div class="node">work item</div>
        <div class="node">work item</div>
        <div class="node">…</div>
      </div>
      <span class="arrow">→</span>
      <div class="node">initiative branch</div>
      <span class="arrow">→</span>
      <div class="node user">before/after<br>demo + PR</div>
      <span class="arrow">→</span>
      <div class="node user">reflect</div>
    </div>
  </div>

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
  <h2>Open escalations</h2>
  <p class="meta">These taste decisions the council surfaced are unresolved. Resolve each inline in PLAN.md with <code>&lt;!-- review: ... --&gt;</code> before approving, or explicitly defer in your verdict.</p>
  <div class="escalations">
${open.map((e) => `    <div class="escalation"><span class="critic-chip">${esc(e.critic)}</span><div class="q" style="display:inline">${esc(e.question)}</div><div class="options">${e.options.map((o) => `<div class="option"><span class="label">${esc(o.label)}</span><span class="rationale">${esc(o.rationale)}</span></div>`).join('')}</div></div>`).join('\n')}
  </div>`}

  <hr style="margin: 3rem 0 1.5rem; border: none; border-top: 1px solid var(--border);">
  <div class="meta">
    Generated by the architect skill on ${new Date().toISOString()}.
    Edit <code>PLAN.md</code> in place; commit with
    <code>forge architect commit ${esc(session.session_id)}</code>.
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

const VERDICT_RE = /<!--\s*verdict:\s*(approve|revise|reject)\s*-->/i;
const REVIEW_RE = /<!--\s*review:\s*([\s\S]*?)\s*-->/i;

/**
 * Parse the operator-edited PLAN.md for the top-of-file verdict + inline
 * `<!-- review: ... -->` comments.
 *
 * - Verdict: first `<!-- verdict: approve|revise|reject -->` match wins;
 *   the literal placeholder `approve | revise | reject` (untouched template)
 *   is NOT a valid verdict — only one of the three concrete tokens counts.
 * - Annotations: every `<!-- review: ... -->` (one per line) gets recorded
 *   with its 1-based line number. Multi-line bodies are not supported.
 * - Annotations is always an array — never `null`.
 */
export function parseFeedbackComments(planDocPath: string): FeedbackParseResult {
  if (!existsSync(planDocPath)) {
    throw new Error(`parseFeedbackComments: file not found: ${planDocPath}`);
  }
  const text = readFileSync(planDocPath, 'utf8');
  const lines = text.split('\n');

  let verdict: Verdict | null = null;
  const annotations: Annotation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (verdict === null) {
      const m = VERDICT_RE.exec(line);
      if (m) {
        const v = m[1].toLowerCase();
        if (v === 'approve' || v === 'revise' || v === 'reject') {
          verdict = v;
        }
      }
    }
    const r = REVIEW_RE.exec(line);
    if (r) {
      annotations.push({ line: i + 1, text: r[1].trim() });
    }
  }

  return { verdict, annotations };
}

// ---------------------------------------------------------------------------
// Bundle feedback as markdown — fed back to the council on revise
// ---------------------------------------------------------------------------

export function bundleFeedbackAsMarkdown(annotations: Annotation[]): string {
  const lines: string[] = [];
  lines.push('# Operator feedback');
  lines.push('');
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push('');
  if (annotations.length === 0) {
    lines.push('_The operator set a revise verdict but added no inline annotations. ' +
      'Treat the bare revise as a no-op and regenerate the same PLAN.md._');
    lines.push('');
    return lines.join('\n');
  }
  lines.push('The operator left these inline notes on PLAN.md:');
  lines.push('');
  for (const a of annotations) {
    lines.push(`- (line ${a.line}) ${a.text}`);
  }
  lines.push('');
  lines.push('Address each note in the next draft.');
  lines.push('');
  return lines.join('\n');
}

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
