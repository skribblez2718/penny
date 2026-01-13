"""
load-core-context.py
====================

Purpose
-------
Automatically inject the DA.md file contents as a system-reminder at session
start, providing PAI core context directly to Claude.

Behavior
--------
* Skips execution for subagent sessions (they do not need PAI context).
* Reads DA.md from ``${CAII_DIRECTORY}/.claude/DA.md``.
* Emits the contents wrapped in ``<system-reminder>`` tags to ``stdout``.
* Logs progress to ``stderr``.
* Exits with code ``0`` on success, ``1`` on irrecoverable error.

Environment Variables
---------------------
* ``CAII_DIRECTORY`` — Base directory for PAI configuration files.
* ``CLAUDE_PROJECT_DIR`` — If it contains ``/.claude/agents/``, this is treated
  as a subagent session.
* ``CLAUDE_AGENT_TYPE`` — If set (to any value), this is treated as a subagent
  session.
"""

from __future__ import annotations

import os
import sys


#########################[ start is_subagent_session ]#######################
def is_subagent_session() -> bool:
    """
    Determine whether the current session is a subagent session.

    A session is considered a subagent if either of the following is true:

    * ``CLAUDE_PROJECT_DIR`` contains the substring ``"/.claude/agents/"``; or
    * ``CLAUDE_AGENT_TYPE`` is set in the environment.

    :returns: ``True`` if this looks like a subagent session; ``False`` otherwise.
    :rtype: bool
    """
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", "")
    normalized = project_dir.replace("\\", "/")
    return "/.claude/agents/" in normalized or os.environ.get("CLAUDE_AGENT_TYPE") is not None


#########################[ end is_subagent_session ]#########################

#########################[ start main ]######################################
def main() -> int:
    """
    Entry point for loading PAI core context.

    Workflow
    --------
    1. Detect and skip subagent sessions.
    2. Read DA.md contents from CAII_DIRECTORY.
    3. Emit contents wrapped in ``<system-reminder>`` tags.

    :returns: ``0`` on success; ``1`` on irrecoverable error.
    :rtype: int
    """
    try:
        # 1) Skip for subagent sessions
        if is_subagent_session():
            print("🤖 Subagent session - skipping PAI context loading", file=sys.stderr)
            return 0

        # 2) Get CAII_DIRECTORY and construct DA.md path
        caii_directory = os.environ.get("CAII_DIRECTORY")
        if not caii_directory:
            print("⚠️ CAII_DIRECTORY not set - skipping context injection", file=sys.stderr)
            return 0

        da_path = os.path.join(caii_directory, ".claude", "DA.md")

        # 3) Read DA.md contents
        if not os.path.isfile(da_path):
            print(f"❌ DA.md not found at: {da_path}", file=sys.stderr)
            return 1

        with open(da_path, "r", encoding="utf-8") as f:
            da_contents = f.read()

        # 4) Emit system reminder with DA.md contents to STDOUT
        message = f"<system-reminder>\n{da_contents}\n</system-reminder>"
        print(message)  # Captured by the host (Claude Code)
        return 0

    except Exception as exc:  # pragma: no cover - defensive
        print(f"❌ Error in load-core-context hook: {exc}", file=sys.stderr)
        return 1


#########################[ end main ]########################################

if __name__ == "__main__":
    sys.exit(main())
