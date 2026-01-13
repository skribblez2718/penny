"""
base.py
=======

Abstract base class for all step scripts in the Mandatory Reasoning Protocol.

This module provides:
- Common argument parsing
- State loading/saving
- Markdown content reading
- Step execution framework

Each concrete step script inherits from BaseStep and implements:
- step_number: The step number (1-8)
- step_name: The step name (e.g., "SEMANTIC_UNDERSTANDING")
- process_step(): Custom processing logic if needed

The base class handles:
- Loading state from JSON
- Reading markdown content from content/steps/
- Printing content to stdout (actual instructions)
- Updating state with completion
"""

from __future__ import annotations

import argparse
import sys
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Dict, Optional

# Path setup - navigate to protocols directory for fully-qualified imports
# This prevents collision between reasoning/config and skill/config
_STEPS_DIR = Path(__file__).resolve().parent
_REASONING_ROOT = _STEPS_DIR.parent
_PROTOCOLS_DIR = _REASONING_ROOT.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from reasoning.config.config import (
    CONTENT_DIR,
    STEPS_DIR,
    TOTAL_STEPS,
    STEP_NAMES,
    STEP_TITLES,
    ORCHESTRATION_ROOT,
    get_step_content_path,
    format_mandatory_directive,
)
from reasoning.core.state import ProtocolState


class BaseStep(ABC):
    """
    Abstract base class for protocol steps.

    Subclasses set class attributes:
        _step_num: int  - Step number (0-8)
        _step_name: str - Step name (e.g., "SEMANTIC_UNDERSTANDING")

    Optionally override:
    - process_step(): For custom step processing
    - get_extra_context(): For step-specific context from previous steps
    """

    # Class-level configuration (set by subclasses)
    _step_num: int | None = None
    _step_name: str | None = None

    @property
    def step_number(self) -> int:
        """The step number (0-8) - from class attribute or override."""
        if self._step_num is not None:
            return self._step_num
        raise NotImplementedError(
            f"{self.__class__.__name__} must set _step_num class attribute"
        )

    @property
    def step_name(self) -> str:
        """The step name - from class attribute or STEP_NAMES lookup."""
        if self._step_name is not None:
            return self._step_name
        # Fallback to STEP_NAMES lookup
        return STEP_NAMES.get(self.step_number, "UNKNOWN")

    def __init__(self, state: ProtocolState):
        """
        Initialize the step.

        Args:
            state: The protocol state
        """
        self.state = state
        self._content: Optional[str] = None

    @property
    def content_path(self) -> Path:
        """Get the path to this step's markdown content."""
        return get_step_content_path(self.step_number)

    @property
    def title(self) -> str:
        """Get the human-readable step title."""
        return STEP_TITLES.get(self.step_number, f"Step {self.step_number}")

    def load_content(self) -> str:
        """
        Load markdown content for this step.

        Returns:
            The step's markdown content

        Raises:
            FileNotFoundError: If content file doesn't exist
        """
        if self._content is not None:
            return self._content

        content_path = self.content_path
        if not content_path.exists():
            raise FileNotFoundError(
                f"Step content not found: {content_path}\n"
                f"Create the file or run content extraction."
            )

        self._content = content_path.read_text(encoding="utf-8")
        return self._content

    def get_previous_output(self) -> Optional[Dict[str, Any]]:
        """
        Get the output from the previous step.

        Returns:
            Previous step's output or None
        """
        return self.state.get_previous_step_output()

    def get_extra_context(self) -> str:
        """
        Get extra context to print before step content.

        Override in subclasses to add step-specific context
        from previous step outputs.

        Returns:
            Extra context string (empty by default)
        """
        return ""

    def print_content(self) -> None:
        """Print the step's markdown content to stdout."""
        try:
            content = self.load_content()
            print(content)
        except FileNotFoundError as e:
            print(f"ERROR: {e}")
            print()
            print("Using fallback instructions:")
            print(self.get_fallback_content())
        print()

    def get_fallback_content(self) -> str:
        """
        Get fallback content if markdown file is missing.

        Returns:
            Fallback instruction text
        """
        return f"""
Process this step ({self.title}) for the user's query.

Apply the reasoning techniques appropriate for this step and
document your analysis clearly.
"""

    def print_extra_context(self) -> None:
        """Print any extra context before instructions."""
        extra = self.get_extra_context()
        if extra:
            print(extra)

    def print_next_directive(self) -> None:
        """Print the directive to execute the next step."""
        next_step = self.step_number + 1

        if next_step > 8:  # Step 8 is the last step (0-8 = 9 steps total)
            # This is step 8, direct to completion
            complete_script = ORCHESTRATION_ROOT / "complete.py"
            directive = format_mandatory_directive(
                f"python3 {complete_script} --state {self.state.state_file_path}",
                f"Step {self.step_number} complete. Execute protocol completion. "
            )
            print(directive)
        else:
            # Direct to next step
            next_name = STEP_NAMES.get(next_step, "unknown").lower()
            next_script = STEPS_DIR / f"step_{next_step}_{next_name}.py"

            directive = format_mandatory_directive(
                f"python3 {next_script} --state {self.state.state_file_path}",
                f"Step {self.step_number} complete. Execute Step {next_step} of 8. "
            )
            print(directive)

    def process_step(self) -> Dict[str, Any]:
        """
        Process this step.

        Override in subclasses for custom processing logic.
        The default implementation just returns an empty dict.

        Returns:
            Step output data to store in state
        """
        return {}

    def execute(self) -> bool:
        """
        Execute this step.

        This is the main entry point that orchestrates:
        1. Starting the step in FSM
        2. Printing extra context (if any)
        3. Printing content (markdown instructions)
        4. Processing the step
        5. Completing the step in state
        6. Saving state
        7. Printing next step directive

        Returns:
            True if execution successful
        """
        # Start the step
        if not self.state.start_step(self.step_number):
            print(f"ERROR: Cannot start step {self.step_number}",
                  file=sys.stderr)
            print(f"Current state: {self.state.fsm.state.name}",
                  file=sys.stderr)
            return False

        # Print output (becomes Claude's context)
        self.print_extra_context()
        self.print_content()

        # Process the step (subclass-specific logic)
        output = self.process_step()

        # Complete the step
        if not self.state.complete_step(self.step_number, output):
            print(f"ERROR: Cannot complete step {self.step_number}",
                  file=sys.stderr)
            return False

        # Save state
        self.state.save()

        # Print directive for next step
        self.print_next_directive()

        return True

    @classmethod
    def main(cls) -> int:
        """
        Main entry point for step scripts.

        Parses arguments, loads state, and executes the step.

        Returns:
            Exit code (0 for success, 1 for error)
        """
        # Use generic description - cls.step_number and cls.step_name are abstract
        # properties that return property objects when accessed on the class
        parser = argparse.ArgumentParser(
            description="Execute a reasoning protocol step",
        )
        parser.add_argument(
            "--state",
            required=True,
            help="Path to the state file"
        )

        args = parser.parse_args()

        # Load state
        state_path = Path(args.state)
        if not state_path.exists():
            print(f"ERROR: State file not found: {args.state}",
                  file=sys.stderr)
            return 1

        # Extract session ID from filename
        session_id = state_path.stem.replace("reasoning-", "")

        state = ProtocolState.load(session_id)
        if not state:
            print(f"ERROR: Could not load state from {args.state}",
                  file=sys.stderr)
            return 1

        # Create and execute step - properties are now accessible on instance
        step = cls(state)

        # No step header - content is self-explanatory

        if not step.execute():
            return 1

        return 0
