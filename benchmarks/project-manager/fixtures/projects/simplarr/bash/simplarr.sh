#!/usr/bin/env bash
# simplarr — bash entry point.
set -euo pipefail

cmd="${1:-help}"
shift || true

case "$cmd" in
  init)   exec "$(dirname "$0")/cmd_init.sh" "$@" ;;
  apply)  exec "$(dirname "$0")/cmd_apply.sh" "$@" ;;
  revert) exec "$(dirname "$0")/cmd_revert.sh" "$@" ;;
  *)      echo "usage: simplarr {init|apply|revert}" >&2; exit 2 ;;
esac
