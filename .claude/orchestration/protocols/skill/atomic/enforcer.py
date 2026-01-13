"""
Atomic Skill Enforcer
=====================

ENFORCEMENT: Ensures atomic skills invoke their agents and agents complete all steps.

This module tracks the full execution chain:
  Atomic Skill → Agent (via Task tool) → ALL Steps → Memory File

Without this enforcement, atomic skills can "complete" without actually executing
their underlying agents, leading to incomplete workflows.

All imports are ABSOLUTE - no relative imports allowed.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# Path setup - navigate from atomic/ to skill protocol root
_ATOMIC_DIR = Path(__file__).resolve().parent
_SKILL_PROTOCOLS_ROOT = _ATOMIC_DIR.parent
_ORCHESTRATION_ROOT = _SKILL_PROTOCOLS_ROOT.parent

if str(_SKILL_PROTOCOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SKILL_PROTOCOLS_ROOT))


class AtomicSkillIncompleteError(Exception):
    """
    Raised when atomic skill fails to invoke its agent.

    This indicates the Task tool was never called with the required
    subagent_type, meaning the agent never executed.
    """
    pass


class AgentStepsIncompleteError(Exception):
    """
    Raised when agent fails to complete all steps.

    This indicates the agent was invoked but did not execute all
    required steps from its protocol content files.
    """
    pass


class MemoryFileInvalidError(Exception):
    """
    Raised when memory file exists but lacks required sections.

    This indicates the agent ran but did not produce complete output
    as required by the protocol.
    """
    pass


# Mapping of atomic skills to their underlying agents
ATOMIC_SKILL_AGENT_MAPPING: Dict[str, str] = {
    "orchestrate-clarification": "clarification",
    "orchestrate-research": "research",
    "orchestrate-analysis": "analysis",
    "orchestrate-synthesis": "synthesis",
    "orchestrate-generation": "generation",
    "orchestrate-validation": "validation",
    "orchestrate-memory": "memory",
}


@dataclass
class StepVerificationResult:
    """Result of verifying a single step execution."""
    step_id: str
    found: bool
    evidence: Optional[str] = None


@dataclass
class EnforcementResult:
    """Result of full enforcement check."""
    skill_name: str
    agent_name: str
    task_id: str
    agent_invoked: bool
    steps_verified: List[StepVerificationResult] = field(default_factory=list)
    all_steps_complete: bool = False
    memory_file_valid: bool = False
    errors: List[str] = field(default_factory=list)
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())

    def is_complete(self) -> bool:
        """Check if full execution chain is verified."""
        return self.agent_invoked and self.all_steps_complete and self.memory_file_valid


class AtomicSkillEnforcer:
    """
    ENFORCEMENT: Tracks atomic skill → agent → step execution chain.

    Verifies that:
    1. Agent was invoked via Task tool
    2. All steps from agent protocol were executed
    3. Memory file contains required sections

    Usage:
        enforcer = AtomicSkillEnforcer("orchestrate-research", "task-123")
        enforcer.enforce_completion()  # Raises if incomplete
    """

    # Base path for finding agent protocols
    AGENT_PROTOCOLS_PATH = Path(".claude/orchestration/protocols/agent")

    # Base path for memory files
    MEMORY_PATH = Path(".claude/memory")

    def __init__(self, skill_name: str, task_id: str, base_path: Optional[Path] = None):
        """
        Initialize enforcer for an atomic skill execution.

        Args:
            skill_name: Name of the atomic skill (e.g., "orchestrate-research")
            task_id: Task ID for this execution
            base_path: Optional base path for locating files (defaults to cwd)
        """
        self.skill_name = skill_name
        self.task_id = task_id
        self.base_path = base_path or Path.cwd()

        # Map skill to agent
        self.agent_name = ATOMIC_SKILL_AGENT_MAPPING.get(skill_name)
        if not self.agent_name:
            raise ValueError(
                f"Unknown atomic skill: {skill_name}. "
                f"Valid skills: {list(ATOMIC_SKILL_AGENT_MAPPING.keys())}"
            )

        # Get expected steps from agent protocol
        self.expected_steps = self._get_expected_steps()

    def _get_protocol_path(self) -> Path:
        """Get path to agent protocol directory."""
        return self.base_path / self.AGENT_PROTOCOLS_PATH / self.agent_name

    def _get_memory_path(self) -> Path:
        """Get path to expected memory file."""
        return self.base_path / self.MEMORY_PATH / f"{self.task_id}-{self.agent_name}-memory.md"

    def _get_expected_steps(self) -> List[str]:
        """
        Get expected step IDs from agent protocol content files.

        Reads from agent protocol directory to find step_*.md files.
        Returns list of step identifiers (e.g., ["step_1", "step_2", "step_3"]).
        """
        protocol_path = self._get_protocol_path()
        content_path = protocol_path / "content"

        if not content_path.exists():
            # Fallback: check for step files directly in protocol dir
            content_path = protocol_path

        steps = []
        if content_path.exists():
            for content_file in sorted(content_path.glob("step_*.md")):
                steps.append(content_file.stem)  # e.g., "step_1", "step_2"

        # If no step files found, use default structure
        if not steps:
            # Most agents have 3-4 steps
            steps = ["step_1", "step_2", "step_3"]

        return steps

    def verify_agent_invocation(self) -> bool:
        """
        Verify agent was invoked via Task tool.

        Checks for existence of memory file, which is created when agent runs.
        """
        memory_file = self._get_memory_path()
        return memory_file.exists()

    def verify_step_execution(self, step_id: str, content: str) -> StepVerificationResult:
        """
        Verify a specific step was executed by checking memory file content.

        Args:
            step_id: Step identifier (e.g., "step_1")
            content: Memory file content to search

        Returns:
            StepVerificationResult with found status and evidence
        """
        # Multiple patterns to check for step markers
        step_num = step_id.split("_")[-1] if "_" in step_id else step_id

        patterns = [
            f"## {step_id}",           # ## step_1
            f"### {step_id}",          # ### step_1
            f"## Step {step_num}",     # ## Step 1
            f"### Step {step_num}",    # ### Step 1
            f"# Step {step_num}",      # # Step 1
            f"**Step {step_num}",      # **Step 1**
        ]

        for pattern in patterns:
            if pattern in content:
                # Extract some evidence (context around match)
                idx = content.find(pattern)
                evidence = content[idx:idx + 100] if idx >= 0 else None
                return StepVerificationResult(
                    step_id=step_id,
                    found=True,
                    evidence=evidence,
                )

        return StepVerificationResult(step_id=step_id, found=False)

    def verify_all_steps_completed(self) -> Tuple[bool, List[str], List[StepVerificationResult]]:
        """
        Verify ALL steps from agent protocol were executed.

        Returns:
            Tuple of (all_complete, missing_steps, verification_results)
        """
        memory_file = self._get_memory_path()
        if not memory_file.exists():
            return False, self.expected_steps, []

        content = memory_file.read_text()
        results = []
        missing = []

        for step_id in self.expected_steps:
            result = self.verify_step_execution(step_id, content)
            results.append(result)
            if not result.found:
                missing.append(step_id)

        return len(missing) == 0, missing, results

    def verify_memory_file_structure(self) -> Tuple[bool, List[str]]:
        """
        Verify memory file has required structural sections.

        Returns:
            Tuple of (valid, missing_sections)
        """
        memory_file = self._get_memory_path()
        if not memory_file.exists():
            return False, ["FILE_MISSING"]

        content = memory_file.read_text()

        # Required sections for all agent memory files
        required_sections = [
            "## Section 0: Context Loaded",
            "## Section 1: Step Overview",
            "## Section 2: Johari Summary",
            "## Section 3: Downstream Directives",
        ]

        missing = []
        for section in required_sections:
            if section not in content:
                missing.append(section)

        return len(missing) == 0, missing

    def get_enforcement_result(self) -> EnforcementResult:
        """
        Get full enforcement result without raising exceptions.

        Returns:
            EnforcementResult with all verification details
        """
        result = EnforcementResult(
            skill_name=self.skill_name,
            agent_name=self.agent_name,
            task_id=self.task_id,
            agent_invoked=False,
        )

        # Check 1: Agent invoked
        result.agent_invoked = self.verify_agent_invocation()
        if not result.agent_invoked:
            result.errors.append(
                f"Agent {self.agent_name} was never invoked. "
                f"Task tool MUST be used with subagent_type='{self.agent_name}'."
            )
            return result

        # Check 2: All steps completed
        all_complete, missing, step_results = self.verify_all_steps_completed()
        result.steps_verified = step_results
        result.all_steps_complete = all_complete
        if not all_complete:
            result.errors.append(
                f"Agent {self.agent_name} did not complete all steps. "
                f"Missing: {missing}. ALL step instructions MUST be executed."
            )

        # Check 3: Memory file structure valid
        valid, missing_sections = self.verify_memory_file_structure()
        result.memory_file_valid = valid
        if not valid:
            result.errors.append(
                f"Memory file missing required sections: {missing_sections}. "
                f"Agent must output all standard sections."
            )

        return result

    def enforce_completion(self) -> EnforcementResult:
        """
        BLOCKING enforcement of full execution chain.

        Raises if any part of chain is incomplete:
        - AtomicSkillIncompleteError if agent not invoked
        - AgentStepsIncompleteError if steps incomplete
        - MemoryFileInvalidError if memory file invalid

        Returns:
            EnforcementResult if verification passes
        """
        result = self.get_enforcement_result()

        if not result.agent_invoked:
            raise AtomicSkillIncompleteError(
                f"Agent {self.agent_name} was never invoked for {self.skill_name}. "
                f"The Task tool MUST be used with subagent_type='{self.agent_name}'. "
                f"Memory file expected at: {self._get_memory_path()}"
            )

        if not result.all_steps_complete:
            missing = [r.step_id for r in result.steps_verified if not r.found]
            raise AgentStepsIncompleteError(
                f"Agent {self.agent_name} did not complete all steps. "
                f"Missing: {missing}. "
                f"ALL content file instructions MUST be executed."
            )

        if not result.memory_file_valid:
            _, missing_sections = self.verify_memory_file_structure()
            raise MemoryFileInvalidError(
                f"Memory file for {self.agent_name} missing required sections: {missing_sections}. "
                f"Agent must output all standard sections per protocol."
            )

        return result

    def print_enforcement_status(self) -> None:
        """
        Print detailed enforcement status for debugging.

        Useful for diagnosing why enforcement is failing.
        """
        result = self.get_enforcement_result()

        print(f"\n## Atomic Skill Enforcement Status")
        print(f"Skill: `{self.skill_name}`")
        print(f"Agent: `{self.agent_name}`")
        print(f"Task: `{self.task_id}`")
        print()

        print(f"### Agent Invocation")
        print(f"- Status: {'✅ Invoked' if result.agent_invoked else '❌ NOT INVOKED'}")
        print(f"- Memory File: `{self._get_memory_path()}`")
        print()

        print(f"### Step Verification")
        print(f"- Expected Steps: {self.expected_steps}")
        if result.steps_verified:
            for step_result in result.steps_verified:
                status = '✅' if step_result.found else '❌'
                print(f"  - {status} {step_result.step_id}")
        print(f"- All Complete: {'✅ Yes' if result.all_steps_complete else '❌ No'}")
        print()

        print(f"### Memory File Structure")
        print(f"- Valid: {'✅ Yes' if result.memory_file_valid else '❌ No'}")
        print()

        if result.errors:
            print(f"### Errors")
            for error in result.errors:
                print(f"- ❌ {error}")
        else:
            print(f"### Result: ✅ ENFORCEMENT PASSED")
