"""
Code Skill Orchestrator - Ralph Wiggum Loop FSM

States:
    explore → analyze → plan → implement → verify → learn
    learn → implement (loop back)
    learn → complete (exit)
    any → unknown → awaiting_clarification
    any → error

Requires PRD + IDEAL_STATE from prd skill (hard dependency).

Usage:
    python orchestrate.py start --session-id <id> --goal "<goal>" --state-data '<json>'
    python orchestrate.py step --session-id <id>
    python orchestrate.py status --session-id <id>
"""

import json
import re
import sys
from pathlib import Path
from typing import Optional

try:
    from statemachine import StateChart, State
except ImportError:
    print("ERROR: python-statemachine required. Run: uv pip install python-statemachine", file=sys.stderr)
    sys.exit(1)

# Project root for shared scripts
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent
VALIDATE_SCRIPT = str(PROJECT_ROOT / "scripts" / "validate_ideal_state.py")

# ============================================================
# Data Model
# ============================================================

class CodeSession:
    """Serializable session state."""
    def __init__(self, session_id: str, goal: str):
        self.session_id = session_id
        self.goal = goal
        self.language: Optional[str] = None
        self.prd: dict = {}
        self.ideal_state: dict = {}
        self.explore_findings: dict = {}
        self.analyze_findings: dict = {}
        self.plan: dict = {}
        self.implement_result: dict = {}
        self.verify_result: dict = {}
        self.iteration: int = 0
        self.phase_ideal_states: list[dict] = []
        self.current_phase: int = 0
        self.last_confidence: str = ""
        self.previous_state: str = ""
        self.unknown_reason: str = ""
        # Project root (where the code being built lives) — used to scan
        # for server-framework imports and to locate entry points for
        # server-startup verification.
        self.project_root: str = ""
        # Auto-detected server info, populated by ``_detect_server_framework``
        # after the ideal state is built. Shape:
        #   {
        #     "is_server": True,
        #     "language": "python" | "typescript",
        #     "framework": "fastapi" | "flask" | ...,
        #     "entry_points": ["/abs/path/to/main.py", ...],
        #     "evidence": "fastapi in pyproject.toml + backend/main.py",
        #   }
        self.server_info: dict = {}
        # Consecutive carren-loop-back count. Reset to 0 each time
        # implement is entered from a FRESH path (not from learn).
        # When carren_loop >= 3, the loop escalates to complete.
        self.carren_loop: int = 0
        # Flag set by the final-verify gate: when True, the next verify
        # step should route to complete, not back to learn.
        self._final_verify: bool = False
        # Gate flags for user-interactive phases.
        # _criteria_validated: carren has evaluated IDEAL_STATE criteria.
        self._criteria_validated: bool = False
        # _criteria_gap: carren found issues with the criteria themselves.
        self._criteria_gap: list = []
        # _plan_approved: user has approved the plan before implementation.
        self._plan_approved: bool = False
        # _plan_summary: structured summary of the plan for user review.
        self._plan_summary: dict = {}
        # Auto-detected multi-server info. Populated by
        # ``_detect_multi_server`` after the server_info is built. Shape:
        #   {
        #     "is_multi_server": True,
        #     "services": [
        #       {"name": "backend",  "kind": "python-server", "command": "...", "evidence": "fastapi in pyproject.toml"},
        #       {"name": "frontend", "kind": "vite-dev-server", "command": "bun run dev", "evidence": "vite in frontend/package.json"},
        #     ],
        #     "evidence": "backend + frontend detected",
        #   }
        # Drives injection of resources/project-structure.md and the
        # multi-server single-command-startup rule.
        self.multi_server_info: dict = {}

    def to_dict(self) -> dict:
        return self.__dict__

    @classmethod
    def from_dict(cls, data: dict) -> "CodeSession":
        session = cls(data["session_id"], data["goal"])
        for key, value in data.items():
            if hasattr(session, key):
                setattr(session, key, value)
        return session


# ============================================================
# State Machine
# ============================================================

class CodeWorkflow(StateChart):
    """Ralph Wiggum Loop for coding tasks."""

    # States (explore is the entry point; prd skill handles intake+specs)
    explore = State(initial=True)
    analyze = State()
    plan = State()
    implement = State()
    verify = State()
    learn = State()
    complete = State(final=True)
    error = State(final=True)
    unknown = State()
    awaiting_clarification = State()

    # === EXPLORE ===
    explore_done = explore.to(analyze)
    explore_blocked = explore.to(unknown)

    # === ANALYZE ===
    analyze_done = analyze.to(plan)
    analyze_blocked = analyze.to(unknown)

    # === PLAN ===
    plan_ready = plan.to(implement)
    plan_blocked = plan.to(unknown)

    # === IMPLEMENT ===
    implement_done = implement.to(verify)

    # === VERIFY ===
    verify_pass = verify.to(learn, cond="criteria_met")
    verify_fail = verify.to(learn, cond="criteria_not_met")  # Learn evaluates gap

    # === LEARN ===
    learn_retry = learn.to(implement, cond="gap_exists")
    learn_done = learn.to(complete, cond="ideal_state_achieved")

    # === ESCALATION ===
    escalate = unknown.to(awaiting_clarification)
    resume = awaiting_clarification.to(explore, cond="has_clarification")
    abandon = unknown.to(error)

    # === ERROR ===
    explore_error = explore.to(error)
    analyze_error = analyze.to(error)
    plan_error = plan.to(error)
    verify_error = verify.to(error)
    learn_error = learn.to(error)
    implement_error = implement.to(error)

    def __init__(self, session: CodeSession):
        self.session = session
        super().__init__()

    def criteria_met(self) -> bool:
        return self.session.verify_result.get("passed", False)

    def criteria_not_met(self) -> bool:
        return not self.session.verify_result.get("passed", True)

    def gap_exists(self) -> bool:
        return self.session.learn_result.get("gap", False)

    def ideal_state_achieved(self) -> bool:
        return not self.session.learn_result.get("gap", True)

    def has_clarification(self) -> bool:
        return bool(getattr(self.session, "clarification_text", ""))


# ============================================================
# Action Builders
# ============================================================

def action_invoke_agent(agent: str, task: str, session_id: str = "", **kwargs) -> dict:
    """Build an invoke_agent action for the skill extension.

    Every state-transition agent invocation is a ``logical_step`` —
    it represents meaningful progress through the skill pipeline,
    not an internal sub-agent spawn. The extension uses this flag
    to count iterations accurately.
    """
    result = {
        "action": "invoke_agent",
        "agent": agent,
        "task": task,
        "state_id": kwargs.get("state_id", "explore"),
        "session_id": session_id,
        "logical_step": True,
        **kwargs,
    }
    return result

def action_skill(skill_name: str, goal: str) -> dict:
    """Build an invoke_skill action."""
    return {
        "action": "invoke_skill",
        "skill_name": skill_name,
        "goal": goal,
        "logical_step": True,
    }

def action_escalate_to_user(questions: list, state_id: str, session_id: str, orchestrator_state: dict = None, context: dict = None) -> dict:
    """Build an escalation action compatible with the skill extension."""
    action = {
        "action": "escalate_to_user",
        "state_id": state_id,
        "session_id": session_id,
        "questions": questions,
        "previous_state": state_id,
        "logical_step": True,
    }
    if orchestrator_state is not None:
        action["orchestrator_state"] = orchestrator_state
    if context is not None:
        action["context"] = context
    return action

def action_complete(summary: str) -> dict:
    """Build a complete action."""
    return {
        "action": "complete",
        "summary": summary,
        "logical_step": True,
    }

def action_error(reason: str) -> dict:
    """Build an error action."""
    return {
        "action": "error",
        "reason": reason,
    }


# ============================================================
# State Handlers
# ============================================================

def handle_explore(session: CodeSession) -> dict:
    """Explore: Deep dive into affected code areas. Entry point for the skill."""
    # Apply server detection to enrich IDEAL STATE with server-startup verification
    _apply_server_detection(session)

    ideal_state = session.ideal_state
    language = session.language

    return action_invoke_agent(
        agent="echo",
        task=f"Deep exploration. IDEAL STATE: {json.dumps(ideal_state)}. "
             f"Language: {language}. "
             f"Find: all impacted files, existing patterns, coding conventions, "
             f"test patterns, integration points. "
             f"Session: {session.session_id} | "
             f"Sources: {', '.join(ideal_state.get('deliverables', []))}"
    )


def _apply_server_detection(session: CodeSession) -> None:
    """Detect a server framework in the project and update the session.

    Called after the ideal state is built. Populates ``session.server_info``
    and flips ``ideal_state.verification.server_startup`` to True if a
    server framework is found. The implement/verify phases use these
    flags to add server-startup integration tests.
    """
    if not session.project_root:
        # No project root known (e.g. very early in a session) — skip.
        return
    info = _detect_server_framework(session.project_root)
    session.server_info = info
    if info.get("is_server"):
        # Auto-enable the server-startup verification tier. Both Penny
        # (during PRD synthesis) and Synthia (during fixup) can override
        # this in the ideal_state, but the orchestrator will re-assert
        # it after detection to ensure it is never silently dropped.
        verification = session.ideal_state.setdefault("verification", {})
        verification["server_startup"] = True
        verification.setdefault("server_framework", info.get("framework"))
        verification.setdefault("server_entry_points", info.get("entry_points", []))
        verification.setdefault("server_evidence", info.get("evidence", ""))

    # Multi-server detection runs unconditionally — even non-server
    # projects can be multi-server (a Python CLI + a worker, two
    # backends, etc.). The detector decides. Result populates
    # session.multi_server_info and flips the multi_server flag in
    # ideal_state.verification so the plan/implement phases know.
    ms_info = _detect_multi_server(session.project_root)
    session.multi_server_info = ms_info
    if ms_info.get("is_multi_server"):
        verification = session.ideal_state.setdefault("verification", {})
        verification["multi_server"] = True
        verification.setdefault("multi_server_services", ms_info.get("services", []))
        verification.setdefault("multi_server_evidence", ms_info.get("evidence", ""))



def handle_analyze(session: CodeSession) -> dict:
    """Analyze: Security risks, integration surface, dependencies."""
    ideal_state = session.ideal_state

    # Build security review list
    security_domains = ideal_state.get("security_review", [])
    security_docs = " ".join(
        f"docs/agents/secure-coding/{d}.md" for d in security_domains
    ) if security_domains else "docs/agents/secure-coding/AGENTS.md"

    return action_invoke_agent(
        agent="annie",
        task=f"Analyze security and integration risks. "
             f"IDEAL STATE: {json.dumps(ideal_state)}. "
             f"Review: {security_docs}. "
             f"Identify: vulnerability patterns, integration risks, "
             f"dependency conflicts, edge cases not in IDEAL STATE. "
             f"Session: {session.session_id}"
    )


def handle_plan(session: CodeSession) -> dict:
    """Plan: Synthesize findings into TDD implementation plan."""
    ideal_state = session.ideal_state
    verification = ideal_state.get("verification", {})
    is_server = bool(verification.get("server_startup"))
    server_block = ""
    if is_server:
        framework = verification.get("server_framework", "server")
        entry_points = verification.get("server_entry_points", [])
        server_block = (
            f"\n\nSERVER-STARTUP TEST PLAN (REQUIRED):\n"
            f"This project ships a {framework} server. The implementation phase MUST include an integration test that actually starts the server in a background thread (or subprocess) and makes real HTTP requests against it. Mock heavy dependencies (databases, model downloads, third-party APIs) but use the real framework, real middleware, real CORS, real startup, and real handlers. See `.pi/skills/code/resources/server-startup-tests.md` for the mandatory checklist.\n"
            f"\nEntry points to cover: {entry_points if entry_points else '(auto-detect during implement)'}\n"
            f"The plan must include: (1) server-startup integration test, (2) entry-point-script-from-its-own-dir test, (3) CORS preflight test if applicable. These are NON-NEGOTIABLE for server projects — the orchestrator's verify phase will fail if any are missing."
        )
    return action_invoke_agent(
        agent="piper",
        task=f"Create TDD implementation plan. "
             f"IDEAL STATE: {json.dumps(ideal_state)}. "
             f"Language: {session.language}. "
             f"Include: dependency chains, build order (dependencies first), "
             f"phase-by-phase IDEAL STATES for each build step, "
             f"test strategy (unit first, then integration, then E2E). "
             f"Note: integration/E2E tests may have unmet dependencies initially - "
             f"document these in the plan. "
             f"Session: {session.session_id}"
             f"{server_block}"
             f"{_build_multi_server_block(session)}"
    )


def handle_criteria(session: CodeSession) -> dict:
    """Gate 1: Carren evaluates the IDEAL_STATE criteria for quality before
    the plan phase begins. This catches underspecified, immeasurable, or
    missing criteria early.

    If carren finds gaps in the criteria themselves (not the implementation),\n    the result escalates to the user via questionnaire so the user can clarify
    before any implementation work begins.
    """
    ideal_state = session.ideal_state
    criteria_list = ideal_state.get("success_criteria", [])

    return action_invoke_agent(
        agent="carren",
        task=f"Evaluate the IDEAL_STATE criteria for quality and completeness. "
             f"Do NOT evaluate implementation — there is none yet. Evaluate "
             f"WHETHER THE CRITERIA THEMSELVES are well-formed.\n\n"
             f"Criteria to evaluate:\n"
             + "\n".join(f"  [{i+1}] {c}" for i, c in enumerate(criteria_list)) + "\n\n"
             f"For each criterion, assess:\n"
             f"  1. Is it measurable (can we objectively tell if it's met)?\n"
             f"  2. Is it achievable within this project scope?\n"
             f"  3. Is it precise (not vague like 'works well' or 'is fast')?\n"
             f"  4. Is it non-overlapping with other criteria?\n"
             f"\n"
             f"Respond with SUMMARY: {{\"gap\": true/false, \"findings\": [\"...\"], "
             f"\"criteria_issues\": {{\"criterion_index\": [\"issue\", ...]}}}}\n"
             f"\n"
             f"If gap=true: list exactly which criteria need improvement and why.\n"
             f"If gap=false: confirm the criteria are measurable and complete.\n"
             f"\n"
             f"IDEAL STATE (full): {json.dumps(ideal_state)}\n"
             f"Session: {session.session_id}",
        session_id=session.session_id,
        state_id="criteria",
    )


def handle_plan_approve(session: CodeSession) -> dict:
    """Gate 2: Present the plan to the user and get explicit approval
    before implementation. The plan is summarized as a structured\n    proposal; the user must approve (or escalate) before code is written.\n\n    Returns an escalate_to_user action with the plan summary, which\n    the extension surfaces to Penny for questionnaire routing. Penny\n    presents the plan to the user and collects their decision."""
    plan = session.plan or {}
    ideal_state = session.ideal_state

    # Build a condensed plan summary from the plan and IDEAL_STATE
    build_order = ideal_state.get("build_order", [])
    deliverables = ideal_state.get("deliverables", [])
    criteria = ideal_state.get("success_criteria", [])
    anti = ideal_state.get("anti_criteria", [])

    summary_lines = [
        "## Plan Summary",
        "",
        "### Goal",
        f"{ideal_state.get('goal', session.goal)}",
        "",
        "### Build Order",
    ]
    for i, step in enumerate(build_order):
        summary_lines.append(f"  {i+1}. {step}")
    summary_lines.append("")
    summary_lines.append("### Key Deliverables")
    for d in deliverables[:15]:
        summary_lines.append(f"  - {d}")
    if len(deliverables) > 15:
        summary_lines.append(f"  ... and {len(deliverables)-15} more")
    summary_lines.append("")
    summary_lines.append("### Success Criteria")
    for i, c in enumerate(criteria):
        summary_lines.append(f"  - Criterion {i+1}: {c}")
    summary_lines.append("")
    summary_lines.append("### Anti-Criteria (will NOT be built)")
    for a in anti:
        summary_lines.append(f"  - {a}")

    plan_summary = "\n".join(summary_lines)

    return action_escalate_to_user(
        questions=[
            {
                "id": "plan_approval",
                "label": "Plan Review",
                "prompt": plan_summary + "\n\n---\n\n**Do you approve this plan?**\n\n"
                         f"- **Approve**: Start implementing immediately.\n"
                         f"- **Refine**: I'll tell you what to change first.\n"
                         f"- **Deny**: Discard this plan and stop.",
                "options": [
                    {"value": "approve", "label": "Approve",
                     "description": "Begin implementing the build order"},
                    {"value": "refine", "label": "Refine",
                     "description": "Modify the plan before implementation"},
                    {"value": "deny", "label": "Deny",
                     "description": "Discard this plan entirely"},
                ],
                "allowOther": True,
            }
        ],
        state_id="plan_approval",
        session_id=session.session_id,
        context={"plan_summary": plan_summary},
        orchestrator_state=session.to_dict(),
    )


def handle_criteria_fix(session: CodeSession) -> dict:
    """Gate 1b: Carren found issues with the IDEAL_STATE criteria.
    Present the specific issues to the user via questionnaire, asking
    them to refine the underspecified criteria before we re-evaluate.

    This is NOT invoking carren — it's presenting carren's findings to
    the user and asking for input. The user's response feeds back into
    the `criteria` state which re-invokes carren with the updated context.
    """
    ideal_state = session.ideal_state
    criteria_list = ideal_state.get("success_criteria", [])
    issues = getattr(session, "criteria_issues", {})
    findings = getattr(session, "criteria_findings", [])

    # Build a clear issue summary
    issue_lines = []
    if issues:
        for idx_str, issue_list in issues.items():
            try:
                idx = int(idx_str)
                criterion = criteria_list[idx - 1] if 0 <= idx - 1 < len(criteria_list) else "(unknown)"
                issue_lines.append(f"### Criterion {idx}: {criterion}")
                for iss in issue_list:
                    issue_lines.append(f"- {iss}")
                issue_lines.append("")
            except (ValueError, IndexError):
                pass
    if findings:
        issue_lines.append("### General Issues")
        for f in findings:
            issue_lines.append(f"- {f}")

    prompt_body = "\n".join(issue_lines) if issue_lines else "No specific issues identified, but criteria need improvement."

    summary = [
        "## Criteria Refinement Needed",
        "",
        "Carren identified issues with the IDEAL_STATE success criteria. ",
        "These need to be refined before planning and implementation can begin.",
        "",
        prompt_body,
    ]

    return action_escalate_to_user(
        questions=[
            {
                "id": "criteria_refinement",
                "label": "Criteria Fix",
                "prompt": "\n".join(summary) + "\n\n---\n\n"
                         f"**How would you like to proceed?**\n\n"
                         f"- **Refine criteria** (default): Tell me what to change in the criteria.\n"
                         f"- **Accept as-is**: Use the current criteria despite the issues.\n"
                         f"- **Skip**: Proceed without criteria validation.",
                "options": [
                    {"value": "refine", "label": "Refine criteria",
                     "description": "I'll specify how to improve the criteria"},
                    {"value": "accept", "label": "Accept as-is",
                     "description": "Use current criteria despite carren's concerns"},
                    {"value": "skip", "label": "Skip validation",
                     "description": "Proceed without criteria validation"},
                ],
                "allowOther": True,
            }
        ],
        state_id="criteria_fix",
        session_id=session.session_id,
        context={
            "criteria_issues": issues,
            "criteria_findings": findings,
        },
        orchestrator_state=session.to_dict(),
    )


def handle_implement(session: CodeSession) -> dict:
    """Implement: skribble writes code following TDD.

    Gate: if IDEAL_STATE is empty (no success_criteria), emit a structured
    error instead of running skribble with nothing to implement. This
    prevents the infinite carren loop that happens when the plan phase
    never populated the IDEAL_STATE.
    """
    ideal_state = session.ideal_state

    # ── Pre-implement IDEAL_STATE guard ──
    if not ideal_state.get("success_criteria"):
        return {
            "action": "error",
            "state_id": "error",
            "session_id": session.session_id,
            "errors": [
                "Cannot implement: IDEAL_STATE is empty. "
                "The IDEAL_STATE must define at least one success_criterion "
                "before the implement phase can run. "
                "Check that the PRD skill completed and that its IDEAL_STATE "
                "was written to mempalace or passed via --state-data.",
            ],
        }
    language = session.language
    verification = ideal_state.get("verification", {})
    is_server = bool(verification.get("server_startup"))
    server_block = ""
    if is_server:
        framework = verification.get("server_framework", "server")
        entry_points = verification.get("server_entry_points", [])
        entry_list = (
            "\n".join(f"   - {ep}" for ep in entry_points)
            if entry_points
            else "   (no specific entry points detected — locate by inspection)"
        )
        server_block = (
            f"\n\nSERVER-STARTUP TEST REQUIREMENTS (MANDATORY for {framework}):\n"
            f"This project ships a {framework} server. The orchestrator's verify phase will fail if the test suite does not contain tests that actually start the server. You MUST add the following test categories to the test plan and write them as part of this iteration:\n"
            f"\n1. SERVER-STARTUP INTEGRATION TEST: A real uvicorn/Flask/Node server boots in a background thread (or subprocess) with HEAVY DEPS MOCKED (model downloads, databases, third-party APIs). The test makes real HTTP requests against the live server and asserts the expected status codes / response bodies for representative endpoints (e.g. /health, /, one business endpoint). This catches issues that unit tests with mocks cannot: misconfigured middleware, CORS, startup hooks, lifespan events, port conflicts.\n"
            f"\n2. ENTRY-POINT SCRIPT TEST (CRITICAL — this is a recurring bug class):\n"
            f"   - For each entry point listed below, run the script as a SUBPROCESS from inside its own directory and verify the import chain works. Many runners (Streamlit, uvicorn --reload wrappers, CLI tools) change cwd to the script's directory before importing, so `from sibling_pkg import ...` silently breaks unless the script itself puts the project root on sys.path.\n"
            f"   - Add a test that does exactly this: subprocess.run([sys.executable, '-c', '<driver code that imports the entry point and exercises its imports>'], cwd=os.path.dirname(entry_point), check=True). If the script needs PYTHONPATH set, the test should set it; but ideally the production script itself handles sys.path.\n"
            f"   - Entry points to cover:\n{entry_list}\n"
            f"\n3. CORS / ORIGIN PREFLIGHT TEST (if the server has CORS): make an OPTIONS request from a representative browser origin and assert the access-control-allow-origin header is present and correct.\n"
            f"\n4. FULL UNITS-OF-WORK TEST: at least one test exercises the actual happy path of the main business flow end-to-end through the running server (e.g. create conversation → send message → fetch → delete).\n"
            f"\nSee `.pi/skills/code/resources/server-startup-tests.md` for a complete reference and copy-pastable patterns. Treat these as NON-NEGOTIABLE for the verify phase to succeed."
        )
    session.iteration += 1

    # Load language-specific resource
    resource_path = f".pi/skills/code/resources/{language}.md"

    # Load security checklist
    security_domains = ideal_state.get("security_review", [])
    security_refs = "\n".join(
        f"- docs/agents/secure-coding/{d}.md" for d in security_domains
    ) if security_domains else "docs/agents/secure-coding/AGENTS.md"

    task = (
        f"Implement code following TDD (RED → GREEN → REFACTOR). "
        f"Iteration: {session.iteration}. "
        f"IDEAL STATE: {json.dumps(ideal_state)}. "
        f"\n\nBEFORE WRITING ANY CODE, read these references: "
        f"\n1. {resource_path} - language conventions and best practices "
        f"\n2. .pi/skills/code/resources/security-checklist.md - mandatory security review "
        f"\n3. {security_refs} - security docs for: {', '.join(security_domains) if security_domains else 'all applicable domains'} "
        f"{_build_resource_context(session)}"
        f"{server_block}"
        f"{_build_multi_server_block(session)}"
        f"\n\nRULES: "
        f"\n- Write a FAILING test FIRST (TDD: RED phase) "
        f"\n- Implement minimum code to pass (GREEN phase) "
        f"\n- Refactor while keeping tests green "
        f"\n- Use DRY methodology "
        f"\n- Use secure coding practices from referenced docs "
        f"\n- For Python: activate .venv/ first, use uv for ALL packages, NEVER install globally "
        f"\n- For TypeScript: use bun for ALL packages, NEVER npm/yarn, NEVER install globally "
        f"\n- Diagnose and fix test failures - the last change is always the breaking change "
        f"\n- Report expected test failures (integration/E2E with unmet dependencies) to the output "
        f"\n\nSession: {session.session_id}"
    )

    # On loop-back, include carren's gap findings
    findings = getattr(session, "learn_findings", [])
    if findings:
        task += (
            "\n\nGAPS FROM LAST VERIFICATION:\n" +
            "\n".join(f"- {f}" for f in findings) +
            "\nADDRESS THESE GAPS FIRST."
        )

    task += f"\n\nSession: {session.session_id}"

    return action_invoke_agent(agent="skribble", task=task)


def handle_verify(session: CodeSession) -> dict:
    """Verify: Run all applicable verification tiers."""
    ideal_state = session.ideal_state
    verification = ideal_state.get("verification", {})
    language = session.language

    # Build verification commands based on language and what's configured
    commands: list[str] = []
    if verification.get("lint"):
        if language == "python":
            commands.append("ruff check .")
        else:
            commands.append("eslint . --ext .ts,.tsx")
    if verification.get("type_check"):
        if language == "python":
            commands.append("mypy . || pyright")
        else:
            commands.append("tsc --noEmit")
    if verification.get("unit_tests"):
        if language == "python":
            commands.append("pytest tests/ -v -k 'not integration and not e2e'")
        else:
            commands.append("bun vitest run tests/unit")
    if verification.get("integration_tests"):
        if language == "python":
            commands.append("pytest tests/ -v -k 'integration'")
        else:
            commands.append("bun vitest run tests/integration")
    if verification.get("e2e_tests"):
        if language == "python":
            commands.append("pytest tests/ -v -k 'e2e'")
        else:
            commands.append("bun vitest run tests/e2e")
    if verification.get("server_startup"):
        # The server-startup tier runs the full integration test suite
        # (which is where server-startup tests live by convention) PLUS
        # a dedicated, name-targeted pass so the verify phase is honest
        # about whether those specific tests exist and pass.
        if language == "python":
            commands.append("pytest tests/ -v -k 'integration or server'")
        else:
            commands.append("bun vitest run tests/integration")

    # If server_startup is required, the verify agent is also given an
    # explicit gap-check: at least one test must actually start the
    # server (by name) and at least one test must run the entry-point
    # script from its own directory. These are the categories that the
    # implement phase was instructed to add; if they are missing, the
    # verify phase must report a gap so the Ralph Wiggum Loop cycles
    # back to implement.
    server_check = ""
    if verification.get("server_startup"):
        framework = verification.get("server_framework", "server")
        server_check = (
            f"\n\nSERVER-STARTUP VERIFICATION (REQUIRED for {framework}):\n"
            f"In addition to running the test commands above, explicitly verify that the following tests exist and pass:\n"
            f"  (a) At least one test that starts the real {framework} server in a background thread (or subprocess) and makes real HTTP requests against it. Mock heavy deps (model downloads, databases) but use the real framework, real startup, real CORS, real handlers.\n"
            f"  (b) At least one test that runs the entry-point script as a subprocess from inside its own directory (os.path.dirname(entry_point)) to catch sys.path / PYTHONPATH bugs that unit tests miss.\n"
            f"  (c) CORS preflight test from a representative browser origin (if the server uses CORS).\n"
            f"\nIf any of these tests are missing, FAIL the verification with a specific gap listing which categories are absent. Do NOT pass verification just because the unit tests pass — for a server project, that is a false positive."
        )

    return action_invoke_agent(
        agent="skribble",  # Skribble handles both implement and verify
        task=f"Verify implementation. IDEAL STATE: {json.dumps(ideal_state)}. "
             f"Run these verification commands: {'; '.join(commands) if commands else '(none configured — that itself is a failure for a server project)'}. "
             f"For any tier not configured in the project, explicitly state it. "
             f"{server_check}"
             f"Session: {session.session_id}"
    )


def handle_learn(session: CodeSession) -> dict:
    """Learn: Evaluate gap. Step function routes to implement (gap) or complete (done)."""
    ideal_state = session.ideal_state

    return action_invoke_agent(
        agent="carren",
        task=f"Evaluate implementation against IDEAL STATE. "
             f"IDEAL STATE: {json.dumps(ideal_state)}. "
             f"\nDetermine: "
             f"\n1. Are all success_criteria met? "
             f"\n2. Are all anti_criteria avoided? "
             f"\n3. Are all edge_cases handled? "
             f"\n4. Were all security review domains addressed? "
             f"\n5. Is there a gap between output and IDEAL STATE? "
             f"\n\nRespond with SUMMARY: {{\"gap\": true|false, \"findings\": [\"...\"]}}. "
             f"\nIf gap=true, the skill loops back to implement. "
             f"\nIf gap=false, the skill completes. "
             f"\nSession: {session.session_id}",
        session_id=session.session_id,
        state_id="learn",
    )


def handle_complete(session: CodeSession) -> dict:
    """Complete: IDEAL STATE achieved."""
    return action_complete(
        f"IDEAL STATE achieved in {session.iteration} iteration(s). "
        f"Deliverables: {session.ideal_state.get('deliverables', [])}"
    )


# ============================================================
# Helpers
# ============================================================

# Map of framework names to the dep tokens that signal their presence.
# Used by ``_detect_server_framework`` to decide whether a project is a
# server. Keep this list aligned with what the integration-test guidance
# in resources/server-startup-tests.md covers.
_PYTHON_SERVER_DEPS: dict[str, list[str]] = {
    "fastapi": ["fastapi", "starlette"],
    "flask": ["flask"],
    "django": ["django"],
    "starlette": ["starlette"],
    "litestar": ["litestar"],
}

_TS_SERVER_DEPS: dict[str, list[str]] = {
    "express": ["express"],
    "fastify": ["fastify"],
    "next": ["next"],
    "koa": ["koa"],
    "hapi": ["@hapi/hapi", "hapi"],
    "nestjs": ["@nestjs/core", "@nestjs/common"],
}


def _detect_server_framework(project_root: str) -> dict:
    """Inspect the project to detect whether it is a server project.

    Returns a dict describing the server (or ``{"is_server": False}`` if
    none is detected). The orchestrator uses this to inject server-
    startup verification requirements into the ideal state and the
    plan/implement/verify task prompts.

    The check is intentionally shallow: we look for known server
    frameworks in the dependency manifest (pyproject.toml, package.json)
    AND for entry-point files that look like servers (e.g. ``app =
    FastAPI(...)`` or ``app = Flask(__name__)``). Any single hit is
    enough to mark the project as a server.

    Detection fields:
        is_server      -- True if any server signal was found
        language       -- "python" or "typescript" (best guess)
        framework      -- canonical framework name (e.g. "fastapi")
        entry_points   -- absolute paths to suspect entry-point files
        evidence       -- human-readable summary of what triggered the
                          detection (used for logging / debugging)
    """
    if not project_root:
        return {"is_server": False}

    root = Path(project_root)
    if not root.is_dir():
        return {"is_server": False}

    # Detect language from project files (was _detect_language, now inlined)
    detected_language = "python"  # default
    if (root / "pyproject.toml").exists() or (root / "setup.py").exists():
        detected_language = "python"
    elif (root / "tsconfig.json").exists() or (root / "package.json").exists():
        detected_language = "typescript"
    detected_framework: str | None = None
    entry_points: list[str] = []
    evidence: list[str] = []

    # --- Python: inspect pyproject.toml --------------------------------
    pyproject = root / "pyproject.toml"
    if pyproject.is_file():
        try:
            content = pyproject.read_text(encoding="utf-8").lower()
        except OSError:
            content = ""
        for framework, tokens in _PYTHON_SERVER_DEPS.items():
            if any(tok in content for tok in tokens):
                detected_framework = framework
                detected_language = "python"
                evidence.append(
                    f"{framework} found in pyproject.toml"
                )
                break

    # --- TypeScript: inspect package.json ------------------------------
    pkg_json = root / "package.json"
    if detected_framework is None and pkg_json.is_file():
        try:
            import json as _json

            with pkg_json.open(encoding="utf-8") as f:
                pkg = _json.load(f)
            all_deps: dict = {}
            all_deps.update(pkg.get("dependencies", {}))
            all_deps.update(pkg.get("devDependencies", {}))
            for framework, tokens in _TS_SERVER_DEPS.items():
                if any(tok in all_deps for tok in tokens):
                    detected_framework = framework
                    detected_language = "typescript"
                    evidence.append(
                        f"{framework} found in package.json"
                    )
                    break
        except (OSError, ValueError):
            pass

    # --- Fallback: scan source files for framework imports -------------
    # If no manifest hit, look for direct framework imports inside .py
    # and .ts/.js files. This catches projects that pin deps elsewhere
    # (e.g. requirements.txt) or that the user wrote without a manifest.
    if detected_framework is None:
        scan_exts: dict[str, list[tuple[str, str]]] = {
            ".py": [
                ("fastapi", "fastapi"),
                ("flask", "flask"),
                ("django", "django"),
                ("starlette", "starlette"),
            ],
            ".ts": [
                ("express", "express"),
                ("fastify", "fastify"),
                ("next", "next"),
                ("koa", "koa"),
            ],
            ".js": [
                ("express", "express"),
                ("fastify", "fastify"),
                ("next", "next"),
                ("koa", "koa"),
            ],
        }
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix not in scan_exts:
                continue
            # Skip obvious noise — node_modules, venvs, caches, etc.
            parts_lower = {p.lower() for p in path.parts}
            if parts_lower & {
                "node_modules",
                ".venv",
                "venv",
                "__pycache__",
                ".pytest_cache",
                ".mypy_cache",
                ".ruff_cache",
                "dist",
                "build",
            }:
                continue
            try:
                content = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for framework, token in scan_exts[path.suffix]:
                # Look for `from fastapi import ...` or `import fastapi`
                # in Python, and `from "express"` / `require("express")`
                # in JS/TS.
                if path.suffix == ".py":
                    if (
                        f"import {token}" in content
                        or f"from {token} " in content
                        or f"from {token}\n" in content
                    ):
                        detected_framework = framework
                        detected_language = (
                            "python" if path.suffix == ".py" else "typescript"
                        )
                        evidence.append(
                            f"{framework} import found in {path.relative_to(root)}"
                        )
                        break
                else:
                    if (
                        f"from '{token}'" in content
                        or f'from "{token}"' in content
                        or f"require('{token}')" in content
                        or f'require("{token}")' in content
                    ):
                        detected_framework = framework
                        detected_language = "typescript"
                        evidence.append(
                            f"{framework} import found in {path.relative_to(root)}"
                        )
                        break
            if detected_framework is not None:
                break

    # --- Identify entry-point files ------------------------------------
    # A reasonable entry point is any non-test source file that creates
    # the framework's app object (e.g. ``app = FastAPI(...)`` for
    # FastAPI, ``app = Flask(__name__)`` for Flask) or that lives in a
    # top-level directory named ``backend``, ``server``, ``api``, or
    # ``src``.
    if detected_framework is not None:
        candidate_names = {
            "fastapi": ["main.py", "app.py", "server.py", "api.py"],
            "flask": ["main.py", "app.py", "server.py", "wsgi.py"],
            "django": ["manage.py", "wsgi.py", "asgi.py"],
            "starlette": ["main.py", "app.py"],
            "litestar": ["main.py", "app.py"],
            "express": ["server.js", "server.ts", "app.js", "app.ts", "index.js", "index.ts"],
            "fastify": ["server.js", "server.ts", "app.js", "app.ts"],
            "next": ["next.config.js", "next.config.ts"],
            "koa": ["server.js", "server.ts", "app.js", "app.ts"],
            "hapi": ["server.js", "app.js"],
            "nestjs": ["main.ts", "main.js"],
        }
        names_to_check = candidate_names.get(detected_framework, [])

        # 1) Files in a backend/server/api/src directory
        for sub in ("backend", "server", "api", "src", "app"):
            sub_path = root / sub
            if not sub_path.is_dir():
                continue
            for path in sub_path.rglob("*"):
                if (
                    path.is_file()
                    and path.suffix in {".py", ".ts", ".js"}
                    and not any(
                        p in path.parts
                        for p in ("tests", "test", "__tests__", "__pycache__")
                    )
                    and path.name in names_to_check
                ):
                    entry_points.append(str(path.resolve()))

        # 2) Top-level files with the candidate names
        for name in names_to_check:
            path = root / name
            if path.is_file():
                entry_points.append(str(path.resolve()))

    if detected_framework is None:
        return {"is_server": False}

    return {
        "is_server": True,
        "language": detected_language,
        "framework": detected_framework,
        "entry_points": sorted(set(entry_points)),
        "evidence": " | ".join(evidence) if evidence else "(no evidence captured)",
    }


# Map of AI framework dep tokens used by _detect_ai_framework.
_AI_DEPS: dict[str, list[str]] = {
    "huggingface": ["transformers", "huggingface", "accelerate", "peft"],
    "openai": ["openai"],
    "anthropic": ["anthropic"],
    "langchain": ["langchain", "langgraph"],
    "llamacpp": ["llama-cpp-python", "llama_cpp"],
    "ollama": ["ollama"],
    "torch": ["torch"],  # PyTorch is a strong AI signal when combined with other clues
}

_WEB_UI_DEPS: dict[str, list[str]] = {
    "streamlit": ["streamlit"],
    "react": ["react"],
    "vue": ["vue"],
    "svelte": ["svelte"],
    "nextjs": ["next"],
    "htmx": ["htmx"],
    "gradio": ["gradio"],
    "dash": ["dash"],
}


def _detect_ai_framework(project_root: str) -> dict:
    """Detect whether a project integrates an AI/ML model.

    Inspects pyproject.toml / requirements.txt for known AI framework
    imports. Returns a dict with the same shape as
    ``_detect_server_framework`` so the orchestrator can inject
    AI-specific guidance (generation params, streaming, prompt design)
    into the plan/implement phases.
    """
    if not project_root:
        return {"is_ai": False}
    root = Path(project_root)
    if not root.is_dir():
        return {"is_ai": False}

    found: list[str] = []

    for manifest_name in ("pyproject.toml", "requirements.txt", "Pipfile"):
        manifest = root / manifest_name
        if not manifest.is_file():
            continue
        try:
            content = manifest.read_text(encoding="utf-8").lower()
        except OSError:
            continue
        for framework, tokens in _AI_DEPS.items():
            if framework in found:
                continue
            if any(tok in content for tok in tokens):
                found.append(framework)

    # Also scan source files for direct import statements
    for pattern in ("**/*.py", "**/*.ts", "**/*.tsx"):
        for src in root.glob(pattern):
            if "__pycache__" in str(src) or "node_modules" in str(src):
                continue
            try:
                content = src.read_text(encoding="utf-8").lower()
            except OSError:
                continue
            for framework, tokens in _AI_DEPS.items():
                if framework in found:
                    continue
                for tok in tokens:
                    if f"import {tok}" in content or f"from {tok}" in content:
                        found.append(framework)
                        break
            if len(found) >= len(_AI_DEPS):
                break

    if not found:
        return {"is_ai": False}
    return {
        "is_ai": True,
        "frameworks": found,
        "evidence": f"Found AI frameworks: {', '.join(sorted(found))}",
    }


def _detect_web_ui_framework(project_root: str) -> dict:
    """Detect whether a project includes a web frontend UI.

    Same detection pattern as ``_detect_server_framework`` but looks for
    frontend frameworks. Returns ``is_web_ui`` + detected frameworks.
    """
    if not project_root:
        return {"is_web_ui": False}
    root = Path(project_root)
    if not root.is_dir():
        return {"is_web_ui": False}

    # Check frontend-specific config files first (strong signals)
    for config_file in ("package.json", "tsconfig.json"):
        config = root / config_file
        if config.is_file():
            try:
                content = config.read_text(encoding="utf-8").lower()
            except OSError:
                continue
            if "react" in content:
                return {"is_web_ui": True, "frameworks": ["react"], "evidence": f"react in {config_file}"}
            if "vue" in content:
                return {"is_web_ui": True, "frameworks": ["vue"], "evidence": f"vue in {config_file}"}
            if "next" in content:
                return {"is_web_ui": True, "frameworks": ["nextjs"], "evidence": f"next in {config_file}"}

    # Check python manifests for UI frameworks
    for manifest_name in ("pyproject.toml", "requirements.txt"):
        manifest = root / manifest_name
        if not manifest.is_file():
            continue
        try:
            content = manifest.read_text(encoding="utf-8").lower()
        except OSError:
            continue
        found = []
        for framework, tokens in _WEB_UI_DEPS.items():
            if any(tok in content for tok in tokens):
                found.append(framework)
        if found:
            return {
                "is_web_ui": True,
                "frameworks": found,
                "evidence": f"UI frameworks in {manifest_name}: {', '.join(found)}",
            }

    # Scan source for Streamlit import (common Python UI)
    for py_file in root.rglob("*.py"):
        if "__pycache__" in str(py_file):
            continue
        try:
            content = py_file.read_text(encoding="utf-8").lower()
        except OSError:
            continue
        if "import streamlit" in content:
            return {"is_web_ui": True, "frameworks": ["streamlit"], "evidence": f"streamlit import in {py_file.name}"}

    return {"is_web_ui": False}


# Known dev-server / build-server frameworks in package.json. Their
# presence (under scripts.dev or scripts.start) is a strong signal
# that a subdirectory hosts a long-running dev server.
_JS_DEV_SERVER_DEPS: dict[str, list[str]] = {
    "vite":       ["vite"],
    "webpack":    ["webpack", "webpack-dev-server"],
    "next":       ["next"],
    "nuxt":       ["nuxt"],
    "remix":      ["@remix-run/dev", "remix"],
    "astro":      ["astro"],
    "sveltekit":  ["@sveltejs/kit"],
    "parcel":     ["parcel"],
    "rollup":     ["rollup", "vite"],
    "esbuild":    ["esbuild"],
    "expo":       ["expo"],  # mobile dev server
    "react-native": ["react-native"],
}

# Subdirectories commonly used to hold a frontend app, in priority order.
_FRONTEND_DIR_CANDIDATES = (
    "frontend", "web", "client", "ui", "app", "apps/web", "apps/client",
    "packages/web", "packages/frontend",
)


def _detect_multi_server(project_root: str) -> dict:
    """Detect whether the project requires multiple long-running processes.

    A project is multi-server if it has:
      (a) a Python server framework (fastapi/flask/django/starlette/
          litestar) at the root AND a frontend dev server in a subdir
          (frontend/, web/, client/, etc.), OR
      (b) two server frameworks at the root (e.g. Python backend + Node
          API), OR
      (c) an explicit multi-process manager present (Makefile with a
          'dev' target that references ≥ 2 services, or Procfile with
          ≥ 2 entries).

    This drives injection of resources/project-structure.md, which
    enforces the single-command startup rule. The detector is
    intentionally conservative: a single-server project is never
    misclassified as multi-server, and a multi-server project is only
    flagged when at least two distinct long-running processes are
    present.

    Returns:
        {
            "is_multi_server": bool,
            "services": [
                {"name": str, "kind": str, "command": str, "evidence": str}
            ],
            "evidence": str,
        }
    """
    if not project_root:
        return {"is_multi_server": False}
    root = Path(project_root)
    if not root.is_dir():
        return {"is_multi_server": False}

    services: list[dict] = []

    # --- (a) Python server at the root ---------------------------------
    py_server = _detect_server_framework(project_root)
    if py_server.get("is_server"):
        framework = py_server.get("framework", "server")
        # Pick a sensible default command
        if framework in ("fastapi", "starlette", "litestar"):
            default_cmd = "uvicorn app.main:app --reload"
        elif framework == "flask":
            default_cmd = "flask --app app.main run --reload"
        elif framework == "django":
            default_cmd = "python manage.py runserver"
        else:
            default_cmd = f"<run {framework} server>"
        services.append({
            "name": "backend",
            "kind": f"python-{framework}",
            "command": default_cmd,
            "evidence": py_server.get("evidence", ""),
        })

    # --- (a) Node server at the root (rare but possible) ---------------
    # Reuse the python-detector's manifest logic: look for server deps
    # in a top-level package.json (not under a frontend/ subdir).
    pkg = root / "package.json"
    if pkg.is_file():
        try:
            with pkg.open(encoding="utf-8") as f:
                pkg_data = json.load(f)
        except (OSError, ValueError):
            pkg_data = {}
        all_deps: dict = {}
        all_deps.update(pkg_data.get("dependencies", {}))
        all_deps.update(pkg_data.get("devDependencies", {}))
        for framework, tokens in _TS_SERVER_DEPS.items():
            if any(tok in all_deps for tok in tokens):
                # Skip if this package.json also has a "dev" script that
                # looks like a dev server (those are detected below).
                scripts = pkg_data.get("scripts", {}) or {}
                has_dev_server = any(
                    _script_looks_like_dev_server(script)
                    for script in scripts.values()
                )
                if not has_dev_server:
                    services.append({
                        "name": framework,
                        "kind": f"node-{framework}",
                        "command": scripts.get("dev") or scripts.get("start") or f"<run {framework}>",
                        "evidence": f"{framework} in root package.json",
                    })
                break

    # --- (a) Frontend dev server in a subdir ----------------------------
    for sub in _FRONTEND_DIR_CANDIDATES:
        sub_path = root / sub
        if not sub_path.is_dir():
            continue
        sub_pkg = sub_path / "package.json"
        if not sub_pkg.is_file():
            continue
        try:
            with sub_pkg.open(encoding="utf-8") as f:
                sub_pkg_data = json.load(f)
        except (OSError, ValueError):
            continue
        sub_deps: dict = {}
        sub_deps.update(sub_pkg_data.get("dependencies", {}))
        sub_deps.update(sub_pkg_data.get("devDependencies", {}))
        sub_scripts = sub_pkg_data.get("scripts", {}) or {}
        for framework, tokens in _JS_DEV_SERVER_DEPS.items():
            if any(tok in sub_deps for tok in tokens):
                dev_script = sub_scripts.get("dev") or sub_scripts.get("start") or ""
                services.append({
                    "name": sub,
                    "kind": f"{framework}-dev-server",
                    "command": dev_script or f"<run {framework}>",
                    "evidence": f"{framework} in {sub}/package.json",
                })
                break
        # Only one frontend subdir counts (don't double-count monorepos)
        if services and services[-1]["name"] == sub:
            break

    # --- (c) Explicit multi-process manager present --------------------
    has_explicit_manager = False
    # Makefile with a 'dev' target that mentions ≥ 2 service names
    makefile = root / "Makefile"
    if makefile.is_file():
        try:
            content = makefile.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            content = ""
        if re.search(r"^dev\s*:", content, re.MULTILINE):
            # Cheap heuristic: if the file mentions two or more of
            # (backend, frontend, server, worker, web, api) it counts.
            names = ("backend", "frontend", "server", "worker", "web", "api", "client")
            hits = sum(1 for n in names if re.search(rf"\b{n}\b", content, re.IGNORECASE))
            if hits >= 2:
                has_explicit_manager = True
    # Procfile with ≥ 2 process types
    procfile = root / "Procfile"
    if procfile.is_file():
        try:
            proc_content = procfile.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            proc_content = ""
        proc_lines = [
            ln for ln in proc_content.splitlines()
            if ln.strip() and not ln.strip().startswith("#") and ":" in ln
        ]
        if len(proc_lines) >= 2:
            has_explicit_manager = True
    # scripts/dev.sh that backgrounds ≥ 2 services
    dev_script_path = root / "scripts" / "dev.sh"
    if dev_script_path.is_file():
        try:
            dev_content = dev_script_path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            dev_content = ""
        # Count `start_*` invocations — a strong signal of multi-process.
        if len(re.findall(r"^start_\w+\s*\(\s*\)", dev_content, re.MULTILINE)) >= 2:
            has_explicit_manager = True

    # --- Decision -------------------------------------------------------
    # Multi-server = at least 2 detected services, OR 1 service plus
    # an explicit multi-process manager.
    is_multi = len(services) >= 2 or (len(services) >= 1 and has_explicit_manager)
    if not is_multi:
        return {"is_multi_server": False}

    if has_explicit_manager and len(services) < 2:
        services.append({
            "name": "(manager)",
            "kind": "multi-process-manager",
            "command": "see Makefile / Procfile / scripts/dev.sh",
            "evidence": "explicit multi-process manager detected",
        })

    return {
        "is_multi_server": True,
        "services": services,
        "evidence": " | ".join(s["evidence"] for s in services) or "multi-server heuristic",
    }


def _script_looks_like_dev_server(script_body: str) -> bool:
    """Cheap heuristic: does this npm script look like it starts a long-running
    dev server (as opposed to a one-shot build/test/lint command)?"""
    if not script_body:
        return False
    body = script_body.lower()
    indicators = (
        "vite", "webpack", "next dev", "nuxt", "remix", "astro dev",
        "svelte-kit dev", "expo start", "react-native start",
        "parcel", "rollup -w", "esbuild --watch", "nodemon",
    )
    return any(tok in body for tok in indicators)


def _build_resource_context(session: CodeSession) -> str:
    """Return a string of resource-file paths to inject into agent tasks.

    Checks ``session.server_info``, the AI-detection result, and the
    web-UI detection result, then returns a newline-separated list of
    resource paths the agent should read before starting work.
    """
    resources: list[str] = []

    # Security checklist is always mandatory
    resources.append("resources/security-checklist.md")

    # Resilience patterns are always applicable
    resources.append("resources/resilience.md")

    # Server detection — inject server-startup tests resource
    if session.server_info.get("is_server"):
        resources.append("resources/server-startup-tests.md")

    # Multi-server detection — inject the project-structure rule so the
    # implement/plan agents know to set up a single-command dev script.
    if session.multi_server_info.get("is_multi_server"):
        resources.append("resources/project-structure.md")

    # AI detection — inject AI application checklist
    project_root = session.project_root or str(Path.cwd())
    ai_info = _detect_ai_framework(project_root)
    if ai_info.get("is_ai"):
        resources.append("resources/ai-application.md")

    # Web UI detection — inject UI checklist
    webui_info = _detect_web_ui_framework(project_root)
    if webui_info.get("is_web_ui"):
        resources.append("resources/web-ui.md")

    if not resources:
        return ""
    return (
        "MANDATORY: Before writing any code, read the following project-specific "
        "resources (use the read tool):\n"
        + "\n".join(f"  - {r}" for r in resources)
    )


def _build_multi_server_block(session: CodeSession) -> str:
    """Return an inject-able task block enforcing the single-command dev rule.

    Fires only when ``session.multi_server_info`` reports multi-server.
    The block tells the agent exactly which services were detected and
    which deliverables are required (Makefile, scripts/dev.sh, etc.).
    """
    info = session.multi_server_info
    if not info.get("is_multi_server"):
        return ""

    services = info.get("services", [])
    if not services:
        return ""

    svc_lines = "\n".join(
        f"   - {s.get('name','?')}: kind={s.get('kind','?')}  command=`{s.get('command','?')}`  evidence: {s.get('evidence','?')}"
        for s in services
    )
    return (
        "\n\nMULTI-SERVER SINGLE-COMMAND STARTUP (MANDATORY):\n"
        "This project ships more than one long-running process. Per the rule in "
        ".pi/skills/code/resources/project-structure.md, the project MUST be "
        "set up so every server can be started with a single command. The "
        "implement phase MUST produce ALL of the following deliverables — "
        "the verify phase will fail if any are missing:\n"
        "\n"
        f"Detected services:\n{svc_lines}\n"
        "\n"
        "Required deliverables (in priority order):\n"
        "  1. `scripts/dev.sh` — executable bash script that starts every "
        "service in the background, traps SIGINT and SIGTERM, and tears down "
        "every child PID on exit. Must wait for the backend to respond to "
        "`/api/health` (or equivalent) before tailing logs. Per-service logs go "
        "to `$LOG_DIR/<service>.log`. Must support a `--check` mode that exits "
        "0 if all services are healthy, 1 otherwise.\n"
        "  2. `scripts/test.sh` — runs all test suites (backend unit + "
        "integration + frontend vitest + tsc), exits non-zero on any failure.\n"
        "  3. `Makefile` — thin wrappers: `make dev`, `make check`, `make test`, "
        "`make install`, `make stop`, `make clean`. The `dev` target invokes "
        "`scripts/dev.sh`; the README documents `./scripts/dev.sh` as the "
        "no-make fallback.\n"
        "  4. `.gitignore` — add `.run-logs/` (the dev script's log dir) and "
        "any `*.pid` files it creates.\n"
        "  5. `README.md` — replace any 'open two terminals' instructions with "
        "`make dev` (or `./scripts/dev.sh`). Document the make targets.\n"
        "\n"
        "The dev script MUST:\n"
        "  - Track every child PID in an array; do NOT rely on process groups "
        "(signaling your own PGID re-fires your own trap).\n"
        "  - Trap SIGINT and SIGTERM; on either, kill each tracked PID, "
        "sleep 0.7s, then SIGKILL any survivors.\n"
        "  - Health-probe each service after start with a deadline; fail the "
        "script (with the last log lines) if any service doesn't respond in "
        "time. This is the only reliable way to surface 'port already in use' "
        "or 'dependency not installed' early.\n"
        "  - Forward logs to per-service files (not stdout) and tail them in a "
        "background `tail -F` so the user sees activity.\n"
        "  - Use `set -euo pipefail` and fail fast on any error.\n"
        "\n"
        "The verify phase will run `scripts/dev.sh --check` and assert exit 0, "
        "then send SIGTERM and assert both ports are free within 5s. If either "
        "fails, the project is incomplete.\n"
    )




# ============================================================
# Main Entry Points
# ============================================================

def _prd_available(state_data: dict = None) -> dict:
    """Check if PRD + IDEAL STATE is available in the state data.

    The prd skill writes IDEAL_STATE to mempalace room skills/prd-{session_id}/.
    The extension passes this via --state-data. This function checks if the
    required data is present, with a fallback to mempalace lookup when
    ``prd_room`` is provided in state_data.

    Returns:
        {"exists": bool, "ideal_state": dict|None, "prd_goal": str|None}
    """
    if not state_data:
        state_data = {}

    ideal_state = state_data.get("ideal_state")
    prd_room = state_data.get("prd_room", "")

    if ideal_state and ideal_state.get("success_criteria"):
        return {
            "exists": True,
            "ideal_state": ideal_state,
            "prd_goal": state_data.get("goal", ideal_state.get("goal", "")),
        }

    # ── Mempalace fallback: if the prd room was injected by the chain, ──
    #    try to fetch IDEAL_STATE from mempalace directly.
    if prd_room and prd_room.startswith("skills/prd-"):
        try:
            import chromadb as _chromadb
            from pathlib import Path as _Path

            # Mempalace stores all drawers in a single "mempalace_drawers"
            # collection; the room is in metadata, not the collection name.
            _mempalace_path = str(
                _Path(PROJECT_ROOT) / ".mempalace"
            )
            _client = _chromadb.PersistentClient(path=_mempalace_path)
            try:
                _drawers = _client.get_collection("mempalace_drawers")
            except Exception:
                _drawers = None
            if _drawers is not None:
                # Query by metadata filter: wing=penny, room=prd_room
                _results = _drawers.get(
                    where={"$and": [{"room": prd_room}, {"wing": "penny"}]},
                    limit=50,
                )
                if _results and _results.get("documents"):
                    for _doc_text in _results["documents"]:
                        if not _doc_text:
                            continue
                        try:
                            _parsed = json.loads(_doc_text)
                            if isinstance(_parsed, dict) and _parsed.get("success_criteria"):
                                return {
                                    "exists": True,
                                    "ideal_state": _parsed,
                                    "prd_goal": _parsed.get("goal", ""),
                                }
                        except (json.JSONDecodeError, TypeError):
                            pass
        except Exception as exc:
            print(f"Mempalace lookup failed: {exc}", file=sys.stderr)

    return {"exists": False, "ideal_state": None, "prd_goal": None}


def start(
    session_id: str,
    goal: str,
    state_data: dict = None,
    project_root: str = "",
) -> dict:
    """Initialize a new code skill session.

    Requires IDEAL_STATE from the prd skill (hard dependency).
    If state_data contains IDEAL_STATE, start at explore.
    Otherwise, emit a chain-contract error.
    """
    session = CodeSession(session_id, goal)
    session.project_root = project_root

    # Check PRD dependency
    prd_check = _prd_available(state_data)

    if not prd_check["exists"]:
        # PRD dependency not satisfied — emit chain-contract error
        return {
            "action": "error",
            "state_id": "error",
            "session_id": session_id,
            "errors": [
                "PRD dependency not satisfied. The code skill requires a complete PRD + IDEAL_STATE from the prd skill before it can run.",
                "",
                "Chain contract: invoke code as part of a chain with prd first:",
                "  skill({ chain: [",
                "    { skill_name: 'prd', goal: '<your goal>' },",
                "    { skill_name: 'code', goal: '<your goal>' }",
                "  ]})",
                "",
                "The prd skill writes IDEAL_STATE to mempalace room skills/prd-{session_id}/. "
                "The code skill reads from this room on startup.",
            ],
            "orchestrator_state": session.to_dict(),
        }

    # Load IDEAL_STATE from PRD skill output
    session.ideal_state = prd_check["ideal_state"]
    session.prd = {
        "source": "prd_skill",
        "goal": prd_check.get("prd_goal", goal),
    }
    session.language = session.ideal_state.get("language", "python")

    # Start at explore
    result = handle_explore(session)
    result["state_id"] = "explore"
    result["session_id"] = session_id
    result["orchestrator_state"] = session.to_dict()
    return result


def step(
    session_id: str,
    session_data: dict,
    agent_result: dict = None,
    state_data: dict = None,
    project_root: str = "",
) -> dict:
    """Advance the state machine by one step."""
    if not session_data or not session_data.get("session_id"):
        # No prior state - this shouldn't happen in normal flow
        return {"action": "error", "state_id": "error", "session_id": session_id, "errors": ["No session state provided"]}

    session = CodeSession.from_dict(session_data)
    if project_root and not session.project_root:
        session.project_root = project_root

    # If state_data is provided and session has no IDEAL_STATE, load it
    # (supports resume scenarios where the first step needs PRD data)
    if state_data and not session.ideal_state:
        prd_check = _prd_available(state_data)
        if prd_check["exists"]:
            session.ideal_state = prd_check["ideal_state"]
            session.prd = {"source": "prd_skill", "goal": prd_check.get("prd_goal", session.goal)}
            session.language = session.ideal_state.get("language", "python")

    # Determine current state from session data
    state_id = session_data.get("_state_id", "explore")

    # Process agent result if provided
    if agent_result:
        confidence = agent_result.get("summary", {}).get("confidence", "")
        session.last_confidence = confidence

        if state_id == "explore":
            session.explore_findings = agent_result
        elif state_id == "analyze":
            session.analyze_findings = agent_result
        elif state_id == "implement":
            session.implement_result = agent_result
        elif state_id == "verify":
            session.verify_result = agent_result
        elif state_id == "learn":
            session.learn_result = agent_result
            # Parse carren's gap evaluation
            summary = agent_result.get("summary", {})
            setattr(session, "learn_gap", summary.get("gap", None))
            setattr(session, "learn_findings", summary.get("findings", []))
        elif state_id == "criteria":
            # Carren evaluated the IDEAL_STATE criteria themselves
            summary = agent_result.get("summary", {})
            setattr(session, "criteria_gap", summary.get("gap", None))
            setattr(session, "criteria_issues", summary.get("criteria_issues", {}))
            setattr(session, "criteria_findings", summary.get("findings", []))

    # Map state to next handler
    # The state order now includes two gates between analyze and plan:
    # analyze → criteria (carren evaluates criteria quality)
    # criteria_ok → plan
    # plan → plan_approval (user approves before implementation)
    # plan_approve → implement
    # See the Advanced State Routing block below for override logic.
    state_order = ["explore", "analyze", "plan", "implement", "verify", "learn"]
    handlers = {
        "explore": handle_explore,
        "analyze": handle_analyze,
        "plan": handle_plan,
        "criteria": handle_criteria,
        "plan_approval": handle_plan_approve,
        "implement": handle_implement,
        "verify": handle_verify,
        "learn": handle_learn,
        "criteria_fix": handle_criteria_fix,
        "complete": handle_complete,
    }

    # Advance to next state (or stay on current if no _state_id).
    # The Ralph Wiggum Loop block below handles the learn→implement
    # (gap=true) and learn→verify (gap=false, final verification)
    # transitions, so we stop the linear advance at "learn" and let
    # the loop block decide the next state.
    if "_state_id" not in session_data:
        next_state = "explore"
    else:
        prev = session_data["_state_id"]
        if prev == "learn":
            # Ralph Wiggum Loop handles this; stay on learn until
            # the loop block decides implement or verify or complete.
            next_state = "learn"
        else:
            try:
                idx = state_order.index(prev)
                next_state = state_order[idx + 1] if idx < len(state_order) - 1 else state_order[-1]
            except ValueError:
                next_state = "explore"

    # Track state on session for persistence
    session._state_id = next_state

    # ── Final-verify route: when _final_verify is set and verify has ──
    #    just finished, skip learn and go directly to complete.
    if getattr(session, "_final_verify", False) and next_state == "learn":
        next_state = "complete"
        session._state_id = "complete"
        session._final_verify = False  # clear the flag

    # When entering implement from a FORWARD path (previous state was
    # plan, not learn), reset the carren-loop counter so skribble gets
    # a fresh 3 carren-retries per implement pass. If the previous
    # state was "learn" and we're going to "implement", that's a
    # loop-back — don't reset.
    prev_state = session_data.get("_state_id", "")
    if next_state == "implement" and prev_state != "learn":
        session.carren_loop = 0

    # ── Advanced State Routing ──
    # The gates are injected between standard linear transitions.
    # This block overrides next_state to route through the gates.
    # It runs after the linear advance above; any override here
    # wins over the linear default.
    #
    # Guards: we only intercept when the session has actually been
    # through the previous state (prev_state matches), not when the
    # state was manually set (e.g. in tests or resume scenarios).

    # ── Gate 1: Criteria validation ──
    # After analyze completes AND criteria haven't been validated yet,
    # route to criteria (carren evaluates IDEAL_STATE for quality)
    # instead of going directly to plan.
    if (
        next_state == "plan"
        and prev_state == "analyze"
        and agent_result
        and not getattr(session, "_criteria_validated", False)
    ):
        next_state = "criteria"
        session._state_id = "criteria"

    # Carren returned from criteria evaluation — route based on gap
    if prev_state == "criteria" and agent_result:
        cgap = getattr(session, "criteria_gap", None)
        if cgap is True:
            next_state = "criteria_fix"
            session._state_id = "criteria_fix"
        else:
            session._criteria_validated = True
            next_state = "plan"
            session._state_id = "plan"

    # User responded to criteria_fix — accept input and re-validate
    if prev_state == "criteria_fix" and agent_result:
        user_resp = agent_result.get("summary", {}).get("user_response", "")
        if user_resp in ("accept", "approve"):
            # User accepts criteria as-is despite carren's concerns
            session._criteria_validated = True
            next_state = "plan"
            session._state_id = "plan"
        elif user_resp == "skip":
            # User skips criteria validation entirely
            session._criteria_validated = True
            next_state = "plan"
            session._state_id = "plan"
        else:
            # refine or custom text — re-invoke carren with context
            session._criteria_validated = False
            next_state = "criteria"
            session._state_id = "criteria"

    # ── Gate 2: Plan approval ──
    # After plan completes and user hasn't approved yet,
    # route to plan_approval which presents the plan for user approval.
    if (
        next_state == "implement"
        and prev_state == "plan"
        and agent_result  # plan just finished
        and not getattr(session, "_plan_approved", False)
    ):
        next_state = "plan_approval"
        session._state_id = "plan_approval"

    # User responded to plan approval
    if prev_state == "plan_approval" and agent_result:
        user_resp = agent_result.get("summary", {}).get("user_response", "")
        if user_resp in ("approve", "confirm"):
            session._plan_approved = True
            next_state = "implement"
            session._state_id = "implement"
        elif user_resp in ("deny", "discard"):
            next_state = "complete"
            session._state_id = "complete"
        else:
            # refine or custom — re-route to plan for rethinking
            next_state = "plan"
            session._state_id = "plan"

    # Ralph Wiggum Loop: learn → implement (gap) or complete (done)
    if next_state == "learn" and getattr(session, "learn_gap", None) is True:
        # Carren found a gap. Before looping back to implement, check
        # a DEDICATED carren-loop counter (not the overall iteration).
        # If carren has found gaps N times in a row without skribble
        # making progress, escalate to complete with a warning rather
        # than cycling forever.
        session.carren_loop = getattr(session, "carren_loop", 0) + 1
        if session.carren_loop >= 3:
            # Max 3 carren retries per implement pass — escalate
            session._state_id = "complete"
            next_state = "complete"
        else:
            session._state_id = "implement"
            next_state = "implement"
            session.iteration += 1
        if session.iteration > 10:
            next_state = "complete"
            session._state_id = "complete"
    elif next_state == "learn" and getattr(session, "learn_gap", None) is False:
        # Carren says no gap — run ONE final verification pass before
        # accepting completion. This catches any regressions introduced
        # by the last round of fixes. Set _final_verify so step() knows
        # to route to complete after verify finishes, not back to learn.
        session._final_verify = True
        next_state = "verify"
        session._state_id = "verify"
    elif next_state == "learn":
        # No gap info from carren — run learn once, then default to complete
        session.learn_attempts = getattr(session, "learn_attempts", 0) + 1
        if session.learn_attempts > 1:
            next_state = "complete"

    handler = handlers.get(next_state, handle_explore)
    result = handler(session)

    # Always inject state tracking + persistence
    result["state_id"] = next_state
    result["session_id"] = session.session_id
    result["orchestrator_state"] = session.to_dict()
    session._state_id = next_state
    return result


def status(session_id: str) -> dict:
    """Get current session status."""
    return {
        "session_id": session_id,
        "status": "active",
    }


# ============================================================
# CLI
# ============================================================

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Code Skill Orchestrator")
    subparsers = parser.add_subparsers(dest="command")

    start_parser = subparsers.add_parser("start")
    start_parser.add_argument("--session-id", required=True)
    start_parser.add_argument("--goal", required=True)
    start_parser.add_argument("--project-root", default=".")
    start_parser.add_argument("--state-data", default="{}")
    # Backward-compat: the skill extension always passes --constraints
    # (matching the plan/prd convention). Accept it as a JSON blob that
    # overrides --state-data when non-empty. Fixes a real Penny bug where
    # code-skill invocations crashed on the first start() call.
    start_parser.add_argument("--constraints", default="")

    step_parser = subparsers.add_parser("step")
    step_parser.add_argument("--session-id", required=True)
    step_parser.add_argument("--project-root", default=".")
    step_parser.add_argument("--agent", default="unknown")
    step_parser.add_argument("--result", default="{}")
    step_parser.add_argument("--state", default="{}")
    step_parser.add_argument("--state-data", default="{}")

    status_parser = subparsers.add_parser("status")
    status_parser.add_argument("--session-id", required=True)
    status_parser.add_argument("--project-root", default=".")

    args = parser.parse_args()

    if args.command == "start":
        # Prefer --constraints if it was passed with non-empty content
        # (the extension always passes it; default is "" until invoked).
        constraints_blob = (args.constraints or "").strip()
        state_data = json.loads(constraints_blob) if constraints_blob else json.loads(args.state_data) if args.state_data else {}
        result = start(
            args.session_id,
            args.goal,
            state_data=state_data,
            project_root=args.project_root,
        )
        print(json.dumps(result))
    elif args.command == "step":
        state = json.loads(args.state) if args.state else {}
        state_data = json.loads(args.state_data) if args.state_data else {}
        agent_result = json.loads(args.result) if args.result else None
        result = step(
            args.session_id,
            state,
            agent_result,
            state_data=state_data,
            project_root=args.project_root,
        )
        print(json.dumps(result))
    elif args.command == "status":
        result = status(args.session_id)
        print(json.dumps(result))
    else:
        parser.print_help()
        sys.exit(1)
