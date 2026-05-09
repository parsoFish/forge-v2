# ADR 016 — Demo recording tooling for the reviewer phase

**Status:** Accepted
**Date:** 2026-05-09

## Context

The review-loop phase ([`docs/phases/review-loop.md`](../phases/review-loop.md), [`skills/reviewer/SKILL.md`](../../skills/reviewer/SKILL.md)) closes initiatives back to `main` with a working demo. The phase doc left the demo format as a TODO — "markdown checklist vs executable shell vs both." The user has now decided demos must be **video recordings**: Playwright trace/video for browser/canvas projects; an equivalent for terminal/CLI/library projects.

Three things constrain the choice:

1. **[ADR 005](./005-phase-isolation-with-benchmarks.md) + [ADR 007](./007-markdown-artifact-flow.md)** — every phase artefact must be greppable and scoreable. A binary video is not greppable; the *source* that produces the video is, so the source must live alongside the recording.
2. **PRINCIPLES.md §1 + CLAUDE.md "battle-tested community tools"** — re-implementing screen capture is forbidden. The tool must be widely-used, single-purpose, and add no `node_modules` liability when avoidable.
3. **Reviewer fixture coverage** — the 5 managed projects span Python lib, TS canvas/web, bash CLI, TS lib, REST API. A single tool that handles all of them does not exist, so the choice is a 2-tool standardisation.

## Decision

### 1. Two tools, one rule

- **Browser / canvas / DOM rendering** → **Playwright**. Already in [`brain/projects/trafficGame/profile.md`](../../brain/projects/trafficGame/profile.md)'s stack for visual tests. The artefact is `recording.trace.zip` (idiomatic — bundles screenshots + DOM snapshots + network + the video) **or** `recording.webm` if the agent uses `video: 'on'` directly. Either is acceptable.
- **Everything else** (terminal, CLI, Python REPL, bash invocation, `curl`-against-REST, language-library demos via consumer scripts) → **VHS** by Charmbracelet ([github.com/charmbracelet/vhs](https://github.com/charmbracelet/vhs), 13k+ stars, single Go binary, declarative `.tape` source compiles to `.mp4` / `.gif` / `.webm` in one step). Not an npm dep; installed as a system binary (apt / brew / `go install`). Zero `node_modules` cost.

The rule: **VHS is the default; Playwright is the exception reserved for actual rendered UI.** A REST API demo is VHS-of-curl, not a tiny HTML harness in Playwright.

### 2. Demo bundle layout

One directory per initiative, under the project's `.forge/`:

```
<project>/.forge/demos/<initiative-id>/
├── source.<tape|spec.ts>           # declarative source — greppable
├── recording.<mp4|webm|gif|trace.zip>   # the rendered artefact
└── README.md                        # one-paragraph context + prereqs
```

**No separate `.demo.yaml` manifest.** The `.tape` file (VHS) and the `.spec.ts` file (Playwright) are themselves declarative manifests — commands, timing, expectations. A third metadata format would duplicate that information and add bureaucracy without enabling anything new.

The `README.md` carries the human-facing context (one paragraph): what the demo shows, what to install before re-recording (e.g. `vhs`, `npx playwright`), what the expected outcome looks like.

### 3. Greppable acceptance-criteria evidence

The reviewer's prompt instructs the agent to write the demo source so each work-item acceptance criterion's `then`-clause keywords appear in `source.<tape|spec.ts>` (as commands, expected output, assertion text). The bench scores this via [`benchmarks/review-loop/scoring.ts:demoExercisesAcceptanceCriteria`](../../benchmarks/review-loop/scoring.ts) — keyword presence, same shape as PM's `no_hidden_coupling` check. This prevents the "5-second black-canvas video" failure mode that a file-exists check would miss.

### 4. Bench-vs-live PR creation split

The agent **never** calls `gh pr create`. It writes its draft to `<worktree>/.forge/pr-description.md`. The orchestrator (`cycle.ts:runReviewer()`) reads the file post-agent and calls `gh pr create --body-file <path>` against the real GitHub remote in live mode. The bench reads the same file for scoring without ever calling `gh`.

Bench tempdirs additionally stub `gh` on the agent's `PATH` (`gh` → `/bin/false`) plus set `GH_TOKEN=invalid`, so an agent that ignores the prompt and tries `gh pr create` fails fast rather than burning iterations.

This mirrors the dev-loop's pattern: agent writes commits + worktree artefacts; orchestrator handles all "outside the worktree" actions (`writeWorkItemStatus`, queue movement, notifications).

## Consequences

**Positive:**
- One tool decision covers all 5 fixture project types with a clean 4:1 split (VHS:Playwright).
- The source script is greppable, version-controlled, and re-runnable — the reviewer's evidence is reproducible, not just a one-off video.
- No new npm dep. VHS is a single binary; Playwright is already in the trafficGame stack.
- The agent cannot accidentally open a real PR from inside the bench (`gh` PATH-stub).
- Demo quality is scoreable beyond "file exists" (AC keyword check + length floor + format check).

**Negative / accepted trade-offs:**
- VHS must be installed on the operator's machine (system dep, not npm). Acceptable — Forge already requires `git`, `gh`, `tmux`. One more single-purpose binary is consistent with [ADR 006](./006-gh-cli-and-worktrees.md).
- A determined agent could record a video that *looks* like it exercises the WI but doesn't (hallucinated content). The bench's keyword check is a heuristic, not a proof — same as PM's coupling check. Real verification happens in the human-review stage (deferred to a follow-up plan).
- Playwright `trace.zip` requires the Playwright viewer to replay (`npx playwright show-trace`). Acceptable — the human reviewer will already have Playwright installed for any project that uses it; the trace is the idiomatic artefact for that ecosystem.

## Alternatives considered

- **asciinema + agg.** Records a `.cast` JSON, then `agg` renders to GIF/video. Two tools, two-step pipeline, and the `.cast` format is not directly playable as a video file. Rejected — VHS produces video in one step and the `.tape` source is more readable than a `.cast` JSON.
- **terminalizer.** Older, less-maintained alternative to VHS with similar declarative input. Rejected — VHS is more actively maintained and produces higher-quality output.
- **`script` / `ttyrec` / raw `ffmpeg`.** Too low-level. Forces re-implementation of timing, framing, and cursor state. Violates "battle-tested, no re-invention."
- **Playwright everywhere (terminal demos via headless terminal-emulator page).** Possible but overengineered for shell demos and adds browser spin-up cost per fixture. Rejected — keep Playwright for actual rendered UI.
- **A `.demo.yaml` manifest alongside the source + recording.** Bureaucratic — the source script is itself the manifest. Rejected for simplicity ([PRINCIPLES.md §3](../../PRINCIPLES.md)).
- **Markdown-checklist-only demos (the original phase-doc default).** Rejected by the user — videos are the deliverable.

## References

- [`docs/phases/review-loop.md`](../phases/review-loop.md) — phase doc this ADR resolves.
- [`skills/reviewer/SKILL.md`](../../skills/reviewer/SKILL.md) — skill that emits demos and PR drafts.
- [ADR 005](./005-phase-isolation-with-benchmarks.md) — bench harness shape per phase.
- [ADR 006](./006-gh-cli-and-worktrees.md) — `gh` CLI + worktrees; sets the precedent for system-binary deps.
- [ADR 007](./007-markdown-artifact-flow.md) — greppable artefacts; the source script is the greppable counterpart of the recording.
- [ADR 013](./013-notifications.md) — notification fires after `runReviewer()` completes.
- [VHS](https://github.com/charmbracelet/vhs) — Charmbracelet, declarative terminal recording.
- [Playwright traces](https://playwright.dev/docs/trace-viewer) — bundled artefact for browser demos.
