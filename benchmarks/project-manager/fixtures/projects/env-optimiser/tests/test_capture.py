"""Existing capture tests. PM-emitted work items will add to this file."""
from src.redactor import redact_one


def test_redact_one_strips_openai_keys():
    assert redact_one("export OPENAI_API_KEY=sk-abc123def456ghi789jkl") == "<REDACTED>"


def test_redact_one_passes_clean_strings():
    assert redact_one("git status") == "git status"
