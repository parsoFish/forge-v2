# env-optimiser

Secret-redaction module. Constitution principle #2 — mandatory before any storage.

## Layout

- `src/redactor.py` — redactor with `redact`, `redact_one`, `redact_argv`.
- `tests/test_redact_argv.py` — acceptance tests for the new `redact_argv` helper.

## Quality gate

```
python3 -m pytest tests/ -q
```

## Recent work

- WI-1 (complete): added `redact_argv` for argv sanitisation. See `.forge/work-items/WI-1.md`.
