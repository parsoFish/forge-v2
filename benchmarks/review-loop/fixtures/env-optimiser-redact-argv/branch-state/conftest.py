"""Make `src` importable when pytest runs from the worktree root."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
