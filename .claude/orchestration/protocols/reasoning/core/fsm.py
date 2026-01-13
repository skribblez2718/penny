"""
fsm.py
======

Native Python Finite State Machine for the Mandatory Reasoning Protocol.

This module implements a simple FSM using only built-in Python modules:
- enum for state definitions
- No external dependencies required

The FSM enforces the 9-step reasoning protocol (Step 0 + Steps 1-8) with:
- Step 0: Johari Window Discovery (ambiguity detection at START of every interaction)
- Linear transitions (step N -> step N+1)
- Routing validation loop (Steps 4-8, max 3 iterations)
- Conditional at Step 8: COMPLETED, HALTED, or loop back to TASK_ROUTING

Planning is handled via Claude Code's built-in EnterPlanMode tool.
Agent mode sessions skip Step 4 (Task Routing) and proceed directly
to Step 5 (Self-Consistency).
"""

from enum import Enum, auto
from typing import Optional, Dict, List


class ReasoningState(Enum):
    """
    States for the Mandatory Reasoning Protocol.

    The protocol follows a linear progression from INITIALIZED through
    steps, ending in either COMPLETED or HALTED.

    Step 0 (Johari Discovery) executes at START of every interaction.
    Step 3b handles skill detection and agent mode routing. Agent mode
    sessions skip Step 4 (Task Routing) and proceed directly to Step 5.
    """
    INITIALIZED = auto()
    JOHARI_DISCOVERY = auto()            # Step 0 - Ambiguity detection at START
    SEMANTIC_UNDERSTANDING = auto()      # Step 1
    CHAIN_OF_THOUGHT = auto()            # Step 2
    TREE_OF_THOUGHT = auto()             # Step 3
    SKILL_DETECTION = auto()             # Step 3b - Semantic skill matching (no keywords)
    TASK_ROUTING = auto()                # Step 4
    SELF_CONSISTENCY = auto()            # Step 5
    SOCRATIC_INTERROGATION = auto()      # Step 6
    CONSTITUTIONAL_CRITIQUE = auto()     # Step 7
    KNOWLEDGE_TRANSFER = auto()          # Step 8
    COMPLETED = auto()                   # Final - success
    HALTED = auto()                      # Final - needs clarification


class ReasoningFSM:
    """
    Simple Finite State Machine for the Mandatory Reasoning Protocol.

    This FSM enforces deterministic step ordering while allowing the LLM
    to process each step's content adaptively.

    Features:
    - Linear state transitions (step 1 -> 2 -> 3)
    - Routing validation loop (steps 4-8, max 3 iterations)
    - Loop-back transition: KNOWLEDGE_TRANSFER -> TASK_ROUTING on contradiction
    - Conditional final transitions: COMPLETED, HALTED, or loop-back
    - State history tracking
    - JSON serialization for persistence

    Routing Validation Loop:
        Step 4 produces a preliminary routing decision.
        Steps 5-8 validate it. If contradiction detected at Step 8:
        - Loop back to Step 4 (max 3 iterations)
        - If still uncertain after 3 iterations, HALT

    Example:
        fsm = ReasoningFSM()
        fsm.transition(ReasoningState.SEMANTIC_UNDERSTANDING)  # Step 1
        fsm.transition(ReasoningState.CHAIN_OF_THOUGHT)        # Step 2
        # ... continue through steps ...
        # At step 8, either:
        fsm.transition(ReasoningState.COMPLETED)  # Confident
        fsm.transition(ReasoningState.HALTED)     # Needs clarification
        fsm.transition(ReasoningState.TASK_ROUTING)  # Loop back (contradiction)
    """

    # Maximum iterations for routing validation loop (Steps 4-8)
    MAX_ITERATIONS: int = 3

    # Valid transitions: state -> list of allowed next states
    TRANSITIONS: Dict[ReasoningState, List[ReasoningState]] = {
        ReasoningState.INITIALIZED: [ReasoningState.JOHARI_DISCOVERY],
        ReasoningState.JOHARI_DISCOVERY: [ReasoningState.SEMANTIC_UNDERSTANDING],
        ReasoningState.SEMANTIC_UNDERSTANDING: [ReasoningState.CHAIN_OF_THOUGHT],
        ReasoningState.CHAIN_OF_THOUGHT: [ReasoningState.TREE_OF_THOUGHT],
        ReasoningState.TREE_OF_THOUGHT: [ReasoningState.SKILL_DETECTION],
        # Step 3b: Skill detection leads to task routing, or self-consistency in agent mode
        # Agent mode sessions skip Step 4 (Task Routing) - agents are already routed
        ReasoningState.SKILL_DETECTION: [
            ReasoningState.TASK_ROUTING,      # Normal flow
            ReasoningState.SELF_CONSISTENCY,  # Agent mode (skip Step 4)
        ],
        ReasoningState.TASK_ROUTING: [ReasoningState.SELF_CONSISTENCY],
        ReasoningState.SELF_CONSISTENCY: [ReasoningState.SOCRATIC_INTERROGATION],
        ReasoningState.SOCRATIC_INTERROGATION: [ReasoningState.CONSTITUTIONAL_CRITIQUE],
        ReasoningState.CONSTITUTIONAL_CRITIQUE: [ReasoningState.KNOWLEDGE_TRANSFER],
        # Step 8 can: complete, halt, OR loop back to Step 4 (on contradiction)
        ReasoningState.KNOWLEDGE_TRANSFER: [
            ReasoningState.COMPLETED,      # Confident in routing
            ReasoningState.HALTED,         # Needs user clarification
            ReasoningState.TASK_ROUTING,   # Loop back (contradiction detected)
        ],
        # Terminal states have no transitions
        ReasoningState.COMPLETED: [],
        ReasoningState.HALTED: [],
    }

    # Map states to step numbers for easy reference
    STATE_TO_STEP: Dict[ReasoningState, float] = {
        ReasoningState.JOHARI_DISCOVERY: 0,            # Step 0
        ReasoningState.SEMANTIC_UNDERSTANDING: 1,
        ReasoningState.CHAIN_OF_THOUGHT: 2,
        ReasoningState.TREE_OF_THOUGHT: 3,
        ReasoningState.SKILL_DETECTION: 3.2,           # Step 3b
        ReasoningState.TASK_ROUTING: 4,
        ReasoningState.SELF_CONSISTENCY: 5,
        ReasoningState.SOCRATIC_INTERROGATION: 6,
        ReasoningState.CONSTITUTIONAL_CRITIQUE: 7,
        ReasoningState.KNOWLEDGE_TRANSFER: 8,
    }

    # Reverse mapping: step number to state
    STEP_TO_STATE: Dict[float, ReasoningState] = {v: k for k, v in STATE_TO_STEP.items()}

    def __init__(self, state: ReasoningState = ReasoningState.INITIALIZED):
        """
        Initialize the FSM.

        Args:
            state: Initial state (defaults to INITIALIZED)
        """
        self.state = state
        self.history: List[ReasoningState] = [state]

    def can_transition(self, target: ReasoningState) -> bool:
        """
        Check if transition to target state is allowed.

        Args:
            target: The state to transition to

        Returns:
            True if transition is valid, False otherwise
        """
        return target in self.TRANSITIONS.get(self.state, [])

    def transition(self, target: ReasoningState) -> bool:
        """
        Attempt transition to target state.

        Args:
            target: The state to transition to

        Returns:
            True if transition succeeded, False if invalid
        """
        if self.can_transition(target):
            self.state = target
            self.history.append(target)
            return True
        return False

    def get_current_step(self) -> Optional[float]:
        """
        Get the current step number.

        Returns:
            Step number (1-8, with sub-steps like 3.2, 3.3, 3.4) or None if not in a step state
        """
        return self.STATE_TO_STEP.get(self.state)

    def get_next_state(self) -> Optional[ReasoningState]:
        """
        Get the next state in the sequence.

        For Step 8, returns COMPLETED by default (HALTED requires explicit transition).

        Returns:
            Next state or None if at terminal state
        """
        allowed = self.TRANSITIONS.get(self.state, [])
        if allowed:
            return allowed[0]  # First allowed transition (COMPLETED for step 8)
        return None

    def get_next_step(self) -> Optional[float]:
        """
        Get the next step number.

        Returns:
            Next step number or None if at terminal state
        """
        next_state = self.get_next_state()
        if next_state:
            return self.STATE_TO_STEP.get(next_state)
        return None

    def is_final(self) -> bool:
        """
        Check if current state is a final state.

        Returns:
            True if COMPLETED or HALTED
        """
        return self.state in [ReasoningState.COMPLETED, ReasoningState.HALTED]

    def is_halted(self) -> bool:
        """
        Check if protocol was halted for clarification.

        Returns:
            True if HALTED
        """
        return self.state == ReasoningState.HALTED

    def is_completed(self) -> bool:
        """
        Check if protocol completed successfully.

        Returns:
            True if COMPLETED
        """
        return self.state == ReasoningState.COMPLETED

    def to_dict(self) -> dict:
        """
        Serialize FSM state for JSON storage.

        Returns:
            Dictionary representation of FSM state
        """
        return {
            "state": self.state.name,  # Aligned with protocols/skill FSM naming
            "current_step": self.get_current_step(),
            "history": [s.name for s in self.history],
            "is_final": self.is_final(),
            "is_halted": self.is_halted(),
            "is_completed": self.is_completed(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ReasoningFSM":
        """
        Restore FSM from JSON data.

        Args:
            data: Dictionary with FSM state

        Returns:
            Restored ReasoningFSM instance
        """
        # Support both "state" (new) and "current_state" (legacy) for backwards compatibility
        state_key = "state" if "state" in data else "current_state"
        state = ReasoningState[data[state_key]]
        fsm = cls(state)
        fsm.history = [ReasoningState[s] for s in data["history"]]
        return fsm

    def __repr__(self) -> str:
        step = self.get_current_step()
        step_str = f" (Step {step})" if step else ""
        return f"ReasoningFSM(state={self.state.name}{step_str})"
