"""
Skill Generator Module
======================

Generates Python orchestration scaffolding when develop-skill creates a new skill.

For composite skills, generates:
- protocols/skill/composite/{skill_name}/__init__.py
- protocols/skill/composite/{skill_name}/entry.py
- protocols/skill/composite/{skill_name}/complete.py
- protocols/skill/composite/{skill_name}/content/phase_{id}.md (per phase)

NOTE: Phase orchestration is handled by the generic advance_phase.py script.
Individual phase Python files are no longer generated - the FSM-based
approach uses config.py phase definitions with advance_phase.py.

For atomic skills, generates a minimal wrapper.

SKILL.md files are stored in .claude/skills/{skill-name}/SKILL.md and contain
only summary information. Phases are enforced via Python orchestration.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between skill/config and agent/config
_SKILL_PROTOCOLS_ROOT = Path(__file__).resolve().parent
_ORCHESTRATION_ROOT = _SKILL_PROTOCOLS_ROOT.parent
_PROTOCOLS_DIR = _ORCHESTRATION_ROOT
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from skill import COMPOSITE_DIR


def _to_snake_case(name: str) -> str:
    """Convert skill-name to skill_name."""
    return name.replace("-", "_")


def _to_class_name(name: str) -> str:
    """Convert skill-name to SkillName."""
    return "".join(word.capitalize() for word in name.replace("-", "_").split("_"))


def generate_composite_skill(
    skill_name: str,
    phases: list[dict[str, Any]],
    skill_config: dict[str, Any] = None,
) -> dict[str, str]:
    """
    Generate Python orchestration files for a new composite skill.

    Args:
        skill_name: Name of the skill (e.g., "perform-research")
        phases: List of phase definitions, each containing:
            - id: Phase ID (e.g., "0", "0.5", "1")
            - name: Phase name (e.g., "Requirements Clarification")
            - type: Phase type (LINEAR, AUTO, OPTIONAL, REMEDIATION, ITERATIVE)
            - uses_atomic_skill: Optional atomic skill name
            - configuration: Optional phase configuration
        skill_config: Additional skill configuration

    Returns:
        Dict mapping file paths to file contents
    """
    skill_config = skill_config or {}
    snake_name = _to_snake_case(skill_name)
    class_name = _to_class_name(skill_name)

    files = {}

    # Generate __init__.py
    files[f"composite/{snake_name}/__init__.py"] = _generate_init(skill_name, phases)

    # Generate entry.py
    files[f"composite/{snake_name}/entry.py"] = _generate_entry(skill_name, phases)

    # Generate complete.py
    files[f"composite/{snake_name}/complete.py"] = _generate_complete(skill_name)

    # Generate phase content files (markdown only - Python orchestration uses advance_phase.py)
    for phase in phases:
        phase_id = phase["id"]
        content_file = f"phase_{phase_id.replace('.', '_')}.md"
        files[f"composite/{snake_name}/content/{content_file}"] = _generate_phase_content(
            skill_name, phase
        )

    # Generate config entry (to be appended to config.py)
    files["_config_entry"] = _generate_config_entry(skill_name, phases)

    return files


def generate_atomic_skill(skill_name: str, agent_name: str) -> dict[str, str]:
    """
    Generate minimal wrapper for an atomic skill.

    Atomic skills are thin wrappers around agents. They don't need
    full phase orchestration - just a class that extends BaseAtomicSkill.

    Args:
        skill_name: Atomic skill name (e.g., "orchestrate-custom")
        agent_name: Agent name (e.g., "custom-agent")

    Returns:
        Dict mapping file paths to file contents
    """
    snake_name = _to_snake_case(skill_name)
    class_name = _to_class_name(skill_name)

    # Derive cognitive function from skill name
    function_name = skill_name.replace("orchestrate-", "").upper()

    atomic_class = f'''"""
{skill_name} - Atomic skill wrapper for {agent_name}.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure protocols/skill package is importable
_SKILL_PROTOCOLS_ROOT = Path(__file__).resolve().parent.parent
_ORCHESTRATION_ROOT = _SKILL_PROTOCOLS_ROOT.parent
if str(_ORCHESTRATION_ROOT) not in sys.path:
    sys.path.insert(0, str(_ORCHESTRATION_ROOT))

from skill.atomic.base_atomic import BaseAtomicSkill


class {class_name}(BaseAtomicSkill):
    """Atomic skill wrapper for {agent_name}."""

    @property
    def skill_name(self) -> str:
        return "{skill_name}"

    @property
    def agent_name(self) -> str:
        return "{agent_name}"

    @property
    def cognitive_function(self) -> str:
        return "{function_name}"
'''

    return {
        f"atomic/{snake_name}.py": atomic_class,
    }


def _generate_init(skill_name: str, phases: list[dict]) -> str:
    """Generate __init__.py for skill directory."""
    snake_name = _to_snake_case(skill_name)
    return f'''"""
{skill_name} - Composite skill orchestration.

Phases:
{chr(10).join(f"  - Phase {p['id']}: {p['name']}" for p in phases)}
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure protocols/skill package is importable
_SKILL_PROTOCOLS_ROOT = Path(__file__).resolve().parent.parent.parent
_ORCHESTRATION_ROOT = _SKILL_PROTOCOLS_ROOT.parent
if str(_ORCHESTRATION_ROOT) not in sys.path:
    sys.path.insert(0, str(_ORCHESTRATION_ROOT))

from skill.composite.{snake_name}.entry import main as entry
from skill.composite.{snake_name}.complete import main as complete
'''


def _generate_entry(skill_name: str, phases: list[dict]) -> str:
    """Generate entry.py for skill using common_skill_entry."""
    return f'''#!/usr/bin/env python3
"""{skill_name} Entry Point"""
from __future__ import annotations
import sys
from pathlib import Path

# Ensure protocols/skill package is importable
# From composite/{{skill}}/entry.py, go up 4 levels to reach orchestration/
_ORCHESTRATION_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(_ORCHESTRATION_ROOT) not in sys.path:
    sys.path.insert(0, str(_ORCHESTRATION_ROOT))

from skill.composite.common_skill_entry import skill_entry

if __name__ == "__main__":
    skill_entry("{skill_name}", Path(__file__).parent)
'''


def _generate_complete(skill_name: str) -> str:
    """Generate complete.py for skill."""
    return f'''#!/usr/bin/env python3
"""
{skill_name} Completion
=======================

Validates workflow completion and outputs summary.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

# Path setup - add protocols directory for fully-qualified imports
# From composite/{{skill}}/complete.py, go up 4 levels to reach protocols/
_PROTOCOLS_DIR = Path(__file__).resolve().parent.parent.parent.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from skill.core.state import SkillExecutionState
from skill.core.fsm import SkillPhaseState
from skill.memory_verifier import list_memory_files, verify_format


def main() -> None:
    parser = argparse.ArgumentParser(description="{skill_name} completion")
    parser.add_argument("session_id", help="Session ID")
    args = parser.parse_args()

    skill_name = "{skill_name}"
    state = SkillExecutionState.load(skill_name, args.session_id)

    if not state:
        print(f"ERROR: State not found for session {{args.session_id}}", file=sys.stderr)
        sys.exit(1)

    # Verify FSM reached completion
    # NOTE: FSM stores state as SkillPhaseState enum in .state attribute, not .current_state
    if state.fsm and state.fsm.state != SkillPhaseState.COMPLETED:
        print(f"WARNING: FSM not in COMPLETED state: {{state.fsm.state.name}}", file=sys.stderr)

    # Check memory files
    memory_files = list_memory_files(state.task_id)
    valid_count = sum(1 for mf in memory_files if verify_format(mf)[0])

    # Calculate duration
    start_time = datetime.fromisoformat(state.started_at)
    duration = datetime.now() - start_time

    # Update state
    state.metadata["completed_at"] = datetime.now().isoformat()
    state.metadata["duration_seconds"] = duration.total_seconds()
    state.metadata["status"] = "complete"
    state.save()

    # Minimal output
    print(f"## {skill_name} Complete")
    print(f"Task: `{{state.task_id[:16]}}...`")
    print(f"Duration: {{duration.total_seconds():.1f}}s")
    print(f"Memory files: {{valid_count}}/{{len(memory_files)}}")
    print()
    print(f"**{skill_name.upper().replace('-', '_')}_COMPLETE**")


if __name__ == "__main__":
    main()
'''


# NOTE: _generate_phases_init and _generate_phase_file have been removed.
# Phase orchestration is now handled by the generic advance_phase.py script.
# Individual phase Python files are no longer generated.


def _generate_phase_content(skill_name: str, phase: dict) -> str:
    """Generate phase content markdown file."""
    phase_id = phase["id"]
    phase_name = phase.get("name", f"Phase {phase_id}")
    uses_atomic = phase.get("uses_atomic_skill", "")

    content = f"""# Phase {phase_id}: {phase_name}

## Purpose

[Describe what this phase accomplishes]

## Inputs

- Prior phase outputs (if applicable)
- User requirements (if first phase)

## Outputs

- [List expected outputs from this phase]

"""

    if uses_atomic:
        content += f"""## Agent

**Atomic Skill:** `{uses_atomic}`

The agent will:
1. [Action 1]
2. [Action 2]
3. Write memory file with results

"""

    content += """## Gate Criteria

**Entry:**
- [Prerequisites for this phase]

**Exit:**
- [Criteria for phase completion]
"""

    return content


def _generate_config_entry(skill_name: str, phases: list[dict]) -> str:
    """Generate config.py entry for the skill's phases."""
    snake_name = _to_snake_case(skill_name)

    phase_entries = []
    phase_ids = [p["id"] for p in phases]

    for i, phase in enumerate(phases):
        phase_id = phase["id"]
        phase_type = phase.get("type", "LINEAR")
        uses_atomic = phase.get("uses_atomic_skill", "")
        next_phase = phase_ids[i + 1] if i + 1 < len(phase_ids) else None

        entry = f'''        "{phase_id}": {{
            "name": "PHASE_{phase_id.replace('.', '_').upper()}",
            "title": "{phase.get('name', f'Phase {phase_id}')}",
            "type": PhaseType.{phase_type},
            "script": "phase_{phase_id.replace('.', '_')}.py",
            "content": "phase_{phase_id.replace('.', '_')}.md",'''

        if uses_atomic:
            entry += f'''
            "uses_atomic_skill": "{uses_atomic}",'''

        if next_phase:
            entry += f'''
            "next": "{next_phase}",'''
        else:
            entry += '''
            "next": None,'''

        entry += '''
        },'''
        phase_entries.append(entry)

    return f'''
# Add to SKILL_PHASES in config.py:
    "{skill_name}": {{
{chr(10).join(phase_entries)}
    }},
'''


def write_skill_files(
    skill_name: str,
    files: dict[str, str],
    base_dir: Path = None,
) -> list[Path]:
    """
    Write generated skill files to disk.

    Args:
        skill_name: Name of the skill
        files: Dict mapping relative paths to contents
        base_dir: Base directory for protocols/skill (defaults to COMPOSITE_DIR.parent)

    Returns:
        List of paths to created files
    """
    base_dir = base_dir or COMPOSITE_DIR.parent
    created_files = []

    for rel_path, content in files.items():
        if rel_path.startswith("_"):
            # Skip meta entries like _config_entry
            continue

        full_path = base_dir / rel_path
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_text(content)
        created_files.append(full_path)

    return created_files
