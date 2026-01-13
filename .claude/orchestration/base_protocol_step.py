"""
Unified abstract base class for ALL protocol steps.

This is the SINGLE SOURCE OF TRUTH for step base class functionality.
All three protocol types (agent, execution, reasoning) inherit from this.

Eliminates redundant code:
- 23+ step_number/step_name property definitions
- 65+ identical main() boilerplate functions
- 175+ sys.path.insert() variations

Usage:
    class MyStep(AbstractProtocolStep):
        _step_num = 2
        _step_name = "MY_STEP"  # Optional - can be derived from filename

        def execute(self) -> dict[str, Any]:
            return {"action": "completed"}

    if __name__ == "__main__":
        MyStep.main()
"""
from __future__ import annotations

import argparse
import inspect
import sys
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, ClassVar, Callable


class AbstractProtocolStep(ABC):
    """
    Unified base class for all protocol steps.

    Subclasses set class attributes:
        _step_num: int  - Step number (0, 1, 2, etc.)
        _step_name: str - Step name (e.g., "LEARNING_INJECTION")

    Step name can be:
    1. Explicitly set via _step_name class attribute
    2. Derived from filename (step_0_learning_injection.py -> "LEARNING_INJECTION")
    3. Looked up from config (protocol-specific base classes override)
    """

    # Class-level configuration (set by subclasses)
    _step_num: ClassVar[int | None] = None
    _step_name: ClassVar[str | None] = None

    def __init__(self, state: Any):
        """
        Initialize step with state object.

        Args:
            state: Protocol-specific state object (ProtocolState, ExecutionState,
                   or AgentExecutionState depending on protocol type)
        """
        self.state = state
        self._content: str | None = None

    @property
    def step_num(self) -> int:
        """
        Return step number.

        Priority:
        1. Class attribute _step_num if set
        2. Derived from filename (step_N_name.py -> N)
        """
        if self._step_num is not None:
            return self._step_num
        return self._derive_step_num_from_class()

    @property
    def step_name(self) -> str:
        """
        Return step name.

        Priority:
        1. Class attribute _step_name if set
        2. Derived from filename (step_N_name.py -> "NAME")
        3. Protocol-specific lookup (override in subclasses)
        """
        if self._step_name is not None:
            return self._step_name
        return self._derive_step_name_from_class()

    @classmethod
    def _derive_step_num_from_class(cls) -> int:
        """
        Derive step number from the class's source file.

        Pattern: step_N_name.py -> N
        """
        try:
            source_file = inspect.getfile(cls)
            filename = Path(source_file).stem
            if filename.startswith("step_"):
                parts = filename.split("_")
                if len(parts) >= 2 and parts[1].isdigit():
                    return int(parts[1])
        except (TypeError, IndexError, ValueError):
            pass
        return 0

    @classmethod
    def _derive_step_name_from_class(cls) -> str:
        """
        Derive step name from the class's source file.

        Pattern: step_N_name.py -> "NAME" (uppercase)
        """
        try:
            source_file = inspect.getfile(cls)
            filename = Path(source_file).stem
            if filename.startswith("step_"):
                parts = filename.split("_", 2)
                if len(parts) >= 3:
                    return parts[2].upper()
        except (TypeError, IndexError):
            pass
        return "UNKNOWN"

    @abstractmethod
    def execute(self) -> dict[str, Any]:
        """
        Execute step logic. Must be implemented by subclasses.

        Returns:
            dict containing step output data
        """
        pass

    def run(self) -> None:
        """
        Full execution flow for a step.

        This is the main orchestration method called by main().
        Subclasses typically don't override this - they override
        the individual methods it calls.
        """
        self.print_content()
        output = self.execute()
        self._mark_complete(output)
        self.print_next_directive()

    def print_content(self) -> None:
        """
        Print step content/instructions.

        Override in protocol-specific base classes to load and print
        markdown content from the content/ directory.
        """
        pass

    def print_next_directive(self) -> None:
        """
        Print the directive for the next step.

        Override in protocol-specific base classes to print the
        mandatory command for Claude to execute next.
        """
        pass

    def _mark_complete(self, output: dict[str, Any]) -> None:
        """
        Mark step as complete and save state.

        Override in protocol-specific base classes to call the
        appropriate state completion method.
        """
        pass

    @classmethod
    def main(cls, state_loader: Callable[[Path], Any] | None = None) -> int:
        """
        Unified main entry point - eliminates boilerplate in ALL step files.

        This single implementation replaces 65+ near-identical main() functions.

        Args:
            state_loader: Optional function to load state from path.
                         If None, uses _load_state_default().

        Returns:
            Exit code (0 for success, 1 for failure)
        """
        parser = argparse.ArgumentParser(
            description=f"Step {cls._step_num}: {cls._step_name or cls._derive_step_name_from_class()}"
        )
        parser.add_argument("--state", required=True, help="Path to state file")
        args = parser.parse_args()

        state_path = Path(args.state)

        # Load state using provided loader or default
        if state_loader:
            state = state_loader(state_path)
        else:
            state = cls._load_state_default(state_path)

        if not state:
            print(f"ERROR: Could not load state from {args.state}", file=sys.stderr)
            return 1

        try:
            cls(state).run()
            return 0
        except Exception as e:
            print(f"ERROR: Step execution failed: {e}", file=sys.stderr)
            return 1

    @classmethod
    def _load_state_default(cls, state_path: Path) -> Any:
        """
        Default state loader.

        Override in protocol-specific base classes to provide the
        appropriate state loading logic.

        Args:
            state_path: Path to the state file

        Returns:
            Loaded state object, or None if loading fails
        """
        return None


# Compatibility aliases for different naming conventions across protocols
# This allows gradual migration without breaking existing code
AbstractBaseStep = AbstractProtocolStep
