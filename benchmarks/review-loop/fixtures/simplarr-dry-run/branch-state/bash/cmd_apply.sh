#!/usr/bin/env bash
# Apply the configured stack from ~/.simplarr/state.json.
set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) ;;
  esac
done

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "would apply stack (dry-run, no changes made)"
  exit 0
fi

echo "applying stack..."
