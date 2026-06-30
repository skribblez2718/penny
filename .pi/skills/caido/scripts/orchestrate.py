"""
Caido Skill - State Machine Orchestration

Creates Caido extensions (plugins, workflows) via a 6-phase workflow.
Penny reads minimal directives; agents are self-sufficient via mempalace.
"""

import argparse
import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from statemachine import State, StateMachine


# ============================================================
# Context Data Class
# ============================================================

@dataclass
class CaidoContext:
    """Per-session skill state data."""
    session_id: str = ""
    skill_name: str = "caido"
    project_root: str = ""

    # Input
    goal: str = ""
    constraints: Dict[str, Any] = field(default_factory=dict)

    # Intake extraction
    extension_name: str = ""
    extension_type: str = ""  # backend-only | frontend-only | full-stack | workflow

    # Exploration
    explore_complete: bool = False
    recommended_type: str = ""
    required_apis: List[str] = field(default_factory=list)
    explore_unknowns: int = 0

    # Design
    design_complete: bool = False
    design_files: List[str] = field(default_factory=list)
    design_has_backend: bool = False
    design_has_frontend: bool = False

    # Scaffold
    scaffold_complete: bool = False
    scaffold_files: List[str] = field(default_factory=list)

    # Implementation
    implement_complete: bool = False
    implement_files_created: List[str] = field(default_factory=list)
    implement_files_modified: List[str] = field(default_factory=list)

    # Testing
    test_complete: bool = False
    tests_total: int = 0
    tests_passed: int = 0

    # Build
    build_complete: bool = False
    build_ok: bool = False
    manifest_valid: bool = False

    # Tracking
    iteration: int = 0
    max_iterations: int = 2
    errors: List[str] = field(default_factory=list)

    # UNKNOWN_STATE
    last_confidence: str = ""
    clarification_text: str = ""
    previous_state: str = ""
    unknown_reason: str = ""


# ============================================================
# State Machine
# ============================================================

class CaidoWorkflow(StateMachine):
    """6-phase workflow for Caido extension creation."""

    # States
    intake = State("Intake", initial=True)
    exploring = State("Exploring")
    designing = State("Designing")
    scaffolding = State("Scaffolding")
    implementing = State("Implementing")
    testing = State("Testing")
    building = State("Building")
    complete = State("Complete", final=True)
    error = State("Error", final=True)
    unknown = State("Unknown")
    awaiting_clarification = State("Awaiting Clarification")

    # Transitions
    start = intake.to(exploring, cond="has_goal")
    explore_done = exploring.to(designing, cond="explore_complete")
    design_done = designing.to(scaffolding, cond="design_complete")
    scaffold_done = scaffolding.to(implementing, cond="scaffold_complete")
    implement_done = implementing.to(testing, cond="implement_complete")
    test_done = testing.to(building, cond="test_complete")
    build_done = building.to(complete, cond="build_complete")

    # Error paths
    fail_explore = exploring.to(error)
    fail_design = designing.to(error)
    fail_scaffold = scaffolding.to(error)
    fail_implement = implementing.to(error)
    fail_test = testing.to(error)
    fail_build = building.to(error)

    # UNKNOWN_STATE
    explore_unknown = exploring.to(unknown)
    design_unknown = designing.to(unknown)
    escalate = unknown.to(awaiting_clarification)
    abandon = awaiting_clarification.to(error)
    resume = awaiting_clarification.to(exploring, cond="has_clarification")

    # Guards
    def has_goal(self) -> bool:
        return bool(self.model.goal)

    def has_clarification(self) -> bool:
        return bool(self.model.clarification_text)


# ============================================================
# Orchestrator
# ============================================================

class Orchestrator:
    """Routes state to JSON actions for Penny."""

    def __init__(self, context: CaidoContext):
        self.context = context
        self.workflow = CaidoWorkflow(model=context)

    @property
    def session_room(self) -> str:
        return f"skills/caido-{self.context.session_id}"

    @property
    def state_id(self) -> str:
        return list(self.workflow.configuration)[0].id

    def extract_state(self) -> Dict[str, Any]:
        return {
            "session_id": self.context.session_id,
            "skill_name": self.context.skill_name,
            "goal": self.context.goal,
            "extension_name": self.context.extension_name,
            "extension_type": self.context.extension_type,
            "explore_complete": self.context.explore_complete,
            "design_complete": self.context.design_complete,
            "scaffold_complete": self.context.scaffold_complete,
            "implement_complete": self.context.implement_complete,
            "test_complete": self.context.test_complete,
            "build_complete": self.context.build_complete,
            "tests_total": self.context.tests_total,
            "tests_passed": self.context.tests_passed,
            "build_ok": self.context.build_ok,
            "errors": self.context.errors,
            "current_state": self.state_id,
        }

    def _agent_for_state(self, state: str) -> str:
        mapping = {
            "intake": "echo",
            "exploring": "echo",
            "designing": "piper",
            "scaffolding": "skribble",
            "implementing": "skribble",
            "testing": "skribble",
            "building": "skribble",
        }
        return mapping.get(state, "echo")

    def _prompt_for_state(self, state: str) -> str:
        mapping = {
            "intake": "explore.md",
            "exploring": "explore.md",
            "designing": "design.md",
            "scaffolding": "scaffold.md",
            "implementing": "implement.md",
            "testing": "test.md",
            "building": "build.md",
        }
        return mapping.get(state, "explore.md")

    def _action(self, action: str, **kwargs) -> Dict[str, Any]:
        return {
            "action": action,
            "state_id": self.state_id,
            "session_id": self.context.session_id,
            "session_room": self.session_room,
            "skills_used": ["caido"],
            **kwargs,
            "orchestrator_state": self.extract_state(),
        }

    # --------------------------------------------------------
    # State Handlers
    # --------------------------------------------------------

    def handle_intake(self) -> Dict[str, Any]:
        """Parse the goal and determine extension type."""
        goal = self.context.goal.lower()

        if "workflow" in goal:
            self.context.extension_type = "workflow"
        elif "frontend" in goal and "backend" in goal:
            self.context.extension_type = "full-stack"
        elif "frontend" in goal or "page" in goal or "ui" in goal:
            self.context.extension_type = "frontend-only"
        else:
            self.context.extension_type = "backend-only"

        # Derive extension name from goal
        name = self.context.goal.split(" ")[0].strip().lower()
        name = "".join(c if c.isalnum() else "-" for c in name).strip("-")
        self.context.extension_name = name or "caido-extension"

        # Transition state
        self.workflow.start()

        return self._action(
            "explore",
            agent="echo",
            prompt="explore.md",
            task=f"Research Caido SDK for: {self.context.goal}",
            extension_type=self.context.extension_type,
            extension_name=self.context.extension_name,
        )

    def handle_exploring(self) -> Dict[str, Any]:
        return self._action(
            "explore",
            agent="echo",
            prompt="explore.md",
            task=f"Research Caido APIs needed for: {self.context.goal}",
            extension_type=self.context.extension_type,
        )

    def handle_designing(self) -> Dict[str, Any]:
        return self._action(
            "design",
            agent="piper",
            prompt="design.md",
            task=f"Design architecture for {self.context.extension_type}: {self.context.goal}",
            extension_type=self.context.extension_type,
            extension_name=self.context.extension_name,
        )

    def handle_scaffolding(self) -> Dict[str, Any]:
        project_path = f"~/projects/caido-plugins/{self.context.extension_name}"
        return self._action(
            "scaffold",
            agent="skribble",
            prompt="scaffold.md",
            task=f"Scaffold Caido {self.context.extension_type} at {project_path}. Goal: {self.context.goal}",
            cwd=project_path,
        )

    def handle_implementing(self) -> Dict[str, Any]:
        project_path = f"~/projects/caido-plugins/{self.context.extension_name}"
        return self._action(
            "implement",
            agent="skribble",
            prompt="implement.md",
            task=f"Implement {self.context.extension_type} at {project_path}. Follow ALL hard constraints. Goal: {self.context.goal}",
            cwd=project_path,
        )

    def handle_testing(self) -> Dict[str, Any]:
        project_path = f"~/projects/caido-plugins/{self.context.extension_name}"
        return self._action(
            "test",
            agent="skribble",
            prompt="test.md",
            task=f"Write and run tests for {project_path}. Use Caido mock patterns. Run lint, typecheck, and vitest — all must pass.",
            cwd=project_path,
        )

    def handle_building(self) -> Dict[str, Any]:
        project_path = f"~/projects/caido-plugins/{self.context.extension_name}"
        return self._action(
            "build",
            agent="skribble",
            prompt="build.md",
            task=f"Build {project_path} with caido-dev. Verify ZIP structure, present install instructions. Include onUpstream config steps if applicable.",
            cwd=project_path,
        )

    def handle_complete(self) -> Dict[str, Any]:
        return self._action(
            "complete",
            message=f"Caido {self.context.extension_type} '{self.context.extension_name}' created successfully.",
            extension_name=self.context.extension_name,
            extension_type=self.context.extension_type,
        )

    def handle_error(self) -> Dict[str, Any]:
        return self._action(
            "error",
            errors=self.context.errors,
            message="Skill failed. See errors for details.",
        )

    def handle_unknown(self) -> Dict[str, Any]:
        return self._action(
            "unknown",
            reason=self.context.unknown_reason,
            message="Agent reported UNCERTAIN. Escalating for clarification.",
        )

    # --------------------------------------------------------
    # Main dispatch
    # --------------------------------------------------------

    def next(self, summary: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Advance state machine and return next action."""

        # Apply summary to context if provided
        if summary:
            self._apply_summary(summary)

        state = self.state_id
        handlers = {
            "intake": self.handle_intake,
            "exploring": self.handle_exploring,
            "designing": self.handle_designing,
            "scaffolding": self.handle_scaffolding,
            "implementing": self.handle_implementing,
            "testing": self.handle_testing,
            "building": self.handle_building,
            "complete": self.handle_complete,
            "error": self.handle_error,
            "unknown": self.handle_unknown,
        }

        handler = handlers.get(state)
        if not handler:
            return self._action("error", errors=[f"Unknown state: {state}"])

        return handler()

    def _apply_summary(self, summary: Dict[str, Any]) -> None:
        """Update context from agent summary."""
        state = self.state_id

        if state == "exploring":
            self.context.explore_complete = summary.get("explore_complete", False)
            self.context.recommended_type = summary.get("extension_type", "")
            self.context.required_apis = summary.get("apis", [])
            self.context.explore_unknowns = summary.get("unknowns_count", 0)

        elif state == "designing":
            self.context.design_complete = summary.get("design_complete", False)
            self.context.design_files = summary.get("files", [])

        elif state == "scaffolding":
            self.context.scaffold_complete = summary.get("scaffold_complete", False)
            self.context.scaffold_files = summary.get("files_created", [])

        elif state == "implementing":
            self.context.implement_complete = summary.get("implement_complete", False)

        elif state == "testing":
            self.context.test_complete = summary.get("test_complete", False)
            self.context.tests_total = summary.get("tests_total", 0)
            self.context.tests_passed = summary.get("tests_passed", 0)

        elif state == "building":
            self.context.build_complete = summary.get("build_complete", False)
            self.context.build_ok = summary.get("build", "") == "ok"
            self.context.manifest_valid = summary.get("manifest_valid", False)

        # Apply confidence check
        conf = summary.get("confidence", "").upper()
        self.context.last_confidence = conf


# ============================================================
# CLI Entry Point
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="Caido Skill Orchestrator")
    parser.add_argument("--session-id", required=True, help="Skill session ID")
    parser.add_argument("--goal", required=True, help="Extension goal description")
    parser.add_argument("--project-root", default=".", help="Project root directory")
    parser.add_argument("--state", help="Resume from state (JSON file)")
    parser.add_argument("--summary", help="Agent summary JSON from previous phase")
    args = parser.parse_args()

    # Load or create context
    if args.state:
        with open(args.state) as f:
            state_dict = json.load(f)
        context = CaidoContext(**state_dict)
    else:
        context = CaidoContext(
            session_id=args.session_id,
            goal=args.goal,
            project_root=args.project_root,
        )

    # Parse summary if provided
    summary = None
    if args.summary:
        summary = json.loads(args.summary)

    orchestrator = Orchestrator(context)
    result = orchestrator.next(summary)

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
