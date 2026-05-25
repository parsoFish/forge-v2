'use client';

/**
 * AgentHexCanvas — hexagonal canvas visualisation of a single cycle's phase
 * pipeline. Inspired by patoles/agent-flow (hex nodes, outline-encoded
 * status, cost pills, tapered edges) but rendered with raw HTML5 Canvas
 * so a future animation pass can drive frame-by-frame redraws without
 * SVG / framer-motion churn.
 *
 * Pixel layout is fixed (800x280) and the wrapper provides overflow-x:
 * auto for narrow viewports. Per the forge DOM-as-metrics convention,
 * pixel-only state on the canvas is mirrored to sibling absolutely-
 * positioned `<div data-phase-hex>` elements so playwright / probes can
 * read state without parsing canvas bitmap data.
 *
 * MVP: nothing animated. The redraw effect runs on prop change only.
 * Hooks for the follow-up animation pass:
 *   - active phase outline → dashed-marquee or pulse (rAF loop, redraw)
 *   - active→next edge → flowing dotted line (offset uniform per frame)
 *   - cost pill → number-rollup tween when cost increases
 *   - hex fill → subtle inner glow that pulses with `lastEventAt` deltas
 */

import { useEffect, useRef } from 'react';

import type { CostSummary, InitiativeFeature } from '@/lib/bridge-client';
import { PHASE_ORDER, type Phase, type PhaseState, type PhaseStatus } from '@/lib/phases';
import type { WiStatus } from '@/lib/wi-status';

import { ArtifactBadge } from './CycleArtifacts';

export type CanvasWorkItem = {
  id: string;
  title: string;
  /** Optional — when set, the WI hex renders under its feature column. */
  featureId?: string;
  /** WI IDs this one depends on (used to draw cross-column edges). */
  dependsOn: readonly string[];
  /**
   * Per-WI status — drives the hex's own colour. Independent from
   * siblings (operator note 2026-05-25: a failing WI must not turn
   * its siblings red). Defaults to 'pending' when omitted.
   */
  status?: WiStatus;
};

type Props = {
  phaseStates: readonly PhaseState[];
  cost?: CostSummary | null;
  /**
   * Optional manifest features. When present + PM is non-pending, the
   * feature tier renders below the dev-loop hex. Per the 2026-05-25
   * operator note: the middle panes merge into a single cascading
   * visualization rooted at the phase row; features and WIs branch off
   * under the dev-loop hex (and only show once PM has actually
   * decomposed them).
   */
  features?: readonly InitiativeFeature[];
  /**
   * Optional WI tier. When present + PM is non-pending, each WI renders
   * as a small hex grouped under its feature column. Cross-feature
   * `dependsOn` edges render as thin lines between WI hexes.
   */
  workItems?: readonly CanvasWorkItem[];
  /**
   * Per-feature rolled-up status (worst-case of its WIs). When omitted
   * the canvas falls back to inheriting from the dev-loop phase
   * status. Operator note 2026-05-25: features render in their own
   * status independent of sibling features.
   */
  featureStatuses?: Readonly<Record<string, WiStatus>>;
  /**
   * Active cycle id — when set, the canvas renders the plan + demo
   * artifact badges as overlays above the architect and reflection
   * hexes respectively. Demo badge stays hidden until review-loop or
   * reflection is non-pending (per Bug 4 fix).
   */
  cycleId?: string | null;
};

// ---- layout constants ----------------------------------------------------

const CANVAS_W = 800;
const CANVAS_BASE_H = 280;
const HEX_RADIUS = 50; // vertex-to-center
const HEX_SPACING = 130; // center-to-center along x
const FIRST_HEX_X = 85;
const HEX_Y = 140;
const PILL_W = 60;
const PILL_H = 20;
const PILL_GAP = 14; // gap between pill bottom and hex top
const EDGE_STROKE_SOURCE = 6;
const EDGE_STROKE_DEST = 1.5;
const OUTLINE_W = 3;

// Mirror-div size for DOM-as-metrics overlay (matches task spec).
const HEX_DIV_W = 100;
const HEX_DIV_H = 80;

// Feature tier (renders below dev-loop hex when features are supplied
// AND the PM phase has at least started — features ARE materialised by
// PM, so showing them pre-PM telegraphs unfinished state per operator
// note 2026-05-25).
const FEATURE_HEX_RADIUS = 36;
const FEATURE_HEX_Y = HEX_Y + HEX_RADIUS + 110; // 110px gap = trunk + branch
const FEATURE_HEX_DIV_W = 80;
const FEATURE_HEX_DIV_H = 60;
const FEATURE_SPACING_MIN = 100;
const FEATURE_TIER_EXTRA_H = 180; // canvas height added when feature tier is present

// WI tier (renders below the feature row when WIs are supplied AND PM
// has started). Smaller hexes again. Multiple WIs in a feature stack
// horizontally inside the feature's column.
const WI_HEX_RADIUS = 26;
const WI_HEX_Y = FEATURE_HEX_Y + FEATURE_HEX_RADIUS + 90;
const WI_HEX_DIV_W = 70;
const WI_HEX_DIV_H = 50;
const WI_SUBCOL_SPACING = 60; // horizontal spacing between WIs inside one feature
const WI_TIER_EXTRA_H = 140;  // canvas height added when WI tier is present

// Dev-loop's index in PHASE_ORDER. The feature tier hangs below this hex.
const DEV_LOOP_INDEX = PHASE_ORDER.indexOf('developer-loop');

// ---- colour palette ------------------------------------------------------

// Hex fills + outlines per status. PhaseStatus is a subset of WiStatus
// (WiStatus adds 'retrying' for the "had a transient error mid-cycle"
// state). Phase hexes only ever read the four PhaseStatus keys; feature
// + WI hexes read the full WiStatus map. Operator palette intent:
// blue = working, green = done, yellow = retrying, red = full failure.
const FILL: Record<WiStatus, string> = {
  pending: '#161b22',
  active: '#0d1f3a',
  complete: '#0c2117',
  retrying: '#332a0a',
  failed: '#2d0d0f',
};

const OUTLINE: Record<WiStatus, string> = {
  pending: '#30363d',
  active: '#58a6ff',
  complete: '#7ee787',
  retrying: '#d29922',
  failed: '#f85149',
};

const TEXT_PRIMARY = '#e6edf3';
const TEXT_MUTED = '#8b949e';
const PILL_FILL = '#21262d';
const PILL_BORDER = '#d2a8ff';
const PILL_TEXT = '#d2a8ff';
const CANVAS_BG = '#0c1115';

// Short label for each phase that fits inside the hex.
const SHORT_LABEL: Record<Phase, string> = {
  'architect': 'architect',
  'project-manager': 'pm',
  'developer-loop': 'dev-loop',
  'review-loop': 'review',
  'closure': 'closure',
  'reflection': 'reflect',
};

// ---- component -----------------------------------------------------------

export function AgentHexCanvas({ phaseStates, cost = null, features, workItems, featureStatuses, cycleId = null }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Always render the canonical six phases in canonical order. The prop
  // is permitted to be partial / out-of-order; we look up by name.
  const ordered: PhaseState[] = PHASE_ORDER.map((phase) => {
    const match = phaseStates.find((s) => s.phase === phase);
    return match ?? { phase, status: 'pending' };
  });

  // Per operator note 2026-05-25: tie visuals to actual events, not
  // synthetic phase-status gates. The page passes only the features
  // that have been ack'd by `pm.feature-decomposed` events and only the
  // WIs that have been ack'd by `pm.work-item-emitted` events, so this
  // canvas just renders what's been materialised. The lists naturally
  // come up empty pre-PM and fill in as PM emits each event.
  const featList = features ?? [];
  const wiList = workItems ?? [];
  const hasFeatures = featList.length > 0;
  const hasWis = wiList.length > 0;
  const canvasH =
    CANVAS_BASE_H +
    (hasFeatures ? FEATURE_TIER_EXTRA_H : 0) +
    (hasWis ? WI_TIER_EXTRA_H : 0);

  // Feature row centred under the dev-loop hex. Computed once so the
  // edge drawing and the overlay divs agree on positions.
  const devLoopCx = FIRST_HEX_X + DEV_LOOP_INDEX * HEX_SPACING;
  const featurePositions = computeFeaturePositions(featList.length, devLoopCx);

  // WI positions: group WIs by their featureId, then spread each group
  // horizontally beneath its feature column. Unmapped WIs (featureId
  // missing) go beneath the dev-loop column as a catch-all.
  const wiPositions = computeWiPositions(wiList, featList, featurePositions, devLoopCx);

  const reviewStatus = ordered.find((p) => p.phase === 'review-loop')?.status ?? 'pending';
  // Demo badge surfaces once the review-loop has started — it's the
  // reviewer's surface, so it lives under the review hex (operator
  // note 2026-05-25).
  const demoVisible = reviewStatus !== 'pending';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // High-DPI: draw at devicePixelRatio so hex outlines stay crisp.
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    if (canvas.width !== CANVAS_W * dpr || canvas.height !== canvasH * dpr) {
      canvas.width = CANVAS_W * dpr;
      canvas.height = canvasH * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear: explicit fill rather than clearRect so the panel bg is solid
    // (matches forge's dark theme; avoids flicker on prop change).
    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, CANVAS_W, canvasH);

    // 1) Phase-row edges first so hex fills overlap their endpoints.
    for (let i = 0; i < ordered.length - 1; i += 1) {
      drawTaperedEdge(
        ctx,
        FIRST_HEX_X + i * HEX_SPACING,
        HEX_Y,
        FIRST_HEX_X + (i + 1) * HEX_SPACING,
        HEX_Y,
        OUTLINE[ordered[i].status],
      );
    }

    // 2) Feature-tier branch tree: trunk from dev-loop hex bottom down
    //    to a horizontal junction, then per-feature branches down to
    //    each feature hex. Drawn before the hexes so the hexes overlap
    //    the line ends cleanly. Trunk colour reflects the dev-loop
    //    hex's own status; individual branches inherit it.
    if (hasFeatures) {
      const devLoopStatus = ordered[DEV_LOOP_INDEX].status;
      const branchColor = OUTLINE[devLoopStatus];
      const trunkTop = HEX_Y + HEX_RADIUS;
      const junctionY = trunkTop + (FEATURE_HEX_Y - FEATURE_HEX_RADIUS - trunkTop) / 2;
      // Vertical trunk
      ctx.strokeStyle = branchColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(devLoopCx, trunkTop);
      ctx.lineTo(devLoopCx, junctionY);
      ctx.stroke();
      // Horizontal junction across feature row
      if (featurePositions.length > 1) {
        const minX = featurePositions[0];
        const maxX = featurePositions[featurePositions.length - 1];
        ctx.beginPath();
        ctx.moveTo(minX, junctionY);
        ctx.lineTo(maxX, junctionY);
        ctx.stroke();
      }
      // Per-feature drop lines
      for (const cx of featurePositions) {
        ctx.beginPath();
        ctx.moveTo(cx, junctionY);
        ctx.lineTo(cx, FEATURE_HEX_Y - FEATURE_HEX_RADIUS);
        ctx.stroke();
      }
    }

    // 3) Phase hexes + labels.
    ordered.forEach((state, i) => {
      const cx = FIRST_HEX_X + i * HEX_SPACING;
      drawHex(ctx, cx, HEX_Y, HEX_RADIUS, FILL[state.status], OUTLINE[state.status]);

      // Phase name + status text, both centered horizontally.
      ctx.fillStyle = TEXT_PRIMARY;
      ctx.font = '600 13px Inter, ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(SHORT_LABEL[state.phase], cx, HEX_Y - 6);

      ctx.fillStyle = TEXT_MUTED;
      ctx.font = '500 11px Inter, ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(state.status, cx, HEX_Y + 12);
    });

    // 4) Feature hexes — each in its OWN rolled-up status (operator
    //    note 2026-05-25). A failing feature doesn't tint its siblings;
    //    a green sibling stays green next to a yellow one.
    if (hasFeatures) {
      const devLoopStatus = ordered[DEV_LOOP_INDEX].status;
      featList.forEach((f, i) => {
        const cx = featurePositions[i];
        const status = featureStatuses?.[f.featureId] ?? devLoopStatus;
        drawHex(ctx, cx, FEATURE_HEX_Y, FEATURE_HEX_RADIUS, FILL[status], OUTLINE[status]);
        ctx.fillStyle = TEXT_PRIMARY;
        ctx.font = '600 11px Inter, ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(f.featureId, cx, FEATURE_HEX_Y - 6);
        ctx.fillStyle = TEXT_MUTED;
        ctx.font = '500 10px Inter, ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(truncate(f.title, 14), cx, FEATURE_HEX_Y + 10);
      });

      // Feature-to-feature dependency edges (e.g. FEAT-2 depends_on
      // FEAT-1). Arc ABOVE the feature row so the line doesn't cross
      // through intermediate feature hexes.
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#58a6ff99';
      ctx.lineWidth = 1.3;
      const featIdToCx = new Map<string, number>();
      featList.forEach((f, i) => featIdToCx.set(f.featureId, featurePositions[i]));
      for (const f of featList) {
        const toCx = featIdToCx.get(f.featureId);
        if (toCx === undefined) continue;
        for (const depId of f.dependsOn) {
          const fromCx = featIdToCx.get(depId);
          if (fromCx === undefined) continue;
          drawDepArcAbove(ctx, fromCx, FEATURE_HEX_Y, toCx, FEATURE_HEX_Y, FEATURE_HEX_RADIUS);
        }
      }
      ctx.restore();
    }

    // 4b) WI tier — each WI hex in its OWN per-WI status. Operator
    //     note 2026-05-25: one WI's failure doesn't propagate to its
    //     siblings; yellow during retries; red only if the cycle as a
    //     whole has failed. Branch lines + cross-WI dep edges still
    //     follow the dev-loop tone for consistency with the tree.
    if (hasWis) {
      const devLoopStatus = ordered[DEV_LOOP_INDEX].status;
      const treeOutline = OUTLINE[devLoopStatus];

      // Branch lines: feature hex bottom → each child WI hex top.
      ctx.strokeStyle = treeOutline;
      ctx.lineWidth = 1.5;
      const wiByFeature = new Map<string, string[]>();
      for (const w of wiList) {
        const key = w.featureId ?? '__unmapped__';
        const arr = wiByFeature.get(key) ?? [];
        arr.push(w.id);
        wiByFeature.set(key, arr);
      }
      featList.forEach((f, i) => {
        const featCx = featurePositions[i];
        const childIds = wiByFeature.get(f.featureId) ?? [];
        for (const childId of childIds) {
          const pos = wiPositions.get(childId);
          if (!pos) continue;
          ctx.beginPath();
          ctx.moveTo(featCx, FEATURE_HEX_Y + FEATURE_HEX_RADIUS);
          ctx.lineTo(pos.x, WI_HEX_Y - WI_HEX_RADIUS);
          ctx.stroke();
        }
      });
      // Unmapped WIs — drop from the dev-loop hex bottom (catch-all).
      const unmapped = wiByFeature.get('__unmapped__') ?? [];
      for (const childId of unmapped) {
        const pos = wiPositions.get(childId);
        if (!pos) continue;
        ctx.beginPath();
        ctx.moveTo(devLoopCx, HEX_Y + HEX_RADIUS);
        ctx.lineTo(pos.x, WI_HEX_Y - WI_HEX_RADIUS);
        ctx.stroke();
      }

      // Cross-WI dependency edges (within OR across features). Drawn as
      // bezier curves that arc BELOW the WI row, so the line stays
      // clear of every other WI hex regardless of how many columns it
      // spans (operator note 2026-05-25: deps must remain visible, not
      // disappear under hexes). Dashed + light blue so they read as
      // "dependency", visually distinct from the solid branch lines.
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#58a6ff99';
      ctx.lineWidth = 1.3;
      for (const w of wiList) {
        const toPos = wiPositions.get(w.id);
        if (!toPos) continue;
        for (const depId of w.dependsOn) {
          const fromPos = wiPositions.get(depId);
          if (!fromPos) continue;
          drawDepArc(ctx, fromPos.x, fromPos.y, toPos.x, toPos.y, WI_HEX_RADIUS);
        }
      }
      ctx.restore();

      // WI hexes + labels. Each hex gets its own per-WI status colour
      // (independent from siblings + from the dev-loop phase hex).
      wiList.forEach((w) => {
        const pos = wiPositions.get(w.id);
        if (!pos) return;
        const status = w.status ?? devLoopStatus;
        drawHex(ctx, pos.x, pos.y, WI_HEX_RADIUS, FILL[status], OUTLINE[status]);
        ctx.fillStyle = TEXT_PRIMARY;
        ctx.font = '600 10px Inter, ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(w.id, pos.x, pos.y - 5);
        ctx.fillStyle = TEXT_MUTED;
        ctx.font = '500 9px Inter, ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(truncate(w.title, 11), pos.x, pos.y + 9);
      });
    }

    // 5) Cost pills above each phase hex, only if the phase has a
    //    *non-zero* recorded cost. metrics.ts seeds perPhase[phase] with
    //    cost_usd: 0 on the first event for that phase, so the
    //    `!= null` check alone leaks "$0.00" pills onto phases that
    //    fired events without cost metadata (e.g. a reviewer.pr-open-
    //    failed log).
    ordered.forEach((state, i) => {
      const phaseCost = cost?.perPhase?.[state.phase]?.cost_usd;
      if (phaseCost == null || phaseCost <= 0) return;
      const cx = FIRST_HEX_X + i * HEX_SPACING;
      const top = HEX_Y - HEX_RADIUS - PILL_GAP - PILL_H;
      drawPill(ctx, cx - PILL_W / 2, top, PILL_W, PILL_H, `$${phaseCost.toFixed(2)}`);
    });
  }, [ordered, cost, canvasH, hasFeatures, featList, featurePositions, devLoopCx, hasWis, wiList, wiPositions, featureStatuses]);

  const architectCx = FIRST_HEX_X + PHASE_ORDER.indexOf('architect') * HEX_SPACING;
  const reviewCx = FIRST_HEX_X + PHASE_ORDER.indexOf('review-loop') * HEX_SPACING;

  return (
    <div
      data-component="agent-hex-canvas"
      data-phase-count={ordered.length}
      data-feature-count={featList.length}
      style={{
        position: 'relative',
        width: '100%',
        overflowX: 'auto',
        background: CANVAS_BG,
        border: '1px solid #30363d',
        borderRadius: 8,
      }}
    >
      <div style={{ position: 'relative', width: CANVAS_W, height: canvasH }}>
        <canvas
          ref={canvasRef}
          style={{ display: 'block', width: CANVAS_W, height: canvasH }}
          aria-label="cycle phase + feature pipeline"
        />
        {/* Plan badge overlay — anchored BELOW the architect hex (the
            phase that produces PLAN.md). Operator note 2026-05-25:
            badges live under their producing phase. */}
        {cycleId && (
          <div
            data-overlay="plan-badge"
            style={{ position: 'absolute', left: architectCx - 40, top: HEX_Y + HEX_RADIUS + 8, pointerEvents: 'auto' }}
          >
            <ArtifactBadge
              cycleId={cycleId}
              filename="PLAN.md"
              href={`/plan/${encodeURIComponent(cycleId)}`}
              label="📋 plan"
              title="The architect's PLAN.md for this cycle"
            />
          </div>
        )}
        {/* Demo badge overlay — anchored BELOW the review-loop hex
            (the phase that produces DEMO.md). Hidden until review-loop
            is non-pending. */}
        {cycleId && (
          <div
            data-overlay="demo-badge"
            style={{ position: 'absolute', left: reviewCx - 40, top: HEX_Y + HEX_RADIUS + 8, pointerEvents: 'auto' }}
          >
            <ArtifactBadge
              cycleId={cycleId}
              filename="DEMO.md"
              href={`/demo/${encodeURIComponent(cycleId)}`}
              label="🎬 demo"
              title="The unifier's DEMO.md (visible once review-loop is active)"
              visible={demoVisible}
            />
          </div>
        )}
        {ordered.map((state, i) => {
          const cx = FIRST_HEX_X + i * HEX_SPACING;
          const phaseCost = cost?.perPhase?.[state.phase]?.cost_usd;
          // Match the canvas: leak no zero-cost pills, so the data-* mirror
          // also stays empty when the only events on this phase were
          // cost-less (e.g. orchestrator logs).
          const phaseCostStr = phaseCost != null && phaseCost > 0 ? phaseCost.toFixed(4) : '';
          return (
            <div
              key={state.phase}
              data-phase-hex
              data-phase={state.phase}
              data-phase-status={state.status}
              data-phase-cost-usd={phaseCostStr}
              data-phase-index={i}
              style={{
                position: 'absolute',
                left: cx - HEX_DIV_W / 2,
                top: HEX_Y - HEX_DIV_H / 2,
                width: HEX_DIV_W,
                height: HEX_DIV_H,
                // Visually invisible; canvas underneath is the real picture.
                // Pointer events disabled so the wrapper's overflow scroll
                // behaviour isn't intercepted.
                pointerEvents: 'none',
              }}
            />
          );
        })}
        {/* Feature-hex mirror divs for DOM-as-metrics probes. */}
        {featList.map((f, i) => (
          <div
            key={f.featureId}
            data-feature-hex
            data-feature-id={f.featureId}
            data-feature-deps={f.dependsOn.join(',')}
            data-feature-index={i}
            style={{
              position: 'absolute',
              left: featurePositions[i] - FEATURE_HEX_DIV_W / 2,
              top: FEATURE_HEX_Y - FEATURE_HEX_DIV_H / 2,
              width: FEATURE_HEX_DIV_W,
              height: FEATURE_HEX_DIV_H,
              pointerEvents: 'none',
            }}
          />
        ))}
        {/* WI-hex mirror divs (for DOM-driven probes + future agent-flow
            overlay hooks per 2026-05-25 operator note). */}
        {wiList.map((w) => {
          const pos = wiPositions.get(w.id);
          if (!pos) return null;
          return (
            <div
              key={w.id}
              data-wi-hex
              data-wi-id={w.id}
              data-wi-feature-id={w.featureId ?? ''}
              data-wi-deps={(w.dependsOn ?? []).join(',')}
              style={{
                position: 'absolute',
                left: pos.x - WI_HEX_DIV_W / 2,
                top: pos.y - WI_HEX_DIV_H / 2,
                width: WI_HEX_DIV_W,
                height: WI_HEX_DIV_H,
                pointerEvents: 'none',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * Centre the feature-row hexes around the dev-loop column, spreading
 * them to either side as the count grows. Falls back to a single hex
 * directly under dev-loop when count === 1.
 */
function computeFeaturePositions(count: number, anchorCx: number): number[] {
  if (count === 0) return [];
  if (count === 1) return [anchorCx];
  // Want centre-of-row aligned with anchorCx. Spacing scales with count
  // but never collapses below the minimum.
  const spacing = Math.max(FEATURE_SPACING_MIN, HEX_SPACING - (count - 2) * 8);
  const totalW = spacing * (count - 1);
  const startX = anchorCx - totalW / 2;
  return Array.from({ length: count }, (_, i) => startX + i * spacing);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * Draw a dependency arc from one hex's vicinity to another's. The arc
 * is a quadratic bezier whose control point is below the row, so the
 * line never crosses through other hexes that sit horizontally between
 * the endpoints. For WI deps (sibling hexes at the same Y), this puts
 * the curve under the row and keeps it clearly visible.
 */
function drawDepArc(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  hexR: number,
): void {
  // Start + end just outside the hex perimeters along the line angle.
  const dx = toX - fromX;
  const dy = toY - fromY;
  const len = Math.hypot(dx, dy);
  if (len === 0) return;
  const ux = dx / len;
  const uy = dy / len;
  const sx = fromX + ux * hexR * 0.7;
  const sy = fromY + uy * hexR * 0.7;
  const ex = toX - ux * hexR * 0.7;
  const ey = toY - uy * hexR * 0.7;
  // Control point: below the midpoint by an amount proportional to the
  // horizontal span (so wider arcs bow more). Always positive y so the
  // arc clears any same-row hexes between the endpoints.
  const midX = (sx + ex) / 2;
  const midY = (sy + ey) / 2;
  const arcDepth = Math.max(hexR + 12, Math.abs(dx) * 0.25);
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.quadraticCurveTo(midX, midY + arcDepth, ex, ey);
  ctx.stroke();
}

/**
 * Same as drawDepArc but the control point sits ABOVE the row, so the
 * arc rises over intermediate hexes. Used for feature-to-feature dep
 * edges so the arc doesn't collide with the trunk + branch tree that
 * hangs down to the WI row.
 */
function drawDepArcAbove(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  hexR: number,
): void {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const len = Math.hypot(dx, dy);
  if (len === 0) return;
  const ux = dx / len;
  const uy = dy / len;
  const sx = fromX + ux * hexR * 0.7;
  const sy = fromY + uy * hexR * 0.7;
  const ex = toX - ux * hexR * 0.7;
  const ey = toY - uy * hexR * 0.7;
  const midX = (sx + ex) / 2;
  const midY = (sy + ey) / 2;
  const arcDepth = Math.max(hexR + 12, Math.abs(dx) * 0.25);
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.quadraticCurveTo(midX, midY - arcDepth, ex, ey);
  ctx.stroke();
}

/**
 * Group WIs by featureId and spread each group horizontally beneath its
 * feature column. Returns a Map<wiId, {x, y}>. Unmapped WIs (no
 * featureId) cluster beneath the dev-loop column as a catch-all so
 * they still appear instead of vanishing.
 */
function computeWiPositions(
  workItems: readonly CanvasWorkItem[],
  features: readonly InitiativeFeature[],
  featurePositions: readonly number[],
  unmappedFallbackCx: number,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const featureIdToCx = new Map<string, number>();
  features.forEach((f, i) => featureIdToCx.set(f.featureId, featurePositions[i]));
  const byFeature = new Map<string, CanvasWorkItem[]>();
  for (const w of workItems) {
    const key = w.featureId && featureIdToCx.has(w.featureId) ? w.featureId : '__unmapped__';
    const arr = byFeature.get(key) ?? [];
    arr.push(w);
    byFeature.set(key, arr);
  }
  for (const [key, group] of byFeature.entries()) {
    const anchorCx = key === '__unmapped__' ? unmappedFallbackCx : (featureIdToCx.get(key) ?? unmappedFallbackCx);
    const n = group.length;
    if (n === 1) {
      out.set(group[0].id, { x: anchorCx, y: WI_HEX_Y });
      continue;
    }
    const totalW = WI_SUBCOL_SPACING * (n - 1);
    const startX = anchorCx - totalW / 2;
    group.forEach((w, i) => {
      out.set(w.id, { x: startX + i * WI_SUBCOL_SPACING, y: WI_HEX_Y });
    });
  }
  return out;
}

// ---- canvas primitives ---------------------------------------------------

function drawHex(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  fill: string,
  outline: string,
): void {
  // Flat-top hex: vertices at angles 0°, 60°, 120°, 180°, 240°, 300°.
  ctx.beginPath();
  for (let v = 0; v < 6; v += 1) {
    const angle = (Math.PI / 3) * v;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    if (v === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = OUTLINE_W;
  ctx.strokeStyle = outline;
  // `round` join keeps the corners visually consistent with the hex's
  // wider-than-stroke vertices.
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function drawPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
): void {
  const r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + r, r, Math.PI / 2, -Math.PI / 2);
  ctx.closePath();
  ctx.fillStyle = PILL_FILL;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = PILL_BORDER;
  ctx.stroke();

  ctx.fillStyle = PILL_TEXT;
  ctx.font = '600 11px ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + w / 2, y + h / 2);
}

function drawTaperedEdge(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  colour: string,
): void {
  // Tapered Bézier: approximate by drawing a filled quadrilateral whose
  // long sides are two cubic Béziers offset normal to the edge. This is
  // cheaper than gradient-along-path tricks and renders crisply.
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  // Inward offset so the edge starts/ends at the hex's flat-top vertex
  // boundary rather than at the center.
  const inset = HEX_RADIUS - 4;
  const ux = dx / len;
  const uy = dy / len;
  const sx = x1 + ux * inset;
  const sy = y1 + uy * inset;
  const ex = x2 - ux * inset;
  const ey = y2 - uy * inset;

  // Perpendicular (rotate +90deg) for the taper width.
  const nx = -uy;
  const ny = ux;

  // Half-widths at source (wide) and destination (thin).
  const hwS = EDGE_STROKE_SOURCE / 2;
  const hwD = EDGE_STROKE_DEST / 2;

  // Control points for the cubic — slight bow inward by nudging the
  // midpoint along the perpendicular. For straight horizontal pipeline
  // this is just a smooth taper.
  const c1x = sx + ux * (len / 3);
  const c1y = sy + uy * (len / 3);
  const c2x = sx + ux * (2 * len / 3);
  const c2y = sy + uy * (2 * len / 3);

  ctx.beginPath();
  // Top edge: source-wide → dest-thin.
  ctx.moveTo(sx + nx * hwS, sy + ny * hwS);
  ctx.bezierCurveTo(
    c1x + nx * hwS,
    c1y + ny * hwS,
    c2x + nx * hwD,
    c2y + ny * hwD,
    ex + nx * hwD,
    ey + ny * hwD,
  );
  // Cap at destination.
  ctx.lineTo(ex - nx * hwD, ey - ny * hwD);
  // Bottom edge back to source.
  ctx.bezierCurveTo(
    c2x - nx * hwD,
    c2y - ny * hwD,
    c1x - nx * hwS,
    c1y - ny * hwS,
    sx - nx * hwS,
    sy - ny * hwS,
  );
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.fill();
}
