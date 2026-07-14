"""Pytest config for the imagegen skill tests.

Adds ``scripts/`` to ``sys.path`` so ``import comfy_http`` works in any test file
without per-file path juggling (mirrors the jsa skill's conftest).
"""

import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
