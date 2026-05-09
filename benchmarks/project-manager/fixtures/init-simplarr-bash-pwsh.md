---
initiative_id: INIT-2026-05-08-simplarr-status-cmd
project: simplarr
project_repo_path: projects/simplarr
created_at: 2026-05-08T10:00:00Z
iteration_budget: 25
cost_budget_usd: 10
phase: in-flight
features:
  - feature_id: FEAT-1
    title: Add `simplarr status` subcommand to bash configurator
    depends_on: []
  - feature_id: FEAT-2
    title: Add `Simplarr-Status` cmdlet to powershell configurator
    depends_on: []
  - feature_id: FEAT-3
    title: Parity test harness covering both implementations
    depends_on:
      - FEAT-1
      - FEAT-2
---

# Add `simplarr status` to both configurators

## Why

simplarr's bash and powershell configurators are at parity for `init`, `apply`, and `revert`, but neither has a `status` command. Users currently have to read the state file (`~/.simplarr/state.json`) directly to see what's configured and which services are active.

This adds `status` to both implementations. **Per simplarr's brain decision page, dual-language parity is non-negotiable** — the bash and powershell flavours must accept the same subcommand spelling, return the same output structure, and pass the same parity tests. The two implementations are independent (no language can depend on the other) but the parity test harness must validate both.

## Scope

- `bash/simplarr.sh` — add `status` subcommand dispatcher.
- `bash/cmd_status.sh` — bash implementation.
- `powershell/Simplarr.ps1` — add `Simplarr-Status` cmdlet binding.
- `powershell/Cmd-Status.ps1` — powershell implementation.
- `tests/parity_status.bats` — parity test harness (bats).

## Out of scope

- `--json` machine-readable output (separate initiative).
- Per-service deep status (this is repo-config status, not service health).
- Caching / staleness checks against the actual installed state.

## Acceptance

- `simplarr status` (bash) and `Simplarr-Status` (powershell) both print the same logical structure.
- Output includes: configurator version, state-file path, active services, last-applied timestamp.
- Parity test harness runs both implementations against an identical state-file fixture and asserts identical normalised output.
- Neither implementation reads or modifies the other's state.
