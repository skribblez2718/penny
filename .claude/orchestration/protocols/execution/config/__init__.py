"""
config/__init__.py
==================

Configuration package for execution protocols.
"""

import sys
from pathlib import Path

# Ensure parent is importable
_PACKAGE_DIR = Path(__file__).resolve().parent
_EXECUTION_ROOT = _PACKAGE_DIR.parent
if str(_EXECUTION_ROOT) not in sys.path:
    sys.path.insert(0, str(_EXECUTION_ROOT))

from config.config import (
    # Paths
    EXECUTION_PROTOCOLS_ROOT,
    ORCHESTRATION_ROOT,
    # Enums
    ProtocolType,
    # Route mapping
    VALID_ROUTES,
    ROUTE_ALIASES,
    ROUTE_TO_PROTOCOL,
    PROTOCOL_TO_DIR,
    normalize_route_name,
    # Step definitions
    SKILL_ORCHESTRATION_STEPS,
    DYNAMIC_SKILL_SEQUENCING_STEPS,
    PROTOCOL_STEPS,
    PROTOCOL_TOTAL_STEPS,
    # State config
    SCHEMA_VERSION,
    EXECUTION_PROTOCOL_VERSION,
    # Helper functions
    get_protocol_dir,
    get_protocol_steps_dir,
    get_protocol_content_dir,
    get_protocol_state_dir,
    get_step_script_path,
    get_step_content_path,
    get_state_file_path,
    format_mandatory_directive,
)

__all__ = [
    "EXECUTION_PROTOCOLS_ROOT",
    "ORCHESTRATION_ROOT",
    "ProtocolType",
    "VALID_ROUTES",
    "ROUTE_ALIASES",
    "ROUTE_TO_PROTOCOL",
    "PROTOCOL_TO_DIR",
    "normalize_route_name",
    "SKILL_ORCHESTRATION_STEPS",
    "DYNAMIC_SKILL_SEQUENCING_STEPS",
    "PROTOCOL_STEPS",
    "PROTOCOL_TOTAL_STEPS",
    "SCHEMA_VERSION",
    "EXECUTION_PROTOCOL_VERSION",
    "get_protocol_dir",
    "get_protocol_steps_dir",
    "get_protocol_content_dir",
    "get_protocol_state_dir",
    "get_step_script_path",
    "get_step_content_path",
    "get_state_file_path",
    "format_mandatory_directive",
]
