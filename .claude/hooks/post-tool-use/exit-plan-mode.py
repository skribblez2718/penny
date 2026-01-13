#!/usr/bin/env python3
"""
PostToolUse hook for ExitPlanMode - triggers reasoning protocol.

This hook fires AFTER the ExitPlanMode tool completes, providing
100% reliable triggering of the reasoning protocol.

PostToolUse stdout goes DIRECTLY to Claude's context, making this
the correct way to inject the reasoning protocol directive.

Key differences from PreToolUse:
- PreToolUse stdout -> transcript only (NOT Claude's context)
- PostToolUse stdout -> DIRECTLY to Claude's context
"""

import subprocess
import sys
import os
import json
from pathlib import Path
from typing import Optional


def is_subagent_session() -> bool:
    """
    Detect if running in a subagent context.
    Subagents don't use plan mode, so we skip for them.
    """
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", "")
    normalized = project_dir.replace("\\", "/")
    if "/.claude/agents/" in normalized:
        return True
    if os.environ.get("CLAUDE_AGENT_TYPE") is not None:
        return True
    return False


def find_most_recent_plan_file() -> Optional[Path]:
    """
    Find the most recently modified plan file in ~/.claude/plans/.

    Claude Code writes plan files to this directory when in plan mode.
    We find the most recent one to get the approved plan content.

    Returns:
        Path to the most recent plan file, or None if no plan files exist.
    """
    plans_dir = Path.home() / ".claude" / "plans"
    if not plans_dir.exists():
        return None

    plan_files = list(plans_dir.glob("*.md"))
    if not plan_files:
        return None

    # Sort by modification time, most recent first
    plan_files.sort(key=lambda f: f.stat().st_mtime, reverse=True)
    return plan_files[0]


def read_plan_file(plan_file: Path) -> Optional[str]:
    """
    Read the plan file content.

    Args:
        plan_file: Path to the plan file

    Returns:
        Plan file content as string, or None on error.
    """
    try:
        if plan_file.exists():
            return plan_file.read_text(encoding='utf-8')
    except Exception as e:
        print(f"Error reading plan file: {e}", file=sys.stderr)
    return None


def main():
    """
    Main hook function - triggers reasoning protocol on plan mode exit.

    This hook is called via PostToolUse matcher when ExitPlanMode tool completes.
    PostToolUse stdout goes directly to Claude's context, so we invoke entry.py
    and output its result.
    """
    try:
        # Read JSON payload from stdin
        hook_data = json.load(sys.stdin)

        # Skip for subagents (they don't use plan mode)
        if is_subagent_session():
            return 0

        # Get CAII_DIRECTORY for entry script path
        pai_dir = os.environ.get("CAII_DIRECTORY")
        if not pai_dir:
            print("CAII_DIRECTORY not set, cannot trigger reasoning", file=sys.stderr)
            return 0

        entry_script = Path(pai_dir) / ".claude/orchestration/protocols/reasoning/entry.py"
        if not entry_script.exists():
            print(f"entry.py not found at {entry_script}", file=sys.stderr)
            return 0

        # Find and read the most recent plan file
        plan_file = find_most_recent_plan_file()
        plan_content = ""
        plan_file_path = ""

        if plan_file:
            plan_content = read_plan_file(plan_file) or ""
            plan_file_path = str(plan_file)

        # Truncate plan content for the query (keep it manageable)
        plan_summary = plan_content[:3000] if plan_content else ""
        if len(plan_content) > 3000:
            plan_summary += "\n\n... [plan truncated for context]"

        # Build the query for entry.py
        query = f"PLAN_APPROVED: Execute the approved plan.\n\n## Plan File\n{plan_file_path}\n\n## Plan Content\n{plan_summary}"

        # Execute entry.py and capture output
        # This invokes the reasoning protocol directly
        result = subprocess.run(
            ["python3", str(entry_script), query],
            capture_output=True,
            text=True,
            cwd=pai_dir,
            env={**os.environ, "CAII_DIRECTORY": pai_dir}
        )

        # Output goes DIRECTLY to Claude's context
        # This is the key difference from PreToolUse (which goes to transcript only)
        if result.stdout:
            print(result.stdout, flush=True)

        # Log errors to stderr (for debugging, won't affect Claude's context)
        if result.stderr:
            print(f"entry.py stderr: {result.stderr}", file=sys.stderr)

        return 0

    except json.JSONDecodeError as e:
        print(f"Failed to parse JSON payload: {e}", file=sys.stderr)
        return 0
    except Exception as e:
        print(f"Exit plan mode hook error: {e}", file=sys.stderr)
        return 0  # Don't fail the hook even if there's an error


if __name__ == "__main__":
    sys.exit(main())
