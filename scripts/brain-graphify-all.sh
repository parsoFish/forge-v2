#!/usr/bin/env bash
# brain-graphify-all.sh — rebuild graphify knowledge graphs for all three brains.
#
# Three-brain model (Tier 4 restructure 2026-05-26):
#   Brain 1 (forge-dev): forge code + ADRs + engineering notes
#   Brain 2 (cycles):    cycle-derived patterns, antipatterns, operations, raw archives
#   Brain 3 (per-project): lives inside each project repo — run separately
#
# Usage:
#   bash scripts/brain-graphify-all.sh          # rebuild Brain 1 + Brain 2
#   bash scripts/brain-graphify-all.sh --all    # rebuild Brain 1 + Brain 2 + all managed projects
#
# Requirements: graphify installed (uv tool install graphifyy)
# After modifying forge code, this is run automatically by the post-commit hook.

set -euo pipefail

FORGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run_graphify() {
  local label="$1"; shift
  echo "[brain-graphify-all] rebuilding: $label"
  graphify update "$@" 2>&1 | sed "s/^/  [$label] /"
  echo "[brain-graphify-all] done: $label"
}

# Brain 1 — forge-dev (forge TypeScript source + docs/decisions + brain/forge-dev)
run_graphify "Brain 1 (forge-dev)" \
  "$FORGE_ROOT" \
  --out "$FORGE_ROOT/brain/forge-dev/graphify-out" \
  --include "cli/**" \
  --include "orchestrator/**" \
  --include "loops/**" \
  --include "skills/**" \
  --include "docs/decisions/**" \
  --include "brain/forge-dev/**" \
  --exclude "brain/cycles/**" \
  --exclude "brain/_raw/**" \
  --exclude "node_modules/**" \
  --exclude "forge-ui/**" \
  --exclude "graphify-out/**"

# Brain 2 — cycles (brain/cycles themes + _raw archives)
run_graphify "Brain 2 (cycles)" \
  "$FORGE_ROOT/brain/cycles" \
  --out "$FORGE_ROOT/brain/cycles/graphify-out"

if [[ "${1:-}" == "--all" ]]; then
  # Brain 3 — each managed project repo
  for proj_dir in "$FORGE_ROOT/projects"/*/; do
    proj_name="$(basename "$proj_dir")"
    if [[ -d "$proj_dir/brain" ]]; then
      (
        cd "$proj_dir"
        run_graphify "Brain 3 ($proj_name)" \
          "$proj_dir" \
          --out "$proj_dir/brain/graphify-out"
      )
    fi
  done
fi

echo "[brain-graphify-all] all graphs rebuilt successfully"
