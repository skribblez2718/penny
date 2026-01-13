"""
config package
==============

Configuration for the Mandatory Reasoning Protocol.
"""

from reasoning.config.config import (
    # Paths
    ORCHESTRATION_ROOT,
    STEPS_DIR,
    CONTENT_DIR,
    STATE_DIR,
    TESTS_DIR,
    # Protocol metadata
    PROTOCOL_NAME,
    PROTOCOL_VERSION,
    SCHEMA_VERSION,
    # Step configuration
    TOTAL_STEPS,
    STEP_NAMES,
    STEP_TITLES,
    # File patterns
    STATE_FILE_PATTERN,
    STEP_CONTENT_PATTERN,
    STEP_SCRIPT_PATTERN,
    # Functions
    get_state_file_path,
    get_step_content_path,
    get_step_script_path,
    ensure_directories,
    format_mandatory_directive,
)

__all__ = [
    # Paths
    "ORCHESTRATION_ROOT",
    "STEPS_DIR",
    "CONTENT_DIR",
    "STATE_DIR",
    "TESTS_DIR",
    # Protocol metadata
    "PROTOCOL_NAME",
    "PROTOCOL_VERSION",
    "SCHEMA_VERSION",
    # Step configuration
    "TOTAL_STEPS",
    "STEP_NAMES",
    "STEP_TITLES",
    # File patterns
    "STATE_FILE_PATTERN",
    "STEP_CONTENT_PATTERN",
    "STEP_SCRIPT_PATTERN",
    # Functions
    "get_state_file_path",
    "get_step_content_path",
    "get_step_script_path",
    "ensure_directories",
    "format_mandatory_directive",
]
