---
title: The PR must be the sole review window (visibility-aware demo-in-PR)
description: When the operator is engaged, iterating via PR comments is a low-overhead high-fidelity review loop — but ONLY if the PR is self-contained. The demo must live IN the PR; for PRIVATE repos that means a committed DEMO.md with relative image links, not inline raw URLs (GitHub's image proxy can't fetch private raw).
category: pattern
keywords: [review, pull-request, demo, demo-in-pr, embedDemoInPr, private-repo, raw-url, image-proxy, operator, send-back, iteration, self-contained]
created_at: 2026-05-18T00:00:00Z
updated_at: 2026-05-18T00:00:00Z
related_themes: [review-phase-target-design, human-interaction-via-own-session]
---

# The PR must be the sole review window

## Pattern

When the operator is actively engaged, the tightest review loop is the
**PR comment thread**: review → comment → agent addresses → push →
re-review, all on the PR. It outperformed the file-verdict send-back loop
for the trafficGame world-map work (4 rounds, PR #54, converged + merged).
It only works if the operator never has to leave the PR — they should not
open a local HTML, infer the change, then come back to comment.

## The load-bearing mechanism: demo IN the PR

The reviewer writes the demo into `.forge/demos/<id>/` which is
**gitignored** → invisible to a PR reviewer. `pr.ts:embedDemoInPr` copies
the bundle into a tracked `demo/<id>/`, commits it on the branch (before
the push), and surfaces it in the PR body.

## The hard-won lesson: visibility matters

GitHub's markdown **image proxy (camo) cannot fetch a PRIVATE repo's raw
URLs** — an inline `![](https://github.com/o/r/raw/branch/...)` renders
**broken** in a private-repo PR (it 404s through the proxy). So:

- **Always** commit a `DEMO.md` with **relative** image links. GitHub
  renders a committed markdown file (relative images) on the blob page for
  the authenticated reviewer **regardless of repo visibility**. The PR
  body links to it + points at the *Files changed* tab.
- Inline `![](raw-url)` images **only when the repo is public** (confirm
  via `gh repo view --json isPrivate`). **Default to private** if unknown
  — a broken inline image is worse than a link.

## Evidence

- trafficGame `parsoFish/trafficGame` is **private**; the first
  raw-URL attempt 404'd. Fixed by committing `demo/world-map/DEMO.md`
  (relative links) + linking it from the PR body.
- Forge change: `orchestrator/pr.ts` `embedDemoInPr` (branch
  `fix/operator-review-reliability`), wired into `openPullRequest`,
  best-effort (never blocks PR creation).

## Sources

- `orchestrator/pr.ts` — `embedDemoInPr`, `openPullRequest`.
- trafficGame PR #54 — 4 review rounds on the PR; demo committed under
  `demo/world-map/`.
