"""
Agent Configuration
===================

Centralized configuration for all cognitive agents including registry,
context budgets, and path helpers.
"""

import sys
from pathlib import Path

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between agent/config and skill/config
_CONFIG_DIR = Path(__file__).resolve().parent
_AGENT_ROOT = _CONFIG_DIR.parent
_PROTOCOLS_DIR = _AGENT_ROOT.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from agent.config.config import (
    AGENT_PROTOCOLS_ROOT,
    AGENT_REGISTRY,
    AGENT_NAME_ALIASES,
    AGENT_CONTEXT_BUDGETS,
    normalize_agent_name,
    get_agent_budget,
    get_agent_config,
    get_agent_steps,
    get_agent_directory,
    get_step_content_path,
    get_step_script_path,
    format_agent_directive,
)

__all__ = [
    "AGENT_PROTOCOLS_ROOT",
    "AGENT_REGISTRY",
    "AGENT_NAME_ALIASES",
    "AGENT_CONTEXT_BUDGETS",
    "normalize_agent_name",
    "get_agent_budget",
    "get_agent_config",
    "get_agent_steps",
    "get_agent_directory",
    "get_step_content_path",
    "get_step_script_path",
    "format_agent_directive",
]
