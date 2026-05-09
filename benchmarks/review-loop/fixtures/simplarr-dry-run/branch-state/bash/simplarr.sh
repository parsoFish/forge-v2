#!/usr/bin/env bash
# simplarr — bash entry point.
set -euo pipefail

cmd="${1:-help}"
shift || true

case "$cmd" in
  apply)  exec "$(dirname "$0")/cmd_apply.sh" "$@" ;;
  *)      echo "usage: simplarr {apply}" >&2; exit 2 ;;
esac
