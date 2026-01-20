#!/usr/bin/env python3
"""
Skill Bypass Detector via PostToolUse Hook - Layer 4 Observability

This hook provides post-hoc detection and logging of skill orchestration bypasses.
Since Layer 2 (PreToolUse) should provide 100% blocking, this hook primarily serves
for observability, debugging, and analytics.

Purpose:
    - Detect when DA uses Edit/Write/Bash/NotebookEdit during active orchestration
    - Log bypass events for pattern analysis
    - Provide remediation directive (though this may be too late since tool already ran)

This hook runs AFTER tools complete, so it cannot prevent bypasses - it can only
detect and log them. The PreToolUse hook (skill-enforcement.py) handles prevention.

Exit Codes:
    PostToolUse hooks always return 0 (exit codes don't affect tool result)

Log Format (JSONL):
    {
        "timestamp": "ISO8601",
        "tool_name": "Edit|Write|Bash|NotebookEdit",
        "tool_input": {...},
        "session_id": "...",
        "expected_skill": "...",
        "current_phase": "...",
        "context": "da_main_thread|subagent"
    }
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

# State and log paths (relative to CAII_DIRECTORY)
STATE_DIR = ".claude/orchestration/protocols/skill/state"
CURRENT_SESSION_FILE = "current-session.json"
LOG_DIR = ".claude/logs"
LOG_FILE = "skill-bypass-events.jsonl"

# Tools that indicate a potential bypass
BYPASS_INDICATOR_TOOLS = [
    "Edit",
    "Write",
    "Bash",
    "NotebookEdit",
]


def is_subagent_context() -> bool:
    """
    Detect if running in a subagent context.

    Subagents are expected to use these tools - not a bypass.

    Returns:
        True if this is a subagent session
        False if this is the main DA thread
    """
    # Method 1: Check CLAUDE_AGENT_TYPE environment variable
    agent_type = os.environ.get("CLAUDE_AGENT_TYPE")
    if agent_type is not None:
        return True

    # Method 2: Check CLAUDE_PROJECT_DIR for agent path
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", "")
    normalized = project_dir.replace("\\", "/")
    if "/.claude/agents/" in normalized:
        return True

    return False


def get_caii_directory() -> Path:
    """Get CAII_DIRECTORY from environment or raise error."""
    caii_dir = os.environ.get("CAII_DIRECTORY", "")
    if not caii_dir:
        # Fallback to current working directory
        return Path.cwd()
    return Path(caii_dir)


def get_state_file_path() -> Path:
    """Get path to the current session state file."""
    caii_dir = get_caii_directory()
    return caii_dir / STATE_DIR / CURRENT_SESSION_FILE


def get_log_file_path() -> Path:
    """Get path to the bypass events log file."""
    caii_dir = get_caii_directory()
    return caii_dir / LOG_DIR / LOG_FILE


def load_orchestration_state(state_file: Path) -> Optional[Dict[str, Any]]:
    """Load orchestration state from the session file."""
    if not state_file.exists():
        return None

    try:
        with open(state_file, 'r') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return None


def is_orchestration_active(state: Optional[Dict[str, Any]]) -> bool:
    """Check if skill orchestration is currently active."""
    if state is None:
        return False
    return state.get("orchestration_active", False)


def log_bypass_event(
    tool_name: str,
    tool_input: Dict[str, Any],
    state: Optional[Dict[str, Any]],
    is_subagent: bool
) -> None:
    """
    Log a bypass event to the JSONL log file.

    Args:
        tool_name: Name of the tool that was used
        tool_input: Parameters passed to the tool
        state: Current orchestration state (if available)
        is_subagent: Whether this is from a subagent context
    """
    log_file = get_log_file_path()

    # Ensure log directory exists
    log_file.parent.mkdir(parents=True, exist_ok=True)

    # Build log entry
    entry = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "tool_name": tool_name,
        "tool_input_summary": _summarize_tool_input(tool_name, tool_input),
        "session_id": state.get("session_id") if state else None,
        "expected_skill": state.get("expected_skill") if state else None,
        "current_phase": state.get("current_phase") if state else None,
        "context": "subagent" if is_subagent else "da_main_thread",
        "orchestration_active": is_orchestration_active(state),
        "was_blocked_by_layer2": False,  # If we're logging here, it got through
    }

    try:
        with open(log_file, 'a') as f:
            f.write(json.dumps(entry) + "\n")
    except IOError as e:
        print(f"[BYPASS-DETECTOR] Warning: Could not write to log file: {e}", file=sys.stderr)


def _summarize_tool_input(tool_name: str, tool_input: Dict[str, Any]) -> Dict[str, Any]:
    """
    Create a summary of tool input for logging (avoid logging sensitive content).

    Args:
        tool_name: Name of the tool
        tool_input: Full tool input parameters

    Returns:
        Summarized input suitable for logging
    """
    if tool_name == "Edit":
        return {
            "file_path": tool_input.get("file_path"),
            "old_string_length": len(tool_input.get("old_string", "")),
            "new_string_length": len(tool_input.get("new_string", "")),
        }
    elif tool_name == "Write":
        return {
            "file_path": tool_input.get("file_path"),
            "content_length": len(tool_input.get("content", "")),
        }
    elif tool_name == "Bash":
        command = tool_input.get("command", "")
        # Truncate long commands
        return {
            "command_preview": command[:100] + "..." if len(command) > 100 else command,
            "has_timeout": "timeout" in tool_input,
        }
    elif tool_name == "NotebookEdit":
        return {
            "notebook_path": tool_input.get("notebook_path"),
            "edit_mode": tool_input.get("edit_mode"),
        }
    else:
        return {"tool": tool_name}


def emit_remediation_directive(tool_name: str, state: Optional[Dict[str, Any]]) -> None:
    """
    Emit a remediation directive to stdout.

    Note: This is post-hoc - the tool already ran. This directive informs Claude
    that a bypass occurred and suggests corrective action for future invocations.

    Args:
        tool_name: Name of the tool that was used
        state: Current orchestration state
    """
    expected_skill = state.get("expected_skill", "unknown") if state else "unknown"
    current_phase = state.get("current_phase", "unknown") if state else "unknown"

    # Output as system reminder
    print(f"""<system-reminder>
[SKILL-BYPASS-DETECTED] Tool '{tool_name}' was used directly during active orchestration.

Expected behavior: DA should invoke Skill tool for '{expected_skill}' phase '{current_phase}'
Detected: Direct {tool_name} usage bypassing skill orchestration

This bypass has been logged. Future tool calls should route through the Skill tool
to maintain orchestration integrity.

Remediation: For subsequent operations in this workflow, use:
  Skill tool with skill: "{expected_skill}"

Note: The PreToolUse hook (Layer 2) should have blocked this. If you're seeing this
message, please investigate why Layer 2 enforcement failed.
</system-reminder>""")


def detect_bypass(tool_name: str, tool_input: Dict[str, Any]) -> None:
    """
    Main bypass detection logic.

    Args:
        tool_name: Name of the tool that was used
        tool_input: Parameters passed to the tool
    """
    # Only check bypass indicator tools
    if tool_name not in BYPASS_INDICATOR_TOOLS:
        return

    # Check if in subagent context (expected usage, not a bypass)
    is_subagent = is_subagent_context()

    # Load orchestration state
    state_file = get_state_file_path()
    state = load_orchestration_state(state_file)

    # Check if orchestration is active
    if not is_orchestration_active(state):
        # Orchestration not active - not a bypass
        return

    # At this point, orchestration IS active and a bypass indicator tool was used

    if is_subagent:
        # Subagent usage during orchestration is EXPECTED (agents do the work)
        # Log for analytics but don't emit remediation
        log_bypass_event(tool_name, tool_input, state, is_subagent=True)
        return

    # DA main thread used Edit/Write/Bash during orchestration - THIS IS A BYPASS
    # Log the event
    log_bypass_event(tool_name, tool_input, state, is_subagent=False)

    # Emit remediation directive
    emit_remediation_directive(tool_name, state)

    # Also print to stderr for visibility
    print(f"[BYPASS-DETECTOR] Skill bypass detected: DA used {tool_name} during orchestration", file=sys.stderr)


def main() -> int:
    """
    Main hook entry point.

    Reads tool call information from stdin (JSON) and checks for bypass patterns.

    Returns:
        Always returns 0 (PostToolUse hooks don't affect tool result)
    """
    try:
        # Read hook payload from stdin
        hook_data = json.load(sys.stdin)

        tool_name = hook_data.get("tool_name", "")
        tool_input = hook_data.get("tool_input", {})

        if tool_name:
            detect_bypass(tool_name, tool_input)

    except json.JSONDecodeError as e:
        print(f"[BYPASS-DETECTOR] Error parsing hook payload: {e}", file=sys.stderr)
    except Exception as e:
        print(f"[BYPASS-DETECTOR] Unexpected error: {e}", file=sys.stderr)

    # PostToolUse hooks always return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
