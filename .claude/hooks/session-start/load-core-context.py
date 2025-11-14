"""
load-core-context.py
====================

Purpose
-------
Automatically inject a system-reminder at session start that instructs Claude
to read the DA.md file for PAI core context.

Behavior
--------
* Skips execution for subagent sessions (they do not need PAI context).
* Emits a ``<system-reminder>`` block to ``stdout`` with instruction to read DA.md.
* Logs progress to ``stderr``.
* Exits with code ``0`` on success, ``1`` on irrecoverable error.

Environment Variables
---------------------
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
    Entry point for loading PAI core context instruction.

    Workflow
    --------
    1. Detect and skip subagent sessions.
    2. Emit a ``<system-reminder>`` instructing Claude to read DA.md.

    :returns: ``0`` on success; ``1`` on irrecoverable error.
    :rtype: int
    """
    try:
        # 1) Skip for subagent sessions
        if is_subagent_session():
            print("🤖 Subagent session - skipping PAI context loading", file=sys.stderr)
            return 0

        # 2) Emit system reminder instruction to STDOUT
        message = (
            "<system-reminder>\n"
            "# 🚨 YOU'RE MANDATORY PROTOCOL! YOU MUST ALWAYS FOLLOW THE BELOW PROTOCOL! "
            "FAILURE TO FOLLOW THE BELOW PROTOCOL WILL RESULT IN A SYSTEM CRASH! 🚨\n"
            "1. IMMEDIATELY READ THE `${PAI_DIRECTORY}/.claude/DA.md` FILE\n"
            "</system-reminder>"
        )

        print(message)  # Captured by the host (Claude Code)

        # 3) Emit user-visible success message (appears in chat UI)
        print("\n✅ **Penny Core Context Loaded** — Ready to assist with your tasks!\n")

        print("✅ PAI context instruction injected into session", file=sys.stderr)
        return 0

    except Exception as exc:  # pragma: no cover - defensive
        print(f"❌ Error in load-core-context hook: {exc}", file=sys.stderr)
        return 1


#########################[ end main ]########################################

if __name__ == "__main__":
    sys.exit(main())
