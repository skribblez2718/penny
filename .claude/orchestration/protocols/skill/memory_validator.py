"""
Memory Validator
================

ENFORCEMENT: Validates memory file format to ensure ALL steps were executed.

This module provides validation for agent memory files to ensure:
1. Memory file exists
2. Memory file has minimum required content
3. Memory file contains all required sections
4. Memory file has proper step markers

All imports are ABSOLUTE - no relative imports allowed.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# Ensure protocols/skill package is importable
_MEMORY_VALIDATOR_DIR = Path(__file__).resolve().parent
_ORCHESTRATION_ROOT = _MEMORY_VALIDATOR_DIR.parent

if str(_ORCHESTRATION_ROOT) not in sys.path:
    sys.path.insert(0, str(_ORCHESTRATION_ROOT))


class MemoryValidationError(Exception):
    """Raised when memory file validation fails."""
    pass


class MissingSectionError(MemoryValidationError):
    """Raised when required sections are missing from memory file."""
    pass


class InsufficientContentError(MemoryValidationError):
    """Raised when memory file has insufficient content."""
    pass


# Required sections for each agent's memory file
# These sections ensure proper output structure and downstream compatibility
REQUIRED_SECTIONS: Dict[str, List[str]] = {
    "clarification": [
        "## Section 0: Context Loaded",
        "## Section 1: Step Overview",
        "## Section 2: Johari Summary",
        "## Section 3: Downstream Directives",
    ],
    "research": [
        "## Section 0: Context Loaded",
        "## Section 1: Step Overview",
        "## Section 2: Johari Summary",
        "## Section 3: Downstream Directives",
    ],
    "analysis": [
        "## Section 0: Context Loaded",
        "## Section 1: Step Overview",
        "## Section 2: Johari Summary",
        "## Section 3: Downstream Directives",
    ],
    "synthesis": [
        "## Section 0: Context Loaded",
        "## Section 1: Step Overview",
        "## Section 2: Johari Summary",
        "## Section 3: Downstream Directives",
    ],
    "generation": [
        "## Section 0: Context Loaded",
        "## Section 1: Step Overview",
        "## Section 2: Johari Summary",
        "## Section 3: Downstream Directives",
    ],
    "validation": [
        "## Section 0: Context Loaded",
        "## Section 1: Step Overview",
        "## Section 2: Johari Summary",
        "## Section 3: Downstream Directives",
    ],
    "memory": [
        "## Section 0: Context Loaded",
        "## Section 1: Step Overview",
        "## Section 2: Johari Summary",
        "## Section 3: Downstream Directives",
    ],
}

# Alternate section patterns that are also acceptable
ALTERNATE_PATTERNS: Dict[str, List[List[str]]] = {
    # Some agents may use slightly different section headers
    "all": [
        # Pattern 1: Standard sections
        ["## Section 0", "## Section 1", "## Section 2", "## Section 3"],
        # Pattern 2: Numbered sections
        ["## 0.", "## 1.", "## 2.", "## 3."],
        # Pattern 3: Step-based sections
        ["## Step 0", "## Step 1", "## Step 2", "## Step 3"],
    ],
}

# Minimum content length for a valid memory file (in characters)
MIN_CONTENT_LENGTH = 100


@dataclass
class ValidationResult:
    """Result of memory file validation."""
    agent_name: str
    memory_path: str
    exists: bool
    has_minimum_content: bool
    content_length: int = 0
    required_sections: List[str] = field(default_factory=list)
    missing_sections: List[str] = field(default_factory=list)
    found_sections: List[str] = field(default_factory=list)
    is_valid: bool = False
    errors: List[str] = field(default_factory=list)
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())

    def summary(self) -> str:
        """Generate human-readable summary of validation result."""
        if self.is_valid:
            return f"✅ VALID: Memory file for {self.agent_name} passes all checks"

        issues = []
        if not self.exists:
            issues.append("File does not exist")
        elif not self.has_minimum_content:
            issues.append(f"Insufficient content ({self.content_length} < {MIN_CONTENT_LENGTH})")
        elif self.missing_sections:
            issues.append(f"Missing sections: {self.missing_sections}")

        return f"❌ INVALID: Memory file for {self.agent_name} - {'; '.join(issues)}"


def get_required_sections(agent_name: str) -> List[str]:
    """Get required sections for a specific agent."""
    return REQUIRED_SECTIONS.get(agent_name, REQUIRED_SECTIONS.get("clarification", []))


def check_section_exists(content: str, section: str) -> bool:
    """
    Check if a section exists in the content.

    Uses flexible matching to account for minor variations in section headers.
    """
    # Direct match
    if section in content:
        return True

    # Case-insensitive match
    if section.lower() in content.lower():
        return True

    # Extract section number and check variants
    # e.g., "## Section 0: Context Loaded" -> check for "## 0", "Section 0", etc.
    import re
    section_num_match = re.search(r"Section\s*(\d+)", section, re.IGNORECASE)
    if section_num_match:
        num = section_num_match.group(1)
        # Check for variants
        variants = [
            f"## {num}",
            f"## Section {num}",
            f"### Section {num}",
            f"# Section {num}",
            f"**Section {num}",
        ]
        for variant in variants:
            if variant in content:
                return True

    return False


def validate_memory_file(
    agent_name: str,
    memory_path: Path,
    strict: bool = False,
) -> Tuple[bool, List[str]]:
    """
    Validate memory file has ALL required sections.

    Args:
        agent_name: Name of the agent that produced the memory file
        memory_path: Path to the memory file
        strict: If True, requires exact section matches; otherwise uses flexible matching

    Returns:
        Tuple of (valid, missing_sections)
    """
    if not memory_path.exists():
        return False, ["FILE_MISSING"]

    content = memory_path.read_text()

    # Check minimum content length
    if len(content) < MIN_CONTENT_LENGTH:
        return False, ["INSUFFICIENT_CONTENT"]

    required = get_required_sections(agent_name)
    missing = []

    for section in required:
        if strict:
            # Exact match required
            if section not in content:
                missing.append(section)
        else:
            # Flexible matching
            if not check_section_exists(content, section):
                missing.append(section)

    return len(missing) == 0, missing


def validate_memory_file_full(
    agent_name: str,
    memory_path: Path,
) -> ValidationResult:
    """
    Perform full validation of memory file and return detailed result.

    Args:
        agent_name: Name of the agent that produced the memory file
        memory_path: Path to the memory file

    Returns:
        ValidationResult with full details
    """
    result = ValidationResult(
        agent_name=agent_name,
        memory_path=str(memory_path),
        exists=False,
        has_minimum_content=False,
        required_sections=get_required_sections(agent_name),
    )

    # Check existence
    if not memory_path.exists():
        result.errors.append(f"Memory file does not exist: {memory_path}")
        return result

    result.exists = True
    content = memory_path.read_text()
    result.content_length = len(content)

    # Check minimum content
    if len(content) < MIN_CONTENT_LENGTH:
        result.errors.append(
            f"Memory file too small: {len(content)} characters "
            f"(minimum: {MIN_CONTENT_LENGTH})"
        )
        return result

    result.has_minimum_content = True

    # Check each required section
    for section in result.required_sections:
        if check_section_exists(content, section):
            result.found_sections.append(section)
        else:
            result.missing_sections.append(section)

    # Determine overall validity
    result.is_valid = len(result.missing_sections) == 0

    if result.missing_sections:
        result.errors.append(
            f"Missing required sections: {result.missing_sections}"
        )

    return result


def require_valid_memory_file(
    agent_name: str,
    memory_path: Path,
) -> ValidationResult:
    """
    BLOCKING: Validate memory file and raise exception if invalid.

    Args:
        agent_name: Name of the agent that produced the memory file
        memory_path: Path to the memory file

    Returns:
        ValidationResult if valid

    Raises:
        MemoryValidationError: If memory file is invalid
    """
    result = validate_memory_file_full(agent_name, memory_path)

    if not result.exists:
        raise MemoryValidationError(
            f"Memory file does not exist for {agent_name}: {memory_path}"
        )

    if not result.has_minimum_content:
        raise InsufficientContentError(
            f"Memory file for {agent_name} has insufficient content: "
            f"{result.content_length} characters (minimum: {MIN_CONTENT_LENGTH})"
        )

    if result.missing_sections:
        raise MissingSectionError(
            f"Memory file for {agent_name} missing required sections: "
            f"{result.missing_sections}"
        )

    return result


def get_memory_path(task_id: str, agent_name: str, base_path: Optional[Path] = None) -> Path:
    """
    Get the expected path for an agent's memory file.

    Args:
        task_id: Task ID for the execution
        agent_name: Name of the agent
        base_path: Optional base path (defaults to cwd)

    Returns:
        Path to the expected memory file
    """
    base = base_path or Path.cwd()
    return base / ".claude" / "memory" / f"{task_id}-{agent_name}-memory.md"


def print_validation_report(result: ValidationResult) -> None:
    """
    Print a minimal validation report.

    Only prints on validation failure, keeps output minimal.
    """
    if result.is_valid:
        return  # No output for valid files

    # Only print errors for invalid files
    print(f"Validation failed: {result.agent_name}")
    for error in result.errors:
        print(f"  - {error}")
