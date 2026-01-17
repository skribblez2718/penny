#!/usr/bin/env python3
"""
Directive formatting module - centralized directive formatting for all protocols.

This module provides a unified API for formatting MANDATORY directives across:
- Reasoning protocol
- Execution protocol
- UserPromptSubmit hook

Import via sys.path.insert pattern (NEVER use relative imports):
    import sys
    from pathlib import Path
    _ORCHESTRATION_ROOT = Path(__file__).resolve().parent.parent.parent.parent
    if str(_ORCHESTRATION_ROOT) not in sys.path:
        sys.path.insert(0, str(_ORCHESTRATION_ROOT))
    from directives.base import _format_directive_core, CANONICAL_HEADER
"""

from .base import (
    CANONICAL_HEADER,
    _format_directive_core,
)

__all__ = [
    "CANONICAL_HEADER",
    "_format_directive_core",
]
