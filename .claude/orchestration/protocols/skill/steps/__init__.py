"""
Steps Package - Base classes for skill phase implementations.

Exports:
    BasePhase: Abstract base class for skill phases
    AutoPhase: Base class for AUTO phases (Python execution only)
"""

import sys
from pathlib import Path

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between skill/config and agent/config
_STEPS_DIR = Path(__file__).resolve().parent
_SKILL_PROTOCOLS_ROOT = _STEPS_DIR.parent
_PROTOCOLS_DIR = _SKILL_PROTOCOLS_ROOT.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from skill.steps.base import BasePhase, AutoPhase

__all__ = [
    "BasePhase",
    "AutoPhase",
]
