"""
Plan Skill - State Machine Orchestration

Lightweight orchestration: Penny reads minimal directives, not full prompts.
Agents are self-sufficient — they read context from mempalace, write results to mempalace.
State passes through Penny as a small JSON blob, stored in mempalace between steps.

Architecture:
  - PlanWorkflow: Synchronous state machine (states, transitions, guards)
  - PlanOrchestrator: Outputs MINIMAL JSON directives to stdout
  - Penny: Routes directives to agents, stores state in mempalace
  - Agents: Read/write mempalace for all substantial data

Key principle: Penny is a ROUTER, not a READER.
She sees agent names and session IDs, never full prompts or results.
"""

import argparse
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from statemachine import State, StateMachine


# ============================================================
# Context Data Class — Lean, no raw agent output stored
# ============================================================

@dataclass
class PlanContext:
    """Per-session skill state data — only metadata, no raw output."""
    session_id: str = ""
    skill_name: str = "plan"
    project_root: str = ""

    # Input
    goal: str = ""
    constraints: Dict[str, Any] = field(default_factory=dict)

    # Exploration — just metadata, not raw output
    explore_findings_count: int = 0
    explore_files_count: int = 0
    explore_unknowns_count: int = 0
    explore_complete: bool = False

    # Plan — just structured steps, not full text
    plan_steps: List[Dict[str, Any]] = field(default_factory=list)
    plan_complete: bool = False

    # Critique — just verdict and issues
    critique_verdict: str = ""
    critique_issues: List[str] = field(default_factory=list)

    # Structured plan (from taskifier) — just key fields
    structured_plan_title: str = ""
    structured_plan_step_count: int = 0
    structured_plan_complete: bool = False

    # Tracking
    iteration: int = 0
    max_iterations: int = 3
    exploration_iterations: int = 0
    max_exploration_iterations: int = 2
    errors: List[str] = field(default_factory=list)

    # UNKNOWN_STATE support
    last_confidence: str = ""          # CERTAIN/PROBABLE/POSSIBLE/UNCERTAIN from last agent
    clarification_text: str = ""     # User's clarification response
    previous_state: str = ""         # Working state interrupted by unknown (for resume routing)
    unknown_reason: str = ""          # Why we entered unknown state

    # VERIFYING state support
    verification_pending: str = ""     # Action description pending user confirmation
    verification_alternatives: List[str] = field(default_factory=list)  # Alternative approaches
    verification_counter_argument: str = ""  # Counter-argument against proposed action
    verification_mode: str = "relaxed"  # strict/default/relaxed/off — relaxed skips the verifying state; UNCERTAIN routes through unknown state instead
    verification_confirmed: bool = False  # True after user confirms
    verification_skipped: bool = False   # True if guard bypassed (low stakes)
    verification_rejected: bool = False  # True if user rejects proposed action
    verification_stakes: str = ""       # Stakes level: low/medium/high

    # Output
    complete: bool = False


# ============================================================
# State Machine — unchanged
# ============================================================

class PlanWorkflow(StateMachine):
    """Plan Workflow State Machine — SYNCHRONOUS, state tracking only.

    UNKNOWN_STATE protocol:
    When any agent returns UNCERTAIN confidence, the FSM transitions to `unknown`
    via guard-triggered transitions (explore_unknown, plan_unknown, etc.).
    From `unknown`, the FSM escalates to `awaiting_clarification` which routes
    a questionnaire to the user. After clarification, the FSM resumes to
    the appropriate working state via `resume_*` transitions.

    Soft-error handling:
    `unknown` and `awaiting_clarification` are NOT replayable via _force_state.
    Instead, _force_state redirects them to `exploring` with error context preserved.
    """

    # States
    intake = State(initial=True)
    exploring = State()
    planning = State()
    critiquing = State()
    revising = State()
    taskifying = State()
    unknown = State()
    awaiting_clarification = State()
    verifying = State()  # NEW: high-stakes confirmation state
    complete = State(final=True)
    error = State(final=True)

    # Transitions — happy path with verification
    start = intake.to(exploring, cond="has_goal")
    explore_done = exploring.to(planning, cond="_explore_is_complete")
    plan_done = (
        planning.to(verifying, cond="needs_verification") |
        planning.to(critiquing, cond="_plan_steps_exist", unless="needs_verification")
    )
    verify_confirm = verifying.to(critiquing, cond="_user_confirmed_verification")
    verify_reject = verifying.to(revising, cond="_user_rejected_verification")
    verify_abandon = verifying.to(unknown)
    critique_pass = critiquing.to(taskifying, cond="critique_approved")
    critique_fail = critiquing.to(revising, cond="has_issues")
    revise_explore = revising.to(exploring, cond="needs_more_context")
    revise_plan = revising.to(planning, cond="can_fix_plan")
    taskify_done = taskifying.to(complete, cond="output_valid")

    # Transitions — error path
    fail_intake = intake.to(error)
    fail_explore = exploring.to(error)
    fail_plan = planning.to(error)
    fail_critique = critiquing.to(error)
    fail_taskify = taskifying.to(error)

    # Transitions — UNKNOWN_STATE protocol
    explore_unknown = exploring.to(unknown, cond="confidence_is_uncertain")
    plan_unknown = planning.to(unknown, cond="confidence_is_uncertain")
    critique_unknown = critiquing.to(unknown, cond="confidence_is_uncertain")
    taskify_unknown = taskifying.to(unknown, cond="confidence_is_uncertain")

    # Escalation from unknown
    escalate = unknown.to(awaiting_clarification)
    abandon = unknown.to(error)
    abandon_clarification = awaiting_clarification.to(error)

    # Resume after user clarification
    resume_explore = awaiting_clarification.to(exploring, cond="has_clarification")
    resume_plan = awaiting_clarification.to(planning, cond="has_clarification")
    resume_critique = awaiting_clarification.to(critiquing, cond="has_clarification")

    # Guards — use lean context fields
    def has_goal(self) -> bool:
        return bool(self.model.goal)

    def _explore_is_complete(self) -> bool:
        """Guard: True when explore phase is complete.

        Named differently from explore_complete because python-statemachine v3 ANDs
        model fields and SM methods with the same name. The model has an
        explore_complete boolean field; this guard must use a non-colliding name.
        """
        return self.model.explore_complete

    def _plan_steps_exist(self) -> bool:
        """Guard: True when plan_steps has items.

        Named differently from plan_complete because python-statemachine v3 ANDs
        model fields and SM methods with the same name. The model has a
        plan_complete boolean field; this guard derives from plan_steps and
        must use a non-colliding name.
        """
        return len(self.model.plan_steps) > 0

    def critique_approved(self) -> bool:
        return self.model.critique_verdict == "APPROVE"

    def has_issues(self) -> bool:
        return (
            self.model.critique_verdict != "APPROVE"
            and len(self.model.critique_issues) > 0
        )

    def needs_more_context(self) -> bool:
        return self.model.exploration_iterations < self.model.max_exploration_iterations

    def can_fix_plan(self) -> bool:
        return not self.needs_more_context()

    def confidence_is_uncertain(self) -> bool:
        """Guard: only UNCERTAIN confidence triggers unknown state."""
        return self.model.last_confidence == "UNCERTAIN"

    def has_clarification(self) -> bool:
        """Guard: user has provided clarification text."""
        return bool(self.model.clarification_text)

    def output_valid(self) -> bool:
        return self.model.structured_plan_complete

    # VERIFYING state guards
    def needs_verification(self) -> bool:
        """
        Guard: True when planned action warrants user confirmation.

        Verification triggers:
        - UNCERTAIN confidence → always verify (though typically caught by confidence_is_uncertain first)
        - POSSIBLE confidence + high or irreversible stakes → verify
        - PROBABLE + strict mode + high stakes → verify
        - CERTAIN or low stakes → skip
        """
        mode = self.model.verification_mode
        confidence = self.model.last_confidence
        stakes = self.model.verification_stakes

        # Mode: Off — no verification regardless of confidence
        if mode == "off":
            return False

        # UNCERTAIN → needs verification (will route through unknown state first per boundary)
        if confidence == "UNCERTAIN":
            return True

        # Mode: Relaxed — only verify UNCERTAIN
        if mode == "relaxed":
            return False  # UNCERTAIN already caught above

        # Mode: Strict — verify POSSIBLE or PROBABLE with high stakes
        if mode == "strict":
            if confidence in ("POSSIBLE", "PROBABLE") and stakes in ("high", "medium"):
                return True
            if confidence == "POSSIBLE":
                return True
            return False

        # Mode: Default — verify POSSIBLE + high stakes, or any + irreversible
        if confidence == "POSSIBLE" and stakes in ("high", "medium"):
            return True
        # Also verify if action involves irreversible changes (indicated by stakes="high")
        if stakes == "high":
            return True

        return False

    def _user_confirmed_verification(self) -> bool:
        """Guard: user has confirmed the proposed action.

        Named differently from verification_confirmed because python-statemachine v3 ANDs
        model fields and SM methods with the same name. The model has a
        verification_confirmed boolean field; this guard must use a non-colliding name.
        """
        return self.model.verification_confirmed

    def _user_rejected_verification(self) -> bool:
        """Guard: user has rejected the proposed action.

        Named differently from verification_rejected because python-statemachine v3 ANDs
        model fields and SM methods with the same name. The model has a
        verification_rejected boolean field; this guard must use a non-colliding name.
        """
        return self.model.verification_rejected

    def _user_skipped_verification(self) -> bool:
        """Guard: low-stakes action bypasses verification.

        Named differently from verification_skipped because python-statemachine v3 ANDs
        model fields and SM methods with the same name. The model has a
        verification_skipped boolean field; this guard must use a non-colliding name.
        """
        return self.model.verification_skipped


# ============================================================
# Orchestrator — outputs MINIMAL directives, no full prompts
# ============================================================

class PlanOrchestrator:
    """
    Lightweight orchestrator: outputs agent names + session context.

    Penny never sees full prompt templates or agent results.
    All substantial data flows through mempalace.
    State passes through Penny as a small JSON blob.
    """

    def __init__(
        self,
        session_id: str,
        goal: str,
        project_root: str = ".",
        constraints: Optional[Dict[str, Any]] = None,
        max_iterations: int = 3,
    ):
        self.session_id = session_id
        self.project_root = str(Path(project_root).resolve())

        self.context = PlanContext(
            session_id=session_id,
            project_root=self.project_root,
            goal=goal,
            constraints=constraints or {},
            max_iterations=max_iterations,
        )

        if constraints:
            for key, value in constraints.items():
                if hasattr(self.context, key):
                    setattr(self.context, key, value)

        self.machine = PlanWorkflow(model=self.context)

    # ── State helpers ──────────────────────────────────────

    @property
    def current_state_id(self) -> str:
        return next(iter(self.machine.configuration)).id

    @property
    def current_state(self) -> str:
        return next(iter(self.machine.configuration)).name

    @property
    def is_terminal(self) -> bool:
        return self.machine.is_terminated

    # ── State serialization (for Penny to store in mempalace) ──

    def extract_state(self) -> Dict[str, Any]:
        """Extract current state for Penny to store in mempalace."""
        return {
            "session_id": self.context.session_id,
            "current_state_id": self.current_state_id,
            "context": {
                "goal": self.context.goal,
                "constraints": self.context.constraints,
                "explore_findings_count": self.context.explore_findings_count,
                "explore_files_count": self.context.explore_files_count,
                "explore_unknowns_count": self.context.explore_unknowns_count,
                "explore_complete": self.context.explore_complete,
                "plan_steps": self.context.plan_steps,
                "plan_complete": self.context.plan_complete,
                "critique_verdict": self.context.critique_verdict,
                "critique_issues": self.context.critique_issues,
                "structured_plan_title": self.context.structured_plan_title,
                "structured_plan_step_count": self.context.structured_plan_step_count,
                "structured_plan_complete": self.context.structured_plan_complete,
                "iteration": self.context.iteration,
                "exploration_iterations": self.context.exploration_iterations,
                "errors": self.context.errors,
                "complete": self.context.complete,
                "last_confidence": self.context.last_confidence,
                "clarification_text": self.context.clarification_text,
                "previous_state": self.context.previous_state,
                "unknown_reason": self.context.unknown_reason,
                "verification_stakes": self.context.verification_stakes,
                "verification_mode": self.context.verification_mode,
                "verification_confirmed": self.context.verification_confirmed,
                "verification_rejected": self.context.verification_rejected,
                "verification_pending": self.context.verification_pending,
                "verification_alternatives": self.context.verification_alternatives,
                "verification_counter_argument": self.context.verification_counter_argument,
            },
        }

    def restore_state(self, state: Dict[str, Any]) -> None:
        """Restore state from mempalace-stored blob."""
        context_data = state.get("context", {})
        for key, value in context_data.items():
            if hasattr(self.context, key):
                setattr(self.context, key, value)

        saved_state = state.get("current_state_id", state.get("state_id", state.get("state", "")))
        if saved_state:
            self._force_state(saved_state)

    def _force_state(self, target_state: str) -> None:
        """Force the state machine to a specific state by replaying transitions.

        unknown/awaiting_clarification are NOT replayable via transitions
        because they are guard-triggered. Instead, redirect to `exploring`
        with error context preserved — the explore agent will find prior
        session data in mempalace and won't start from scratch.
        """
        if target_state == "intake" or not target_state:
            return

        # Soft-error redirect for unknown states
        if target_state in ("unknown", "awaiting_clarification"):
            target_state = "exploring"
            self.context.errors.append(
                f"Session recovered from {target_state} state — re-entering exploration. "
                f"Original reason: {self.context.unknown_reason or 'unknown'}"
            )

        transitions_map = {
            "exploring": ["start"],
            "planning": ["start", "explore_done"],
            "verifying": ["start", "explore_done", "plan_done"],
            "critiquing": ["start", "explore_done", "plan_done", "verify_confirm"],
            "revising": ["start", "explore_done", "plan_done", "verify_confirm", "verify_reject", "critique_fail"],
            "taskifying": ["start", "explore_done", "plan_done", "verify_confirm", "critique_pass"],
        }

        if target_state not in transitions_map:
            # Target state is not forcible — log error and fall back to exploring
            self.context.errors.append(
                f"Cannot force state to '{target_state}' — not in transitinos_map. "
                f"Falling back to 'exploring'. Valid forcible states: {list(transitions_map.keys())}"
            )
            target_state = "exploring"
            # Intentionally fall through to exploring logic below

        for transition_name in transitions_map[target_state]:
            # If we already reached the target state (e.g., plan_done went
            # directly to critiquing, skipping verification), stop replaying.
            if self.current_state_id == target_state:
                break

            try:
                self.machine.send(transition_name)
            except Exception as e:
                # verify_confirm, verify_reject, and critique_pass are conditional
                # branch transitions. They may not be valid from the current state
                # (e.g., verify_confirm from critiquing, or critique_pass from
                # verifying). Skip these non-fatal failures and continue.
                if transition_name in ("verify_confirm", "verify_reject", "critique_pass"):
                    self.context.errors.append(
                        f"Skipped optional transition '{transition_name}' during state restore: {e}"
                    )
                    continue
                self.context.errors.append(
                    f"Failed to restore state '{target_state}' at transition '{transition_name}': {e}"
                )
                return

        # POST-LOOP FALLBACK: If conditional transitions failed and the machine
        # didn't reach the target state, apply remedial context fixes iteratively.
        # This handles cases where guards fail due to missing/default context
        # values (e.g., critique_verdict not yet "APPROVE", verification_confirmed
        # not yet True). The machine MUST reach the target state, even if it
        # requires multiple remedial steps (e.g., verifying→critiquing→taskifying).
        max_fallbacks = 5  # Safety: prevent infinite loop
        for _ in range(max_fallbacks):
            if self.current_state_id == target_state:
                break

            # Stuck in verifying → need verify_confirm to reach critiquing
            if self.current_state_id == "verifying":
                if not self.context.verification_confirmed:
                    self.context.verification_confirmed = True
                try:
                    self.machine.send("verify_confirm")
                    continue
                except Exception as e:
                    self.context.errors.append(
                        f"Fallback verify_confirm failed from verifying: {e}"
                    )
                    return

            # Stuck in critiquing → need critique_pass to reach taskifying
            if self.current_state_id == "critiquing" and target_state in ("critiquing", "taskifying"):
                # target_state == critiquing: we're done (check above would catch)
                if self.context.critique_verdict != "APPROVE":
                    self.context.critique_verdict = "APPROVE"
                try:
                    self.machine.send("critique_pass")
                    continue
                except Exception as e:
                    self.context.errors.append(
                        f"Fallback critique_pass failed from critiquing: {e}"
                    )
                    return

            # If we get here, we're in an unexpected state and can't progress
            self.context.errors.append(
                f"Fallback exhausted: stuck in '{self.current_state_id}' trying to reach '{target_state}'"
            )
            return

    # ── Action output — MINIMAL, no prompt content ──────

    def _action(self, action: str, **kwargs) -> Dict[str, Any]:
        """Build a minimal action response with state for Penny to store.

        Every state-transition action is a ``logical_step`` —
        meaningful progress through the pipeline.
        """
        return {
            "action": action,
            "state_id": self.current_state_id,
            "session_id": self.session_id,
            "orchestrator_state": self.extract_state(),
            "logical_step": True,
            **kwargs,
        }

    # ── Parsing helpers — work with summaries, not raw output ──

    def _parse_explore_summary(self, summary: Dict[str, Any]) -> None:
        """Extract metadata from explore summary (not raw output)."""
        self.context.explore_findings_count = summary.get("findings_count", 0)
        self.context.explore_files_count = summary.get("files_count", 0)
        self.context.explore_unknowns_count = summary.get("unknowns_count", 0)
        self.context.explore_complete = summary.get("explore_complete", False)

    def _parse_plan_summary(self, summary: Dict[str, Any]) -> None:
        """Extract plan steps from summary."""
        self.context.plan_steps = summary.get("plan_steps", [])
        self.context.plan_complete = summary.get("plan_complete", len(self.context.plan_steps) > 0)

    def _parse_critique_summary(self, summary: Dict[str, Any]) -> None:
        """Extract critique verdict from summary."""
        self.context.critique_verdict = summary.get("verdict", "NEEDS_REVISION")
        self.context.critique_issues = summary.get("issues", [])

    def _parse_taskifier_summary(self, summary: Dict[str, Any]) -> None:
        """Extract taskifier result from summary."""
        self.context.structured_plan_title = summary.get("title", "")
        self.context.structured_plan_step_count = summary.get("step_count", 0)
        self.context.structured_plan_complete = summary.get("complete", False)

    # ── Exploration logic ─────────────────────────────────

    def _should_parallelize_exploration(self) -> bool:
        """Determine if exploration should run in parallel.

        Default is parallel — most goals benefit from multiple angles
        and perspectives during exploration. Only explicitly set
        exploration_mode='single' to override.
        """
        goal_lower = (self.context.goal or "").lower()
        single_keywords = [
            "quick", "simple", "minor", "small", "single",
            "fix", "patch", "hotfix", "typo",
        ]
        exploration_mode = self.context.constraints.get("exploration_mode", "parallel")
        return (
            exploration_mode == "parallel"
            or (exploration_mode == "auto" and not any(kw in goal_lower for kw in single_keywords))
        )

    # ── Action generators — MINIMAL output ──────────────

    def _action_intake(self) -> Dict[str, Any]:
        """Intake: validate goal and transition to exploring."""
        if not self.context.goal:
            self.context.errors.append("No goal provided")
            self.machine.send("fail_intake")
            return self._action("error", errors=self.context.errors)

        self.machine.send("start")
        return self._action_explore()

    @property
    def session_room(self) -> str:
        """Session-scoped mempalace room to isolate this skill session's data."""
        return f"skills/plan-{self.context.session_id}"

    def _action_explore(self) -> Dict[str, Any]:
        """Exploring: return agent names + focus areas, not full prompts."""
        if self._should_parallelize_exploration() and self.context.exploration_iterations == 0:
            aspects = [
                {"focus": "entry points and call graph"},
                {"focus": "tests and build pipeline"},
                {"focus": "configurations and dependencies"},
            ]
            return self._action(
                "invoke_agents_parallel",
                tasks=[
                    {
                        "agent": "echo",
                        "task_summary": (
                            f"Session: {self.context.session_id}. "
                            f"Goal: {self.context.goal}. "
                            f"Focus: {a['focus']}. "
                            f"Mempalace room: {self.session_room}. "
                            f"Write findings to mempalace wing=penny room={self.session_room} "
                            f"with header: {self.context.session_id} Explore — {a['focus']}. "
                            f"Check room {self.session_room} for prior session results first. "
                        ),
                    }
                    for a in aspects
                ],
            )
        else:
            task_summary = (
                f"Session: {self.context.session_id}. "
                f"Goal: {self.context.goal}. "
                f"Mempalace room: {self.session_room}. "
            )

            if self.context.iteration > 0 and self.context.critique_issues:
                # Re-exploration requested because critique identified gaps
                issues_str = "; ".join(self.context.critique_issues)
                task_summary += (
                    f"This is additional exploration (cycle {self.context.iteration}) "
                    f"requested because the critique identified gaps: {issues_str}. "
                    f"Search mempalace for the prior critique to understand what information is missing. "
                    f"Focus your exploration on filling these gaps. "
                    f"Write findings to mempalace wing=penny room={self.session_room} "
                    f"with header: {self.context.session_id} Explore (Revision {self.context.iteration}). "
                    f"Check room {self.session_room} for prior session results first."
                )
            else:
                task_summary += (
                    f"Write findings to mempalace wing=penny room={self.session_room} "
                    f"with header: {self.context.session_id} Explore. "
                    f"Check room {self.session_room} for prior session results first."
                )

            return self._action(
                "invoke_agent",
                agent="echo",
                task_summary=task_summary,
            )

    def _action_plan(self) -> Dict[str, Any]:
        """Planning: invoke planner. Agent reads from mempalace."""
        if self.context.iteration > 0:
            # Revision cycle — planner must address critique issues
            issues_str = "; ".join(self.context.critique_issues) if self.context.critique_issues else "see critique in mempalace"
            task_summary = (
                f"Session: {self.context.session_id}. "
                f"Goal: {self.context.goal}. "
                f"Mempalace room: {self.session_room}. "
                f"This is REVISION cycle {self.context.iteration}. "
                f"The prior critique identified these issues: {issues_str}. "
                f"Search mempalace for the critique to understand each issue in detail. "
                f"Also read explore findings and any new exploration results from mempalace. "
                f"Address EVERY critique issue in your revised plan — mark which issues you resolved and how. "
                f"Write revised plan to mempalace wing=penny room={self.session_room} "
                f"with header: {self.context.session_id} Planner (Revision {self.context.iteration}). "
                f"Output brief SUMMARY with plan steps."
            )
        else:
            task_summary = (
                f"Session: {self.context.session_id}. "
                f"Goal: {self.context.goal}. "
                f"Mempalace room: {self.session_room}. "
                f"Read explore findings from mempalace wing=penny room={self.session_room}. "
                f"Write plan to mempalace wing=penny room={self.session_room} "
                f"with header: {self.context.session_id} Planner. "
                f"Output brief SUMMARY with plan steps."
            )

        return self._action(
            "invoke_agent",
            agent="piper",
            task_summary=task_summary,
        )

    def _action_verify(self) -> Dict[str, Any]:
        """VERIFYING: present proposed action to user for confirmation.

        When the FSM enters VERIFYING, the planned action is ready but
        requires user confirmation because confidence is POSSIBLE + stakes
        are high, or the user has configured strict verification mode.

        Presents:
        1. The proposed action summary
        2. Confidence level and risk context
        3. At least one alternative approach
        4. A counter-argument against the proposed action (formalizing Carren)
        5. A questionnaire for user to confirm, reject, or revise
        """
        pending = self.context.verification_pending or "A high-stakes action is pending confirmation"
        confidence = self.context.last_confidence or "POSSIBLE"
        alternatives = self.context.verification_alternatives or ["Alternative not generated"]
        counter = self.context.verification_counter_argument or "No counter-argument generated"

        questions = [{
            "id": "verification_action",
            "label": "Verify Action",
            "prompt": (
                f"I am about to proceed with an action, but I want your confirmation first.\n\n"
                f"**Proposed Action:** {pending}\n\n"
                f"**Confidence:** {confidence}\n\n"
                f"**Counter-argument (why this might go wrong):** {counter}\n\n"
                f"**Alternative approach:** {alternatives[0] if alternatives else 'None provided'}"
            ),
            "options": [
                {"value": "confirm", "label": "Proceed — confidence is acceptable", "description": "Execute the planned action"},
                {"value": "reject", "label": "Reject — try alternative", "description": "Reject and return to planning for revision"},
                {"value": "escalate", "label": "I don't know — escalate", "description": "Move to UNKNOWN_STATE for clarification"},
            ],
            "allowOther": True,
        }]

        return self._action(
            "escalate_to_user",
            questions=questions,
            state_id="verifying",
            verification=True,
            unknown_reason=f"Verification needed for: {pending}",
            previous_state="planning",
        )

    def _action_critique(self) -> Dict[str, Any]:
        """Critiquing: invoke critique. Agent reads from mempalace."""
        task_summary = (
            f"Session: {self.context.session_id}. "
            f"Mempalace room: {self.session_room}. "
            f"Read plan from mempalace wing=penny room={self.session_room}. "
        )

        if self.context.iteration > 0:
            task_summary += (
                f"This is review cycle {self.context.iteration + 1} — the plan has been revised to address prior critique issues. "
                f"Apply revision-appropriate standards: block ONLY on Critical, High, or Medium severity issues. "
                f"Low severity issues should be noted but should NOT prevent approval — issue APPROVE with notes for Low-only concerns. "
            )

        task_summary += (
            f"Write critique to mempalace wing=penny room={self.session_room} "
            f"with header: {self.context.session_id} Critique. "
            f"Output brief SUMMARY with verdict."
        )

        return self._action(
            "invoke_agent",
            agent="carren",
            task_summary=task_summary,
        )

    def _action_taskify(self) -> Dict[str, Any]:
        """Taskifying: invoke taskifier. Agent reads from mempalace."""
        return self._action(
            "invoke_agent",
            agent="tabitha",
            task_summary=(
                f"Session: {self.context.session_id}. "
                f"Mempalace room: {self.session_room}. "
                f"Read plan and critique from mempalace wing=penny room={self.session_room}. "
                f"Write structured plan to mempalace wing=penny room={self.session_room} "
                f"with header: {self.context.session_id} Taskifier. "
                f"Output brief SUMMARY with step count."
            ),
        )

    def _action_escalate(self) -> Dict[str, Any]:
        """Escalate to user when FSM is in unknown/awaiting_clarification state.

        Generates a questionnaire asking the user for direction when
        the workflow cannot proceed due to UNCERTAIN confidence.
        The previous_state field determines which working state to resume
        to after clarification.
        """
        reason = self.context.unknown_reason or "An agent returned UNCERTAIN confidence"
        previous = self.context.previous_state or "exploring"

        escalation_questions = [{
            "id": "clarification",
            "label": "Help Needed",
            "prompt": (
                f"I'm not confident about how to proceed because: {reason}. "
                f"The previous step was: {previous}. "
                f"Please choose how to continue:"
            ),
            "options": [
                {"value": "retry", "label": "Try again with a different approach"},
                {"value": "skip", "label": "Skip this step and continue"},
                {"value": "restart", "label": "Start the whole plan over"},
            ],
            "allowOther": True,
        }]

        return self._action(
            "escalate_to_user",
            questions=escalation_questions,
            previous_state=previous,
            unknown_reason=reason,
        )

    # ── Result processors — accept summaries ────────────

    def _is_success_exit(self, result: Dict[str, Any]) -> bool:
        """Check if an agent result indicates success.

        exitCode 0 = clean success. Pi exits with 0 when the agent
        completes its work, runs compaction, and cleans up.
        No hard timeout is enforced — we trust Pi to exit naturally
        (Pi Alignment Standard). Only exit code 0 means success.
        """
        code = result.get("exitCode", 1)
        return code == 0

    # ── Safe default summaries — NEVER lie about completion ──

    def _safe_default_summary(self, agent: str) -> Dict[str, Any]:
        """Return a safe default summary that does NOT claim completion.

        These defaults are used ONLY when the agent result has no SUMMARY
        block or an empty summary. They signal "incomplete" so the
        orchestrator knows the agent did not produce structured output.

        CONTRAST with the old behavior: previous defaults claimed
        explore_complete=True, plan_complete=True, etc. — which caused
        the skill to advance on empty/missing data, producing broken plans.
        """
        if agent == "echo":
            return {
                "findings_count": 0,
                "files_count": 0,
                "unknowns_count": 0,
                "explore_complete": False,
            }
        elif agent == "piper":
            return {"plan_steps": [], "plan_complete": False}
        elif agent == "carren":
            return {
                "verdict": "NEEDS_REVISION",
                "issues": ["Agent did not emit SUMMARY or summary was empty"],
            }
        elif agent == "tabitha":
            return {"title": "", "step_count": 0, "complete": False}
        else:
            return {}

    def _validate_summary(self, agent: str, summary: Dict[str, Any]) -> tuple[bool, str]:
        """Validate that a summary has the required fields for its agent.

        Returns (is_valid, error_message). Empty dicts or missing required
        fields produce an error so the skill does NOT advance on bad data.

        Required fields per agent:
          echo:     explore_complete (bool)
          piper:    plan_steps (list), plan_complete (bool)
          carren:   verdict (str), issues (list)
          tabitha:  title (str), step_count (int), complete (bool)
        """
        if not summary or not isinstance(summary, dict):
            return False, f"Agent {agent}: summary is missing or not a dict"

        required: Dict[str, type] = {}
        if agent == "echo":
            required = {"explore_complete": bool}
        elif agent == "piper":
            required = {"plan_steps": list, "plan_complete": bool}
        elif agent == "carren":
            required = {"verdict": str, "issues": list}
        elif agent == "tabitha":
            required = {"title": str, "step_count": int, "complete": bool}
        else:
            return True, ""  # Unknown agent: no validation

        missing = [k for k in required if k not in summary]
        if missing:
            return False, f"Agent {agent}: missing required fields: {', '.join(missing)}"

        for field_name, expected_type in required.items():
            if not isinstance(summary[field_name], expected_type):
                return (
                    False,
                    f"Agent {agent}: field '{field_name}' has wrong type "
                    f"(expected {expected_type.__name__}, got {type(summary[field_name]).__name__})",
                )

        return True, ""

    def _extract_and_validate_summary(
        self, agent: str, result: Dict[str, Any]
    ) -> tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        """Extract summary from result, validate it, return (summary, error_action).

        If validation fails, returns (None, error_action).
        If validation passes, returns (summary_dict, None).

        This is the SINGLE GATEKEEPER: no process_* method should ever
        advance the state machine without passing through here first.
        """
        raw_summary = result.get("summary", {})
        if not raw_summary:
            safe = self._safe_default_summary(agent)
            safe["_was_default"] = True
            safe["_reason"] = "Agent output contained no SUMMARY block or summary was empty"
            # Return the safe default BUT also flag it as invalid so caller can decide
            # For now: treat empty summary as validation failure
            self.context.errors.append(
                f"Agent {agent}: summary is empty. "
                f"The agent may have failed silently (e.g., SSE timeout, process killed). "
                f"Safe default applied — NOT advancing on fabricated data."
            )
            return None, self._action(
                "error",
                errors=[
                    f"Agent {agent}: missing or empty SUMMARY. "
                    f"The agent produced no structured output. Common causes: "
                    f"(1) Pi SSE stream timeout killed the agent mid-generation, "
                    f"(2) Agent crashed without emitting SUMMARY, "
                    f"(3) parseSummaryFromOutput could not find SUMMARY: block. "
                    f"Check agent-runner logs for 'completed without message_end'."
                ],
            )

        valid, error_msg = self._validate_summary(agent, raw_summary)
        if not valid:
            self.context.errors.append(error_msg)
            return None, self._action("error", errors=[error_msg])

        return raw_summary, None

    def _check_confidence_and_handle(self, agent: str, result: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Check if an agent's confidence is UNCERTAIN. If so, enter unknown state.

        Returns an escalate action if confidence is UNCERTAIN, None otherwise.
        Only UNCERTAIN triggers escalation — POSSIBLE, PROBABLE, and CERTAIN
        all proceed normally (strict threshold per MVI design decision).
        """
        confidence = result.get("summary", {}).get("confidence", "")
        if confidence and confidence.upper() == "UNCERTAIN":
            self.context.last_confidence = "UNCERTAIN"
            self.context.previous_state = self.current_state_id
            self.context.unknown_reason = result.get("summary", {}).get(
                "uncertain_reason", f"{agent} returned UNCERTAIN confidence"
            )
            # Enter unknown state via the appropriate guard transition
            state_id = self.current_state_id
            transition_map = {
                "exploring": "explore_unknown",
                "planning": "plan_unknown",
                "critiquing": "critique_unknown",
                "taskifying": "taskify_unknown",
            }
            transition = transition_map.get(state_id)
            if not transition:
                # Not a confidence-checkable state — return error action instead of silently proceeding
                self.context.errors.append(f"Cannot handle UNCERTAIN confidence from state: {state_id}")
                return self._action("error", errors=[
                    f"Agent {agent} returned UNCERTAIN confidence from unsupported state '{state_id}'. ",
                    f"Expected one of: {', '.join(transition_map.keys())}. ",
                    f"Reason: {self.context.unknown_reason}",
                ])
            try:
                self.machine.send(transition)
            except Exception as e:
                self.context.errors.append(f"Could not enter unknown state: {e}")
                return self._action("error", errors=[f"Transition '{transition}' failed: {e}"])
            # Transition to awaiting_clarification
            self.machine.send("escalate")
            return self._action_escalate()
        return None

    def process_explore_result(self, results: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Process exploration summary and determine next action."""
        failed = [r for r in results if not self._is_success_exit(r)]
        if failed and len(failed) == len(results):
            self.context.errors.append("All explore agents failed")
            self.machine.send("fail_explore")
            return self._action("error", errors=self.context.errors)

        # Validate each summary before parsing — track valid ones
        valid_summaries: List[Dict[str, Any]] = []
        for result in results:
            if self._is_success_exit(result):
                summary, error_action = self._extract_and_validate_summary("echo", result)
                if error_action:
                    self.context.errors.append(
                        f"Explore agent produced invalid summary: {error_action.get('errors', ['unknown'])[0]}"
                    )
                elif summary is not None:
                    self._parse_explore_summary(summary)
                    valid_summaries.append(summary)

        # If NO valid summaries among success exits, fail the batch
        success_count = len([r for r in results if self._is_success_exit(r)])
        if success_count > 0 and len(valid_summaries) == 0:
            self.context.errors.append("All explore agents produced invalid/empty summaries")
            self.machine.send("fail_explore")
            return self._action("error", errors=self.context.errors)

        # Check for UNCERTAIN confidence from any explore agent
        for result in results:
            escalation = self._check_confidence_and_handle("echo", result)
            if escalation:
                return escalation

        # If no summary was provided, mark as complete if at least one succeeded
        if not self.context.explore_complete and len(failed) < len(results):
            self.context.explore_complete = True

        self.context.exploration_iterations += 1
        self.machine.send("explore_done")
        return self._action_plan()

    def process_plan_result(self, result: Dict[str, Any]) -> Dict[str, Any]:
        """Process planner summary and determine next action."""
        if not self._is_success_exit(result):
            self.context.errors.append(f"Planner failed: {result.get('error', 'unknown')}")
            self.machine.send("fail_plan")
            return self._action("error", errors=self.context.errors)

        # Check for UNCERTAIN confidence
        escalation = self._check_confidence_and_handle("piper", result)
        if escalation:
            return escalation

        # Validate summary before parsing — gatekeeper against Pi update failures
        summary, error_action = self._extract_and_validate_summary("piper", result)
        if error_action:
            self.context.errors.append(f"Planner summary invalid: {error_action.get('errors', ['unknown'])[0]}")
            self.machine.send("fail_plan")
            return self._action("error", errors=self.context.errors)

        # NEW: Detect agent-side clarification signal (parent-process questionnaire pattern)
        # When a subagent can't ask the user directly (non-interactive mode), it signals
        # needs_clarification in its SUMMARY. We route this through the UNKNOWN_STATE
        # escalation path, which presents questions at the parent level (Penny/DA).
        if summary and summary.get("needs_clarification"):
            questions = summary.get("clarifying_questions", [])
            self.context.last_confidence = "UNCERTAIN"
            self.context.previous_state = self.current_state_id
            self.context.unknown_reason = f"Piper needs clarification: {'; '.join(questions) if questions else 'Missing critical information'}"
            self.context.clarification_text = ""  # Will be filled after user response
            self.machine.send("plan_unknown")
            return self._get_action_for_state()


        # Parse plan steps from summary (guaranteed valid by gatekeeper)
        self._parse_plan_summary(summary or {})

        if not self.context.plan_steps:
            self.context.errors.append("Planner produced no parseable steps")
            self.machine.send("fail_plan")
            return self._action("error", errors=self.context.errors)

        # Extract verification fields from plan summary
        plan_summary = summary or {}
        self.context.verification_pending = plan_summary.get("proposed_action", "")
        self.context.verification_alternatives = plan_summary.get("alternatives", [])
        self.context.verification_counter_argument = plan_summary.get("counter_argument", "")
        self.context.verification_stakes = plan_summary.get("stakes", "low")

        # Send plan_done — guards route to verifying or critiquing
        self.machine.send("plan_done")
        return self._get_action_for_state()

    def process_critique_result(self, result: Dict[str, Any]) -> Dict[str, Any]:
        """Process critique summary and determine next action."""
        if not self._is_success_exit(result):
            self.context.errors.append(f"Critique failed: {result.get('error', 'unknown')}")
            self.machine.send("fail_critique")
            return self._action("error", errors=self.context.errors)

        # Check for UNCERTAIN confidence
        escalation = self._check_confidence_and_handle("carren", result)
        if escalation:
            return escalation

        # Validate summary before parsing
        summary, error_action = self._extract_and_validate_summary("carren", result)
        if error_action:
            self.context.errors.append(f"Critique summary invalid: {error_action.get('errors', ['unknown'])[0]}")
            self.machine.send("fail_critique")
            return self._action("error", errors=self.context.errors)

        self._parse_critique_summary(summary or {})

        if self.context.critique_verdict == "APPROVE":
            self.machine.send("critique_pass")
            return self._action_taskify()
        else:
            self.context.iteration += 1
            if self.context.iteration >= self.context.max_iterations:
                self.context.critique_verdict = "APPROVE"
                self.machine.send("critique_pass")
                return self._action_taskify()

            self.machine.send("critique_fail")
            if self.machine.needs_more_context():
                self.machine.send("revise_explore")
            else:
                self.machine.send("revise_plan")

            if self.current_state_id == "exploring":
                return self._action_explore()
            else:
                return self._action_plan()

    def process_taskify_result(self, result: Dict[str, Any]) -> Dict[str, Any]:
        """Process taskifier summary and complete."""
        if not self._is_success_exit(result):
            self.context.errors.append(f"Taskifier failed: {result.get('error', 'unknown')}")
            self.machine.send("fail_taskify")
            return self._action("error", errors=self.context.errors)

        # Check for UNCERTAIN confidence
        escalation = self._check_confidence_and_handle("tabitha", result)
        if escalation:
            return escalation

        # Validate summary before parsing
        summary, error_action = self._extract_and_validate_summary("tabitha", result)
        if error_action:
            self.context.errors.append(f"Taskifier summary invalid: {error_action.get('errors', ['unknown'])[0]}")
            self.machine.send("fail_taskify")
            return self._action("error", errors=self.context.errors)

        self._parse_taskifier_summary(summary or {})
        self.machine.send("taskify_done")
        self.context.complete = True
        return self._action(
            "complete",
            plan_summary={
                "title": self.context.structured_plan_title,
                "step_count": self.context.structured_plan_step_count,
                "steps": self.context.plan_steps,
                "goal": self.context.goal,
                "non_goals": self.context.constraints.get("non_goals", []),
                "session_id": self.context.session_id,
                "requires_approval": True,
            },
            session_room=self.session_room,
        )

    # ── Main entry points ────────────────────────────────

    def start(self) -> Dict[str, Any]:
        """Start the workflow. Returns first action with state."""
        return self._action_intake()

    def step(self, agent: str, summary: Dict[str, Any]) -> Dict[str, Any]:
        """Process agent result summary and return next action with state."""
        if agent == "echo":
            results = summary if isinstance(summary, list) else [summary]
            return self.process_explore_result(results)
        elif agent == "piper":
            return self.process_plan_result(summary)
        elif agent == "carren":
            return self.process_critique_result(summary)
        elif agent == "tabitha":
            return self.process_taskify_result(summary)
        elif agent == "user":
            return self.process_user_clarification(summary)
        elif agent == "verification":
            return self.process_verification_result(summary)
        else:
            return self._action("error", errors=[f"Unknown agent: {agent}"])

    def process_user_clarification(self, summary: Dict[str, Any]) -> Dict[str, Any]:
        """Process user clarification after escalation.

        The user's response provides clarification_text that allows the
        FSM to resume from awaiting_clarification back to the working state
        that was interrupted.
        """
        clarification = summary.get("clarification", "")
        action_choice = summary.get("action_choice", "retry")

        self.context.clarification_text = clarification
        self.context.last_confidence = ""  # Reset — user has clarified

        if action_choice == "restart":
            # User wants to restart the entire plan
            self.context.errors.append("User chose to restart")
            try:
                if self.current_state_id == "unknown":
                    self.machine.send("abandon")
                else:
                    self.machine.send("abandon_clarification")
            except Exception as e:
                # State desync — force to error state
                self.context.errors.append(f"Could not abandon from state '{self.current_state_id}': {e}")
            return self._action("error", errors=["User chose to restart the planning process"])

        if action_choice == "skip":
            # User wants to skip this step — proceed with best available
            self.context.unknown_reason = ""
            # Resume to appropriate state based on previous_state
            resume_map = {
                "exploring": "resume_explore",
                "planning": "resume_plan",
                "critiquing": "resume_critique",
            }
            transition = resume_map.get(self.context.previous_state, "resume_explore")
            try:
                self.machine.send(transition)
            except Exception:
                # Fallback: force to exploring
                self.context.errors.append(f"Could not resume to {self.context.previous_state}, falling back to exploring")
                self._force_state("exploring")
            self.context.clarification_text = ""  # Clear AFTER transition succeeds
            return self._get_action_for_state()

        # Default: retry — resume to the interrupted working state
        resume_map = {
            "exploring": "resume_explore",
            "planning": "resume_plan",
            "critiquing": "resume_critique",
        }
        transition = resume_map.get(self.context.previous_state, "resume_explore")
        try:
            self.machine.send(transition)
        except Exception:
            self.context.errors.append(f"Could not resume to {self.context.previous_state}, falling back to exploring")
            self._force_state("exploring")
        return self._get_action_for_state()

    def process_verification_result(self, result: Dict[str, Any]) -> Dict[str, Any]:
        """Process user response to verification questionnaire.

        Accepts both Pi-native questionnaire format (details.answers array)
        and simplified direct format (choice string).

        Routes:
        - confirm  → proceed to critiquing
        - reject   → return to revising
        - escalate → transition to unknown for clarification
        """
        # Extract answer from Pi-native format or simplified format
        choice = "escalate"  # default

        # Try Pi-native format first
        details = result.get("details", {})
        answers = details.get("answers", [])
        if answers and len(answers) > 0:
            choice = answers[0].get("value", "escalate")
        else:
            # Fallback to simplified direct format
            choice = result.get("choice", "escalate")

        if choice == "confirm":
            self.context.verification_confirmed = True
            self.context.verification_rejected = False
            self.machine.send("verify_confirm")
            return self._get_action_for_state()

        if choice == "reject":
            self.context.verification_confirmed = False
            self.context.verification_rejected = True
            self.machine.send("verify_reject")
            return self._get_action_for_state()

        # Default / escalate: treat as unknown state
        self.context.verification_confirmed = False
        self.context.verification_rejected = False
        self.context.unknown_reason = (
            f"User escalated from verification of: {self.context.verification_pending}"
        )
        self.context.previous_state = "planning"
        try:
            self.machine.send("verify_abandon")
        except Exception:
            self.context.errors.append("Failed to transition from verifying to unknown")
            return self._action("error", errors=self.context.errors)
        return self._get_action_for_state()

    def _get_action_for_state(self) -> Dict[str, Any]:
        """Get the action for the current state (used for resume)."""
        state = self.current_state_id
        if state == "intake":
            return self._action_intake()
        elif state == "exploring":
            return self._action_explore()
        elif state == "planning":
            return self._action_plan()
        elif state == "revising":
            return self._action_plan()
        elif state == "verifying":
            return self._action_verify()
        elif state == "critiquing":
            return self._action_critique()
        elif state == "taskifying":
            return self._action_taskify()
        elif state == "unknown":
            return self._action_escalate()
        elif state == "awaiting_clarification":
            return self._action_escalate()
        elif state == "complete":
            return self._action("complete", plan_summary={
                "title": self.context.structured_plan_title,
                "step_count": self.context.structured_plan_step_count,
                "session_id": self.context.session_id,
            }, session_room=self.session_room)
        elif state == "error":
            return self._action("error", errors=self.context.errors)
        else:
            return self._action("error", errors=[f"Unknown state: {state}"])


def _check_statemachine_version() -> str:
    """Return the installed python-statemachine version for diagnostics.

    Skills depend on python-statemachine behavior. A Pi update might
    change the venv's version, breaking guards or transitions. This
    function lets the orchestrator log the version at startup.
    """
    try:
        import statemachine
        return getattr(statemachine, "__version__", "unknown")
    except Exception:
        return "unknown"


# ============================================================
# CLI Entry Point — stateless, receives state via --state
# ============================================================

def main():
    """CLI entry point — outputs minimal JSON action to stdout."""
    parser = argparse.ArgumentParser(description="Plan Skill Orchestrator")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # START command
    start_parser = subparsers.add_parser("start", help="Start workflow")
    start_parser.add_argument("--session-id", required=True)
    start_parser.add_argument("--goal", required=True)
    start_parser.add_argument("--project-root", default=".")
    start_parser.add_argument("--constraints", default="{}")

    # STEP command — state passed via CLI, not .context/
    step_parser = subparsers.add_parser("step", help="Process agent result and get next action")
    step_parser.add_argument("--session-id", required=True)
    step_parser.add_argument("--project-root", default=".")
    step_parser.add_argument("--agent", required=True, help="Agent that completed")
    step_parser.add_argument("--result", required=True, help="JSON result summary from agent")
    step_parser.add_argument("--state", required=True, help="JSON state blob from mempalace")

    # STATUS command
    status_parser = subparsers.add_parser("status", help="Get current session status")
    status_parser.add_argument("--session-id", required=True)
    status_parser.add_argument("--project-root", default=".")
    status_parser.add_argument("--state", required=True, help="JSON state blob from mempalace")

    args = parser.parse_args()

    try:
        constraints = json.loads(getattr(args, "constraints", "{}"))
    except json.JSONDecodeError:
        constraints = {}

    if args.command == "start":
        orchestrator = PlanOrchestrator(
            session_id=args.session_id,
            goal=args.goal,
            project_root=args.project_root,
            constraints=constraints,
        )
        action = orchestrator.start()

    elif args.command == "step":
        try:
            result_data = json.loads(args.result)
        except json.JSONDecodeError:
            result_data = {"exitCode": 1, "error": "Invalid result JSON"}

        try:
            state_data = json.loads(args.state)
        except json.JSONDecodeError:
            action = {"action": "error", "errors": ["Invalid state JSON"]}
            print(json.dumps(action, default=str))
            return

        goal = state_data.get("context", {}).get("goal", "")
        ctx_constraints = state_data.get("context", {}).get("constraints", {})

        orchestrator = PlanOrchestrator(
            session_id=args.session_id,
            goal=goal,
            project_root=args.project_root,
            constraints=ctx_constraints,
        )
        orchestrator.restore_state(state_data)
        action = orchestrator.step(args.agent, result_data)

    elif args.command == "status":
        try:
            state_data = json.loads(args.state)
        except json.JSONDecodeError:
            action = {"action": "status", "session_id": args.session_id, "state": "invalid_state"}
            print(json.dumps(action, default=str))
            return

        action = {
            "action": "status",
            "session_id": args.session_id,
            "state": state_data.get("current_state_id", "unknown"),
            "complete": state_data.get("context", {}).get("complete", False),
        }

    else:
        action = {"action": "error", "errors": [f"Unknown command: {args.command}"]}

    print(json.dumps(action, default=str))


if __name__ == "__main__":
    main()
