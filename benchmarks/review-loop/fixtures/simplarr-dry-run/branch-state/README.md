# simplarr

Bash-based stack manager. The `apply` subcommand now supports `--dry-run` for preview-before-mutate.

## Quality gate

```
bats tests/dry_run.bats
```

## Recent work

- WI-1 (complete): `--dry-run` flag on `simplarr apply`. See `.forge/work-items/WI-1.md`.
