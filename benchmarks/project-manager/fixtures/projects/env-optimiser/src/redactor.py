"""Secret-redaction module. Constitution principle #2 — mandatory before any storage."""
import re

PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"(?i)(?:password|token|secret)[=:]\s*\S+"),
]


def redact(events: list[str]) -> list[str]:
    return [redact_one(e) for e in events]


def redact_one(s: str) -> str:
    for p in PATTERNS:
        s = p.sub("<REDACTED>", s)
    return s
