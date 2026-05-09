---
initiative_id: INIT-2026-05-08-eo-redact-flag
project: env-optimiser
project_repo_path: projects/env-optimiser
created_at: 2026-05-08T10:00:00Z
iteration_budget: 20
cost_budget_usd: 8
phase: in-flight
features:
  - feature_id: FEAT-1
    title: Add --no-redact flag to capture CLI
    depends_on: []
  - feature_id: FEAT-2
    title: Plumb the flag through to the redactor
    depends_on:
      - FEAT-1
  - feature_id: FEAT-3
    title: Document the flag in quickstart and tests
    depends_on:
      - FEAT-2
---

# Add `--no-redact` debug flag to `wsl-deo capture`

## Why

Constitution principle #2 mandates secret redaction before storage. The redactor is in `src/redactor.py`; the capture CLI in `src/capture.py` always runs it. When debugging a misclassification (innocuous string treated as a secret) the developer has no way to see the unredacted value alongside the redacted one without temporarily editing the redactor itself.

This initiative adds a developer-only flag `--no-redact` that bypasses redaction. **It must be loud about what it does**: prints a banner on every run, refuses to write to the durable `~/.wsl-deo/` store (in-memory / stdout only), and is gated behind the existing `WSL_DEO_DEV=1` environment variable so it cannot be accidentally enabled in user-facing flows.

## Scope

- `src/capture.py` — argument parsing + flag plumbing.
- `src/redactor.py` — accept a bypass parameter; emit warning when bypassed.
- `tests/test_capture.py` — assertions about the banner, the storage refusal, the env-var gating.
- `specs/no-redact-flag/quickstart.md` — runnable example showing intended workflow.

## Out of scope

- Any change to the redaction rules themselves.
- Any new persisted artifact format.
- Integration with the analyser or VS Code workspace collectors.

## Acceptance

The PM should produce work items that, taken together, satisfy:

- The flag is parseable and gated by `WSL_DEO_DEV=1`.
- Bypass mode never writes to `~/.wsl-deo/`.
- Tests cover both the redacted (default) and unredacted (bypass) paths.
- `specs/no-redact-flag/quickstart.md` is runnable end-to-end (constitution principle: quickstart is the spec).
