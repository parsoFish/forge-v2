#!/usr/bin/env bats
# Parity test harness — runs both implementations against the same state file.

@test "bash apply prints the apply banner" {
  run bash bash/simplarr.sh apply
  [ "$status" -eq 0 ]
  [[ "$output" == *"applying"* ]]
}
