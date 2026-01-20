#!/usr/bin/env python3
"""
Skill Orchestration Enforcement via PreToolUse Hook - CONTEXT-AWARE VERSION

This hook enforces skill orchestration by blocking direct tool usage from the DA
main thread when orchestration is active. CRITICAL: This hook NEVER blocks agents.

Key Design Principle:
    "Agents have unrestricted access to their frontmatter-declared tools.
     DA has restricted access during orchestration."

Context Detection:
    - Main Thread: orchestration_active flag checked; may restrict Edit/Write/Bash
    - Subagent: Immediately returns EXIT_ALLOW (agents ARE the orchestration)

Exit Codes:
    - EXIT_ALLOW (0): Tool execution proceeds
    - EXIT_BLOCK (1): Tool execution blocked (DA violation)
    - EXIT_HALT (2): Halt execution entirely (future use)

Agent Tool Access:
    Agents have their tools defined in their YAML frontmatter. The Claude Code
    Task tool handles agent tool restrictions based on frontmatter. This hook
    must NEVER interfere with agent tool access.

    Agent frontmatter examples:
    - generation.md: Bash(python3:*), Glob, Grep, Read, Edit, Write, TodoWrite, Skill
    - research.md: Bash(python3:*), Glob, Grep, Read, Edit, Write, WebFetch, WebSearch
    - analysis.md: Bash(python3:*), Glob, Grep, Read, Edit, Write, Playwright tools
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional

# Exit codes for PreToolUse hooks
EXIT_ALLOW = 0
EXIT_BLOCK = 1
EXIT_HALT = 2

# Tools DA can ALWAYS use during orchestration (read-only + orchestration tools)
DA_ALWAYS_ALLOWED_TOOLS = [
    "Task",           # Spawn agents - the correct orchestration path
    "Skill",          # Invoke skills - the correct orchestration path
    "Read",           # Read files (read-only)
    "Glob",           # Search files (read-only)
    "Grep",           # Search content (read-only)
    "TodoWrite",      # Track progress (allowed for visibility)
    "AskUserQuestion", # Clarify requirements (always allowed)
    "WebFetch",       # Fetch web content (read-only)
    "WebSearch",      # Search web (read-only)
]

# Tools that DA CANNOT use directly during orchestration
# These should be used by agents, not DA
DA_BLOCKED_TOOLS_DURING_ORCHESTRATION = [
    "Edit",           # Agent work - artifacts should be created by agents
    "Write",          # Agent work - files should be created by agents
    "Bash",           # Agent work - commands should be run by agents
    "NotebookEdit",   # Agent work - notebooks should be edited by agents
]

# State file paths (relative to project root)
STATE_DIR = ".claude/orchestration/protocols/skill/state"
CURRENT_SESSION_FILE = "current-session.json"


def is_subagent_context() -> bool:
    """
    Detect if running in a subagent context - CRITICAL FOR AGENT SAFETY.

    Subagents are detected by:
    1. CLAUDE_AGENT_TYPE environment variable being set
    2. CLAUDE_PROJECT_DIR containing '/.claude/agents/' path

    Returns:
        True if this is a subagent session (NEVER block these)
        False if this is the main DA thread (may restrict)
    """
    # Method 1: Check CLAUDE_AGENT_TYPE environment variable
    # This is set by Claude Code when spawning agents via Task tool
    agent_type = os.environ.get("CLAUDE_AGENT_TYPE")
    if agent_type is not None:
        return True

    # Method 2: Check CLAUDE_PROJECT_DIR for agent path
    # When agents run, their project dir contains '/.claude/agents/'
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", "")
    normalized = project_dir.replace("\\", "/")
    if "/.claude/agents/" in normalized:
        return True

    return False


def get_state_file_path() -> Path:
    """
    Get path to the current session state file.

    Returns:
        Path to the state file (may not exist if no orchestration active)
    """
    caii_dir = os.environ.get("CAII_DIRECTORY", "")
    if not caii_dir:
        # Fallback to current working directory
        return Path(STATE_DIR) / CURRENT_SESSION_FILE

    return Path(caii_dir) / STATE_DIR / CURRENT_SESSION_FILE


def load_orchestration_state(state_file: Path) -> Optional[Dict[str, Any]]:
    """
    Load orchestration state from the session file.

    Args:
        state_file: Path to the state JSON file

    Returns:
        State dictionary if file exists and valid, None otherwise
    """
    if not state_file.exists():
        return None

    try:
        with open(state_file, 'r') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        print(f"[ENFORCEMENT] Warning: Could not read state file: {e}", file=sys.stderr)
        return None


def is_orchestration_active(state: Optional[Dict[str, Any]]) -> bool:
    """
    Check if skill orchestration is currently active for DA.

    Args:
        state: Loaded state dictionary

    Returns:
        True if orchestration is active and DA should be restricted
    """
    if state is None:
        return False

    return state.get("orchestration_active", False)


def is_allowed_da_tool(tool_name: str) -> bool:
    """
    Check if tool is allowed for DA during orchestration.

    Args:
        tool_name: Name of the tool being invoked

    Returns:
        True if DA can use this tool, False if blocked
    """
    return tool_name in DA_ALWAYS_ALLOWED_TOOLS


def validate_tool_call(tool_name: str, tool_input: Dict[str, Any]) -> int:
    """
    Validate tool call - AGENTS ALWAYS PASS, DA MAY BE RESTRICTED.

    This is the main enforcement logic:
    1. Agents are NEVER blocked (they ARE the orchestration)
    2. DA is restricted when orchestration_active is True
    3. DA can always use read-only and orchestration tools
    4. DA is blocked from Edit/Write/Bash during orchestration

    Args:
        tool_name: Name of the tool being invoked
        tool_input: Parameters passed to the tool

    Returns:
        EXIT_ALLOW (0) to proceed, EXIT_BLOCK (1) to prevent execution
    """
    # CRITICAL: Never block agents - they ARE the orchestration
    # Agents have their tools defined in their YAML frontmatter
    # The Claude Code Task tool handles agent tool restrictions
    # We do NOT interfere with agent tool access
    if is_subagent_context():
        return EXIT_ALLOW

    # Load orchestration state
    state_file = get_state_file_path()
    state = load_orchestration_state(state_file)

    # Not in orchestration mode - allow everything
    if not is_orchestration_active(state):
        return EXIT_ALLOW

    # Skill invocation is always the correct path
    if tool_name == "Skill":
        return EXIT_ALLOW

    # Check if tool is in DA's allowed list
    if is_allowed_da_tool(tool_name):
        return EXIT_ALLOW

    # Tool is blocked during orchestration
    # DA should be invoking Skill tool instead of using Edit/Write/Bash directly
    expected_skill = state.get("expected_skill", "unknown")
    current_phase = state.get("current_phase", "unknown")

    print(f"[ENFORCEMENT] Blocked DA using {tool_name} during skill orchestration", file=sys.stderr)
    print(f"[ENFORCEMENT] Expected: Invoke Skill tool for '{expected_skill}'", file=sys.stderr)
    print(f"[ENFORCEMENT] Current Phase: {current_phase}", file=sys.stderr)
    print(f"[ENFORCEMENT] DA should use Skill tool instead of {tool_name}", file=sys.stderr)

    return EXIT_BLOCK


def main() -> int:
    """
    Main hook entry point.

    Reads tool call information from stdin (JSON) and validates against
    orchestration constraints.

    Returns:
        Exit code (0=allow, 1=block, 2=halt)
    """
    try:
        # Read hook payload from stdin
        hook_data = json.load(sys.stdin)

        tool_name = hook_data.get("tool_name", "")
        tool_input = hook_data.get("tool_input", {})

        if not tool_name:
            # No tool name - allow (shouldn't happen)
            return EXIT_ALLOW

        return validate_tool_call(tool_name, tool_input)

    except json.JSONDecodeError as e:
        print(f"[ENFORCEMENT] Error parsing hook payload: {e}", file=sys.stderr)
        return EXIT_ALLOW  # Don't block on parse errors
    except Exception as e:
        print(f"[ENFORCEMENT] Unexpected error: {e}", file=sys.stderr)
        return EXIT_ALLOW  # Don't block on unexpected errors


if __name__ == "__main__":
    sys.exit(main())
