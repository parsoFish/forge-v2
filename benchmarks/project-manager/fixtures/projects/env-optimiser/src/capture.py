"""wsl-deo capture — command/git/vscode collector entry point."""
import argparse
import sys
from pathlib import Path

from .redactor import redact

STORE_DIR = Path.home() / ".wsl-deo"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="wsl-deo capture")
    parser.add_argument("source", choices=["shell", "git", "vscode"])
    args = parser.parse_args(argv)

    raw = read_source(args.source)
    redacted = redact(raw)
    write_store(redacted, args.source)
    return 0


def read_source(source: str) -> list[str]:
    raise NotImplementedError(f"read_source({source}) — see source-specific collectors")


def write_store(events: list[str], source: str) -> None:
    STORE_DIR.mkdir(parents=True, exist_ok=True)
    target = STORE_DIR / f"{source}.jsonl"
    with target.open("a") as f:
        for ev in events:
            f.write(ev + "\n")


if __name__ == "__main__":
    sys.exit(main())
