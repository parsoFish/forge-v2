# simplarr

Cross-platform configurator for self-hosted *arr services (Sonarr/Radarr/etc).

## Layout

- `bash/simplarr.sh` — bash entry point.
- `bash/cmd_*.sh` — one file per subcommand.
- `powershell/Simplarr.ps1` — powershell entry point.
- `powershell/Cmd-*.ps1` — one file per cmdlet.
- `tests/` — bats-based parity test harness (runs both implementations against the same fixtures).

## Constraint

**Dual-language parity is non-negotiable.** Bash and PowerShell flavours must accept the same subcommands, return the same output structure, and pass the parity test harness. New features ship as paired work items — neither implementation depends on the other.
