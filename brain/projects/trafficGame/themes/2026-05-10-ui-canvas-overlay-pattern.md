---
title: trafficGame — UI overlays paint translucent black via fillRect without clearRect first
description: GameMenu.draw() (and likely other CanvasScreen-derived overlays) paint rgba(0,0,0,0.7) full-canvas without clearing first. Each redraw stacks another translucent layer on whatever is underneath — this is the most likely cause of the "menu hover incrementally darkens the screen" bug.
category: bug-candidate
keywords: [trafficgame, ui, canvas, overlay, fillrect, clearrect, hover, darken, gamemenu, levelcompleteoverlay, alpha-stacking]
created_at: 2026-05-10T15:30:00Z
updated_at: 2026-05-10T15:30:00Z
related_themes: []
---

# trafficGame — UI overlay pattern and the cumulative-darken bug

## The pattern

`src/ui/` has 9+ canvas-overlay screens, all extending a `CanvasScreen` base:

`CanvasScreen.ts`, `CampaignHub.ts`, `ConnectionFeedback.ts`, `GameMenu.ts`, `LevelCompleteOverlay.ts`, `LevelMetadataHeader.ts`, `RunSimulationButton.ts`, `SandboxSettingsPanel.ts`, `SimulationWarning.ts`, `TitleScreen.ts`.

Each overlay implements `draw()` and re-draws on hover (`onMouseMove`) when the hit-tested action changes.

## The bug pattern (cumulative darkening)

[`src/ui/GameMenu.ts`](../../../../projects/trafficGame/src/ui/GameMenu.ts):144–198.

```typescript
protected override onMouseMove(e: MouseEvent): void {
  const { mx, my } = this.getMousePos(e);
  const action = this.hitTest(mx, my);
  if (action !== this.hoveredAction) {
    this.hoveredAction = action;
    this.setCursor(action ? 'pointer' : 'default');
    this.draw();          // ← redraws the menu on every hover-change
  }
}

protected override draw(): void {
  const { ctx, canvas } = this;
  const panel = this.getPanelRect();

  // Dim overlay
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);   // ← no clearRect first

  // Panel background, title, buttons, shortcuts...
}
```

`draw()` paints **`rgba(0, 0, 0, 0.7)` over the entire canvas** without first calling `clearRect()`. If the canvas underneath isn't redrawn between hover events (i.e., the game frame loop is paused while the menu is open), every hover event stacks another 70%-alpha black layer:

- After 1 hover: 70% opacity (correct).
- After 2 hovers: ~91% opacity.
- After 3 hovers: ~97% opacity.
- After 5 hovers: ~99.8% opacity — visually black.

This matches the user's bug report: *"if any button in a menu is hovered over it darkens the rest of the screen incrementally"*.

`LevelCompleteOverlay.ts`:140 has the same `rgba(0, 0, 0, 0.75)` + `fillRect` pattern (and uses `globalAlpha` at line 170 — a second class of stacking). `globalAlpha` is restored to `1` immediately after, but the underlying `fillStyle` overlay shares the same root cause if it's re-applied without a clear.

## The fix surface (informational, not prescriptive)

- The canonical fix is to **call `ctx.clearRect(0, 0, canvas.width, canvas.height)` before** painting the dim overlay, OR have the parent `CanvasScreen` base class own the clear-then-delegate-draw pattern so every screen gets it for free.
- Alternative: use a separate canvas layer for overlays, where the dim layer is owned by the layer compositor (cheap to repaint).
- Beware the bug is unlikely to be **only** in `GameMenu` — every CanvasScreen subclass that uses `rgba(...)` + `fillRect` without a preceding clear is suspect. A single-WI fix that touches just GameMenu would leave LevelCompleteOverlay and any sibling screens still vulnerable.

## What to verify in the architect's spec

- Acceptance criteria should reference the **base CanvasScreen contract**, not just GameMenu — otherwise the bug returns the next time someone adds an overlay.
- Visual regression coverage (Playwright `test:visual`) should cover the menu in three states: just-opened, after 1 hover, after 5+ hovers.
- The fix must not regress the intentional dim effect — the menu *should* dim the game behind it, just stably.

## Sources

- [`src/ui/GameMenu.ts`](../../../../projects/trafficGame/src/ui/GameMenu.ts):144–198 — hover handler + draw with no preceding clear.
- [`src/ui/LevelCompleteOverlay.ts`](../../../../projects/trafficGame/src/ui/LevelCompleteOverlay.ts):140, 170 — same pattern, plus `globalAlpha` use.
- `ls src/ui/` — full list of CanvasScreen subclasses likely to share the pattern.

## Related

- [`canvas-bpr-flow-tests`](canvas-bpr-flow-tests.md) — Playwright `test:visual` is the gate for canvas regressions.
- [`mvp-architecture-snapshot`](2026-05-10-mvp-architecture-snapshot.md) — `src/ui/` location.
