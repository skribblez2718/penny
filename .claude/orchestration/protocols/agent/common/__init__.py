"""
Common Agent Entry/Complete Logic
=================================

Shared initialization and completion logic for all cognitive agents.
"""

from pathlib import Path
import sys

# Add protocols directory to path for fully-qualified imports
_COMMON_DIR = Path(__file__).resolve().parent
_AGENT_PROTOCOLS_DIR = _COMMON_DIR.parent
_PROTOCOLS_DIR = _AGENT_PROTOCOLS_DIR.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

# Re-export for convenience (using fully-qualified imports)
from agent.common.entry import agent_entry, parse_args
from agent.common.complete import agent_complete

__all__ = ["agent_entry", "agent_complete", "parse_args"]
