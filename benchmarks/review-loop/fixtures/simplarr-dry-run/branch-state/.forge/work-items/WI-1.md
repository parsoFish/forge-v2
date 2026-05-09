---
work_item_id: WI-1
feature_id: FEAT-1
initiative_id: INIT-2026-05-09-simplarr-dry-run
status: complete
depends_on: []
acceptance_criteria:
  - given: "the apply command is invoked with --dry-run"
    when:  "cmd_apply.sh runs"
    then:  "it prints 'would apply' to stdout and exits with status 0 without modifying any state"
  - given: "the apply command is invoked with --dry-run"
    when:  "cmd_apply.sh runs"
    then:  "it does NOT print 'applying stack' (the destructive banner)"
  - given: "the apply command is invoked without --dry-run"
    when:  "cmd_apply.sh runs"
    then:  "it prints 'applying' as a regression guard"
files_in_scope:
  - bash/cmd_apply.sh
estimated_iterations: 2
---

# WI-1: Add `--dry-run` flag to `simplarr apply`

`simplarr apply` previously had no preview mode — running it would mutate state with no chance for
the operator to inspect what was about to happen. Adds a `--dry-run` flag that prints the would-be
actions and exits cleanly.

## Status: complete

- New flag handling in `bash/cmd_apply.sh`.
- Three bats tests covering the dry-run behaviour and the regression guard.
- Local-dry-run-required theme respected — apply now requires the operator to run `--dry-run` first.

## Brain themes consulted

- `local-dry-run-required` — operator policy mandating preview before apply (project-specific).
