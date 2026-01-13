"""
base.py
=======

Abstract base class for execution protocol steps.

This module provides:
- Common argument parsing
- State loading/saving
- Markdown content reading
- Step execution framework

Each concrete step script inherits from ExecutionBaseStep and implements:
- step_number: The step number
- step_name: The step name
- process_step(): Custom processing logic if needed
"""

from __future__ import annotations

import argparse
import sys
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Dict, Optional

# Path setup - navigate to execution protocol root
_STEPS_DIR = Path(__file__).resolve().parent
_EXECUTION_ROOT = _STEPS_DIR.parent
if str(_EXECUTION_ROOT) not in sys.path:
    sys.path.insert(0, str(_EXECUTION_ROOT))

from config.config import (
    ProtocolType,
    PROTOCOL_STEPS,
    PROTOCOL_TOTAL_STEPS,
    PROTOCOL_TO_DIR,
    get_step_content_path,
    get_protocol_steps_dir,
    EXECUTION_PROTOCOLS_ROOT,
    format_mandatory_directive,
)
from core.state import ExecutionState


class ExecutionBaseStep(ABC):
    """
    Abstract base class for execution protocol steps.

    Subclasses set class attributes:
        _step_num: int - The step number (1, 2, 3, etc.)
        _step_name: str - The step name (e.g., "GENERATE_TASK_ID")
        _protocol_type: ProtocolType - The protocol type

    Optionally override:
    - process_step(): For custom step processing
    - get_extra_context(): For step-specific context from previous steps
    """

    # Class-level configuration (set by subclasses)
    _step_num: int | None = None
    _step_name: str | None = None
    _protocol_type: ProtocolType | None = None

    @property
    def step_number(self) -> int:
        """The step number - from class attribute or override."""
        if self._step_num is not None:
            return self._step_num
        raise NotImplementedError(
            f"{self.__class__.__name__} must set _step_num class attribute "
            "or override step_number property"
        )

    @property
    def step_name(self) -> str:
        """The step name - from class attribute or config lookup."""
        if self._step_name is not None:
            return self._step_name
        # Try to look up from config
        if self._protocol_type and self._step_num:
            steps = PROTOCOL_STEPS.get(self._protocol_type, {})
            step_info = steps.get(self._step_num, {})
            return step_info.get("name", "UNKNOWN")
        raise NotImplementedError(
            f"{self.__class__.__name__} must set _step_name class attribute "
            "or override step_name property"
        )

    @property
    def protocol_type(self) -> ProtocolType:
        """The protocol type - from class attribute or override."""
        if self._protocol_type is not None:
            return self._protocol_type
        raise NotImplementedError(
            f"{self.__class__.__name__} must set _protocol_type class attribute "
            "or override protocol_type property"
        )

    def __init__(self, state: ExecutionState):
        """
        Initialize the step.

        Args:
            state: The execution state
        """
        self.state = state
        self._content: Optional[str] = None

    @property
    def content_path(self) -> Path:
        """Get the path to this step's markdown content."""
        return get_step_content_path(self.protocol_type, self.step_number)

    @property
    def title(self) -> str:
        """Get the human-readable step title."""
        steps = PROTOCOL_STEPS.get(self.protocol_type, {})
        step_info = steps.get(self.step_number, {})
        return step_info.get("title", f"Step {self.step_number}")

    @property
    def total_steps(self) -> int:
        """Get the total number of steps in this protocol."""
        return PROTOCOL_TOTAL_STEPS.get(self.protocol_type, 0)

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

    def format_content(self, content: str) -> str:
        """
        Format content with variable substitution.

        Override in subclasses for custom formatting.

        Args:
            content: Raw markdown content

        Returns:
            Formatted content
        """
        return content

    def print_content(self) -> None:
        """Print the step's markdown content to stdout."""
        try:
            content = self.load_content()
            formatted = self.format_content(content)
            print(formatted)
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
Process this step ({self.title}) for the execution protocol.

Apply the appropriate processing for this step and
document your results clearly.
"""

    def print_extra_context(self) -> None:
        """Print any extra context before instructions."""
        extra = self.get_extra_context()
        if extra:
            print(extra)

    def print_next_directive(self) -> None:
        """Print the directive to execute the next step."""
        next_step = self.step_number + 1

        if next_step > self.total_steps:
            # This is the final step, direct to completion
            protocol_dir = EXECUTION_PROTOCOLS_ROOT / self.state.protocol_name
            complete_script = protocol_dir / "complete.py"
            directive = format_mandatory_directive(
                f"python {complete_script} --state {self.state.state_file_path}",
                f"Step {self.step_number} of {self.total_steps} complete. Execute protocol completion. ",
                self.protocol_type
            )
            print(directive)
        else:
            # Direct to next step
            steps = PROTOCOL_STEPS.get(self.protocol_type, {})
            next_info = steps.get(next_step, {})
            next_script_name = next_info.get("script", f"step_{next_step}.py")

            steps_dir = get_protocol_steps_dir(self.protocol_type)
            next_script = steps_dir / next_script_name

            directive = format_mandatory_directive(
                f"python {next_script} --state {self.state.state_file_path}",
                f"Step {self.step_number} of {self.total_steps} complete. Execute Step {next_step}. ",
                self.protocol_type
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
    def main(cls, protocol_type: ProtocolType | None = None) -> int:
        """
        Main entry point for step scripts.

        Parses arguments, loads state, and executes the step.

        Args:
            protocol_type: The protocol type for loading state.
                          If None, uses cls._protocol_type class attribute.

        Returns:
            Exit code (0 for success, 1 for error)
        """
        # Use class attribute if protocol_type not provided
        ptype = protocol_type or cls._protocol_type
        if ptype is None:
            print("ERROR: protocol_type not provided and _protocol_type not set",
                  file=sys.stderr)
            return 1

        parser = argparse.ArgumentParser(
            description=f"Execute Step {cls._step_num}: {cls._step_name or 'execution step'}",
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
        # Format: {dir-name}-{session-id}.json (e.g., dynamic-da8c22f7-b01.json)
        # Note: dir_name comes from PROTOCOL_TO_DIR, not ptype.name
        filename = state_path.stem
        dir_name = PROTOCOL_TO_DIR[ptype]  # e.g., "dynamic" or "skill"
        protocol_prefix = f"{dir_name}-"
        if filename.startswith(protocol_prefix):
            session_id = filename[len(protocol_prefix):]
        else:
            # Fallback: split on first dash (dir_name doesn't contain dashes)
            parts = filename.split("-", 1)
            session_id = parts[-1] if len(parts) > 1 else filename

        state = ExecutionState.load(ptype, session_id)
        if not state:
            print(f"ERROR: Could not load state from {args.state}",
                  file=sys.stderr)
            return 1

        # Create and execute step
        step = cls(state)
        if not step.execute():
            return 1

        return 0


# Backward compatibility alias
BaseStep = ExecutionBaseStep
