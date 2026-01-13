"""
base.py
=======

Base class for all agent execution steps.

This provides common functionality for:
- Loading step content from markdown files
- Managing agent execution state
- Outputting directives for next steps
- Validating step completion
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between agent/config and skill/config
import sys
_STEPS_DIR = Path(__file__).resolve().parent
_AGENT_PROTOCOLS_DIR = _STEPS_DIR.parent
_PROTOCOLS_DIR = _AGENT_PROTOCOLS_DIR.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from agent.config.config import (
    AGENT_PROTOCOLS_ROOT,
    get_agent_config,
    get_agent_budget,
    get_step_content_path,
    get_step_script_path,
    format_agent_directive,
)


@dataclass
class AgentExecutionState:
    """
    State management for agent execution.

    Tracks which agent is executing, current step, and accumulated context.
    """

    agent_name: str
    task_id: str
    current_step: int = 0
    started_at: str = field(default_factory=lambda: datetime.now().isoformat())
    completed_steps: list[int] = field(default_factory=list)
    step_outputs: dict[int, dict[str, Any]] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)

    # Skill orchestration context (set when invoked from a skill)
    @property
    def skill_name(self) -> str | None:
        """Return skill name if invoked from a skill."""
        return self.metadata.get("skill_name")

    @property
    def phase_id(self) -> str | None:
        """Return phase ID if invoked from a skill."""
        return self.metadata.get("phase_id")

    @property
    def context_pattern(self) -> str:
        """Return context loading pattern."""
        return self.metadata.get("context_pattern", "IMMEDIATE_PREDECESSORS")

    @property
    def predecessors(self) -> list[str]:
        """Return list of predecessor agents for context loading."""
        return self.metadata.get("predecessors", [])

    def set_skill_context(
        self,
        skill_name: str | None = None,
        phase_id: str | None = None,
        context_pattern: str = "IMMEDIATE_PREDECESSORS",
        predecessors: list[str] | None = None,
    ) -> None:
        """Set skill orchestration context in metadata."""
        if skill_name:
            self.metadata["skill_name"] = skill_name
        if phase_id:
            self.metadata["phase_id"] = phase_id
        self.metadata["context_pattern"] = context_pattern
        self.metadata["predecessors"] = predecessors or []
        self.save()

    @property
    def state_file_path(self) -> Path:
        """Get the path to this state's JSON file."""
        state_dir = AGENT_PROTOCOLS_ROOT / "state"
        state_dir.mkdir(parents=True, exist_ok=True)
        return state_dir / f"{self.agent_name}-{self.task_id[:8]}.json"

    def save(self) -> None:
        """Save state to JSON file."""
        data = {
            "agent_name": self.agent_name,
            "task_id": self.task_id,
            "current_step": self.current_step,
            "started_at": self.started_at,
            "completed_steps": self.completed_steps,
            "step_outputs": self.step_outputs,
            "metadata": self.metadata,
        }
        self.state_file_path.write_text(json.dumps(data, indent=2))

    @classmethod
    def load(cls, state_file: Path) -> AgentExecutionState | None:
        """Load state from JSON file."""
        if not state_file.exists():
            return None
        try:
            data = json.loads(state_file.read_text())
            return cls(
                agent_name=data["agent_name"],
                task_id=data["task_id"],
                current_step=data.get("current_step", 0),
                started_at=data.get("started_at", datetime.now().isoformat()),
                completed_steps=data.get("completed_steps", []),
                step_outputs={int(k): v for k, v in data.get("step_outputs", {}).items()},
                metadata=data.get("metadata", {}),
            )
        except (json.JSONDecodeError, KeyError):
            return None

    def mark_step_complete(self, step_num: int, output: dict[str, Any] | None = None) -> None:
        """Mark a step as complete and store its output."""
        if step_num not in self.completed_steps:
            self.completed_steps.append(step_num)
        if output:
            self.step_outputs[step_num] = output
        self.current_step = step_num + 1
        self.save()


# --- Context Budget Enforcement ---

def count_tokens(text: str) -> int:
    """
    Count tokens in text.

    Uses simple heuristic of ~4 chars per token.
    For more accuracy, could integrate tiktoken if available.
    """
    try:
        import tiktoken
        encoding = tiktoken.get_encoding("cl100k_base")
        return len(encoding.encode(text))
    except ImportError:
        # Fallback: estimate ~4 chars per token
        return len(text) // 4


def enforce_context_budget(
    content: str,
    agent_name: str,
    is_input: bool = True
) -> str:
    """
    Enforce context budget for agent input/output.

    Compresses content if over budget using truncation.
    More sophisticated compression strategies can be added.
    """
    budget = get_agent_budget(agent_name)
    max_tokens = budget["max_input_tokens"] if is_input else budget["max_output_tokens"]

    current_tokens = count_tokens(content)

    if current_tokens <= max_tokens:
        return content  # Within budget

    # Need to compress - use truncation strategy
    ratio = max_tokens / current_tokens
    char_limit = int(len(content) * ratio * 0.9)  # 10% safety margin

    compressed = content[:char_limit] + "\n\n[... content truncated to fit context budget ...]"

    return compressed


class BaseAgentStep(ABC):
    """
    Abstract base class for agent execution steps.

    Each step inherits from this class and implements execute().

    Step number can be specified in two ways (class attribute preferred):
    1. Class attribute (NEW - preferred, eliminates boilerplate):
       class MyStep(BaseAgentStep):
           _step_num = 2
           def execute(self): ...

    2. Property method (LEGACY - still supported for backwards compatibility):
       class MyStep(BaseAgentStep):
           @property
           def step_num(self) -> int:
               return 2
           def execute(self): ...
    """

    # Class attribute - set by subclasses to eliminate property boilerplate
    _step_num: int | None = None

    def __init__(self, state: AgentExecutionState):
        self.state = state
        self.agent_config = get_agent_config(state.agent_name)

    @property
    def step_num(self) -> int:
        """
        Return the step number for this step.

        Checks class attribute _step_num first. If not set, subclasses must
        override this property (legacy pattern).
        """
        if self._step_num is not None:
            return self._step_num
        raise NotImplementedError(
            f"{self.__class__.__name__} must set _step_num class attribute "
            "or override step_num property"
        )

    @property
    def step_name(self) -> str:
        """Return the step name from config."""
        if self.agent_config and self.step_num < len(self.agent_config["steps"]):
            return self.agent_config["steps"][self.step_num]
        return f"step_{self.step_num}"

    @property
    def content_path(self) -> Path:
        """Get path to this step's markdown content."""
        return get_step_content_path(self.state.agent_name, self.step_num)

    def load_content(self) -> str:
        """Load the markdown content for this step, resolving #INCLUDE directives."""
        if self.content_path.exists():
            content = self.content_path.read_text()
            return self._resolve_includes(content)
        return f"# Step {self.step_num}: {self.step_name}\n\nContent file not found."

    def _resolve_includes(self, content: str) -> str:
        """
        Resolve #INCLUDE directives in content.

        Syntax: #INCLUDE:path/within/shared/
        Example: #INCLUDE:protocols/johari.md

        The path is relative to the shared/ directory.
        """
        import re

        pattern = r'^#INCLUDE:([^\n]+)$'

        def replace_include(match: re.Match) -> str:
            shared_path = match.group(1).strip()
            # Import shared content loader - navigate from steps/ to orchestration/shared/
            try:
                orchestration_root = AGENT_PROTOCOLS_ROOT.parent.parent
                sys.path.insert(0, str(orchestration_root))
                from shared import load_shared_content
                included = load_shared_content(shared_path)
                if included:
                    return included.rstrip()
            except ImportError:
                pass
            return f"[Failed to load: {shared_path}]"

        return re.sub(pattern, replace_include, content, flags=re.MULTILINE)

    def load_content_with_budget(self) -> str:
        """Load step content and enforce context budget."""
        content = self.load_content()
        return enforce_context_budget(
            content,
            self.state.agent_name,
            is_input=True
        )

    def print_content(self) -> None:
        """Print the step content to stdout (with budget enforcement)."""
        content = self.load_content_with_budget()
        print(content)

    def print_next_step_directive(self) -> None:
        """Print the directive to execute the next step."""
        next_step = self.step_num + 1
        total_steps = len(self.agent_config["steps"]) if self.agent_config else 0

        if next_step >= total_steps:
            # Last step - point to complete.py
            complete_script = AGENT_PROTOCOLS_ROOT / self.state.agent_name / "complete.py"
            print(f"\n**AGENT COMPLETION:**")
            print(f"`python3 {complete_script} --state {self.state.state_file_path}`")
        else:
            # More steps remain
            next_script = get_step_script_path(self.state.agent_name, next_step)

            # Build command - shared.py (in steps/) needs --step argument
            if next_script.name == "shared.py":
                command = f"python3 {next_script} --step {next_step} --state {self.state.state_file_path}"
            else:
                command = f"python3 {next_script} --state {self.state.state_file_path}"

            directive = format_agent_directive(
                command,
                self.state.agent_name,
                next_step,
            )
            print(f"\n{directive}")

    @abstractmethod
    def execute(self) -> dict[str, Any]:
        """
        Execute this step's work.

        Returns:
            Dictionary containing step output to store in state
        """
        pass

    def run(self) -> None:
        """
        Full execution flow for this step.

        1. Print step content
        2. Execute step logic
        3. Mark step complete
        4. Print next step directive
        """
        # Print content for Claude to process
        self.print_content()

        # Execute step (subclass implementation)
        output = self.execute()

        # Mark complete and save
        self.state.mark_step_complete(self.step_num, output)

        # Print directive for next step
        self.print_next_step_directive()

    @classmethod
    def main(cls) -> None:
        """
        Unified main entry point - eliminates boilerplate in ALL step files.

        This single implementation replaces 35+ near-identical main() functions.
        Usage in step files:
            if __name__ == "__main__":
                MyStepClass.main()
        """
        import argparse

        parser = argparse.ArgumentParser(
            description=f"Step {cls._step_num}: {cls.__name__}"
        )
        parser.add_argument("--state", required=True, help="Path to state file")
        args = parser.parse_args()

        state = AgentExecutionState.load(Path(args.state))
        if not state:
            print(f"ERROR: Could not load state from {args.state}", file=sys.stderr)
            sys.exit(1)

        cls(state).run()
