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

import type { CostSummary } from '@/lib/bridge-client';
import { PHASE_ORDER, type Phase, type PhaseState, type PhaseStatus } from '@/lib/phases';

type Props = {
  phaseStates: readonly PhaseState[];
  cost?: CostSummary | null;
};

// ---- layout constants ----------------------------------------------------

const CANVAS_W = 800;
const CANVAS_H = 280;
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

// ---- colour palette ------------------------------------------------------

const FILL: Record<PhaseStatus, string> = {
  pending: '#161b22',
  active: '#0d1f3a',
  complete: '#0c2117',
  failed: '#2d0d0f',
};

const OUTLINE: Record<PhaseStatus, string> = {
  pending: '#30363d',
  active: '#58a6ff',
  complete: '#7ee787',
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

export function AgentHexCanvas({ phaseStates, cost = null }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Always render the canonical six phases in canonical order. The prop
  // is permitted to be partial / out-of-order; we look up by name.
  const ordered: PhaseState[] = PHASE_ORDER.map((phase) => {
    const match = phaseStates.find((s) => s.phase === phase);
    return match ?? { phase, status: 'pending' };
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // High-DPI: draw at devicePixelRatio so hex outlines stay crisp.
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    if (canvas.width !== CANVAS_W * dpr || canvas.height !== CANVAS_H * dpr) {
      canvas.width = CANVAS_W * dpr;
      canvas.height = CANVAS_H * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear: explicit fill rather than clearRect so the panel bg is solid
    // (matches forge's dark theme; avoids flicker on prop change).
    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // 1) Edges first so hex fills overlap their endpoints.
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

    // 2) Hexes + labels.
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

    // 3) Cost pills above each hex, only if the phase has a recorded cost.
    ordered.forEach((state, i) => {
      const phaseCost = cost?.perPhase?.[state.phase]?.cost_usd;
      if (phaseCost == null) return;
      const cx = FIRST_HEX_X + i * HEX_SPACING;
      const top = HEX_Y - HEX_RADIUS - PILL_GAP - PILL_H;
      drawPill(ctx, cx - PILL_W / 2, top, PILL_W, PILL_H, `$${phaseCost.toFixed(2)}`);
    });
  }, [ordered, cost]);

  return (
    <div
      data-component="agent-hex-canvas"
      data-phase-count={ordered.length}
      style={{
        position: 'relative',
        width: '100%',
        overflowX: 'auto',
        background: CANVAS_BG,
        border: '1px solid #30363d',
        borderRadius: 8,
      }}
    >
      <div style={{ position: 'relative', width: CANVAS_W, height: CANVAS_H }}>
        <canvas
          ref={canvasRef}
          style={{ display: 'block', width: CANVAS_W, height: CANVAS_H }}
          aria-label="cycle phase pipeline"
        />
        {ordered.map((state, i) => {
          const cx = FIRST_HEX_X + i * HEX_SPACING;
          const phaseCost = cost?.perPhase?.[state.phase]?.cost_usd;
          return (
            <div
              key={state.phase}
              data-phase-hex
              data-phase={state.phase}
              data-phase-status={state.status}
              data-phase-cost-usd={phaseCost != null ? phaseCost.toFixed(4) : ''}
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
      </div>
    </div>
  );
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
