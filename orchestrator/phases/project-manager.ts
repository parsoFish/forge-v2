/**
 * Project-manager phase runner. Extracted from cycle.ts (Phase 3.4c step 3).
 *
 * Invokes the PM skill via the Claude Agent SDK, validates the emitted work
 * items, and emits decomposition telemetry. Behaviour is identical to the
 * prior in-cycle implementation — this module only relocates the code so the
 * orchestration spine stays thin.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

import type { EventLogger } from '../logging.ts';
import { parseManifest, type InitiativeManifest } from '../manifest.ts';
import {
  PM_ALLOWED_TOOLS,
  PM_DISALLOWED_TOOLS,
  PM_MODEL,
  buildPmSystemPrompt,
  renderPmUserPrompt,
  renderPmHallucinationRetryAugment,
  tallyToolUse,
  type PmToolUseSummary,
} from '../pm-invocation.ts';
import {
  detectHiddenCoupling,
  readWorkItemsFromDir,
  validateWorkItemSet,
  type WorkItem,
} from '../work-item.ts';
import { recordBrainGateResult, type CycleInput } from '../cycle-context.ts';

/**
 * Injection seam for tests. The live cycle uses `sdkQuery` from the
 * Claude Agent SDK; cycle-pm-hallucination.test.ts supplies a stub that
 * returns a canned PM session per call so we can exercise the retry path
 * without hitting the network.
 */
export type PmQueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncIterable<unknown>;

export type RunProjectManagerOptions = {
  queryFn?: PmQueryFn;
};

/**
 * Defaults for the live PM invocation. Higher budget + turn cap than the bench
 * (real worktrees are richer than fixtures); the bench enforces 0.5 USD / 30
 * turns to keep iteration cheap.
 */
const PM_LIVE_MAX_TURNS = 50;
// F-42: PM budget floor bumped from $1.00 → $2.50. The 22:17
// simplification-source cycle hit $1.01 and emitted 0 WIs
// (pm-budget-exhausted). At trafficGame's scale (251 files) $1.00 wasn't
// enough headroom; $2.50 is generous there (PM peaks ~$1.50).
//
// F-43: $2.50 was a FLAT constant, so the classifier's pm-budget-exhausted
// recommendation ("increase cost_budget_usd in the manifest") was inert —
// the cap ignored the manifest entirely. terraform-provider-betterado (286
// *_test.go + a huge vendored tree) proved larger than any project tuned
// for: its PM blew $2.50 on the brain-first mandate + worktree exploration
// before emitting any WIs, failing INIT 01/03 and stalling 18 dependents.
// Fix: derive the cap from the initiative's own declared budget so big
// initiatives (which already declare big budgets) get proportional PM
// planning headroom, while $2.50 stays the floor (small projects + the PM
// bench, which pins its own 2.5, are unchanged — no regression). This also
// makes the classifier's existing recommendation actually true.
const PM_LIVE_MAX_BUDGET_USD_FLOOR = 2.5;
const PM_BUDGET_FRACTION_OF_INITIATIVE = 0.2;
function pmMaxBudgetUsd(initiativeCostBudgetUsd: number): number {
  return Math.max(
    PM_LIVE_MAX_BUDGET_USD_FLOOR,
    initiativeCostBudgetUsd * PM_BUDGET_FRACTION_OF_INITIATIVE,
  );
}

export async function runProjectManager(
  input: CycleInput,
  logger: EventLogger,
  options: RunProjectManagerOptions = {},
): Promise<void> {
  const start = logger.emit({
    initiative_id: input.initiativeId,
    phase: 'project-manager',
    skill: 'project-manager',
    event_type: 'start',
    input_refs: [input.manifestPath],
    output_refs: [],
  });

  const manifest = parseManifest(readFileSync(input.manifestPath, 'utf8'));
  const queryFn = options.queryFn ?? (sdkQuery as unknown as PmQueryFn);

  // First PM pass — the standard production behaviour. If it fails ONLY
  // because of a feature-hallucination (PM emitted FEAT-N not in the
  // manifest), C5b says: retry once with an augmented prompt that names
  // the manifest's feature IDs verbatim. Any other failure mode falls
  // through to the standard throw path.
  const first = await runOnePmPass({
    input,
    logger,
    manifest,
    parentEventId: start.event_id,
    queryFn,
    pass: 1,
    promptAugment: null,
  });

  if (first.kind === 'success') return;

  if (first.kind !== 'feature-hallucination') {
    throw new Error(`project-manager phase failed: ${first.summary}`);
  }

  // Hallucination retry per C5b. Emit a marker so the failure-classifier
  // can disambiguate the retry-path failure from a first-pass success.
  logger.emit({
    initiative_id: input.initiativeId,
    parent_event_id: start.event_id,
    phase: 'project-manager',
    skill: 'project-manager',
    event_type: 'log',
    input_refs: [input.manifestPath],
    output_refs: [],
    message: 'pm.feature-hallucination-retry',
    metadata: {
      pass: 1,
      hallucinated_feature_ids: first.hallucinated,
      manifest_feature_ids: manifest.features.map((f) => f.feature_id),
    },
  });

  const second = await runOnePmPass({
    input,
    logger,
    manifest,
    parentEventId: start.event_id,
    queryFn,
    pass: 2,
    promptAugment: renderPmHallucinationRetryAugment({
      knownFeatureIds: manifest.features.map((f) => f.feature_id),
      hallucinated: first.hallucinated,
    }),
  });

  if (second.kind === 'success') return;

  // Second pass also failed. If it's STILL a hallucination, classify and
  // throw distinctly so the cycle's failure-classifier picks up
  // pm-feature-hallucination (terminal — needs an architect amend, not
  // an auto-retry). Other failure modes (hidden coupling, schema, etc.)
  // fall back to the generic message and let their respective classifiers
  // route them.
  if (second.kind === 'feature-hallucination') {
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'project-manager',
      skill: 'project-manager',
      event_type: 'error',
      input_refs: [input.manifestPath],
      output_refs: [],
      message: 'pm.feature-hallucination',
      metadata: {
        passes_attempted: 2,
        hallucinated_feature_ids: second.hallucinated,
        manifest_feature_ids: manifest.features.map((f) => f.feature_id),
      },
    });
    throw new Error(
      `project-manager phase failed: feature_id hallucination persisted across 2 passes (last invented ${second.hallucinated.join(', ')}); manifest only declares ${manifest.features.map((f) => f.feature_id).join(', ')}`,
    );
  }
  throw new Error(`project-manager phase failed: ${second.summary}`);
}

type PmPassInput = {
  input: CycleInput;
  logger: EventLogger;
  manifest: InitiativeManifest;
  parentEventId: string;
  queryFn: PmQueryFn;
  pass: 1 | 2;
  /** Extra text appended to the standard PM prompt for retry-augmented passes. */
  promptAugment: string | null;
};

type PmPassOutcome =
  | { kind: 'success' }
  | { kind: 'feature-hallucination'; hallucinated: string[]; summary: string }
  | { kind: 'failure'; summary: string };

/**
 * Run one PM pass against the SDK, validate the emitted work-items, and
 * emit telemetry. Returns a discriminated outcome rather than throwing so
 * the outer orchestrator can decide whether to retry (hallucination) or
 * give up (anything else).
 */
async function runOnePmPass(p: PmPassInput): Promise<PmPassOutcome> {
  const { input, logger, manifest, parentEventId, queryFn, pass, promptAugment } = p;

  // F-21: wipe any stale `.forge/work-items/` inherited from the project's
  // base branch. The dev-loop's pre-review boundary snapshot historically
  // committed cycle scratch into project repos; without this wipe, the PM
  // agent sees pre-existing WI files and emits stale content (wrong
  // initiative_id, wrong work) instead of starting from a clean canvas.
  // Idempotent — missing dir is fine; gitignore is the structural fix,
  // this is the runtime backstop. On the retry pass this also clears the
  // hallucinated WI files from pass 1.
  const stalePmScratch = resolve(input.worktreePath, '.forge', 'work-items');
  if (existsSync(stalePmScratch)) {
    rmSync(stalePmScratch, { recursive: true, force: true });
  }

  const featureCountByFeatureId = new Map<string, number>();
  for (const f of manifest.features) featureCountByFeatureId.set(f.feature_id, 0);

  const forgeRoot = resolve(import.meta.dirname, '..', '..');
  const systemPrompt = buildPmSystemPrompt(forgeRoot);
  const featureCount = manifest.features.length;
  // C5 sizing band as ADVISORY range (operator note 2026-05-25: PM was
  // hitting the cap formulaically, over-decomposing to "look thorough"
  // instead of letting work-shape decide). Floor relaxed to 1 — a
  // trivial single-WI initiative is legitimate. Ceiling kept (rough cap
  // on cycle complexity) but PM may exceed if the work genuinely needs
  // it. The hint is what's surfaced to the agent; no orchestrator-side
  // rejection on count.
  const minWorkItems = 1;
  const maxWorkItems = featureCount > 4
    ? 2 * featureCount + 2
    : Math.min(2 * featureCount + 2, 8);
  // 2026-05-25 (claude-harness cycle 8 audit): read the project-shape
  // context off-disk and inject it into the prompt. PM was hallucinating
  // tooling (jest in a node:test project, npm run build with no build
  // script) because "go read package.json" wasn't load-bearing —
  // inlining the contents makes it so.
  const projectContext = readProjectContext(input.worktreePath);
  let prompt = renderPmUserPrompt({
    initiativeId: input.initiativeId,
    manifestRelPath: input.manifestPath,
    worktreeRelPath: input.worktreePath,
    projectName: manifest.project,
    minWorkItems,
    maxWorkItems,
    parallelFractionAtLeast: 0.3,
    manifestType: detectManifestType(manifest),
    knownFeatureIds: manifest.features.map((f) => f.feature_id),
    projectContext,
  });
  if (promptAugment) prompt = prompt + '\n\n' + promptAugment;

  const options: Record<string, unknown> = {
    // F-37: PM runs with cwd = the worktree, NOT forgeRoot. Previously
    // the PM agent's `Glob({pattern: 'src/**'})` resolved against forge's
    // own root (which has no src/ directory) — getting zero results, then
    // fabricating plausible paths from training-data priors (e.g.,
    // src/engine/physics.test.ts on a project that has no src/engine/).
    // With cwd at the worktree, every relative-path tool call sees the
    // actual project. The system prompt's brain content is captured at
    // build time so it's unaffected by the cwd switch.
    cwd: input.worktreePath,
    systemPrompt,
    model: PM_MODEL,
    permissionMode: 'acceptEdits',
    allowedTools: PM_ALLOWED_TOOLS,
    disallowedTools: PM_DISALLOWED_TOOLS,
    maxTurns: PM_LIVE_MAX_TURNS,
    maxBudgetUsd: pmMaxBudgetUsd(manifest.cost_budget_usd),
  };

  const toolUseSummary: PmToolUseSummary = { brainReads: 0, writes: 0, bashCalls: 0 };
  let costUsd = 0;
  let durationMs = 0;
  let resultSubtype: string | undefined;

  for await (const msg of queryFn({ prompt, options }) as AsyncIterable<unknown>) {
    if (typeof msg !== 'object' || msg === null) continue;
    const m = msg as { type?: string; message?: { content?: Array<{ type?: string; name?: string; input?: unknown }> }; subtype?: string; total_cost_usd?: number; duration_ms?: number };
    if (m.type === 'assistant') {
      tallyToolUse(m.message, toolUseSummary);
      continue;
    }
    if (m.type !== 'result') continue;
    if (typeof m.duration_ms === 'number') durationMs = m.duration_ms;
    if (typeof m.total_cost_usd === 'number') costUsd = m.total_cost_usd;
    resultSubtype = m.subtype ?? 'success';
    break;
  }

  for (let i = 0; i < toolUseSummary.brainReads; i++) {
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: parentEventId,
      phase: 'project-manager',
      skill: 'project-manager',
      event_type: 'tool_use',
      input_refs: ['brain/'],
      output_refs: [],
      message: 'pm.brain-query',
    });
  }

  // F-13 / F-19: enforce the brain-first mandate at the orchestrator. If the
  // PM agent skipped brain-query entirely, fail fast with a distinct error
  // (rather than continuing into validateWorkItemSet, where the
  // brain-skip's downstream effect — incomplete frontmatter — surfaces
  // instead, masking the real cause). Only enforced on the first pass:
  // the retry's augmented prompt is the orchestrator's "consult-the-brain
  // result" surface, and the second pass shouldn't re-burn that budget.
  if (
    pass === 1 &&
    !recordBrainGateResult('project-manager', 'project-manager', toolUseSummary.brainReads, {
      initiativeId: input.initiativeId,
      logger,
      parentEventId,
    })
  ) {
    return {
      kind: 'failure',
      summary:
        'brain-first mandate not honoured (0 brain-query calls). The system prompt requires reading from `brain/...` (forge themes + project themes) before producing work items.',
    };
  }

  const workItemsDir = resolve(input.worktreePath, '.forge', 'work-items');
  const { items, parseErrors } = readWorkItemsFromDir(workItemsDir);

  for (const item of items) {
    const prev = featureCountByFeatureId.get(item.feature_id) ?? 0;
    featureCountByFeatureId.set(item.feature_id, prev + 1);
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: parentEventId,
      phase: 'project-manager',
      skill: 'project-manager',
      event_type: 'log',
      input_refs: [input.manifestPath],
      output_refs: [resolve(workItemsDir, `${item.work_item_id}.md`)],
      message: 'pm.work-item-emitted',
      metadata: { work_item_id: item.work_item_id, feature_id: item.feature_id, pass },
    });
  }

  for (const [featureId, count] of featureCountByFeatureId.entries()) {
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: parentEventId,
      phase: 'project-manager',
      skill: 'project-manager',
      event_type: 'log',
      input_refs: [input.manifestPath],
      output_refs: [],
      message: 'pm.feature-decomposed',
      metadata: { feature_id: featureId, work_item_count: count, pass },
    });
  }

  const knownFeatureIds = new Set(manifest.features.map((f) => f.feature_id));
  const { perItem, setErrors } = validateWorkItemSet(items, {
    expectedInitiativeId: manifest.initiative_id,
    knownFeatureIds,
  });
  const itemErrorCount = Object.values(perItem).reduce((acc, errs) => acc + errs.length, 0);

  // F-05: hidden-coupling check. Two WIs whose `files_in_scope` overlap
  // without a `depends_on` edge between them will conflict at merge time.
  const couplingViolations = items.length > 0 ? detectHiddenCoupling(items) : [];

  const hallucinated = collectHallucinatedFeatureIds(items, knownFeatureIds);

  const failed =
    items.length === 0 ||
    Object.keys(parseErrors).length > 0 ||
    setErrors.length > 0 ||
    itemErrorCount > 0 ||
    couplingViolations.length > 0;

  logger.emit({
    initiative_id: input.initiativeId,
    parent_event_id: parentEventId,
    phase: 'project-manager',
    skill: 'project-manager',
    event_type: 'log',
    input_refs: [input.manifestPath],
    output_refs: [resolve(workItemsDir, '_graph.md')],
    message: 'pm.graph-emitted',
    metadata: { pass },
  });

  logger.emit({
    initiative_id: input.initiativeId,
    parent_event_id: parentEventId,
    phase: 'project-manager',
    skill: 'project-manager',
    event_type: failed ? 'error' : 'end',
    input_refs: [input.manifestPath],
    output_refs: [workItemsDir],
    duration_ms: durationMs,
    cost_usd: costUsd,
    metadata: {
      work_item_count: items.length,
      result_subtype: resultSubtype,
      tool_use: toolUseSummary,
      parse_errors: parseErrors,
      set_errors: setErrors,
      per_item_error_count: itemErrorCount,
      hidden_coupling_violations: couplingViolations,
      hallucinated_feature_ids: hallucinated,
      pass,
    },
  });

  if (!failed) return { kind: 'success' };

  // If the only validator-level error is the feature-hallucination set
  // (i.e., per_item_error_count is exactly the count of hallucinated WIs
  // and nothing else fails), surface as the dedicated kind so the
  // outer orchestrator can retry per C5b.
  const onlyHallucination =
    hallucinated.length > 0 &&
    items.length > 0 &&
    Object.keys(parseErrors).length === 0 &&
    setErrors.length === 0 &&
    couplingViolations.length === 0 &&
    itemErrorCount === hallucinated.length;

  const summary = [
    items.length === 0 ? 'no work items emitted' : null,
    Object.keys(parseErrors).length > 0 ? `parse errors: ${Object.keys(parseErrors).join(', ')}` : null,
    setErrors.length > 0 ? `set errors: ${setErrors.join('; ')}` : null,
    itemErrorCount > 0 ? `${itemErrorCount} per-item validation errors` : null,
    couplingViolations.length > 0
      ? `${couplingViolations.length} hidden-coupling pair(s): ${couplingViolations.map((p) => `${p.a}↔${p.b} share ${p.sharedFiles.join(',')}`).join('; ')}`
      : null,
  ]
    .filter((s): s is string => s !== null)
    .join('; ');

  if (onlyHallucination) {
    return { kind: 'feature-hallucination', hallucinated, summary };
  }
  return { kind: 'failure', summary };
}

/**
 * Walk the emitted work items and return the set of feature_ids that don't
 * appear in the manifest. Drives the retry path per C5b.
 */
function collectHallucinatedFeatureIds(
  items: ReadonlyArray<WorkItem>,
  knownFeatureIds: ReadonlySet<string>,
): string[] {
  const out = new Set<string>();
  for (const item of items) {
    if (item.feature_id && !knownFeatureIds.has(item.feature_id)) {
      out.add(item.feature_id);
    }
  }
  return [...out].sort();
}

/**
 * Detect the C27 manifest discriminator. The architect's manifest
 * frontmatter may carry `type: implementation | exploration`. Read it
 * defensively — most current manifests omit it, in which case the default
 * is `implementation`.
 */
/**
 * Read the project-shape context files off the worktree. Each is
 * optional — skipped if the file isn't present. Caps each file at
 * 8 KB so a freak large CLAUDE.md / package.json doesn't blow the
 * prompt budget; trims aren't ideal but the agent only needs enough
 * to identify the tooling.
 *
 * Surfaced 2026-05-25 by the claude-harness cycle 8 audit: PM was
 * hallucinating `jest` in a `node:test` project. Inlining
 * package.json's actual scripts makes it impossible to ignore.
 */
function readProjectContext(worktreePath: string): {
  packageJson?: string;
  pyprojectToml?: string;
  cargoToml?: string;
  forgeProjectJson?: string;
  claudeMd?: string;
} {
  const safeRead = (rel: string): string | undefined => {
    const p = resolve(worktreePath, rel);
    if (!existsSync(p)) return undefined;
    try {
      const raw = readFileSync(p, 'utf8');
      return raw.length > 8192 ? raw.slice(0, 8192) + '\n… (truncated)' : raw;
    } catch {
      return undefined;
    }
  };
  return {
    packageJson: safeRead('package.json'),
    pyprojectToml: safeRead('pyproject.toml'),
    cargoToml: safeRead('Cargo.toml'),
    forgeProjectJson: safeRead('.forge/project.json'),
    claudeMd: safeRead('CLAUDE.md'),
  };
}

function detectManifestType(manifest: InitiativeManifest): 'implementation' | 'exploration' {
  // The current InitiativeManifest type doesn't yet expose `type:` (it
  // arrives via S2B). Read the body for a frontmatter-shaped hint until
  // the field lands in the schema — robust against partial migrations.
  const m = manifest as unknown as { type?: string };
  if (m.type === 'exploration') return 'exploration';
  return 'implementation';
}
