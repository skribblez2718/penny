"""
Agent Skill - State Machine Orchestration

Generates Penny agent definitions (.pi/agents/<name>.md) via a structured workflow.
Penny reads minimal directives; agents are self-sufficient via mempalace.

Key principle: Penny is a ROUTER, not a READER.
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
class AgentContext:
    """Per-session skill state data — only metadata, no raw output."""
    session_id: str = ""
    skill_name: str = "agent"
    project_root: str = ""

    # Input
    goal: str = ""
    constraints: Dict[str, Any] = field(default_factory=dict)

    # Intake extraction
    agent_name: str = ""
    agent_type: str = "generic"
    create_skill_scaffold: bool = False

    # Sub-skill contract
    parent_session_id: str = ""
    subskill_mode: bool = False

    # Exploration
    explore_findings_count: int = 0
    explore_files_count: int = 0
    explore_unknowns_count: int = 0
    explore_complete: bool = False

    # Design
    design_steps: List[Dict[str, Any]] = field(default_factory=list)
    design_complete: bool = False

    # Critique
    critique_verdict: str = ""
    critique_issues: List[str] = field(default_factory=list)

    # Scaffold
    files_created: List[str] = field(default_factory=list)
    files_modified: List[str] = field(default_factory=list)
    generation_complete: bool = False
    agent_definition: str = ""
    agent_file_path: str = ""

    # Verification
    verification_yaml_valid: bool = False
    verification_schema_valid: bool = False
    verification_diff_applied: bool = False
    verification_complete: bool = False

    # Tracking
    iteration: int = 0
    max_iterations: int = 3
    exploration_iterations: int = 0
    max_exploration_iterations: int = 2
    errors: List[str] = field(default_factory=list)

    # UNKNOWN_STATE support
    last_confidence: str = ""
    clarification_text: str = ""
    previous_state: str = ""
    unknown_reason: str = ""

    # Output
    complete: bool = False


# ============================================================
# State Machine
# ============================================================

class AgentWorkflow(StateMachine):
    """Agent Workflow State Machine."""

    intake = State(initial=True)
    exploring = State()
    designing = State()
    critiquing = State()
    revising = State()
    scaffolding = State()
    verifying = State()
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    # Happy path
    start = intake.to(exploring, cond="has_goal")
    explore_done = exploring.to(designing, cond="explore_complete")
    design_done = designing.to(critiquing, cond="_has_design_steps")
    critique_pass = critiquing.to(scaffolding, cond="critique_approved")
    critique_fail = critiquing.to(revising, cond="has_issues")
    scaffold_done = scaffolding.to(verifying, cond="generation_complete")
    verify_pass = verifying.to(complete, cond="_verification_passes")
    verify_fail = verifying.to(scaffolding, cond="_verification_fails")

    # Revision loops
    revise_explore = revising.to(exploring, cond="needs_more_context")
    revise_design = revising.to(designing, cond="can_fix_design")

    # Error paths
    fail_intake = intake.to(error)
    fail_explore = exploring.to(error)
    fail_design = designing.to(error)
    fail_critique = critiquing.to(error)
    fail_scaffold = scaffolding.to(error)
    fail_verify = verifying.to(error)

    # UNKNOWN_STATE protocol
    explore_unknown = exploring.to(unknown, cond="confidence_is_uncertain")
    design_unknown = designing.to(unknown, cond="confidence_is_uncertain")
    critique_unknown = critiquing.to(unknown, cond="confidence_is_uncertain")
    scaffold_unknown = scaffolding.to(unknown, cond="confidence_is_uncertain")

    # Escalation from unknown
    escalate = unknown.to(awaiting_clarification)
    abandon = unknown.to(error)
    abandon_clarification = awaiting_clarification.to(error)

    # Resume after user clarification
    resume_explore = awaiting_clarification.to(exploring, cond="has_clarification")
    resume_design = awaiting_clarification.to(designing, cond="has_clarification")
    resume_critique = awaiting_clarification.to(critiquing, cond="has_clarification")
    resume_scaffold = awaiting_clarification.to(scaffolding, cond="has_clarification")

    # Guards
    def has_goal(self) -> bool:
        return bool(self.model.goal)

    def explore_complete(self) -> bool:
        return self.model.explore_complete

    def design_complete(self) -> bool:
        """Check if design is complete (derives from design_steps, not the model field)."""
        return len(self.model.design_steps) > 0

    def _has_design_steps(self) -> bool:
        """Guard: True when design_steps has items.

        Named differently from design_complete() because python-statemachine v3
        ANDs model fields and SM methods with the same name. The model has a
        design_complete boolean field; this guard derives from design_steps
        and must use a non-conflicting name.
        """
        return self.design_complete()

    def critique_approved(self) -> bool:
        return self.model.critique_verdict == "APPROVE"

    def has_issues(self) -> bool:
        return (
            self.model.critique_verdict != "APPROVE"
            and len(self.model.critique_issues) > 0
        )

    def generation_complete(self) -> bool:
        return self.model.generation_complete

    def verification_complete(self) -> bool:
        """Check if all verification checks passed (derives from 3 booleans)."""
        return (
            self.model.verification_yaml_valid
            and self.model.verification_schema_valid
            and self.model.verification_diff_applied
        )

    def _verification_passes(self) -> bool:
        """Guard: True when all verification checks passed.

        Named differently from verification_complete() because
        python-statemachine v3 ANDs model fields and SM methods
        with the same name. The model has a verification_complete
        boolean field; this guard derives from 3 booleans and must
        use a non-conflicting name.
        """
        return self.verification_complete()

    def _verification_fails(self) -> bool:
        """Guard: True when verification has not passed."""
        return not self.verification_complete()

    def needs_more_context(self) -> bool:
        return self.model.exploration_iterations < self.model.max_exploration_iterations

    def can_fix_design(self) -> bool:
        return not self.needs_more_context()

    def confidence_is_uncertain(self) -> bool:
        return self.model.last_confidence == "UNCERTAIN"

    def has_clarification(self) -> bool:
        return bool(self.model.clarification_text)


# ============================================================
# Orchestrator
# ============================================================

class Orchestrator:
    """Routes state to JSON actions for Penny."""

    def __init__(self, context: AgentContext):
        self.context = context
        self.workflow = AgentWorkflow(model=context)
        self._force_state_transitions = {}
        self._build_transitions_map()
        self._check_statemachine_version()

    def _check_statemachine_version(self) -> None:
        import statemachine  # noqa: F811
        version = getattr(statemachine, "__version__", "unknown")
        self.context.errors.append(f"python-statemachine version: {version}")

    def _build_transitions_map(self) -> None:
        self._force_state_transitions = {
            "intake": ("start",),
            "exploring": ("explore_done", "explore_unknown", "fail_explore"),
            "designing": ("design_done", "design_unknown", "fail_design"),
            "critiquing": ("critique_pass", "critique_fail", "critique_unknown", "fail_critique"),
            "revising": ("revise_explore", "revise_design"),
            "scaffolding": ("scaffold_done", "scaffold_unknown", "fail_scaffold"),
            "verifying": ("verify_pass", "verify_fail", "fail_verify"),
            "complete": (),
            "error": (),
            "unknown": ("escalate", "abandon"),
            "awaiting_clarification": ("abandon_clarification",),
        }

    @property
    def session_room(self) -> str:
        return f"skills/agent-{self.context.session_id}"

    def extract_state(self) -> Dict[str, Any]:
        return {
            "session_id": self.context.session_id,
            "skill_name": self.context.skill_name,
            "project_root": self.context.project_root,
            "goal": self.context.goal,
            "constraints": self.context.constraints,
            "agent_name": self.context.agent_name,
            "agent_type": self.context.agent_type,
            "create_skill_scaffold": self.context.create_skill_scaffold,
            "parent_session_id": self.context.parent_session_id,
            "subskill_mode": self.context.subskill_mode,
            "explore_findings_count": self.context.explore_findings_count,
            "explore_files_count": self.context.explore_files_count,
            "explore_unknowns_count": self.context.explore_unknowns_count,
            "explore_complete": self.context.explore_complete,
            "design_steps": self.context.design_steps,
            "design_complete": self.context.design_complete,
            "critique_verdict": self.context.critique_verdict,
            "critique_issues": self.context.critique_issues,
            "files_created": self.context.files_created,
            "files_modified": self.context.files_modified,
            "generation_complete": self.context.generation_complete,
            "agent_definition": self.context.agent_definition,
            "agent_file_path": self.context.agent_file_path,
            "verification_yaml_valid": self.context.verification_yaml_valid,
            "verification_schema_valid": self.context.verification_schema_valid,
            "verification_diff_applied": self.context.verification_diff_applied,
            "verification_complete": self.context.verification_complete,
            "iteration": self.context.iteration,
            "exploration_iterations": self.context.exploration_iterations,
            "errors": self.context.errors,
            "last_confidence": self.context.last_confidence,
            "clarification_text": self.context.clarification_text,
            "previous_state": self.context.previous_state,
            "unknown_reason": self.context.unknown_reason,
            "complete": self.context.complete,
            "current_state": self._state_id(),
        }

    def _state_id(self) -> str:
        """Return current workflow state id without deprecation warning."""
        return list(self.workflow.configuration)[0].id

    def _is_in_state(self, state) -> bool:
        """Check if workflow is in given state without deprecation warning."""
        return state in self.workflow.configuration

    def restore_state(self, state_dict: Dict[str, Any]) -> None:
        for k, v in state_dict.items():
            if hasattr(self.context, k):
                setattr(self.context, k, v)

    def _force_state(self, state_id: str) -> None:
        """Restore workflow to a specific state id."""
        try:
            self.workflow.current_state_value = state_id
        except KeyError:
            # If state is not found in state_map, leave as-is (shouldn't happen)
            pass

    def _action(self, action: str, **kwargs) -> Dict[str, Any]:
        state_id = self._state_id()
        return {
            "action": action,
            "state_id": state_id,
            "session_id": self.context.session_id,
            "session_room": self.session_room,
            "skills_used": ["agent"],
            **kwargs,
            "orchestrator_state": self.extract_state(),
        }

    def _agent_for_state(self, state: str) -> str:
        mapping = {
            "intake": "echo",
            "exploring": "echo",
            "designing": "piper",
            "critiquing": "carren",
            "scaffolding": "skribble",
            "verifying": "vera",
        }
        return mapping.get(state, "echo")

    def _safe_default_summary(self, agent: str) -> Dict[str, Any]:
        defaults = {
            "echo": {
                "explore_complete": False,
                "findings_count": 0,
                "files_count": 0,
                "unknowns_count": 0,
                "verification_complete": False,
                "yaml_valid": False,
                "schema_valid": False,
                "diff_applied": False,
            },
            "piper": {"design_complete": False, "design_steps": []},
            "carren": {"verdict": "NEEDS_REVISION", "issues": ["Agent did not emit SUMMARY or summary was empty."]},
            "skribble": {"generation_complete": False, "files_created": [], "files_modified": []},
            "vera": {
                "yaml_valid": False,
                "schema_valid": False,
                "diff_applied": False,
                "verification_complete": False,
            },
        }
        return defaults.get(agent, {"complete": False})

    def _validate_summary(self, agent: str, summary: Dict[str, Any]) -> Tuple[bool, str]:
        if not summary:
            return False, "Summary is empty or None"

        # Echo agent can be used in explore OR verify phase
        if agent == "echo":
            if "explore_complete" not in summary:
                return False, "Missing required fields for echo: expected 'explore_complete'"
            return True, ""

        if agent == "vera":
            if not any(k in summary for k in ("verification_complete", "yaml_valid", "schema_valid", "diff_applied")):
                return False, "Missing required fields for vera: expected 'verification_complete', 'yaml_valid', 'schema_valid', or 'diff_applied'"
            return True, ""

        required = {
            "piper": {"design_complete", "design_steps"},
            "carren": {"verdict", "issues"},
            "skribble": {"generation_complete", "files_created"},
        }
        fields = required.get(agent, set())
        missing = fields - set(summary.keys())
        if missing:
            return False, f"Missing required fields for {agent}: {missing}"
        return True, ""

    def _extract_and_validate_summary(self, result: Dict[str, Any], agent: str) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        summary = result.get("summary", {})
        valid, error_msg = self._validate_summary(agent, summary)
        if not valid:
            safe = self._safe_default_summary(agent)
            safe["_reason"] = error_msg
            return None, self._action(
                "error",
                agent=agent,
                errors=[f"Invalid summary from {agent}: {error_msg}"],
            )
        return summary, None

    def _check_confidence(self, summary: Dict[str, Any]) -> bool:
        conf = summary.get("confidence", "").upper()
        self.context.last_confidence = conf
        return conf == "UNCERTAIN"

    def _check_confidence_and_handle(self, summary: Optional[Dict[str, Any]]) -> bool:
        if summary and self._check_confidence(summary):
            self.context.unknown_reason = summary.get("unknown_reason", "Agent reported UNCERTAIN confidence")
            self.context.previous_state = self._state_id()
            if self._is_in_state(self.workflow.exploring):
                self.workflow.explore_unknown()
            elif self._is_in_state(self.workflow.designing):
                self.workflow.design_unknown()
            elif self._is_in_state(self.workflow.critiquing):
                self.workflow.critique_unknown()
            elif self._is_in_state(self.workflow.scaffolding):
                self.workflow.scaffold_unknown()
            self.workflow.escalate()
            return True
        return False

    # --------------------------------------------------------
    # Action generators
    # --------------------------------------------------------

    def _action_intake(self) -> Dict[str, Any]:
        if not self.context.goal:
            return self._action("error", errors=["No goal provided"])

        # Extract agent_name from goal or constraints
        goal_words = self.context.goal.split()
        self.context.agent_name = (
            self.context.constraints.get("agent_name")
            or (goal_words[0] if goal_words else "new-agent")
        )
        # Enforce create_skill_scaffold=false
        self.context.create_skill_scaffold = self.context.constraints.get("create_skill_scaffold", False)
        if self.context.create_skill_scaffold:
            self.context.errors.append("create_skill_scaffold is always false for agent skill; ignoring constraint")
            self.context.create_skill_scaffold = False

        # Sub-skill contract
        if self.context.constraints.get("parent_session_id"):
            self.context.parent_session_id = self.context.constraints["parent_session_id"]
            self.context.subskill_mode = True

        return self._action_explore()

    def _action_explore(self) -> Dict[str, Any]:
        if self._should_parallelize() and self.context.exploration_iterations == 0:
            aspects = [
                {"focus": "existing agent patterns and conventions"},
                {"focus": "agent definition schema and standard docs"},
                {"focus": "constraint analysis and requirements"},
            ]
            return self._action(
                "invoke_agents_parallel",
                tasks=[
                    {
                        "agent": "echo",
                        "task_summary": (
                            f"Session: {self.context.session_id}. "
                            f"Agent name: {self.context.agent_name}. "
                            f"Goal: {self.context.goal}. "
                            f"Focus: {a['focus']}. "
                            f"Mempalace room: {self.session_room}. "
                            f"Write findings to mempalace wing=penny room={self.session_room} "
                            f"with header: {self.context.session_id} Explore — {a['focus']}. "
                            f"Check room {self.session_room} for prior results first."
                        ),
                    }
                    for a in aspects
                ],
            )
        else:
            task = (
                f"Session: {self.context.session_id}. "
                f"Agent name: {self.context.agent_name}. "
                f"Goal: {self.context.goal}. "
                f"Mempalace room: {self.session_room}. "
                f"Write findings to mempalace wing=penny room={self.session_room} "
                f"with header: {self.context.session_id} Explore."
            )
            if self.context.iteration > 0 and self.context.critique_issues:
                issues_str = "; ".join(self.context.critique_issues)
                task += (
                    f" This is additional exploration (cycle {self.context.iteration}) "
                    f"requested by critique issues: {issues_str}."
                )
            return self._action("invoke_agent", agent="echo", task_summary=task)

    def _action_design(self) -> Dict[str, Any]:
        aspects = [
            {"focus": "purpose and role specification"},
            {"focus": "tools and model specification"},
            {"focus": "rules and output format specification"},
        ]
        return self._action(
            "invoke_agents_parallel",
            tasks=[
                {
                    "agent": "piper",
                    "task_summary": (
                        f"Session: {self.context.session_id}. "
                        f"Agent name: {self.context.agent_name}. "
                        f"Goal: {self.context.goal}. "
                        f"Focus: {a['focus']}. "
                        f"Mempalace room: {self.session_room}. "
                        f"Read prior explore findings from room {self.session_room}. "
                        f"Design the agent definition. Write design spec to mempalace "
                        f"with header: {self.context.session_id} Design — {a['focus']}."
                    ),
                }
                for a in aspects
            ],
        )

    def _action_critique(self) -> Dict[str, Any]:
        aspects = [
            {"focus": "schema validation against agent standard"},
            {"focus": "security and boundary check"},
            {"focus": "completeness and consistency check"},
        ]
        return self._action(
            "invoke_agents_parallel",
            tasks=[
                {
                    "agent": "carren",
                    "task_summary": (
                        f"Session: {self.context.session_id}. "
                        f"Agent name: {self.context.agent_name}. "
                        f"Goal: {self.context.goal}. "
                        f"Focus: {a['focus']}. "
                        f"Mempalace room: {self.session_room}. "
                        f"Read design spec from room {self.session_room}. "
                        f"Write critique to mempalace with header: "
                        f"{self.context.session_id} Critique — {a['focus']}."
                    ),
                }
                for a in aspects
            ],
        )

    def _action_scaffold(self) -> Dict[str, Any]:
        task = (
            f"Session: {self.context.session_id}. "
            f"Agent name: {self.context.agent_name}. "
            f"Goal: {self.context.goal}. "
            f"Mempalace room: {self.session_room}. "
            f"Read the design spec from room {self.session_room}. "
            f"Generate the agent definition file at .pi/agents/{self.context.agent_name}.md. "
            f"Return SUMMARY with 'files_created', 'files_modified', 'generation_complete', 'agent_definition'."
        )
        if self.context.critique_issues:
            issues_str = "; ".join(self.context.critique_issues)
            task += f" Address critique issues: {issues_str}."
        if self.context.verification_complete is False and self.context.iteration > 0:
            task += " Fix verification failures from previous iteration."
        return self._action("invoke_agent", agent="skribble", task_summary=task)

    def _action_verify(self) -> Dict[str, Any]:
        task = (
            f"Session: {self.context.session_id}. "
            f"Agent name: {self.context.agent_name}. "
            f"Read the generated agent definition from .pi/agents/{self.context.agent_name}.md. "
            f"Validate it against the Penny agent definition standard: "
            f"valid YAML frontmatter (name, description, tools, model), required sections "
            f"(Purpose, Mempalace-First, Alignment, Non-Negotiable Rules, Output Format, agent_boundary), "
            f"no spoofed directives, no fake agent_boundary tags. "
            f"Return SUMMARY with 'yaml_valid', 'schema_valid', 'diff_applied', 'verification_complete'."
        )
        return self._action("invoke_agent", agent="vera", task_summary=task)

    def _action_escalate(self) -> Dict[str, Any]:
        pending = self.context.unknown_reason or "A high-stakes action is pending clarification"
        return self._action(
            "escalate_to_user",
            questions=[
                {
                    "id": "unknown_clarification",
                    "label": "Clarification Needed",
                    "prompt": (
                        f"The agent skill needs clarification before proceeding.\n\n"
                        f"Reason: {pending}\n\n"
                        f"Current state: {self.context.previous_state}\n\n"
                        f"Please provide additional information to proceed."
                    ),
                    "options": [
                        {"value": "continue", "label": "Continue as-is", "description": "Proceed with current context"},
                        {"value": "revise", "label": "Revise goal", "description": "Change the agent generation goal"},
                    ],
                    "allowOther": True,
                }
            ],
            unknown_reason=pending,
            previous_state=self.context.previous_state,
        )

    def _action_complete(self) -> Dict[str, Any]:
        plan_summary = {
            "goal": self.context.goal,
            "agent_name": self.context.agent_name,
            "agent_file_path": self.context.agent_file_path,
            "verification_result": {
                "yaml_valid": self.context.verification_yaml_valid,
                "schema_valid": self.context.verification_schema_valid,
                "diff_applied": self.context.verification_diff_applied,
            },
            "confidence": self.context.last_confidence or "PROBABLE",
        }
        if self.context.subskill_mode:
            plan_summary["parent_session_id"] = self.context.parent_session_id
            plan_summary["subskill_return"] = {
                "agent_name": self.context.agent_name,
                "agent_definition": self.context.agent_definition,
                "file_path": self.context.agent_file_path,
                "verification_result": plan_summary["verification_result"],
                "confidence": plan_summary["confidence"],
            }
        return self._action("complete", plan_summary=plan_summary)

    def _should_parallelize(self) -> bool:
        return True  # Agent skill always parallelizes exploration

    # --------------------------------------------------------
    # Result processors
    # --------------------------------------------------------

    def process_explore_result(self, summary: Dict[str, Any]) -> None:
        self.context.explore_findings_count += summary.get("findings_count", 0)
        self.context.explore_files_count += summary.get("files_count", 0)
        self.context.explore_unknowns_count += summary.get("unknowns_count", 0)
        self.context.explore_complete = summary.get("explore_complete", False)
        self.context.exploration_iterations += 1

    def process_design_result(self, summary: Dict[str, Any]) -> None:
        # Accept design_steps (canonical) or plan_steps (fallback alias) —
        # see research/skills-agent-output-mismatch-audit.md
        steps = summary.get("design_steps") or summary.get("plan_steps", [])
        if steps:
            self.context.design_steps.extend(steps)
        self.context.design_complete = summary.get("design_complete", summary.get("plan_complete", False))

    def process_critique_result(self, summary: Dict[str, Any]) -> None:
        self.context.critique_verdict = summary.get("verdict", "NEEDS_REVISION")
        issues = summary.get("issues", [])
        if issues:
            self.context.critique_issues.extend(issues)
        self.context.iteration += 1

    def process_scaffold_result(self, summary: Dict[str, Any]) -> None:
        # Accept files_created (canonical) or files_written (fallback alias) —
        # see research/skills-agent-output-mismatch-audit.md
        self.context.files_created = summary.get("files_created") or summary.get("files_written", [])
        self.context.files_modified = summary.get("files_modified", [])
        self.context.generation_complete = summary.get("generation_complete", summary.get("write_complete", False))
        self.context.agent_definition = summary.get("agent_definition", "")
        self.context.agent_file_path = summary.get("agent_file_path", "")

    def process_verify_result(self, summary: Dict[str, Any]) -> None:
        self.context.verification_yaml_valid = summary.get("yaml_valid", False)
        self.context.verification_schema_valid = summary.get("schema_valid", False)
        self.context.verification_diff_applied = summary.get("diff_applied", False)
        self.context.verification_complete = summary.get("verification_complete", False)

    def process_user_clarification(self, summary: Dict[str, Any]) -> None:
        self.context.clarification_text = summary.get("clarification", "")

    # --------------------------------------------------------
    # Main entry points
    # --------------------------------------------------------

    def start(self, goal: str, constraints: dict = None) -> Dict[str, Any]:
        self.context.goal = goal
        if constraints:
            self.context.constraints = constraints

        # Intake processing — extract before FSM transition
        if not self.context.goal:
            return self._action("error", errors=["No goal provided"])

        goal_words = self.context.goal.split()
        self.context.agent_name = (
            self.context.constraints.get("agent_name")
            or (goal_words[0] if goal_words else "new-agent")
        )
        # Enforce create_skill_scaffold=false
        self.context.create_skill_scaffold = self.context.constraints.get("create_skill_scaffold", False)
        if self.context.create_skill_scaffold:
            self.context.errors.append("create_skill_scaffold is always false for agent skill; ignoring constraint")
            self.context.create_skill_scaffold = False

        # Sub-skill contract
        if self.context.constraints.get("parent_session_id"):
            self.context.parent_session_id = self.context.constraints["parent_session_id"]
            self.context.subskill_mode = True

        try:
            self.workflow.start()
        except Exception as e:
            return self._action("error", errors=[f"Intake failed: {e}"])
        return self._next_action()

    def step(self, agent: str, result: Dict[str, Any], state: Dict[str, Any]) -> Dict[str, Any]:
        self.restore_state(state)
        # Restore workflow state from serialized state
        self._force_state(state.get("current_state", self._state_id()))

        # Handle error result
        if result.get("exitCode", 0) != 0:
            error_msg = result.get("error", "Unknown error")
            self.context.errors.append(f"{agent} error: {error_msg}")
            return self._action(
                "error",
                agent=agent,
                errors=self.context.errors,
            )

        summary, error_action = self._extract_and_validate_summary(result, agent)
        if error_action:
            return error_action

        # UNKNOWN_STATE check
        if self._check_confidence_and_handle(summary):
            return self._action_escalate()

        # NEW: Detect agent-side clarification signal (parent-process questionnaire pattern)
        # When a subagent can't ask the user directly (non-interactive mode), it signals
        # needs_clarification in its SUMMARY. We route this through the UNKNOWN_STATE
        # escalation path, which presents questions at the parent level (Penny/DA).
        if summary and summary.get("needs_clarification"):
            questions = summary.get("clarifying_questions", [])
            self.context.last_confidence = "UNCERTAIN"
            self.context.previous_state = self._state_id()
            self.context.unknown_reason = f"Agent needs clarification: {'; '.join(questions) if questions else 'Missing critical information'}"
            self.context.clarification_text = ""
            # Fire the appropriate *_unknown transition
            state_id = self._state_id()
            transition_map = {
                "exploring": "explore_unknown",
                "designing": "design_unknown",
                "critiquing": "critique_unknown",
                "scaffolding": "scaffold_unknown",
            }
            transition = transition_map.get(state_id)
            if transition:
                getattr(self.workflow, transition)()
            else:
                self.workflow.escalate()
            return self._action_escalate()

        if agent in ("echo", "vera"):
            state_id = self._state_id()
            if state_id == "exploring" and agent == "echo":
                self.process_explore_result(summary or {})
                try:
                    self.workflow.explore_done()
                except Exception:
                    return self._action("error", errors=["Failed to transition from exploring"])
            elif state_id == "verifying" and agent == "vera":
                self.process_verify_result(summary or {})
                try:
                    if self.context.verification_complete:
                        self.workflow.verify_pass()
                    else:
                        self.workflow.verify_fail()
                except Exception:
                    return self._action("error", errors=["Failed to transition from verifying"])
        elif agent == "piper":
            self.process_design_result(summary or {})
            try:
                self.workflow.design_done()
            except Exception:
                return self._action("error", errors=["Failed to transition from designing"])
        elif agent == "carren":
            self.process_critique_result(summary or {})
            if self.context.critique_verdict == "APPROVE":
                self.workflow.critique_pass()
            else:
                self.workflow.critique_fail()
        elif agent == "skribble":
            self.process_scaffold_result(summary or {})
            try:
                self.workflow.scaffold_done()
            except Exception:
                return self._action("error", errors=["Failed to transition from scaffolding"])
        elif agent == "user":
            self.process_user_clarification(summary or {})
            if self.context.previous_state == "exploring":
                self.workflow.resume_explore()
            elif self.context.previous_state == "designing":
                self.workflow.resume_design()
            elif self.context.previous_state == "critiquing":
                self.workflow.resume_critique()
            elif self.context.previous_state == "scaffolding":
                self.workflow.resume_scaffold()

        return self._next_action()

    def _next_action(self):
        state = self._state_id()
        if state == "complete":
            return self._action_complete()
        elif state == "error":
            return self._action("error", errors=self.context.errors)
        elif state == "awaiting_clarification":
            return self._action_escalate()
        elif state == "unknown":
            self.workflow.escalate()
            return self._action_escalate()
        elif state == "intake":
            # Intake is handled in start() before FSM transition; should never reach here
            return self._action_explore()
        elif state == "exploring":
            return self._action_explore()
        elif state == "designing":
            return self._action_design()
        elif state == "critiquing":
            return self._action_critique()
        elif state == "revising":
            # Revising routes back to explore or design; default to design
            return self._action_design() if self.workflow.can_fix_design() else self._action_explore()
        elif state == "scaffolding":
            return self._action_scaffold()
        elif state == "verifying":
            return self._action_verify()
        else:
            return self._action("error", errors=[f"No action defined for state: {state}"])


# ============================================================
# CLI Entry Point
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="Agent skill orchestration")
    subparsers = parser.add_subparsers(dest="command")

    start_p = subparsers.add_parser("start")
    start_p.add_argument("--session-id", required=True)
    start_p.add_argument("--goal", required=True)
    start_p.add_argument("--project-root", default=".")
    start_p.add_argument("--constraints", default="{}")

    step_p = subparsers.add_parser("step")
    step_p.add_argument("--session-id", required=True)
    step_p.add_argument("--project-root", default=".")
    step_p.add_argument("--agent", required=True)
    step_p.add_argument("--result", required=True)
    step_p.add_argument("--state", required=True)

    status_p = subparsers.add_parser("status")
    status_p.add_argument("--session-id", required=True)
    status_p.add_argument("--state", required=True)

    args = parser.parse_args()

    if args.command == "start":
        context = AgentContext(
            session_id=args.session_id,
            project_root=args.project_root,
        )
        orch = Orchestrator(context)
        constraints = json.loads(args.constraints)
        result = orch.start(args.goal, constraints)
        print(json.dumps(result))

    elif args.command == "step":
        state_dict = json.loads(args.state)
        context = AgentContext(
            session_id=state_dict.get("session_id", args.session_id),
            project_root=args.project_root,
        )
        orch = Orchestrator(context)
        result_obj = json.loads(args.result)
        result = orch.step(args.agent, result_obj, state_dict)
        print(json.dumps(result))

    elif args.command == "status":
        state_dict = json.loads(args.state)
        context = AgentContext(
            session_id=state_dict.get("session_id", args.session_id),
        )
        orch = Orchestrator(context)
        result = {
            "current_state": orch._state_id(),
            "session_id": context.session_id,
            "agent_name": context.agent_name,
            "iteration": context.iteration,
        }
        print(json.dumps(result))


if __name__ == "__main__":
    main()
