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

A UI is a **machine-readable surface** as much as a human-readable one.
If a human can see "scheduler is stopped" because of an amber dot, a
playwright probe should be able to see the same fact via
`document.querySelector('[data-component="scheduler-banner"]')
.dataset.schedulerRunning === 'false'` — **without** scraping the text
"Scheduler is stopped" or guessing at CSS classes.

The discipline: every load-bearing state goes on a `data-*` attribute
alongside the visual encoding. Visual is for humans, `data-*` is for
machines, both update from the same React state.

## Why this matters for forge

1. **Forge already evaluates phases via automated benches** (per
   [[brain-first-research]] / per the per-phase bench harnesses). The
   UI is the only phase output that previously had **no automated
   verification surface**. DOM-as-metrics gives it one.
2. **The operator can't always sit in front of the UI** — the
   architecture's whole point is unattended operation. A headless
   probe checking `data-active-cycle-status="ready-for-review"` is the
   honest equivalent of "the operator would see this and act on it".
3. **LLM-driven UI tests are the obvious next step.** When forge's
   own agents need to verify the UI (e.g., a brain agent confirming a
   feature shipped end-to-end), they can read structured DOM rather
   than fight `puppeteer.screenshot` + vision-LM scoring.

## How forge applies it

Root `<main>` carries page-level state:

```
data-conn-state              connecting | open | reconnecting | no-bridge
data-page-ready              true once the bridge is open
data-live-count              count of in-flight + ready-for-review cycles
data-recent-count            count of recently done/failed
data-active-cycle-id         current selection
data-active-cycle-status     in-flight | ready-for-review | done | …
data-active-cycle-events     event count for the selected cycle
data-bridge-url              full URL the client is talking to
```

Per-section anchors with state in sibling attrs:

- `[data-section="cycles-tab"][data-cycles-count]`
- `[data-section="state-machine"]` containing
  `li[data-phase="architect"][data-phase-status="active"]` etc.
- `[data-section="activity-sidebar"]` containing
  `li[data-phase][data-phase-events][data-phase-tool-uses][data-phase-iterations][data-phase-errors][data-phase-work-item]`
- `[data-section="wi-graph"][data-state]` containing
  `li[data-wi-id][data-wi-deps][data-wi-enables]`
- `[data-section="event-tail"][data-events-total]` containing
  `[data-event-id][data-event-phase][data-event-type]`
- `[data-component="verdict-form"][data-form-state][data-form-kind][data-initiative-id]`
- `[data-component="scheduler-banner"][data-banner-state][data-scheduler-running]`
- `[data-component="toasts"][data-toast-count]` containing
  `[data-toast-id][data-toast-kind]`

Convention: **always update the `data-*` attribute alongside any
visual state change**. If the verdict form's visible label changes from
"approve and merge" to "submitting…", `data-form-state` flips from
`editing` to `submitting` in the same render.

## The waits the demo uses

`scripts/forge-ui-demo.mjs` drives chromium against the page and
captures screenshots at every interesting state. It replaces every
timing-based sleep with a `data-*` wait:

```js
await page.waitForFunction(
  (id) => document.querySelector('main')?.getAttribute('data-active-cycle-id') === id,
  cycleId,
);
```

This eliminated three classes of flake: (a) shot 02 = shot 01 when the
click outraced the render; (b) the WI-graph shot showed "loading…"
because the fetch hadn't resolved; (c) the verdict-form shot caught
the form mid-render with stale fields.

## How to extend

When adding a new component or state:

1. Decide the discriminator (`data-state`, `data-kind`, `data-…`).
2. Set it from React props/state alongside any visual change.
3. Add it to the doc table in CLAUDE.md §"forge-ui DOM-as-metrics
   convention" so future contributors stay disciplined.
4. If the state matters for a demo flow, have the demo wait on it
   instead of using a sleep.

## See also

- [[brain-first-research]] (mirror discipline: keep the source of
  truth singular, read from it)
- forge-ui demo: [`scripts/forge-ui-demo.mjs`](../../../scripts/forge-ui-demo.mjs)
- live demo (mutations the operator watches via WebSocket): [`scripts/forge-ui-live-demo.mjs`](../../../scripts/forge-ui-live-demo.mjs)
- pattern source: [anthropics/cwc-workshops `how-we-claude-code`](https://github.com/anthropics/cwc-workshops/tree/main/how-we-claude-code)
