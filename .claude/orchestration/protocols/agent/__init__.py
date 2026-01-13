"""
Agent Protocols
===============

Python orchestration for cognitive agent execution protocols.

Each cognitive agent has a multi-step execution methodology that is
orchestrated via Python scripts. The content for each step is stored
in markdown files and read one step at a time.

Directory Structure:
    protocols/agent/
    ├── __init__.py             # THIS FILE
    ├── factory.py              # Unified agent entry point
    ├── CLAUDE.md               # Documentation
    ├── common/
    │   ├── __init__.py
    │   ├── entry.py            # Shared agent initialization
    │   └── complete.py         # Shared agent completion
    ├── config/
    │   ├── __init__.py
    │   └── config.py           # Agent registry and configuration
    ├── steps/
    │   ├── __init__.py
    │   ├── base.py             # Base class for agent steps
    │   └── shared.py           # Shared step implementations (steps 0-1)
    ├── state/                  # Agent state files (JSON)
    └── {agent}/                # Per-agent directories
        ├── entry.py
        ├── complete.py
        ├── content/            # Markdown step content
        └── steps/              # Python step orchestration
"""

import sys
from pathlib import Path

AGENT_PROTOCOLS_ROOT = Path(__file__).parent

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between agent/config and skill/config
_PROTOCOLS_DIR = AGENT_PROTOCOLS_ROOT.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

# Re-export key components for convenience
from agent.config.config import (
    AGENT_REGISTRY,
    AGENT_NAME_ALIASES,
    AGENT_CONTEXT_BUDGETS,
    get_agent_config,
    get_agent_budget,
    normalize_agent_name,
)

from agent.steps.base import (
    AgentExecutionState,
    BaseAgentStep,
    count_tokens,
    enforce_context_budget,
)

from agent.common.entry import agent_entry
from agent.common.complete import agent_complete

__all__ = [
    "AGENT_PROTOCOLS_ROOT",
    # Config exports
    "AGENT_REGISTRY",
    "AGENT_NAME_ALIASES",
    "AGENT_CONTEXT_BUDGETS",
    "get_agent_config",
    "get_agent_budget",
    "normalize_agent_name",
    # Steps exports
    "AgentExecutionState",
    "BaseAgentStep",
    "count_tokens",
    "enforce_context_budget",
    # Common exports
    "agent_entry",
    "agent_complete",
]
