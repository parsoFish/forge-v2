"""Acceptance test for WI-1 (redact_argv). Passes — implementation in place."""
from src.redactor import redact_argv


def test_redact_argv_redacts_each_element():
    assert redact_argv(["sk-abc123def456ghi789jkl", "ls -la"]) == ["<REDACTED>", "ls -la"]


def test_redact_argv_returns_new_list():
    argv = ["git status"]
    out = redact_argv(argv)
    assert out is not argv  # new list, not the same object


def test_redact_argv_handles_empty():
    assert redact_argv([]) == []
