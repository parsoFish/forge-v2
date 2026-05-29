---
title: DOM-as-metrics — design UIs so any automation can drive them
description: >-
  Mirror every load-bearing UI state to `data-*` attributes so playwright
  / headless probes / future LLM-driven UI tests can drive the page by
  reading structured DOM rather than scraping rendered text or guessing
  selectors. Pattern from anthropics/cwc-workshops `how-we-claude-code`.
  Applied to forge-ui (Move 2) and used as the wait/assertion source for
  scripts/forge-ui-demo.mjs.
category: pattern
keywords:
  - dom
  - data-attributes
  - automation
  - playwright
  - cwc-workshops
  - forge-ui
  - active-monitoring
created_at: 2026-05-24T00:00:00Z
updated_at: 2026-05-24T00:00:00Z
source_dates:
  - 2026-05-24
---

## The principle

A UI is a **machine-readable surface** as much as a human-readable one. If a
human can see "scheduler is stopped" from an amber dot, a probe should see the
same fact via `[data-component="scheduler-banner"].dataset.schedulerRunning ===
'false'` — **without** scraping the text or guessing CSS classes. The
discipline: every load-bearing state goes on a `data-*` attribute alongside the
visual encoding, both updated from the same React state. Visual is for humans,
`data-*` is for machines.

## Why this matters for forge

1. **The UI was the only phase output with no automated verification surface.**
   DOM-as-metrics gives it one (phase quality is now judged on real merged
   cycles, and the UI's state is now machine-checkable as part of that).
2. **The operator can't always sit in front of the UI** — unattended operation
   is the whole point. A headless probe checking
   `data-active-cycle-status="ready-for-review"` is the honest equivalent of
   "the operator would see this and act."
3. **LLM-driven UI tests are the obvious next step** — forge's own agents can
   read structured DOM rather than fight screenshot + vision-LM scoring.

## How forge applies it

The root `<main>` carries page-level state (`data-conn-state`, `data-page-ready`,
`data-active-cycle-id/-status/-events`, …) and each section/component carries
its own discriminators. The **canonical, current attribute inventory lives in
CLAUDE.md §"forge-ui DOM-as-metrics convention"** — that's the single source of
truth (this theme intentionally does not duplicate it, since the layout evolves).

Convention: **always update the `data-*` attribute alongside any visual change**
— when the verdict form's label flips to "submitting…", `data-form-state` flips
to `submitting` in the same render.

`scripts/forge-ui-demo.mjs` drives chromium and replaces every timing-based
sleep with a `data-*` wait (e.g. `waitForFunction(() => main.dataset
.activeCycleId === id)`). That killed three flake classes: click outracing
render, fetch-not-resolved "loading…" shots, and forms caught mid-render.

## How to extend

When adding a component or state: pick the discriminator (`data-state`,
`data-kind`, …), set it from React state alongside any visual change, add it to
the CLAUDE.md convention table so contributors stay disciplined, and — if it
matters for a demo flow — have the demo wait on it instead of sleeping.

## See also

- [[brain-first-research]] (mirror discipline: keep the source of truth singular, read from it)
- [[windows-browser-to-wsl-via-window-location]] (`data-bridge-url` is one of these probes)
- demo: [`scripts/forge-ui-demo.mjs`](../../../scripts/forge-ui-demo.mjs)
- pattern source: [anthropics/cwc-workshops `how-we-claude-code`](https://github.com/anthropics/cwc-workshops/tree/main/how-we-claude-code)
