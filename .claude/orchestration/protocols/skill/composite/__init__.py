"""
Composite Skills - Full phase orchestration for multi-phase skill workflows.

Each composite skill has:
- entry.py: Initialize state, start FSM, print first phase directive
- complete.py: Validate all phases executed, finalize workflow
- content/: Phase content markdown files (instructions for each phase)

NOTE: Phase orchestration is handled by the generic advance_phase.py script.
Individual phase Python files are no longer generated - the FSM-based
approach uses config.py phase definitions with advance_phase.py.
"""

from pathlib import Path

COMPOSITE_DIR = Path(__file__).parent

__all__ = ["COMPOSITE_DIR"]
