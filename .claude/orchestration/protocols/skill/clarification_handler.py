"""
Clarification Handler Module
============================

Provides utilities for detecting and processing clarification requests
from agent memory files.

IMPORTANT: Due to Claude Code limitations, subagents CANNOT use the
AskUserQuestion tool directly. Instead, they document questions in their
memory files, and this module helps the main orchestrator thread detect and
process those questions.

Usage Flow:
1. Agent completes and writes memory file with Section 4: User Questions
2. Main orchestrator thread calls check_clarification_needed() to detect questions
3. If questions found, main thread uses AskUserQuestion to present them
4. Answers are provided to the next phase or agent re-invocation

Example:
    from skill.clarification_handler import (
        check_clarification_needed,
        extract_questions_from_memory,
        format_questions_for_ask_user,
    )

    # After agent completes
    memory_path = f".claude/memory/{task_id}-clarification-memory.md"

    if check_clarification_needed(memory_path):
        questions = extract_questions_from_memory(memory_path)
        ask_user_params = format_questions_for_ask_user(questions)
        # Use AskUserQuestion tool with these params
"""

import json
import re
from pathlib import Path
from typing import Optional


def check_clarification_needed(memory_file_path: str | Path) -> bool:
    """
    Check if a memory file indicates clarification is needed.

    Looks for:
    1. Section 4: User Questions with clarification_required: true
    2. JSON block with clarification_required field

    Args:
        memory_file_path: Path to the agent's memory file

    Returns:
        True if clarification is required, False otherwise
    """
    path = Path(memory_file_path)

    if not path.exists():
        return False

    content = path.read_text()

    # Look for clarification_required: true in JSON blocks
    json_pattern = r'```json\s*(\{[^`]+\})\s*```'
    matches = re.findall(json_pattern, content, re.DOTALL)

    for match in matches:
        try:
            data = json.loads(match)
            if data.get("clarification_required") is True:
                return True
        except json.JSONDecodeError:
            continue

    return False


def extract_questions_from_memory(memory_file_path: str | Path) -> list[dict]:
    """
    Extract user questions from a memory file.

    Parses Section 4: User Questions JSON block to extract
    the list of questions to present to the user.

    Args:
        memory_file_path: Path to the agent's memory file

    Returns:
        List of question dictionaries, each with:
        - id: Question identifier
        - priority: P0/P1/P2
        - question: The question text
        - context: Why this question matters
        - options: Optional list of choices
        - default: Optional default answer
        - multi_select: Whether multiple options allowed
    """
    path = Path(memory_file_path)

    if not path.exists():
        return []

    content = path.read_text()

    # Find Section 4 and extract JSON
    section4_pattern = r'## Section 4.*?```json\s*(\{[^`]+\})\s*```'
    match = re.search(section4_pattern, content, re.DOTALL | re.IGNORECASE)

    if not match:
        # Fall back to any JSON with questions array
        json_pattern = r'```json\s*(\{[^`]+\})\s*```'
        matches = re.findall(json_pattern, content, re.DOTALL)

        for m in matches:
            try:
                data = json.loads(m)
                if "questions" in data and isinstance(data["questions"], list):
                    return data["questions"]
            except json.JSONDecodeError:
                continue

        return []

    try:
        data = json.loads(match.group(1))
        return data.get("questions", [])
    except json.JSONDecodeError:
        return []


def format_questions_for_ask_user(
    questions: list[dict],
    max_questions: int = 4,
) -> list[dict]:
    """
    Format extracted questions for the AskUserQuestion tool.

    Converts agent question format to AskUserQuestion parameter format.

    Args:
        questions: List of question dicts from extract_questions_from_memory
        max_questions: Maximum questions to include (AskUserQuestion limit is 4)

    Returns:
        List of question parameter dicts for AskUserQuestion tool:
        [
            {
                "question": "Question text?",
                "header": "Short label",
                "options": [
                    {"label": "Option A", "description": "Description A"},
                    {"label": "Option B", "description": "Description B"}
                ],
                "multiSelect": false
            }
        ]
    """
    result = []

    # Sort by priority (P0 first)
    priority_order = {"P0": 0, "P1": 1, "P2": 2}
    sorted_questions = sorted(
        questions,
        key=lambda q: priority_order.get(q.get("priority", "P2"), 2)
    )

    for q in sorted_questions[:max_questions]:
        formatted = {
            "question": q.get("question", ""),
            "header": q.get("id", "Q")[:12],  # Max 12 chars for header
            "multiSelect": q.get("multi_select", False),
        }

        # Format options if provided
        options = q.get("options", [])
        if options:
            formatted["options"] = []
            for i, opt in enumerate(options[:4]):  # Max 4 options
                if isinstance(opt, dict):
                    formatted["options"].append({
                        "label": opt.get("label", str(opt)),
                        "description": opt.get("description", ""),
                    })
                else:
                    formatted["options"].append({
                        "label": str(opt),
                        "description": q.get("context", "") if i == 0 else "",
                    })
        else:
            # Create default options for open questions
            formatted["options"] = [
                {"label": "Provide details", "description": q.get("context", "")},
                {"label": "Skip for now", "description": "Address this later"},
            ]

        result.append(formatted)

    return result


def get_clarification_summary(memory_file_path: str | Path) -> Optional[str]:
    """
    Get a summary of what clarification is needed.

    Useful for logging or displaying to the user before asking questions.

    Args:
        memory_file_path: Path to the agent's memory file

    Returns:
        Summary string, or None if no clarification needed
    """
    if not check_clarification_needed(memory_file_path):
        return None

    questions = extract_questions_from_memory(memory_file_path)

    if not questions:
        return "Clarification needed but no specific questions found."

    p0_count = sum(1 for q in questions if q.get("priority") == "P0")
    p1_count = sum(1 for q in questions if q.get("priority") == "P1")
    p2_count = sum(1 for q in questions if q.get("priority") == "P2")

    parts = []
    if p0_count:
        parts.append(f"{p0_count} blocking question(s)")
    if p1_count:
        parts.append(f"{p1_count} important question(s)")
    if p2_count:
        parts.append(f"{p2_count} optional question(s)")

    return f"Clarification needed: {', '.join(parts)}"


# Convenience function for main orchestrator
def handle_clarification_if_needed(
    memory_file_path: str | Path,
) -> Optional[list[dict]]:
    """
    Check for and format clarification questions if needed.

    This is the main entry point for the orchestrator to check
    if user clarification is needed after an agent completes.

    Args:
        memory_file_path: Path to the agent's memory file

    Returns:
        Formatted questions for AskUserQuestion if clarification needed,
        None if no clarification needed

    Example:
        questions = handle_clarification_if_needed(memory_path)
        if questions:
            # Use AskUserQuestion tool with questions parameter
            pass
        else:
            # Continue to next phase
            pass
    """
    if not check_clarification_needed(memory_file_path):
        return None

    questions = extract_questions_from_memory(memory_file_path)

    if not questions:
        return None

    return format_questions_for_ask_user(questions)


def build_ask_user_invocation(questions: list[dict]) -> str:
    """
    Build a complete AskUserQuestion tool invocation directive.

    This generates a formatted string that the main orchestrator can
    print to instruct Claude to invoke the AskUserQuestion tool.

    Args:
        questions: Formatted questions from format_questions_for_ask_user()

    Returns:
        Formatted directive string for Claude to invoke AskUserQuestion

    Example output:
        ---
        ## MANDATORY: Invoke AskUserQuestion Tool

        Clarification is required before proceeding. You MUST invoke the
        AskUserQuestion tool with the following parameters:

        ```json
        {
          "questions": [...]
        }
        ```

        DO NOT proceed until the user has answered these questions.
        ---
    """
    questions_json = json.dumps({"questions": questions}, indent=2)

    return f"""
---

## MANDATORY: Invoke AskUserQuestion Tool

Clarification is required before proceeding. You **MUST** invoke the `AskUserQuestion` tool with the following parameters:

```json
{questions_json}
```

**DO NOT:**
- Print these questions as markdown
- Assume answers
- Proceed without user response

**DO:**
- Invoke AskUserQuestion tool NOW
- Wait for user response
- Then continue with the workflow

---
"""


def print_clarification_directive(memory_file_path: str | Path) -> bool:
    """
    Check for clarification needs and print invocation directive if needed.

    This is the primary entry point for phase transitions. Call this after
    an agent completes to check if clarification is needed and print the
    appropriate directive.

    Args:
        memory_file_path: Path to the agent's memory file

    Returns:
        True if clarification directive was printed, False otherwise
    """
    questions = handle_clarification_if_needed(memory_file_path)

    if questions:
        print(build_ask_user_invocation(questions))
        return True

    return False
