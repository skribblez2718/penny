#!/usr/bin/env python3
"""
Core directive formatting - shared by all protocols.

This module provides the canonical directive formatting implementation used by:
- protocols/reasoning/config/config.py
- protocols/execution/config/config.py
- hooks/user-prompt-submit/submit.py

Import via sys.path.insert pattern (NEVER use relative imports):
    import sys
    from pathlib import Path
    _ORCHESTRATION_ROOT = Path(__file__).resolve().parent.parent.parent.parent
    if str(_ORCHESTRATION_ROOT) not in sys.path:
        sys.path.insert(0, str(_ORCHESTRATION_ROOT))
    from directives.base import _format_directive_core, CANONICAL_HEADER
"""

from __future__ import annotations

from typing import List, Optional

# Canonical header used by all MANDATORY directives
CANONICAL_HEADER = "**MANDATORY - EXECUTE IMMEDIATELY BEFORE ANY OTHER ACTION:**"


def _format_directive_core(
    command: str,
    context: str = "",
    warnings: Optional[List[str]] = None,
) -> str:
    """
    Base directive formatting. All domain-specific functions call this.

    This creates a consistently formatted MANDATORY directive that Claude
    recognizes from DA.md training. The format is designed to be unambiguous
    about the requirement to execute before any other action.

    Args:
        command: The command to execute (without backticks)
        context: Optional context about what this step accomplishes
        warnings: Optional list of warning messages to include

    Returns:
        Formatted directive string with mandatory enforcement language

    Example:
        >>> _format_directive_core(
        ...     "python3 entry.py",
        ...     context="Start reasoning protocol.",
        ...     warnings=["Execute NOW. Do NOT respond with text first."]
        ... )
        **MANDATORY - EXECUTE IMMEDIATELY BEFORE ANY OTHER ACTION:**
        `python3 entry.py`

        ⚠️ Execute NOW. Do NOT respond with text first.
        Start reasoning protocol.
    """
    # Build warning lines
    warning_lines = []
    if warnings:
        for w in warnings:
            warning_lines.append(f"⚠️ {w}")
    warning_text = "\n".join(warning_lines)

    # Build the full directive
    parts = [CANONICAL_HEADER, f"`{command}`"]

    if warning_text:
        parts.append("")  # Blank line before warnings
        parts.append(warning_text)

    if context:
        parts.append(context)

    return "\n".join(parts).strip()
