"""
Shared Content - Cross-protocol content modules.

This directory contains content that is referenced by multiple protocols,
agents, and skills. Each content piece exists in exactly ONE place here
and is referenced by components that need it.

Directories:
- agents/protocols/: Agent execution patterns (error-handling, communication, learning, memory, unknowns)
- agents/gates/: Quality gates
- agents/format/: Output formatting
- protocols/: Cross-cutting protocols (johari.md)
- format/: General formatting (johari format)
- context/loading/: Context loading patterns and checklist
- context/loading/patterns/: Specific loading patterns (workflow, immediate-predecessors, etc.)
- context/pruning/: Pruning implementation and levels
- context/pruning/compression/: Compression levels and techniques
- skills/code-generation/: Code generation patterns (TDD, security, structure, python-setup)
"""

from pathlib import Path

SHARED_CONTENT_ROOT = Path(__file__).parent

__all__ = ["SHARED_CONTENT_ROOT", "load_shared_content"]


def load_shared_content(content_path: str) -> str:
    """
    Load content from shared directory.

    Args:
        content_path: Relative path within shared/

    Returns:
        Content string or empty string if not found
    """
    full_path = SHARED_CONTENT_ROOT / content_path
    if full_path.exists():
        return full_path.read_text()
    return ""
