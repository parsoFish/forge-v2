# env-optimiser (WSL-DEO)

Local-first workflow analysis for WSL2 developers. Captures shell commands, git activity, and VS Code workspace usage; emits daily optimisation briefs.

**Read-only by design.** Constitution at `.specify/memory/constitution.md` (not in this fixture); 7 non-negotiable principles, including mandatory secret redaction.

## Layout

- `src/capture.py` — capture CLI (`wsl-deo capture`).
- `src/redactor.py` — secret-redaction module (constitution #2).
- `src/analyser.py` — daily-brief analyser.
- `tests/` — pytest suite.
- `specs/<feature>/{spec,plan,tasks,quickstart}.md` — spec-driven feature layout.

## Stack

Python stdlib + Atuin only. New runtime deps need spec-level justification (constitution #3).
