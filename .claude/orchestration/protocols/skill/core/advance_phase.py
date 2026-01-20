"""
Generic Phase Advancer for Composite Skills
============================================

Advances any composite skill to its next phase after agent completion.
Replaces per-skill phase Python files with a single data-driven advancer.

Usage:
    python3 advance_phase.py <skill_name> <session_id>

Example:
    python3 advance_phase.py perform-research abc12345

The script:
1. Loads SkillExecutionState by session_id
2. Gets current phase from FSM
3. Transitions to next phase via config "next" pointer
4. Handles special phase types (OPTIONAL, AUTO, PARALLEL, REMEDIATION, ITERATIVE)
5. Prints next phase content + agent directive
6. Saves updated state
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between skill/config and agent/config
_CORE_DIR = Path(__file__).resolve().parent
_SKILL_PROTOCOLS_ROOT = _CORE_DIR.parent
_ORCHESTRATION_ROOT = _SKILL_PROTOCOLS_ROOT.parent
_PROTOCOLS_DIR = _ORCHESTRATION_ROOT
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

# Import shared directive core for consistent formatting
_DIRECTIVES_PATH = _ORCHESTRATION_ROOT.parent
if str(_DIRECTIVES_PATH) not in sys.path:
    sys.path.insert(0, str(_DIRECTIVES_PATH))
from directives.base import _format_directive_core

from skill.core.state import SkillExecutionState
from skill.config.config import (
    get_phase_config,
    get_atomic_skill_agent,
    PhaseType,
    COMPOSITE_DIR,
)
from skill.core.execution_verifier import (
    ExecutionVerifier,
    PhaseNotVerifiedError,
    GoalMemoryNotCompletedError,
)
from skill.clarification_handler import (
    check_clarification_needed,
    extract_questions_from_memory,
    format_questions_for_ask_user,
    build_ask_user_invocation,
)

from datetime import datetime


# Skills that bypass memory invocations at phase transitions
# for performance optimization (these workflows don't benefit from metacognitive hooks)
SKILLS_BYPASSING_GOAL_MEMORY = frozenset([
    # Currently no skills bypass memory
])


# --- Clarification Handling at Phase Level ---

# Exit code indicating clarification is needed
EXIT_CODE_CLARIFICATION_NEEDED = 2


def check_and_handle_clarification(
    state: SkillExecutionState,
    memory_file_path: Path,
) -> bool:
    """
    Check if the agent's memory file indicates clarification is needed.

    If clarification_required: true is found in Section 4, this function:
    1. Stores clarification state in the skill's metadata
    2. Prints an AskUserQuestion directive for the main thread
    3. Returns True to signal that execution should block

    Args:
        state: Current skill execution state
        memory_file_path: Path to the agent's memory file

    Returns:
        True if clarification is needed and workflow should block,
        False otherwise (continue normal phase advancement)
    """
    if not memory_file_path.exists():
        return False

    if not check_clarification_needed(str(memory_file_path)):
        return False

    # Extract questions from the memory file
    questions = extract_questions_from_memory(str(memory_file_path))

    if not questions:
        return False

    # Store clarification state in metadata
    current_phase = state.fsm.get_current_phase() if state.fsm else None
    current_config = get_phase_config(state.skill_name, current_phase) if current_phase else None
    agent_name = None
    if current_config:
        atomic_skill = current_config.get("uses_atomic_skill")
        if atomic_skill:
            agent_name = get_atomic_skill_agent(atomic_skill)

    # Track clarification round (for iterative questioning)
    clarification_round = state.metadata.get("clarification_round", 0) + 1

    state.metadata["clarification_pending"] = True
    state.metadata["clarification_agent"] = agent_name
    state.metadata["clarification_phase"] = current_phase
    state.metadata["clarification_questions"] = questions
    state.metadata["clarification_round"] = clarification_round
    state.metadata["clarification_memory_file"] = str(memory_file_path)
    state.metadata["clarification_requested_at"] = datetime.now().isoformat()

    # Save state before printing directive
    state.save()

    # Format questions for AskUserQuestion tool
    formatted_questions = format_questions_for_ask_user(questions)

    # Print the directive for the main thread
    print(build_ask_user_invocation(formatted_questions))
    print()
    print(f"After user answers, re-run: `python3 .claude/orchestration/protocols/skill/core/advance_phase.py {state.skill_name} {state.session_id} --resume-with-answers`")

    return True


def resume_with_answers(
    state: SkillExecutionState,
    answers_data: Optional[Dict[str, Any]] = None,
) -> None:
    """
    Resume workflow after user has provided answers to clarification questions.

    This function:
    1. Stores the user's answers in state metadata
    2. Clears the clarification_pending flag
    3. Re-invokes the agent with the answers in context

    Args:
        state: Current skill execution state
        answers_data: Optional dict with user answers (if None, answers are
                      expected to be in context from AskUserQuestion response)
    """
    if not state.metadata.get("clarification_pending"):
        print("WARNING: resume_with_answers called but no clarification was pending")
        return

    # Store answers in metadata
    clarification_round = state.metadata.get("clarification_round", 1)
    answers_key = f"clarification_answers_round_{clarification_round}"
    state.metadata[answers_key] = answers_data or {"note": "Answers provided via AskUserQuestion in conversation context"}
    state.metadata["clarification_answered_at"] = datetime.now().isoformat()

    # Clear pending flag (but keep history)
    state.metadata["clarification_pending"] = False

    # Get agent to re-invoke
    agent_name = state.metadata.get("clarification_agent")
    phase_id = state.metadata.get("clarification_phase")

    if not agent_name:
        print("ERROR: No agent recorded for clarification re-invocation")
        sys.exit(1)

    state.save()

    # Print directive to re-invoke the agent
    phase_config = get_phase_config(state.skill_name, phase_id) if phase_id else None
    phase_name = phase_config.get("title", phase_id) if phase_config else phase_id

    print(f"\n## Clarification Answered - Re-invoke Agent")
    print(f"\nUser has answered clarification questions (round {clarification_round}).")
    print(f"Re-invoke the agent to continue with the clarified context.")
    print()
    print(format_mandatory_agent_directive(agent_name, phase_name))
    print(f"After agent completes: `python3 .claude/orchestration/protocols/skill/core/advance_phase.py {state.skill_name} {state.session_id}`")


# --- GoalMemory Integration at Phase Level ---

def invoke_phase_goal_memory(
    state: SkillExecutionState,
    completed_phase_id: str,
    next_phase_id: str
) -> None:
    """
    MANDATORY memory invocation at phase transitions.

    ENFORCEMENT: Creates phase-specific blocking that requires a unique
    memory file for THIS specific phase transition. Each transition
    gets its own memory assessment file, ensuring the agent is
    invoked at every phase boundary.
    """
    # Generate phase-specific memory file identifier
    phase_transition_id = f"phase-{completed_phase_id}-to-{next_phase_id}"

    # Phase-specific expected output file
    expected_file = f".claude/memory/{state.task_id}-{phase_transition_id}-memory.md"

    # Minimal output - just the essential directive
    print(f"\nPhase transition: {completed_phase_id} → {next_phase_id}")
    print(f"Invoke memory-agent via Task tool with subagent_type: `memory-agent`")
    print(f"Expected output: {expected_file}")
    print(f"After completion: `python3 .claude/orchestration/protocols/skill/core/advance_phase.py {state.skill_name} {state.session_id}`")
    print()

    # Track phase-specific invocation in state
    state.metadata["last_goal_memory_invocation"] = datetime.now().isoformat()
    state.metadata["last_goal_memory_phase"] = completed_phase_id
    state.metadata["goal_memory_required_for_phase"] = next_phase_id
    state.metadata["goal_memory_pending"] = True
    state.metadata["goal_memory_transition_id"] = phase_transition_id


def get_content_path(skill_name: str, content_file: str) -> Path:
    """Get the path to a phase's markdown content file."""
    # Convert skill name to directory format (e.g., perform-research -> perform_research)
    skill_dir_name = skill_name.replace("-", "_")
    return COMPOSITE_DIR / skill_dir_name / "content" / content_file


def print_phase_content(skill_name: str, phase_config: Dict[str, Any]) -> None:
    """Print the markdown content for a phase."""
    content_file = phase_config.get("content")
    if not content_file:
        return

    content_path = get_content_path(skill_name, content_file)
    if content_path.exists():
        print(content_path.read_text())
    else:
        print(f"[Content file not found: {content_path}]")


def format_mandatory_agent_directive(agent_name: str, phase_name: str = "") -> str:
    """
    Format a mandatory agent invocation directive.

    This uses the centralized _format_directive_core() to ensure consistent
    directive formatting across all protocols.

    Args:
        agent_name: The agent to invoke via Task tool
        phase_name: Optional phase name for context

    Returns:
        Formatted directive string with mandatory enforcement language
    """
    # Build section header
    phase_context = f" for phase: {phase_name}" if phase_name else ""
    section_header = f"## MANDATORY: Invoke Agent{phase_context}\n\n"

    # Task tool is invoked via tool call, not shell command
    # Format as instruction rather than executable command
    command = f"Task tool with subagent_type: {agent_name}"

    context = "The agent will create a memory file upon completion. Only then can the workflow advance."

    directive_body = _format_directive_core(
        command,
        context,
        warnings=[
            "This agent invocation is REQUIRED for workflow completion.",
            "DO NOT proceed with any other action until this agent is invoked.",
            "DO NOT perform the agent's work directly - you MUST spawn the agent via Task tool.",
        ]
    )

    return section_header + directive_body


def print_agent_directive(phase_config: Dict[str, Any]) -> None:
    """Print the agent invocation directive for a phase.

    ENFORCEMENT: Uses mandatory directive language to ensure Claude
    invokes the agent via Task tool rather than performing the work directly.

    NOTE: As of the AUTO deprecation, ALL phases should specify an agent.
    Phases without agents (uses_atomic_skill: None) are deprecated.
    """
    atomic_skill = phase_config.get("uses_atomic_skill")
    if atomic_skill:
        agent_name = get_atomic_skill_agent(atomic_skill)
        phase_name = phase_config.get("title", phase_config.get("name", ""))
        print(format_mandatory_agent_directive(agent_name, phase_name))
    # DEPRECATED: Phases without agent invocation should be updated to use appropriate agents


def print_parallel_directives(phase_config: Dict[str, Any]) -> None:
    """Print directives for all parallel branches.

    ENFORCEMENT: Uses mandatory directive language to ensure Claude
    invokes ALL parallel branch agents via Task tool.
    """
    branches = phase_config.get("parallel_branches", {})
    if not branches:
        return

    print("Parallel branches - invoke all via Task tool:")
    for branch_id, branch_config in branches.items():
        atomic_skill = branch_config.get("uses_atomic_skill")
        agent_name = get_atomic_skill_agent(atomic_skill) if atomic_skill else "N/A"
        print(f"  - {branch_id}: subagent_type: `{agent_name}`")
    print("After ALL branches complete, run advance_phase.py to continue.")


def should_skip_optional(state: SkillExecutionState, phase_config: Dict[str, Any]) -> bool:
    """
    Determine if an optional phase should be skipped.

    Check skip_condition against state metadata.
    Returns True if phase should be skipped.
    """
    skip_condition = phase_config.get("skip_condition")
    if not skip_condition:
        return False

    # Skip conditions are stored as simple string identifiers
    # Check if the condition flag is set in state metadata
    return state.metadata.get(skip_condition, False)


def get_remediation_loop_count(state: SkillExecutionState, phase_id: str) -> int:
    """Get the current remediation loop count for a phase."""
    key = f"remediation_count_{phase_id}"
    return state.metadata.get(key, 0)


def increment_remediation_count(state: SkillExecutionState, phase_id: str) -> int:
    """Increment and return the remediation loop count."""
    key = f"remediation_count_{phase_id}"
    count = state.metadata.get(key, 0) + 1
    state.metadata[key] = count
    return count


def needs_remediation(state: SkillExecutionState) -> bool:
    """
    Check if the previous validation phase indicated need for remediation.

    Looks for validation_status in state metadata.
    """
    return state.metadata.get("validation_status") == "needs_remediation"


def handle_phase_transition(
    state: SkillExecutionState,
    phase_config: Dict[str, Any],
    phase_id: str,
) -> Optional[str]:
    """
    Handle phase type-specific transition logic.

    Returns the next phase ID, or None if current phase needs execution.

    Args:
        state: Current skill execution state
        phase_config: Configuration for the current phase
        phase_id: Current phase ID

    ENFORCEMENT: No bypass mechanism exists by design. All phases must
    complete their execution chain before advancement is allowed.
    """
    phase_type = phase_config.get("type", PhaseType.LINEAR)

    # Ensure we have a PhaseType enum
    if isinstance(phase_type, str):
        phase_type = PhaseType[phase_type]

    # LINEAR: Simple transition to next
    if phase_type == PhaseType.LINEAR:
        return phase_config.get("next")

    # OPTIONAL: Check skip condition
    if phase_type == PhaseType.OPTIONAL:
        if should_skip_optional(state, phase_config):
            print(f"[Skipping optional phase {phase_id}: condition met]")
            state.fsm.skip_phase(phase_id, "skip_condition_met")
            return phase_config.get("next")
        return phase_config.get("next")

    # AUTO: No agent needed, just advance
    # DEPRECATED: PhaseType.AUTO should not be used in new skills.
    # All phases should use appropriate agents for cognitive oversight.
    # See: protocols/skill/CLAUDE.md for guidance.
    if phase_type == PhaseType.AUTO:
        print(f"[DEPRECATION WARNING: Phase uses PhaseType.AUTO - consider using LINEAR with appropriate agent]", file=sys.stderr)
        return phase_config.get("next")

    # PARALLEL: All branches must complete before advancing
    # ENFORCEMENT: No bypass mechanism exists. All parallel branches must
    # complete their full execution chain before advancement.
    if phase_type == PhaseType.PARALLEL:
        if state.fsm.are_all_branches_complete(phase_id):
            return phase_config.get("next")
        # Branches not complete - need to continue executing
        return None

    # ITERATIVE: Track iteration through agents
    if phase_type == PhaseType.ITERATIVE:
        iteration_agents = phase_config.get("iteration_agents", [])
        current_iteration = state.metadata.get(f"iteration_{phase_id}", 0)

        if current_iteration >= len(iteration_agents):
            # All iterations complete
            state.metadata[f"iteration_{phase_id}"] = 0  # Reset for potential re-entry
            return phase_config.get("next")
        # Still iterating - advance to next agent
        state.metadata[f"iteration_{phase_id}"] = current_iteration + 1
        return None  # Stay on this phase but with next iteration

    # REMEDIATION: May loop back on validation failure
    if phase_type == PhaseType.REMEDIATION:
        if needs_remediation(state):
            max_loops = phase_config.get("max_remediation", 2)
            current_count = get_remediation_loop_count(state, phase_id)

            if current_count >= max_loops:
                print(f"[Max remediation loops ({max_loops}) reached for phase {phase_id}]")
                state.halt(f"Max remediation loops reached for phase {phase_id}")
                return None

            increment_remediation_count(state, phase_id)
            target = phase_config.get("remediation_target")
            print(f"[Remediation required: looping back to phase {target}]")
            return target

        # Validation passed
        state.metadata["validation_status"] = None  # Clear status
        return phase_config.get("next")

    # Default: treat as LINEAR
    return phase_config.get("next")


def verify_parallel_branches(
    state: SkillExecutionState,
    phase_id: str,
    phase_config: Dict[str, Any],
) -> Tuple[bool, List[str]]:
    """
    Verify that all parallel branch memory files exist.

    For PARALLEL phases, each branch spawns its own agent and creates its own
    memory file. This function verifies all branch memory files exist.

    Memory file naming is flexible to accommodate agents that may not know their
    branch context. The function accepts multiple naming patterns:
    1. {task_id}-{branch_id}-{agent_name}-memory.md (branch-prefixed)
    2. {task_id}-{agent_name}-memory.md (standard)
    3. {task_id}-{agent_name}-{descriptive}-memory.md (descriptive suffix)
    4. {task_id}-{descriptive}-memory.md (descriptive only)

    Args:
        state: Current skill execution state
        phase_id: The PARALLEL phase ID
        phase_config: Configuration for the PARALLEL phase

    Returns:
        Tuple of (all_verified, list of failure messages)
    """
    branches = phase_config.get("parallel_branches", {})
    if not branches:
        return True, []

    failures = []
    memory_dir = Path(".claude/memory")
    verifier = ExecutionVerifier(state.task_id, memory_dir)

    for branch_id, branch_config in branches.items():
        atomic_skill = branch_config.get("uses_atomic_skill")
        if not atomic_skill:
            continue

        agent_name = get_atomic_skill_agent(atomic_skill)
        if not agent_name:
            continue

        # Extract the base agent type (e.g., "research" from "research")
        agent_base = agent_name.replace("-agent", "")

        # Check for branch-specific memory file first: {task_id}-{branch_id}-{agent_name}-memory.md
        branch_memory_file = memory_dir / f"{state.task_id}-{branch_id}-{agent_name}-memory.md"

        # Also check for standard memory file (agents may not know their branch_id)
        standard_memory_file = memory_dir / f"{state.task_id}-{agent_name}-memory.md"

        # FLEXIBLE PATTERN: Check for any file matching {task_id}-{agent_base}*-memory.md
        # This handles descriptive naming like {task_id}-research-codebase-memory.md
        pattern = f"{state.task_id}-{agent_base}*-memory.md"
        matching_files = list(memory_dir.glob(pattern))

        # Also check for pattern like {task_id}-*-{agent_name}-memory.md
        pattern_alt = f"{state.task_id}-*-{agent_name}-memory.md"
        matching_files.extend(list(memory_dir.glob(pattern_alt)))

        # Remove duplicates
        matching_files = list(set(matching_files))

        if branch_memory_file.exists():
            print(f"[Branch {branch_id} verified: {branch_memory_file.name}]")
        elif standard_memory_file.exists():
            # Standard file exists - this is acceptable for parallel branches
            print(f"[Branch {branch_id} verified via shared file: {standard_memory_file.name}]")
        elif matching_files:
            # Found files matching flexible pattern
            # Use the first match (or most recent if multiple)
            matched_file = sorted(matching_files, key=lambda f: f.stat().st_mtime, reverse=True)[0]
            print(f"[Branch {branch_id} verified via flexible match: {matched_file.name}]")
        else:
            failures.append(
                f"Branch {branch_id} ({branch_config.get('name', branch_id)}): "
                f"No memory file found. Expected {branch_memory_file.name}, "
                f"{standard_memory_file.name}, or matching pattern {pattern}"
            )

    return len(failures) == 0, failures


def advance_phase(skill_name: str, session_id: str) -> None:
    """
    Advance a skill to its next phase.

    Args:
        skill_name: Name of the composite skill
        session_id: Session ID for state lookup

    ENFORCEMENT: No bypass mechanisms exist by design. This function will
    only advance when all phase requirements are verified complete.
    """
    # Load state
    state = SkillExecutionState.load(skill_name, session_id)
    if not state:
        print(f"ERROR: State not found for {skill_name} session {session_id}", file=sys.stderr)
        sys.exit(1)

    if not state.fsm:
        print(f"ERROR: No FSM found in state (is this an atomic skill?)", file=sys.stderr)
        sys.exit(1)

    # ENFORCEMENT: Check if memory was required and verify it completed
    # Uses per-phase-transition file tracking to ensure memory is invoked
    # at EVERY phase transition, not just the first one
    # Skip for skills in bypass list (for performance optimization)
    skill_bypasses_goal_memory = skill_name in SKILLS_BYPASSING_GOAL_MEMORY

    # Clear pending flag for bypassed skills (they never require memory)
    if skill_bypasses_goal_memory and state.metadata.get("goal_memory_pending"):
        state.metadata["goal_memory_pending"] = False
        state.metadata["goal_memory_bypassed"] = True

    if state.metadata.get("goal_memory_pending") and not skill_bypasses_goal_memory:
        next_phase_for_gm = state.metadata.get("goal_memory_required_for_phase")
        transition_id = state.metadata.get("goal_memory_transition_id")

        # Use phase-specific file path for this transition
        if transition_id:
            goal_memory_filename = f"{state.task_id}-{transition_id}-memory.md"
        else:
            # Fallback for legacy state files without transition_id
            goal_memory_filename = f"{state.task_id}-memory.md"

        goal_memory_file = Path(".claude/memory") / goal_memory_filename

        if not goal_memory_file.exists():
            print(f"BLOCKED: Goal-Memory required. Expected: {goal_memory_file}")
            print("Run memory-agent assessment, then re-run this command.")
            sys.exit(1)
        else:
            # Goal-memory completed for THIS phase transition, clear the pending flag
            state.metadata["goal_memory_pending"] = False
            state.metadata["goal_memory_completed_at"] = datetime.now().isoformat()
            if transition_id:
                state.metadata[f"goal_memory_{transition_id}_completed"] = True
            print(f"[Goal-memory verification PASSED for phase transition to {next_phase_for_gm}]")

    # ENFORCEMENT: Verify current phase's agent completed (memory file exists)
    # This MUST happen before we mark the phase complete
    current_phase_id_check = state.fsm.get_current_phase()
    if current_phase_id_check:
        check_config = get_phase_config(skill_name, current_phase_id_check)
        if check_config:
            # Get phase type to determine verification strategy
            phase_type = check_config.get("type", PhaseType.LINEAR)
            if isinstance(phase_type, str):
                phase_type = PhaseType[phase_type]

            # PARALLEL phases: Verify branch memory files instead of parent
            # PARALLEL phases don't directly invoke agents - their branches do
            if phase_type == PhaseType.PARALLEL:
                print(f"[PARALLEL phase {current_phase_id_check}: Verifying branch memory files]")
                all_verified, failures = verify_parallel_branches(
                    state, current_phase_id_check, check_config
                )
                if not all_verified:
                    print(f"BLOCKED: Parallel branch memory files missing for phase {current_phase_id_check}")
                    for failure in failures:
                        print(f"  - {failure}")
                    print(f"Use --complete-all-branches {current_phase_id_check} if agents already ran")
                    sys.exit(1)
                print(f"[PARALLEL phase {current_phase_id_check}: All branches verified]")
            else:
                # Standard verification for non-PARALLEL phases
                atomic_skill = check_config.get("uses_atomic_skill")
                if atomic_skill:
                    agent_name = get_atomic_skill_agent(atomic_skill)
                    if agent_name:
                        verifier = ExecutionVerifier(state.task_id, Path(".claude/memory"))
                        try:
                            verifier.require_phase_completion(current_phase_id_check, agent_name)
                        except PhaseNotVerifiedError as e:
                            print(f"BLOCKED: Agent memory file missing for phase {current_phase_id_check}")
                            print(f"Invoke {agent_name} via Task tool to complete the phase.")
                            sys.exit(1)

                        # CLARIFICATION CHECK: After verifying memory file exists,
                        # check if it indicates clarification is needed
                        memory_file = Path(".claude/memory") / f"{state.task_id}-{agent_name}-memory.md"
                        if check_and_handle_clarification(state, memory_file):
                            # Clarification needed - directive already printed, exit with special code
                            sys.exit(EXIT_CODE_CLARIFICATION_NEEDED)

    # Get current phase info
    current_phase_id = state.fsm.get_current_phase()
    if not current_phase_id:
        print(f"ERROR: No current phase in FSM", file=sys.stderr)
        sys.exit(1)

    current_config = get_phase_config(skill_name, current_phase_id)
    if not current_config:
        print(f"ERROR: Phase config not found for {current_phase_id}", file=sys.stderr)
        sys.exit(1)

    # Mark current phase as complete
    state.complete_phase(current_phase_id, {"status": "completed"})

    # Determine next phase
    next_phase_id = handle_phase_transition(state, current_config, current_phase_id)

    # NEW: Invoke GoalMemory at phase transition for skill-level assessment
    # Skip for skills in bypass list (for performance optimization)
    skill_bypasses_goal_memory = skill_name in SKILLS_BYPASSING_GOAL_MEMORY
    if next_phase_id and next_phase_id != "COMPLETED" and not skill_bypasses_goal_memory:
        invoke_phase_goal_memory(state, current_phase_id, next_phase_id)

    # Check for workflow completion
    if state.fsm.is_completed() or state.fsm.is_halted():
        if state.fsm.is_halted():
            print(f"Workflow halted: {state.halt_reason}")
        else:
            # AUTO-CALL complete.py
            skill_dir = skill_name.replace("-", "_")
            complete_script = Path(f".claude/orchestration/protocols/skill/composite/{skill_dir}/complete.py")

            if complete_script.exists():
                result = subprocess.run(
                    ["python3", str(complete_script), session_id],
                    capture_output=False,  # Let output flow to stdout
                    text=True
                )
                if result.returncode != 0:
                    print(f"WARNING: complete.py exited with code {result.returncode}", file=sys.stderr)
            else:
                print(f"WARNING: complete.py not found at {complete_script}", file=sys.stderr)

        state.save()
        return

    if next_phase_id is None:
        # Phase requires more execution (PARALLEL branches or ITERATIVE)
        print_phase_content(skill_name, current_config)

        phase_type = current_config.get("type")
        if phase_type == PhaseType.PARALLEL:
            print_parallel_directives(current_config)
        else:
            print_agent_directive(current_config)

        state.save()
        return

    # Transition FSM to next phase
    # ENFORCEMENT: verified=True because memory has validated the transition
    # Goal-memory completion IS the verification signal for phase advancement
    try:
        actual_next = state.fsm.transition(next_phase_id, verified=True)
    except ValueError as e:
        print(f"ERROR: Transition failed: {e}", file=sys.stderr)
        sys.exit(1)

    # CRITICAL FIX: Save state IMMEDIATELY after FSM transition and BEFORE spawning
    # any subprocess. This prevents race condition where subprocess loads stale state.
    # Bug reference: FSM transitions to COMPLETED in memory, but complete.py loads
    # from disk before state.save() was called, seeing EXECUTING instead of COMPLETED.
    state.save()

    # Check if transition resulted in completion
    if actual_next == "COMPLETED":
        # AUTO-CALL complete.py
        skill_dir = skill_name.replace("-", "_")
        complete_script = Path(f".claude/orchestration/protocols/skill/composite/{skill_dir}/complete.py")

        if complete_script.exists():
            result = subprocess.run(
                ["python3", str(complete_script), session_id],
                capture_output=False,  # Let output flow to stdout
                text=True
            )
            if result.returncode != 0:
                print(f"WARNING: complete.py exited with code {result.returncode}", file=sys.stderr)
        else:
            print(f"WARNING: complete.py not found at {complete_script}", file=sys.stderr)

        # Note: state.save() already called before COMPLETED check (line 568)
        return

    # Get next phase config
    next_config = get_phase_config(skill_name, actual_next)
    if not next_config:
        print(f"ERROR: Next phase config not found for {actual_next}", file=sys.stderr)
        sys.exit(1)

    # Handle AUTO phases - execute immediately without agent
    # DEPRECATED: PhaseType.AUTO should not be used in new skills.
    # All phases should invoke appropriate agents for cognitive oversight.
    phase_type = next_config.get("type")
    if phase_type == PhaseType.AUTO:
        print(f"[DEPRECATION WARNING: Phase {actual_next} uses PhaseType.AUTO - consider using LINEAR with appropriate agent]", file=sys.stderr)
        print_phase_content(skill_name, next_config)
        print(f"AUTO phase - run: `python3 .claude/orchestration/protocols/skill/core/advance_phase.py {skill_name} {session_id}`")
        state.save()
        return

    # Handle PARALLEL phases - print all branch directives
    if phase_type == PhaseType.PARALLEL:
        print_phase_content(skill_name, next_config)
        print_parallel_directives(next_config)

        # Initialize parallel branch tracking
        state.fsm.initialize_parallel_branches(actual_next)
        state.save()
        return

    # Standard phase output
    print_phase_content(skill_name, next_config)
    print_agent_directive(next_config)
    print(f"After agent completes: `python3 .claude/orchestration/protocols/skill/core/advance_phase.py {skill_name} {session_id}`")

    # Note: state.save() already called after FSM transition (line 568)


def complete_branch(skill_name: str, session_id: str, phase_id: str, branch_id: str) -> None:
    """
    Mark a parallel branch as completed.

    Args:
        skill_name: Name of the composite skill
        session_id: Session ID for state lookup
        phase_id: Phase ID containing the branch
        branch_id: Branch ID to mark complete
    """
    state = SkillExecutionState.load(skill_name, session_id)
    if not state:
        print(f"ERROR: State not found for {skill_name} session {session_id}", file=sys.stderr)
        sys.exit(1)

    if not state.fsm:
        print(f"ERROR: No FSM found in state", file=sys.stderr)
        sys.exit(1)

    # Mark branch complete
    state.fsm.complete_parallel_branch(phase_id, branch_id, {"status": "completed"})
    state.save()
    print(f"Branch {branch_id} in phase {phase_id} marked as completed")


def complete_all_branches(skill_name: str, session_id: str, phase_id: str) -> None:
    """
    Mark all parallel branches in a phase as completed.

    Args:
        skill_name: Name of the composite skill
        session_id: Session ID for state lookup
        phase_id: Phase ID to complete all branches for
    """
    state = SkillExecutionState.load(skill_name, session_id)
    if not state:
        print(f"ERROR: State not found for {skill_name} session {session_id}", file=sys.stderr)
        sys.exit(1)

    if not state.fsm:
        print(f"ERROR: No FSM found in state", file=sys.stderr)
        sys.exit(1)

    # Get branches for phase
    if phase_id not in state.fsm.parallel_branches:
        print(f"ERROR: No parallel branches found for phase {phase_id}", file=sys.stderr)
        sys.exit(1)

    # Mark all branches complete
    for branch_id in state.fsm.parallel_branches[phase_id]:
        state.fsm.complete_parallel_branch(phase_id, branch_id, {"status": "completed"})
        print(f"Branch {branch_id} marked as completed")

    state.save()
    print(f"All branches in phase {phase_id} marked as completed")


def main():
    """Main entry point.

    ENFORCEMENT: No --force flag exists by design. All phases must complete
    their full execution chain before advancement is allowed.

    Exit Codes:
        0 - Success (workflow advanced)
        1 - Error (fix error and retry)
        2 - Clarification needed (use AskUserQuestion, then --resume-with-answers)
    """
    parser = argparse.ArgumentParser(
        description="Advance a composite skill to its next phase"
    )
    parser.add_argument("skill_name", help="Name of the composite skill")
    parser.add_argument("session_id", help="Session ID for state lookup")
    # ENFORCEMENT: --force flag removed. No bypass mechanism allowed.
    parser.add_argument(
        "--complete-branch",
        metavar="PHASE:BRANCH",
        help="Mark a specific branch as completed (format: phase_id:branch_id)"
    )
    parser.add_argument(
        "--complete-all-branches",
        metavar="PHASE",
        help="Mark all branches in a phase as completed"
    )
    parser.add_argument(
        "--resume-with-answers",
        action="store_true",
        help="Resume workflow after user has answered clarification questions"
    )

    args = parser.parse_args()

    # Handle branch completion commands
    if args.complete_branch:
        parts = args.complete_branch.split(":")
        if len(parts) != 2:
            print("ERROR: --complete-branch format must be PHASE:BRANCH", file=sys.stderr)
            sys.exit(1)
        complete_branch(args.skill_name, args.session_id, parts[0], parts[1])
        return

    if args.complete_all_branches:
        complete_all_branches(args.skill_name, args.session_id, args.complete_all_branches)
        return

    # Handle clarification resumption
    if args.resume_with_answers:
        state = SkillExecutionState.load(args.skill_name, args.session_id)
        if not state:
            print(f"ERROR: State not found for {args.skill_name} session {args.session_id}", file=sys.stderr)
            sys.exit(1)
        resume_with_answers(state)
        return

    advance_phase(args.skill_name, args.session_id)


if __name__ == "__main__":
    main()
