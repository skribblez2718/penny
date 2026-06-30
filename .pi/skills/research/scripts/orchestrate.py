"""
Research Skill Orchestrator

Lightweight orchestration: Penny reads minimal directives, not full prompts.
Agents are self-sufficient — they read context from mempalace, write results to mempalace.
State passes through Penny as a small JSON blob, stored in mempalace between steps.

Architecture:
  - ResearchWorkflow: Synchronous state machine (states, transitions, guards)
  - ResearchOrchestrator: Outputs MINIMAL JSON directives to stdout
  - Penny: Routes directives to agents, stores state in mempalace
  - Agents: Read/write mempalace for all substantial data

Key principle: Penny is a ROUTER, not a READER.
She sees agent names and session IDs, never full prompts or results.
"""

import argparse
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from statemachine import State, StateMachine

# ============================================================
# Context Data Class — Lean, no raw agent output stored
# ============================================================


@dataclass
class ResearchContext:
    """Per-session research state — only metadata, no raw output."""

    session_id: str = ""
    skill_name: str = "research"
    project_root: str = ""

    # Input
    query: str = ""
    mode: str = "auto"  # quick / standard / deep / auto
    purpose: str = "general"
    purpose_params: Dict[str, Any] = field(default_factory=dict)
    report_format: str = "default"
    constraints: Dict[str, Any] = field(default_factory=dict)

    # Mode detection
    detected_mode: str = "standard"

    # Planning (Piper)
    max_sub_queries: int = 0
    sub_queries: List[str] = field(default_factory=list)
    plan_complete: bool = False
    plan_critique_verdict: str = ""
    plan_critique_issues: List[str] = field(default_factory=list)

    # Research (Echo)
    research_task_ids: List[str] = field(default_factory=list)
    completed_tasks: List[str] = field(default_factory=list)
    tasks_total: int = 0
    research_complete: bool = False

    # Validation (Vera) — REMOVED in P3: folded into synthesizing
    # validation_complete: bool = False
    # unresolved_conflicts: List[str] = field(default_factory=list)

    # Synthesis (Synthia)
    synthesis_complete: bool = False
    report_word_count: int = 0

    # Report critique (Carren)
    report_critique_verdict: str = ""
    report_critique_issues: List[str] = field(default_factory=list)

    # Tracking
    iteration: int = 0
    max_iterations: int = 2
    errors: List[str] = field(default_factory=list)

    # UNKNOWN_STATE support
    last_confidence: str = ""  # CERTAIN/PROBABLE/POSSIBLE/UNCERTAIN
    clarification_text: str = ""  # User's clarification response
    unknown_reason: str = ""  # Why we entered unknown state

    # Report writing (Skribble)
    report_written: bool = False
    report_files: List[str] = field(default_factory=list)
    report_dir: str = ""

    # Output
    complete: bool = False


# ============================================================
# State Machine
# ============================================================


class ResearchWorkflow(StateMachine):
    """Research Workflow State Machine.

    UNKNOWN_STATE protocol:
    When any agent returns UNCERTAIN confidence, the FSM transitions to `unknown`
    via guard-triggered transitions. From `unknown`, the FSM escalates to
    `awaiting_clarification` which routes a questionnaire to the user.
    After clarification, the FSM resumes to the appropriate working state.

    Soft-error handling:
    `unknown` and `awaiting_clarification` are NOT replayable via transitions.
    _force_state redirects them to `planning` with error context preserved.
    """

    # States
    intake = State(initial=True)
    planning = State()
    critiquing_plan = State()
    revising_plan = State()
    researching = State()
    synthesizing = State()
    critiquing_report = State()
    revising_report = State()
    report_writing = State()
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    # ── Transitions: Happy Path ──────────────────────────
    start = intake.to(planning, cond="has_goal_and_not_quick")
    quick_research = intake.to(researching, cond="is_quick_mode")

    plan_done_deep = planning.to(critiquing_plan, cond="is_deep_mode_and_plan_complete")
    plan_to_research = planning.to(researching, cond="is_standard_mode_and_plan_complete")

    critique_pass = critiquing_plan.to(researching, cond="critique_approved")
    critique_revise = critiquing_plan.to(revising_plan, cond="has_issues")
    revise_plan_done = revising_plan.to(planning)

    research_done_deep = researching.to(synthesizing, cond="is_deep_mode_and_research_complete")
    research_to_synth_std = researching.to(
        synthesizing, cond="is_standard_mode_and_research_complete"
    )
    quick_to_synth = researching.to(synthesizing, cond="is_quick_mode_and_research_complete")

    synthesize_done_deep = synthesizing.to(
        critiquing_report, cond="is_deep_mode_and_synthesis_complete"
    )
    synth_to_report = synthesizing.to(report_writing, cond="is_not_deep_and_synthesis_complete")

    report_pass = critiquing_report.to(report_writing, cond="report_critique_approved")
    report_revise = critiquing_report.to(revising_report, cond="report_has_issues")
    revise_report_done = revising_report.to(synthesizing)

    report_done = report_writing.to(complete, cond="report_written")

    # ── Error Path ───────────────────────────────────────
    fail_any = (
        intake.to(error)
        | planning.to(error)
        | critiquing_plan.to(error)
        | researching.to(error)
        | synthesizing.to(error)
        | critiquing_report.to(error)
        | report_writing.to(error)
    )

    # ── UNKNOWN_STATE Protocol ──────────────────────────
    plan_unknown = planning.to(unknown, cond="confidence_is_uncertain")
    critique_plan_unknown = critiquing_plan.to(unknown, cond="confidence_is_uncertain")
    research_unknown = researching.to(unknown, cond="confidence_is_uncertain")
    synthesize_unknown = synthesizing.to(unknown, cond="confidence_is_uncertain")
    report_unknown = critiquing_report.to(unknown, cond="confidence_is_uncertain")
    report_write_unknown = report_writing.to(unknown, cond="confidence_is_uncertain")

    escalate = unknown.to(awaiting_clarification)

    resume_plan = awaiting_clarification.to(planning, cond="has_clarification")
    resume_research = awaiting_clarification.to(researching, cond="has_clarification")
    resume_synth = awaiting_clarification.to(synthesizing, cond="has_clarification")

    # ── Guards ──────────────────────────────────────────
    def has_goal_and_not_quick(self) -> bool:
        return bool(self.model.query) and self.model.detected_mode != "quick"

    def is_quick_mode(self) -> bool:
        return self.model.detected_mode == "quick"

    def is_standard_mode_and_plan_complete(self) -> bool:
        return self.model.detected_mode == "standard" and self.model.plan_complete

    def is_deep_mode_and_plan_complete(self) -> bool:
        return self.model.detected_mode == "deep" and self.model.plan_complete

    def is_standard_mode_and_research_complete(self) -> bool:
        return self.model.detected_mode == "standard" and self.model.research_complete

    def is_deep_mode_and_research_complete(self) -> bool:
        return self.model.detected_mode == "deep" and self.model.research_complete

    def is_quick_mode_and_research_complete(self) -> bool:
        return self.model.detected_mode == "quick" and self.model.research_complete

    def is_deep_mode_and_synthesis_complete(self) -> bool:
        return self.model.detected_mode == "deep" and self.model.synthesis_complete

    def is_not_deep_and_synthesis_complete(self) -> bool:
        return self.model.detected_mode != "deep" and self.model.synthesis_complete

    def critique_approved(self) -> bool:
        return self.model.plan_critique_verdict == "APPROVE"

    def has_issues(self) -> bool:
        """Guard: True when critique found issues or gave non-APPROVE verdict."""
        verdict = self.model.plan_critique_verdict
        issues = self.model.plan_critique_issues
        # Non-APPROVE verdict always means issues exist (even if list is empty)
        return verdict != "APPROVE" and (
            len(issues) > 0 or verdict in ("NEEDS_REVISION", "BLOCKED")
        )

    def report_critique_approved(self) -> bool:
        return self.model.report_critique_verdict == "APPROVE"

    def report_has_issues(self) -> bool:
        return (
            self.model.report_critique_verdict != "APPROVE"
            and len(self.model.report_critique_issues) > 0
        )

    def report_written(self) -> bool:
        return self.model.report_written

    def confidence_is_uncertain(self) -> bool:
        """Guard: only UNCERTAIN confidence triggers unknown state."""
        return self.model.last_confidence == "UNCERTAIN"

    def has_clarification(self) -> bool:
        """Guard: user has provided clarification text."""
        return bool(self.model.clarification_text)


# ============================================================
# Orchestrator
# ============================================================


class ResearchOrchestrator:
    """Lightweight orchestrator: outputs agent names + session context."""

    MODE_DEFAULTS = {
        "quick": {"min_sub_queries": 1, "max_sub_queries": 1, "min_invocations": 3},
        "standard": {"min_sub_queries": 2, "max_sub_queries": 3, "min_invocations": 5},
        "deep": {"min_sub_queries": 3, "max_sub_queries": 4, "min_invocations": 7},
    }

    def __init__(
        self,
        session_id: str,
        query: str,
        mode: str = "auto",
        project_root: str = ".",
        constraints: Optional[Dict[str, Any]] = None,
    ):
        self.session_id = session_id
        self.project_root = str(Path(project_root).resolve())

        self.context = ResearchContext(
            session_id=session_id,
            project_root=self.project_root,
            query=query,
            mode=mode,
        )

        if constraints:
            for key, value in constraints.items():
                if hasattr(self.context, key):
                    setattr(self.context, key, value)

        if self.context.mode == "auto":
            self.context.detected_mode = self._detect_mode(query)
        else:
            self.context.detected_mode = self.context.mode

        defaults = self.MODE_DEFAULTS.get(
            self.context.detected_mode, self.MODE_DEFAULTS["standard"]
        )
        if self.context.max_sub_queries == 0:
            self.context.max_sub_queries = defaults["max_sub_queries"]

        self.machine = ResearchWorkflow(model=self.context)

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

    # ── Mode Detection ─────────────────────────────────────

    @staticmethod
    def _detect_mode(query: str) -> str:
        query_lower = query.lower()
        deep_keywords = [
            "deep research",
            "comprehensive",
            "thorough",
            "in-depth",
            "detailed analysis",
            "exhaustive",
            "extensive research",
        ]
        if any(kw in query_lower for kw in deep_keywords):
            return "deep"
        quick_keywords = [
            "quick",
            "briefly",
            "summary",
            "tldr",
            "what is",
            "define",
            "explain briefly",
            "overview",
        ]
        if any(kw in query_lower for kw in quick_keywords):
            return "quick"
        word_count = len(re.findall(r"\w+", query))
        question_count = query.count("?")
        if word_count <= 10 and question_count == 1:
            return "quick"
        return "standard"

    @staticmethod
    def _sanitize_topic(query: str) -> str:
        """Sanitize a research query into a filesystem-safe directory name."""
        sanitized = re.sub(r"[^\w\s-]", "", query.lower())
        sanitized = re.sub(r"[-\s]+", "-", sanitized)
        return sanitized.strip("-")[:80]

    # ── State Serialization ────────────────────────────────

    def extract_state(self) -> Dict[str, Any]:
        return {
            "session_id": self.context.session_id,
            "current_state_id": self.current_state_id,
            "context": {
                "query": self.context.query,
                "mode": self.context.mode,
                "detected_mode": self.context.detected_mode,
                "purpose": self.context.purpose,
                "purpose_params": self.context.purpose_params,
                "report_format": self.context.report_format,
                "max_sub_queries": self.context.max_sub_queries,
                "sub_queries": self.context.sub_queries,
                "plan_complete": self.context.plan_complete,
                "plan_critique_verdict": self.context.plan_critique_verdict,
                "plan_critique_issues": self.context.plan_critique_issues,
                "research_task_ids": self.context.research_task_ids,
                "completed_tasks": self.context.completed_tasks,
                "tasks_total": self.context.tasks_total,
                "research_complete": self.context.research_complete,
                "synthesis_complete": self.context.synthesis_complete,
                "report_word_count": self.context.report_word_count,
                "report_critique_verdict": self.context.report_critique_verdict,
                "report_critique_issues": self.context.report_critique_issues,
                "report_written": self.context.report_written,
                "report_files": self.context.report_files,
                "report_dir": self.context.report_dir,
                "last_confidence": self.context.last_confidence,
                "clarification_text": self.context.clarification_text,
                "unknown_reason": self.context.unknown_reason,
                "iteration": self.context.iteration,
                "max_iterations": self.context.max_iterations,
                "errors": self.context.errors,
                "complete": self.context.complete,
            },
        }

    def restore_state(self, state: Dict[str, Any]) -> None:
        context_data = state.get("context", {})
        for key, value in context_data.items():
            if hasattr(self.context, key):
                setattr(self.context, key, value)
        saved_state = state.get("current_state_id", state.get("state_id", state.get("state", "")))
        if saved_state:
            self._force_state(saved_state)

    def _force_state(self, target_state: str) -> None:
        if target_state == "intake" or not target_state:
            return
        if target_state in ("unknown", "awaiting_clarification"):
            target_state = "planning"
            self.context.errors.append(
                f"Session recovered from {target_state} state — re-entering planning. "
                f"Original reason: {self.context.unknown_reason or 'unknown'}"
            )
        mode = self.context.detected_mode
        if mode == "quick":
            transitions_map = {
                "researching": ["quick_research"],
                "synthesizing": ["quick_research", "quick_to_synth"],
                "report_writing": ["quick_research", "quick_to_synth", "synth_to_report"],
                "complete": ["quick_research", "quick_to_synth", "synth_to_report", "report_done"],
            }
        elif mode == "standard":
            transitions_map = {
                "planning": ["start"],
                "researching": ["start", "plan_to_research"],
                "synthesizing": ["start", "plan_to_research", "research_to_synth_std"],
                "report_writing": [
                    "start",
                    "plan_to_research",
                    "research_to_synth_std",
                    "synth_to_report",
                ],
                "complete": [
                    "start",
                    "plan_to_research",
                    "research_to_synth_std",
                    "synth_to_report",
                    "report_done",
                ],
            }
        else:
            transitions_map = {
                "planning": ["start"],
                "critiquing_plan": ["start", "plan_done_deep"],
                "revising_plan": ["start", "plan_done_deep", "critique_revise"],
                "researching": ["start", "plan_done_deep", "critique_pass"],
                "synthesizing": ["start", "plan_done_deep", "critique_pass", "research_done_deep"],
                "critiquing_report": [
                    "start",
                    "plan_done_deep",
                    "critique_pass",
                    "research_done_deep",
                    "synthesize_done_deep",
                ],
                "revising_report": [
                    "start",
                    "plan_done_deep",
                    "critique_pass",
                    "research_done_deep",
                    "synthesize_done_deep",
                    "report_revise",
                ],
                "report_writing": [
                    "start",
                    "plan_done_deep",
                    "critique_pass",
                    "research_done_deep",
                    "synthesize_done_deep",
                    "report_pass",
                ],
                "complete": [
                    "start",
                    "plan_done_deep",
                    "critique_pass",
                    "research_done_deep",
                    "synthesize_done_deep",
                    "report_pass",
                    "report_done",
                ],
            }
        if target_state not in transitions_map:
            self.context.errors.append(
                f"Cannot force state to '{target_state}' — not in transitions_map for mode '{mode}'. "
                f"Falling back to 'planning'."
            )
            target_state = "planning"
            if mode == "quick":
                return
        for transition_name in transitions_map[target_state]:
            try:
                self.machine.send(transition_name)
            except Exception as e:
                self.context.errors.append(
                    f"Failed to restore state '{target_state}' at transition '{transition_name}': {e}"
                )
                return

    # ── Action Output ────────────────────────────────────

    def _action(self, action: str, **kwargs) -> Dict[str, Any]:
        return {
            "action": action,
            "state_id": self.current_state_id,
            "session_id": self.session_id,
            "session_room": f"skills/research-{self.session_id}",
            "orchestrator_state": self.extract_state(),
            **kwargs,
        }

    # ── Summary validation gatekeepers (H2 fix) ─────────
    # See research/skills-agent-output-mismatch-audit.md

    @staticmethod
    def _safe_default_summary(agent: str) -> Dict[str, Any]:
        """Return a minimal safe summary when an agent fails to emit one."""
        defaults = {
            "echo": {
                "findings_count": 0,
                "sources_count": 0,
                "explore_complete": False,
                "mempalace_drawer": "",
                "confidence": "UNCERTAIN",
            },
            "piper": {
                "plan_steps": [],
                "plan_complete": False,
                "confidence": "UNCERTAIN",
            },
            "carren": {
                "verdict": "NEEDS_REVISION",
                "issues": ["Agent did not emit SUMMARY or summary was empty"],
                "confidence": "UNCERTAIN",
            },
            "tabitha": {
                "title": "",
                "step_count": 0,
                "complete": False,
                "confidence": "UNCERTAIN",
            },
            "vera": {
                "verdict": "PASS",
                "validation_complete": False,
                "quality_gate_passed": False,
                "confidence": "UNCERTAIN",
            },
            "synthia": {
                "synthesis_complete": False,
                "theme_count": 0,
                "source_count": 0,
                "confidence": "UNCERTAIN",
            },
            "skribble": {
                "write_complete": False,
                "files_written": [],
                "word_count": 0,
                "theme_count": 0,
                "source_count": 0,
                "confidence": "UNCERTAIN",
            },
        }
        return defaults.get(agent, {"confidence": "UNCERTAIN"})

    def _extract_and_validate_summary(
        self, result_data: Dict[str, Any], agent: str, *, prefix: str = "Agent"
    ) -> Dict[str, Any]:
        """Extract summary from agent result; return safe default if missing/invalid."""
        if result_data.get("exitCode", 0) != 0:
            error_msg = result_data.get("error", "Unknown error")
            self.context.errors.append(f"{prefix} {agent} failed: {error_msg}")
            safe = self._safe_default_summary(agent)
            safe["_reason"] = f"Agent exit code non-zero: {error_msg}"
            return safe

        summary = result_data.get("summary")
        if not isinstance(summary, dict) or not summary:
            self.context.errors.append(
                f"Agent {agent} returned empty or missing summary. "
                f"Raw keys: {list(result_data.keys())}"
            )
            safe = self._safe_default_summary(agent)
            safe["_reason"] = "Missing or empty SUMMARY block"
            return safe

        return summary

    # ── Parsing helpers ───────────────────────────────────

    def _parse_plan_summary(self, summary: Dict[str, Any]) -> None:
        self.context.sub_queries = summary.get("plan_steps", [])
        self.context.plan_complete = summary.get("plan_complete", len(self.context.sub_queries) > 0)

    def _parse_critique_plan_summary(self, summary: Dict[str, Any]) -> None:
        self.context.plan_critique_verdict = summary.get("verdict", "NEEDS_REVISION")
        # Carren's SUMMARY emits counts, not a raw issues list — synthesize a proxy list
        # so downstream logic that checks len(plan_critique_issues) continues to work.
        raw_issues = summary.get("issues", [])
        if isinstance(raw_issues, list) and raw_issues:
            self.context.plan_critique_issues = raw_issues
        else:
            issues_count = summary.get("issues_count", 0)
            self.context.plan_critique_issues = ["(issue placeholder)"] * max(0, issues_count)

    def _parse_research_summary(self, summary: Dict[str, Any]) -> None:
        task_id = summary.get("mempalace_drawer", "")
        if task_id:
            self.context.completed_tasks.append(task_id)
        tasks = summary.get("tasks", [])
        if isinstance(tasks, list):
            for t in tasks:
                if t and t not in self.context.completed_tasks:
                    self.context.completed_tasks.append(t)
        elif isinstance(tasks, str) and tasks and tasks not in self.context.completed_tasks:
            self.context.completed_tasks.append(tasks)
        # Heuristic: enough tasks completed?
        self.context.research_complete = len(self.context.completed_tasks) >= len(
            self.context.research_task_ids
        )
        # Accept research_complete (canonical) or explore_complete (echo prompt alias) —
        # see research/skills-agent-output-mismatch-audit.md (H1 fix)
        if summary.get("research_complete", False) or summary.get("explore_complete", False):
            self.context.research_complete = True

    def _parse_synthesis_summary(self, summary: Dict[str, Any]) -> None:
        self.context.synthesis_complete = summary.get("synthesis_complete", False)
        self.context.report_word_count = summary.get("report_word_count", 0)
        if not self.context.synthesis_complete:
            if any(
                k in summary
                for k in (
                    "theme_count",
                    "source_count",
                    "themes",
                    "key_findings",
                    "synthesis",
                    "report",
                    "word_count",
                    "report_drawer",
                )
            ):
                self.context.synthesis_complete = True

    def _parse_report_critique_summary(self, summary: Dict[str, Any]) -> None:
        self.context.report_critique_verdict = summary.get("verdict", "NEEDS_REVISION")
        # Carren's SUMMARY emits counts, not a raw issues list — synthesize a proxy list
        # so downstream logic that checks len(report_critique_issues) continues to work.
        raw_issues = summary.get("issues", [])
        if isinstance(raw_issues, list) and raw_issues:
            self.context.report_critique_issues = raw_issues
        else:
            issues_count = summary.get("issues_count", 0)
            self.context.report_critique_issues = ["(issue placeholder)"] * max(0, issues_count)

    def _parse_report_write_summary(self, summary: Dict[str, Any]) -> None:
        """Extract file-writing metadata from Skribble summary."""
        self.context.report_written = summary.get("write_complete", False)
        files = summary.get("files_written", [])
        if isinstance(files, list):
            self.context.report_files = files
        elif isinstance(files, str) and files:
            self.context.report_files = [files]

    # ── State Entry Actions ────────────────────────────────

    def on_enter_planning(self) -> Dict[str, Any]:
        room = f"skills/research-{self.session_id}"
        return self._action(
            "invoke_agent",
            agent="piper",
            task_summary=f"Research planning: decompose '{self.context.query}' into sub-queries\n\nWrite your plan to mempalace room: {room}",
        )

    def on_enter_critiquing_plan(self) -> Dict[str, Any]:
        room = f"skills/research-{self.session_id}"
        return self._action(
            "invoke_agent",
            agent="carren",
            task_summary=f"Critique research plan for: {self.context.query}\n\nRead the plan from mempalace room: {room}",
        )

    def on_enter_researching(self) -> Dict[str, Any]:
        room = f"skills/research-{self.session_id}"
        if self.context.detected_mode == "quick":
            self.context.tasks_total = 1
            return self._action(
                "invoke_agent",
                agent="echo",
                task_summary=f"Quick research: {self.context.query}\n\nWrite findings to mempalace room: {room}",
            )
        tasks = []
        for i, sub_query in enumerate(self.context.sub_queries, 1):
            task_id = f"{self.session_id}-echo-{i}"
            self.context.research_task_ids.append(task_id)
            tasks.append(
                {
                    "agent": "echo",
                    "task_summary": f"Research sub-query {i}: {sub_query}\n\nWrite findings to mempalace room: {room}",
                }
            )
        self.context.tasks_total = len(tasks)
        return self._action(
            "invoke_agents_parallel",
            tasks=tasks,
            agent_timeout_ms=2700000,
        )

    def on_enter_synthesizing(self) -> Dict[str, Any]:
        room = f"skills/research-{self.session_id}"
        format_note = ""
        if self.context.report_format != "default":
            format_note = f" Use {self.context.report_format} format."
        return self._action(
            "invoke_agent",
            agent="synthia",
            task_summary=f"Synthesize research report for: {self.context.query}.{format_note}\n\nRead findings and validation from mempalace room: {room}",
            agent_timeout_ms=1200000,
        )

    def on_enter_critiquing_report(self) -> Dict[str, Any]:
        room = f"skills/research-{self.session_id}"
        return self._action(
            "invoke_agent",
            agent="carren",
            task_summary=f"Critique research report for: {self.context.query}\n\nRead the report from mempalace room: {room}",
        )

    def on_enter_report_writing(self) -> Dict[str, Any]:
        room = f"skills/research-{self.session_id}"
        topic = self._sanitize_topic(self.context.query)
        report_dir = f"~/projects/penny/research/{topic}"
        self.context.report_dir = report_dir
        return self._action(
            "invoke_agent",
            agent="skribble",
            task_summary=f"Write the final research report for: {self.context.query}\n\nWrite all files to: {report_dir}\n\nRead the synthesized report from mempalace room: {room}\n\nProduce: report.md (main report), sources.md (bibliography), README.md (quick reference).",
            agent_timeout_ms=600000,
        )

    def on_enter_unknown(self) -> Dict[str, Any]:
        self.context.unknown_reason = (
            f"Agent returned UNCERTAIN confidence in state: {self.current_state_id}"
        )
        return self._action(
            "escalate_to_user",
            questions=[
                {
                    "id": "clarification",
                    "label": "Research Clarification",
                    "prompt": f"The research agent is uncertain about the query: '{self.context.query}'.\n\nCan you clarify or provide additional context?",
                    "options": [
                        {
                            "value": "continue",
                            "label": "Continue",
                            "description": "Proceed with current approach",
                        },
                        {
                            "value": "clarify",
                            "label": "Clarify",
                            "description": "Provide additional context or constraints",
                        },
                    ],
                    "allowOther": True,
                }
            ],
            unknown_reason=self.context.unknown_reason,
            previous_state=self._get_previous_working_state(),
        )

    def on_enter_complete(self) -> Dict[str, Any]:
        self.context.complete = True
        return self._action(
            "complete",
            result={
                "query": self.context.query,
                "mode": self.context.detected_mode,
                "sub_queries": self.context.sub_queries,
                "report_drawer_id": f"{self.session_id} synthesis",
                "sources_count": len(self.context.completed_tasks),
                "room": f"skills/research-{self.session_id}",
            },
        )

    def on_enter_error(self) -> Dict[str, Any]:
        return self._action(
            "error",
            result={
                "query": self.context.query,
                "mode": self.context.detected_mode,
                "errors": self.context.errors,
                "state_at_error": self.current_state_id,
            },
        )

    def start(self) -> Optional[Dict[str, Any]]:
        return self.next_action()

    def step(self, agent_name: str, result_data: Any) -> Optional[Dict[str, Any]]:
        """Process an agent result and return the next action."""
        # Handle parallel results (array of entries) — aggregate into single summary
        if isinstance(result_data, list):
            all_task_ids = []
            all_findings = []
            all_unknowns = []
            has_errors = False
            total_tasks = 0
            for entry in result_data:
                if not isinstance(entry, dict):
                    continue
                total_tasks += 1
                # H2 validation gatekeeper
                summary = self._extract_and_validate_summary(
                    entry, entry.get("agent", agent_name), prefix="Parallel agent"
                )
                if "_reason" in summary:
                    # Error was logged inside _extract_and_validate_summary
                    has_errors = True
                    continue
                tasks = summary.get("tasks", [])
                if isinstance(tasks, list):
                    all_task_ids.extend(t for t in tasks if t)
                elif isinstance(tasks, str) and tasks:
                    all_task_ids.append(tasks)
                drawer = summary.get("mempalace_drawer", "")
                if drawer and drawer not in all_task_ids:
                    all_task_ids.append(drawer)
                findings = summary.get("findings", [])
                if isinstance(findings, list):
                    all_findings.extend(findings)
                unknowns = summary.get("unknowns", [])
                if isinstance(unknowns, list):
                    all_unknowns.extend(unknowns)
            success_count = len(all_task_ids)
            if success_count == 0:
                self.context.errors.append("No parallel tasks completed successfully")
                self.machine.send("fail_any")
                return self.next_action()
            elif success_count < total_tasks / 2:
                self.context.errors.append(
                    f"{success_count} of {total_tasks} parallel research tasks succeeded — insufficient data"
                )
                self.machine.send("fail_any")
                return self.next_action()
            elif success_count < total_tasks:
                self.context.errors.append(
                    f"{success_count} of {total_tasks} parallel research tasks succeeded — proceeding with partial data"
                )
                self.context.research_complete = True
            aggregated = {
                "tasks": all_task_ids,
                "findings": all_findings,
                "unknowns": all_unknowns,
                "research_complete": True,
            }
            return self.advance(aggregated)

        # Handle single-agent result (dict)
        if not isinstance(result_data, dict):
            self.context.errors.append(
                f"Unexpected result type for {agent_name}: {type(result_data).__name__}"
            )
            self.machine.send("fail_any")
            return self.next_action()

        # Handle error results
        if result_data.get("exitCode") != 0:
            self.context.errors.append(
                f"Agent {agent_name} failed: {result_data.get('error', 'Unknown error')}"
            )
            if self.context.iteration < self.context.max_iterations:
                self.context.iteration += 1
                return self.next_action()
            else:
                self.machine.send("fail_any")
                return self.next_action()

        # H2 validation gatekeeper: replaces loose error handling
        summary = self._extract_and_validate_summary(result_data, agent_name, prefix="Agent")
        return self.advance(summary)

    # ── Main Loop ──────────────────────────────────────────

    def next_action(self) -> Optional[Dict[str, Any]]:
        if self.is_terminal:
            return None
        state = self.current_state_id
        state_actions = {
            "planning": self.on_enter_planning,
            "critiquing_plan": self.on_enter_critiquing_plan,
            "researching": self.on_enter_researching,
            "synthesizing": self.on_enter_synthesizing,
            "critiquing_report": self.on_enter_critiquing_report,
            "report_writing": self.on_enter_report_writing,
            "unknown": self.on_enter_unknown,
            "complete": self.on_enter_complete,
            "error": self.on_enter_error,
        }
        if state in state_actions:
            return state_actions[state]()
        if state == "intake":
            if self.context.detected_mode == "quick":
                self.machine.send("quick_research")
            else:
                self.machine.send("start")
            return self.next_action()
        if state == "revising_plan":
            self.machine.send("revise_plan_done")
            return self.next_action()
        if state == "revising_report":
            self.machine.send("revise_report_done")
            return self.next_action()
        if state == "awaiting_clarification":
            if self.context.clarification_text:
                prev = self._get_previous_working_state()
                if prev == "planning":
                    self.machine.send("resume_plan")
                elif prev == "researching":
                    self.machine.send("resume_research")
                else:
                    self.machine.send("resume_synth")
                self.context.clarification_text = ""
                return self.next_action()
            return None
        return None

    def _get_previous_working_state(self) -> str:
        if self.context.sub_queries and not self.context.research_complete:
            return "researching"
        if self.context.research_complete and not self.context.synthesis_complete:
            return "synthesizing"
        if self.context.synthesis_complete and not self.context.report_written:
            return "report_writing"
        return "planning"

    def advance(self, agent_summary: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        previous_state = self.current_state_id
        confidence = agent_summary.get("confidence", "")
        if confidence:
            self.context.last_confidence = confidence

        # Auto-route UNCERTAIN confidence to unknown state (M5 fix)
        # Mirrors plan/agent skill behavior. Must happen BEFORE needs_clarification
        # so that agents that forget to set needs_clarification but set confidence
        # still get routed correctly.
        # See research/skills-agent-output-mismatch-audit.md
        if self.context.last_confidence.upper() == "UNCERTAIN" and not agent_summary.get(
            "needs_clarification"
        ):
            transition_map = {
                "planning": "plan_unknown",
                "critiquing_plan": "critique_plan_unknown",
                "researching": "research_unknown",
                "synthesizing": "synthesize_unknown",
                "critiquing_report": "report_unknown",
                "report_writing": "report_write_unknown",
            }
            transition = transition_map.get(previous_state)
            if transition:
                self.context.previous_state = previous_state
                self.context.unknown_reason = (
                    f"Agent returned UNCERTAIN confidence in state: {previous_state}"
                )
                try:
                    self.machine.send(transition)
                except Exception as e:
                    self.context.errors.append(f"Failed to send transition {transition}: {e}")
                    self.machine.send("escalate")
                return self.next_action()

        # NEW: Detect agent-side clarification signal (parent-process questionnaire pattern)
        # When a subagent can't ask the user directly (non-interactive mode), it signals
        # needs_clarification in its SUMMARY. We route this through the UNKNOWN_STATE
        # escalation path, which presents questions at the parent level (Penny/DA).
        if agent_summary.get("needs_clarification"):
            questions = agent_summary.get("clarifying_questions", [])
            self.context.last_confidence = "UNCERTAIN"
            self.context.previous_state = previous_state
            self.context.unknown_reason = f"Agent needs clarification in {previous_state}: {'; '.join(questions) if questions else 'Missing critical information'}"
            self.context.clarification_text = ""
            # Fire the appropriate *_unknown transition
            transition_map = {
                "planning": "plan_unknown",
                "critiquing_plan": "critique_plan_unknown",
                "researching": "research_unknown",
                "synthesizing": "synthesize_unknown",
                "critiquing_report": "report_unknown",
                "report_writing": "report_write_unknown",
            }
            transition = transition_map.get(previous_state)
            if transition:
                self.machine.send(transition)
            else:
                self.machine.send("escalate")
            return self.next_action()

        if self.current_state_id == "intake":
            if self.context.detected_mode == "quick":
                self.machine.send("quick_research")
            else:
                self.machine.send("start")
        state = self.current_state_id
        if state == "planning":
            self._parse_plan_summary(agent_summary)
            if self.context.plan_complete:
                if self.context.detected_mode == "deep":
                    self.machine.send("plan_done_deep")
                else:
                    self.machine.send("plan_to_research")
        elif state == "critiquing_plan":
            self._parse_critique_plan_summary(agent_summary)
            if self.context.plan_critique_verdict == "APPROVE":
                self.machine.send("critique_pass")
            elif self.context.plan_critique_verdict in ("NEEDS_REVISION", "BLOCKED"):
                self.machine.send("critique_revise")
            # If somehow no transition fires, the state-change guard below will catch it.
        elif state == "researching":
            self._parse_research_summary(agent_summary)
            if self.context.research_complete:
                if self.context.detected_mode == "deep":
                    self.machine.send("research_done_deep")
                elif self.context.detected_mode == "standard":
                    self.machine.send("research_to_synth_std")
                else:
                    self.machine.send("quick_to_synth")
        elif state == "synthesizing":
            self._parse_synthesis_summary(agent_summary)
            if self.context.synthesis_complete:
                if self.context.detected_mode == "deep":
                    self.machine.send("synthesize_done_deep")
                else:
                    self.machine.send("synth_to_report")
        elif state == "critiquing_report":
            self._parse_report_critique_summary(agent_summary)
            if self.context.report_critique_verdict == "APPROVE":
                self.machine.send("report_pass")
            elif self.context.report_critique_verdict in ("NEEDS_REVISION", "BLOCKED"):
                self.machine.send("report_revise")
            # If somehow no transition fires, the state-change guard below will catch it.
        elif state == "report_writing":
            self._parse_report_write_summary(agent_summary)
            if self.context.report_written:
                self.machine.send("report_done")
        if self.current_state_id == previous_state:
            if state == "researching" and len(self.context.completed_tasks) < len(
                self.context.research_task_ids
            ):
                return None
            summary_keys = list(agent_summary.keys()) if isinstance(agent_summary, dict) else []
            self.context.errors.append(
                f"No transition fired from state '{state}' after processing agent result. "
                f"Summary keys: {summary_keys}. "
                f"Context flags: plan_complete={self.context.plan_complete}, "
                f"research_complete={self.context.research_complete}, "
                f"synthesis_complete={self.context.synthesis_complete}."
            )
            self.machine.send("fail_any")
            return self.next_action()
        if self.is_terminal:
            if self.current_state_id == "complete":
                return self.on_enter_complete()
            if self.current_state_id == "error":
                return self.on_enter_error()
            return None
        return self.next_action()


# ============================================================
# CLI Entry Point
# ============================================================


def main() -> None:
    try:
        _main_inner()
    except Exception as e:
        import traceback

        print(
            json.dumps(
                {
                    "action": "error",
                    "state_id": "error",
                    "session_id": "",
                    "errors": [f"Orchestrator exception: {str(e)}", traceback.format_exc()],
                }
            )
        )


def _main_inner() -> None:
    parser = argparse.ArgumentParser(description="Research Skill Orchestrator")
    subparsers = parser.add_subparsers(dest="command", required=True)

    start_parser = subparsers.add_parser("start", help="Start workflow")
    start_parser.add_argument("--session-id", required=True)
    start_parser.add_argument("--goal", required=True, help="Research query")
    start_parser.add_argument("--project-root", default=".")
    start_parser.add_argument("--constraints", default="{}")

    step_parser = subparsers.add_parser("step", help="Process agent result and get next action")
    step_parser.add_argument("--session-id", required=True)
    step_parser.add_argument("--project-root", default=".")
    step_parser.add_argument("--agent", required=True, help="Agent that completed")
    step_parser.add_argument("--result", required=True, help="JSON result summary from agent")
    step_parser.add_argument("--state", required=True, help="JSON state blob from mempalace")

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
        mode = constraints.get("mode", "auto")
        query = args.goal
        orchestrator = ResearchOrchestrator(
            session_id=args.session_id,
            query=query,
            mode=mode,
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

        query = state_data.get("context", {}).get("query", "")
        ctx_constraints = state_data.get("context", {}).get("constraints", {})
        mode = state_data.get("context", {}).get("mode", "auto")

        orchestrator = ResearchOrchestrator(
            session_id=args.session_id,
            query=query,
            mode=mode,
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

    if action:
        print(json.dumps(action, default=str))
    else:
        print(
            json.dumps(
                {
                    "action": "error",
                    "state_id": orchestrator.current_state_id,
                    "session_id": args.session_id,
                    "errors": [
                        "Orchestrator returned no action — state may be stalled or terminal"
                    ],
                    "orchestrator_state": orchestrator.extract_state(),
                }
            )
        )


if __name__ == "__main__":
    main()
