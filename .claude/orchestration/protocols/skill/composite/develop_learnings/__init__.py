"""develop-learnings skill module."""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure protocols/skill package is importable
_ORCHESTRATION_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(_ORCHESTRATION_ROOT) not in sys.path:
    sys.path.insert(0, str(_ORCHESTRATION_ROOT))

from skill.composite.develop_learnings.entry import main as entry_main
from skill.composite.develop_learnings.complete import main as complete_main

SKILL_NAME = "develop-learnings"

__all__ = ["SKILL_NAME", "entry_main", "complete_main"]
