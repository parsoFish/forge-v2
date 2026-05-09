#!/usr/bin/env bats
# Acceptance test for WI-1 (--dry-run flag on cmd_apply.sh).

@test "apply --dry-run prints would-apply and exits 0" {
  run bash bash/simplarr.sh apply --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"would apply"* ]]
}

@test "apply --dry-run does not print the active applying banner" {
  run bash bash/simplarr.sh apply --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" != *"applying stack"* ]]
}

@test "apply without --dry-run still prints applying (regression guard)" {
  run bash bash/simplarr.sh apply
  [ "$status" -eq 0 ]
  [[ "$output" == *"applying"* ]]
}
