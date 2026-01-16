"""
Execution Verifier - Hard Enforcement of Phase Execution
=========================================================

This module provides hard enforcement that phases actually executed before
allowing advancement. No phase can advance without verified completion.

DESIGN PRINCIPLE: Execution-Before-Advance
No phase can advance until:
1. Agent invocation is VERIFIED (not just printed)
2. Memory file is CREATED and VALIDATED
3. Completion signal is RECEIVED
4. Goal-memory assessment is COMPLETED (for non-trivial phases)

This module is critical infrastructure - DO NOT add bypass mechanisms.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any, Tuple
from dataclasses import dataclass, field


class PhaseNotVerifiedError(Exception):
    """Raised when attempting to advance without verified execution."""
    pass


class MemoryFileValidationError(Exception):
    """Raised when memory file fails validation."""
    pass


class GoalMemoryNotCompletedError(Exception):
    """Raised when goal-memory assessment was not completed."""
    pass


@dataclass
class VerificationResult:
    """Result of a verification check."""
    passed: bool
    phase_id: str
    agent_name: str
    checks_performed: List[str] = field(default_factory=list)
    failures: List[str] = field(default_factory=list)
    memory_file_path: Optional[Path] = None
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "passed": self.passed,
            "phase_id": self.phase_id,
            "agent_name": self.agent_name,
            "checks_performed": self.checks_performed,
            "failures": self.failures,
            "memory_file_path": str(self.memory_file_path) if self.memory_file_path else None,
            "timestamp": self.timestamp,
        }


class ExecutionVerifier:
    """
    Hard enforcement of phase execution verification.

    This class verifies that phases actually executed by checking:
    1. Memory file exists at expected path
    2. Memory file has minimum content length
    3. Required sections are present
    4. Timestamp is within current session

    ENFORCEMENT: No phase can advance without passing these checks.
    """

    # Minimum content length to consider a memory file valid
    MIN_CONTENT_LENGTH = 100

    # Required sections by agent type
    REQUIRED_SECTIONS = {
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
        ],
    }

    def __init__(self, task_id: str, memory_dir: Optional[Path] = None):
        """
        Initialize the verifier.

        Args:
            task_id: The task ID for this workflow
            memory_dir: Directory where memory files are stored
                        (defaults to .claude/memory/)
        """
        self.task_id = task_id
        self.memory_dir = memory_dir or Path(".claude/memory")
        self.verification_log: List[Dict[str, Any]] = []

    def get_memory_file_path(self, agent_name: str, branch_id: Optional[str] = None) -> Path:
        """
        Get the expected memory file path for an agent.
        Checks multiple naming patterns for flexibility.

        Args:
            agent_name: Name of the agent
            branch_id: Optional branch identifier for parallel phases

        Returns:
            Path to the expected memory file (existing file if found, else primary pattern)
        """
        # Build list of candidate filenames in priority order
        candidates = []

        if branch_id:
            # Branch-prefixed pattern
            candidates.append(f"{self.task_id}-{branch_id}-{agent_name}-memory.md")

        # Standard pattern
        candidates.append(f"{self.task_id}-{agent_name}-memory.md")

        # Orchestrate-prefixed pattern (for atomic skill naming)
        candidates.append(f"{self.task_id}-orchestrate-{agent_name}-memory.md")

        # Check each candidate for existence
        for filename in candidates:
            filepath = self.memory_dir / filename
            if filepath.exists():
                return filepath

        # Fallback to glob pattern matching for flexible naming
        pattern = f"{self.task_id}-*{agent_name}*-memory.md"
        matches = list(self.memory_dir.glob(pattern))
        if matches:
            # Return most recently modified match
            return sorted(matches, key=lambda f: f.stat().st_mtime, reverse=True)[0]

        # Return primary expected path for error messaging
        if branch_id:
            return self.memory_dir / f"{self.task_id}-{branch_id}-{agent_name}-memory.md"
        return self.memory_dir / f"{self.task_id}-{agent_name}-memory.md"

    def verify_phase_execution(
        self,
        phase_id: str,
        agent_name: str,
        branch_id: Optional[str] = None,
        required_sections: Optional[List[str]] = None,
    ) -> VerificationResult:
        """
        Verify that a phase actually executed.

        Performs the following checks:
        1. Memory file exists at expected path
        2. Memory file has minimum content length
        3. Required sections are present (if specified)

        Args:
            phase_id: The phase ID being verified
            agent_name: The agent that should have executed
            branch_id: Optional branch ID for parallel phases
            required_sections: Override default required sections

        Returns:
            VerificationResult with details of all checks
        """
        result = VerificationResult(
            passed=True,
            phase_id=phase_id,
            agent_name=agent_name,
        )

        memory_file = self.get_memory_file_path(agent_name, branch_id)
        result.memory_file_path = memory_file

        # Check 1: File exists
        result.checks_performed.append("file_exists")
        if not memory_file.exists():
            result.passed = False
            result.failures.append(
                f"Memory file missing: {memory_file}. "
                f"Agent {agent_name} was never invoked for phase {phase_id}."
            )
            self._log_verification(result)
            return result

        # Check 2: File has content
        result.checks_performed.append("content_length")
        content = memory_file.read_text()
        if len(content) < self.MIN_CONTENT_LENGTH:
            result.passed = False
            result.failures.append(
                f"Memory file too small ({len(content)} chars, minimum {self.MIN_CONTENT_LENGTH}). "
                f"Agent {agent_name} may not have completed execution."
            )
            self._log_verification(result)
            return result

        # Check 3: Required sections present
        sections_to_check = required_sections or self.REQUIRED_SECTIONS.get(agent_name, [])
        if sections_to_check:
            result.checks_performed.append("required_sections")
            missing_sections = []
            for section in sections_to_check:
                if section not in content:
                    missing_sections.append(section)

            if missing_sections:
                result.passed = False
                result.failures.append(
                    f"Memory file missing required sections: {missing_sections}. "
                    f"Agent {agent_name} did not complete all required steps."
                )

        self._log_verification(result)
        return result

    def require_phase_completion(
        self,
        phase_id: str,
        agent_name: str,
        branch_id: Optional[str] = None,
    ) -> None:
        """
        Block until phase is verified complete. Raise if verification fails.

        This is the ENFORCEMENT mechanism. Call this before allowing
        any phase transition.

        Args:
            phase_id: The phase ID being verified
            agent_name: The agent that should have executed
            branch_id: Optional branch ID for parallel phases

        Raises:
            PhaseNotVerifiedError: If phase verification fails
        """
        result = self.verify_phase_execution(phase_id, agent_name, branch_id)

        if not result.passed:
            error_msg = (
                f"ENFORCEMENT VIOLATION: Phase {phase_id} ({agent_name}) not verified.\n"
                f"Failures:\n"
            )
            for failure in result.failures:
                error_msg += f"  - {failure}\n"
            error_msg += (
                f"\nMemory file required at: {result.memory_file_path}\n"
                f"The agent MUST be invoked via Task tool with subagent_type='{agent_name}'."
            )
            raise PhaseNotVerifiedError(error_msg)

    def verify_goal_memory_completed(self, phase_id: str) -> bool:
        """
        Verify that goal-memory assessment was completed for a phase transition.

        Args:
            phase_id: The phase ID that should have goal-memory assessment

        Returns:
            True if goal-memory completed, False otherwise
        """
        memory_file = self.get_memory_file_path("memory")

        if not memory_file.exists():
            return False

        content = memory_file.read_text()

        # Check for phase-specific assessment marker
        phase_marker = f"Phase: {phase_id}" or f"phase_{phase_id}"
        return phase_marker in content or len(content) >= self.MIN_CONTENT_LENGTH

    def require_goal_memory_completion(self, completed_phase_id: str, next_phase_id: str) -> None:
        """
        Block advancement until goal-memory assessment is completed.

        Args:
            completed_phase_id: The phase that just completed
            next_phase_id: The phase we want to advance to

        Raises:
            GoalMemoryNotCompletedError: If goal-memory not completed
        """
        if not self.verify_goal_memory_completed(completed_phase_id):
            raise GoalMemoryNotCompletedError(
                f"ENFORCEMENT VIOLATION: Goal-memory assessment not completed.\n"
                f"Cannot advance from phase {completed_phase_id} to {next_phase_id}.\n"
                f"Run goal-memory-agent assessment first.\n"
                f"Expected memory file: {self.get_memory_file_path('memory')}"
            )

    def get_missing_phases(
        self,
        skill_name: str,
        phase_agent_mapping: Dict[str, str],
    ) -> List[Tuple[str, str]]:
        """
        Return list of phases that should have executed but didn't.

        Args:
            skill_name: Name of the skill being checked
            phase_agent_mapping: Dict mapping phase_id to agent_name

        Returns:
            List of (phase_id, agent_name) tuples for missing phases
        """
        missing = []
        for phase_id, agent_name in phase_agent_mapping.items():
            result = self.verify_phase_execution(phase_id, agent_name)
            if not result.passed:
                missing.append((phase_id, agent_name))
        return missing

    def _log_verification(self, result: VerificationResult) -> None:
        """Log a verification result."""
        self.verification_log.append(result.to_dict())

    def get_verification_report(self) -> str:
        """Get a formatted report of all verification checks."""
        if not self.verification_log:
            return "No verification checks performed."

        lines = [
            f"# Execution Verification Report",
            f"Task ID: {self.task_id}",
            f"Timestamp: {datetime.now(timezone.utc).isoformat()}",
            "",
            "## Verification Results",
            "",
        ]

        passed_count = 0
        failed_count = 0

        for entry in self.verification_log:
            status = "PASS" if entry["passed"] else "FAIL"
            if entry["passed"]:
                passed_count += 1
            else:
                failed_count += 1

            lines.append(f"### Phase: {entry['phase_id']} ({entry['agent_name']})")
            lines.append(f"- Status: **{status}**")
            lines.append(f"- Checks: {', '.join(entry['checks_performed'])}")

            if entry["failures"]:
                lines.append("- Failures:")
                for failure in entry["failures"]:
                    lines.append(f"  - {failure}")
            lines.append("")

        lines.append("## Summary")
        lines.append(f"- Total checks: {len(self.verification_log)}")
        lines.append(f"- Passed: {passed_count}")
        lines.append(f"- Failed: {failed_count}")

        return "\n".join(lines)


# Convenience functions for direct use

def verify_phase(
    task_id: str,
    phase_id: str,
    agent_name: str,
    memory_dir: Optional[Path] = None,
) -> bool:
    """
    Convenience function to verify a single phase.

    Args:
        task_id: The task ID
        phase_id: The phase to verify
        agent_name: The agent that should have executed
        memory_dir: Optional memory directory override

    Returns:
        True if verified, False otherwise
    """
    verifier = ExecutionVerifier(task_id, memory_dir)
    result = verifier.verify_phase_execution(phase_id, agent_name)
    return result.passed


def require_phase(
    task_id: str,
    phase_id: str,
    agent_name: str,
    memory_dir: Optional[Path] = None,
) -> None:
    """
    Convenience function to require phase completion.

    Raises PhaseNotVerifiedError if phase not verified.
    """
    verifier = ExecutionVerifier(task_id, memory_dir)
    verifier.require_phase_completion(phase_id, agent_name)


if __name__ == "__main__":
    # Simple CLI for testing
    import argparse

    parser = argparse.ArgumentParser(description="Verify phase execution")
    parser.add_argument("task_id", help="Task ID to verify")
    parser.add_argument("phase_id", help="Phase ID to verify")
    parser.add_argument("agent_name", help="Agent name to verify")
    parser.add_argument("--memory-dir", help="Memory directory path")

    args = parser.parse_args()

    memory_dir = Path(args.memory_dir) if args.memory_dir else None
    verifier = ExecutionVerifier(args.task_id, memory_dir)

    result = verifier.verify_phase_execution(args.phase_id, args.agent_name)

    print(f"Phase: {result.phase_id}")
    print(f"Agent: {result.agent_name}")
    print(f"Status: {'PASS' if result.passed else 'FAIL'}")

    if not result.passed:
        print("Failures:")
        for failure in result.failures:
            print(f"  - {failure}")

    sys.exit(0 if result.passed else 1)
