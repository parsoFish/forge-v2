---
work_item_id: WI-1
feature_id: FEAT-1
initiative_id: INIT-2026-05-09-env-optimiser-redact-argv
status: complete
depends_on: []
acceptance_criteria:
  - given: "a list of argv strings, some containing secrets"
    when:  "redact_argv is called with that list"
    then:  "a new list is returned where each element has been passed through redact_one"
  - given: "an empty argv list"
    when:  "redact_argv is called with []"
    then:  "an empty list is returned (not None)"
  - given: "the input argv list reference"
    when:  "redact_argv has returned"
    then:  "the input list is not the same object as the output (no aliasing)"
files_in_scope:
  - src/redactor.py
estimated_iterations: 2
---

# WI-1: Add `redact_argv` helper to the redactor module

Capture pipeline calls `redact(events: list[str])` to scrub stored events. Sibling helper `redact_argv(argv: list[str]) -> list[str]` does the same operation but is named after its caller's intent (sanitising argv before logging). Implementation is a thin wrapper around `redact_one`.

## Status: complete

- New `redact_argv` function in `src/redactor.py`.
- All three acceptance criteria covered by `tests/test_redact_argv.py`.
- Existing `tests/test_redactor.py` regression suite still passes.

## Brain themes consulted

- `secrets-redaction-mandatory` — constitution rule the redactor enforces.
