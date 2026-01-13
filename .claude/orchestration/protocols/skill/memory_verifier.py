"""
Memory Verifier Module
======================

Verifies that agent memory files exist and conform to the Section-based
format expected by the skill orchestration system.

Memory File Convention:
    .claude/memory/{task-id}-{agent-name}-memory.md

Expected Format (Section-based with Johari Summary):
    # {Agent} Agent Output: {Task Description}

    ## Section 0: Context Loaded
    [Task ID, skill, phase, domain, user request]

    ## Section 1: Step Overview
    [What was clarified/researched/analyzed, key decisions]

    ## Section 2: Johari Summary
    [Known Knowns, Known Unknowns, Unknown Unknowns]

    ## Section 3: Downstream Directives
    [Instructions for next phase/agent]

    ---
    **{AGENT_NAME}_COMPLETE**
"""

import re
from pathlib import Path
from typing import Optional

# Base directory for memory files
MEMORY_BASE = Path(__file__).parent.parent.parent / "memory"

# Required sections (Section-based format)
REQUIRED_SECTIONS = [
    "Section 0",
    "Section 1",
    "Section 2",
    "Section 3",
]

# Section header patterns (flexible matching)
SECTION_PATTERNS = {
    "Section 0": r"##\s+Section\s*0\s*[:\-]?\s*",
    "Section 1": r"##\s+Section\s*1\s*[:\-]?\s*",
    "Section 2": r"##\s+Section\s*2\s*[:\-]?\s*",
    "Section 3": r"##\s+Section\s*3\s*[:\-]?\s*",
}


def get_memory_path(task_id: str, agent_name: str) -> Path:
    """
    Get the expected memory file path for an agent's output.

    Args:
        task_id: Task identifier
        agent_name: Agent name (e.g., "clarification")

    Returns:
        Path to the memory file
    """
    return MEMORY_BASE / f"{task_id}-{agent_name}-memory.md"


def verify_exists(task_id: str, agent_name: str) -> bool:
    """
    Verify that a memory file exists.

    Args:
        task_id: Task identifier
        agent_name: Agent name

    Returns:
        True if file exists, False otherwise
    """
    return get_memory_path(task_id, agent_name).exists()


def verify_format(file_path: Path) -> tuple[bool, list[str]]:
    """
    Verify that a memory file has correct Johari Window format.

    Checks for:
    1. File header with agent name and task
    2. All required sections present
    3. Sections have content (not empty)

    Args:
        file_path: Path to the memory file

    Returns:
        Tuple of (is_valid, list of error messages)
    """
    errors = []

    if not file_path.exists():
        return False, [f"File does not exist: {file_path}"]

    try:
        content = file_path.read_text()
    except IOError as e:
        return False, [f"Cannot read file: {e}"]

    if not content.strip():
        return False, ["File is empty"]

    # Check for header (flexible: "Agent Memory:" or "Agent Output:")
    if not re.search(r"#\s+.*Agent\s+(?:Memory|Output):", content, re.IGNORECASE):
        errors.append("Missing agent header (e.g., '# Clarification Agent Output:')")

    # Check for Task ID (can be in header or as "Task:" or "Task ID:" line)
    if not re.search(r"(?:Task(?:\s*ID)?:|##\s+Section\s*0.*Task)", content, re.IGNORECASE):
        errors.append("Missing 'Task:' or 'Task ID:' identifier")

    # Check for required sections
    for section_name, pattern in SECTION_PATTERNS.items():
        if not re.search(pattern, content, re.IGNORECASE):
            errors.append(f"Missing section: {section_name}")

    # Check sections have content (not just headers)
    sections_with_content = 0
    for section_name, pattern in SECTION_PATTERNS.items():
        match = re.search(pattern, content, re.IGNORECASE)
        if match:
            # Find content between this section and the next
            section_start = match.end()
            remaining = content[section_start:]

            # Look for next section header or end of file
            next_section = re.search(r"\n##\s+", remaining)
            if next_section:
                section_content = remaining[: next_section.start()]
            else:
                section_content = remaining

            # Check if section has meaningful content
            if section_content.strip() and len(section_content.strip()) > 10:
                sections_with_content += 1

    if sections_with_content < 3:
        errors.append(
            f"Insufficient section content: only {sections_with_content}/4 sections have meaningful content"
        )

    return len(errors) == 0, errors


def verify_memory(task_id: str, agent_name: str) -> tuple[bool, list[str]]:
    """
    Convenience function to verify a memory file by task and agent.

    Args:
        task_id: Task identifier
        agent_name: Agent name

    Returns:
        Tuple of (is_valid, list of error messages)
    """
    memory_path = get_memory_path(task_id, agent_name)
    return verify_format(memory_path)


def get_memory_content(task_id: str, agent_name: str) -> Optional[str]:
    """
    Read and return memory file content.

    Args:
        task_id: Task identifier
        agent_name: Agent name

    Returns:
        File content if exists, None otherwise
    """
    memory_path = get_memory_path(task_id, agent_name)

    if not memory_path.exists():
        return None

    try:
        return memory_path.read_text()
    except IOError:
        return None


def extract_section(content: str, section_name: str) -> Optional[str]:
    """
    Extract a specific section's content from a memory file.

    Args:
        content: Full memory file content
        section_name: Section name (Open, Blind, Hidden, Unknown, Deliverables)

    Returns:
        Section content if found, None otherwise
    """
    pattern = SECTION_PATTERNS.get(section_name)
    if not pattern:
        return None

    match = re.search(pattern, content, re.IGNORECASE)
    if not match:
        return None

    section_start = match.end()
    remaining = content[section_start:]

    # Find next section header
    next_section = re.search(r"\n##\s+", remaining)
    if next_section:
        section_content = remaining[: next_section.start()]
    else:
        section_content = remaining

    return section_content.strip()


def get_deliverables(task_id: str, agent_name: str) -> Optional[str]:
    """
    Get the Downstream Directives (Section 3) from an agent's memory file.

    This is the primary output that subsequent agents or
    skill phases should consume.

    Args:
        task_id: Task identifier
        agent_name: Agent name

    Returns:
        Section 3 (Downstream Directives) content if found, None otherwise
    """
    content = get_memory_content(task_id, agent_name)
    if not content:
        return None

    return extract_section(content, "Section 3")


def get_johari_summary(task_id: str, agent_name: str) -> Optional[str]:
    """
    Get the Johari Summary (Section 2) from an agent's memory file.

    Contains Known Knowns, Known Unknowns, and Unknown Unknowns.
    Useful for tracking what still needs to be discovered.

    Args:
        task_id: Task identifier
        agent_name: Agent name

    Returns:
        Section 2 (Johari Summary) content if found, None otherwise
    """
    content = get_memory_content(task_id, agent_name)
    if not content:
        return None

    return extract_section(content, "Section 2")


def list_memory_files(task_id: str) -> list[Path]:
    """
    List all memory files for a task.

    Args:
        task_id: Task identifier

    Returns:
        List of paths to memory files
    """
    if not MEMORY_BASE.exists():
        return []

    return list(MEMORY_BASE.glob(f"{task_id}-*-memory.md"))


def get_completed_agents(task_id: str) -> list[str]:
    """
    Get list of agents that have completed (have memory files).

    Args:
        task_id: Task identifier

    Returns:
        List of agent names that have memory files
    """
    memory_files = list_memory_files(task_id)
    agents = []

    for mf in memory_files:
        # Extract agent name from filename
        # Format: {task_id}-{agent-name}-memory.md
        name = mf.stem  # Remove .md
        if name.endswith("-memory"):
            name = name[: -len("-memory")]
        if name.startswith(f"{task_id}-"):
            agent_name = name[len(f"{task_id}-") :]
            agents.append(agent_name)

    return agents


def ensure_memory_dir() -> Path:
    """
    Ensure memory directory exists.

    Returns:
        Path to memory directory
    """
    MEMORY_BASE.mkdir(parents=True, exist_ok=True)
    return MEMORY_BASE


def cleanup_memory_files(task_id: str) -> int:
    """
    Remove all memory files for a task.

    Typically used during testing or workflow reset.

    Args:
        task_id: Task identifier

    Returns:
        Number of files removed
    """
    memory_files = list_memory_files(task_id)
    count = 0

    for mf in memory_files:
        try:
            mf.unlink()
            count += 1
        except IOError:
            pass

    return count
