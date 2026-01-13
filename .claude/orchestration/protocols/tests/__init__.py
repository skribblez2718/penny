"""
Orchestration Protocol Tests
============================

Comprehensive test suite for the orchestration system including:
- State management tests (reasoning, skill, agent states)
- FSM transition tests (valid paths, invalid transitions, loop-backs)
- Memory file verification tests
- Advance phase blocking tests (CRITICAL)
- Entry point tests
- End-to-end flow tests
- Edge case tests (halt, remediation, recovery)

Run tests:
    pytest protocols/tests/ -v
    pytest protocols/tests/ -k "fsm" -v  # Run FSM tests only
    pytest protocols/tests/ --cov=protocols --cov-report=html

Interactive simulation:
    python3 protocols/tests/interactive_runner.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Add orchestration root to sys.path for imports
_TESTS_DIR = Path(__file__).resolve().parent
_PROTOCOLS_DIR = _TESTS_DIR.parent
_ORCHESTRATION_ROOT = _PROTOCOLS_DIR.parent
_CLAUDE_ROOT = _ORCHESTRATION_ROOT.parent
_PROJECT_ROOT = _CLAUDE_ROOT.parent

# Ensure imports work from tests
if str(_ORCHESTRATION_ROOT) not in sys.path:
    sys.path.insert(0, str(_ORCHESTRATION_ROOT))
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

# Export path constants for test modules
TESTS_DIR = _TESTS_DIR
PROTOCOLS_DIR = _PROTOCOLS_DIR
ORCHESTRATION_ROOT = _ORCHESTRATION_ROOT
CLAUDE_ROOT = _CLAUDE_ROOT
PROJECT_ROOT = _PROJECT_ROOT

__all__ = [
    "TESTS_DIR",
    "PROTOCOLS_DIR",
    "ORCHESTRATION_ROOT",
    "CLAUDE_ROOT",
    "PROJECT_ROOT",
]
