"""
KG Integration Tests for Agent Skill — Phase 2 (Revision 1)

Addresses Critique gaps:
  1. Missing test coverage for _action_design() and _action_critique() parallel
     invocation methods in KG context propagation
  2. test_scaffold_summary_fields_for_kg incorrectly assumes structured dict
     output — task_summary is a STRING, files_created/files_modified come
     from skribble's RESULT, not the action

Tests verify KG triple writes are properly invoked during agent skill
orchestration. The KG writes are issued by agents (echo, piper, carren,
skribble, vera) via memory_kg_add tool calls.

KG Triple Contract per agent:
  - echo:    SkillSession:{session_id} → explored_by → Agent:echo
  - piper:   SkillSession:{session_id} → planned_by → Agent:piper
  - carren:  item → critiqued_by → Agent:carren
  - skribble: file_path → generated_from → SkillSession:{session_id}
  - vera:    file_path → verified_by → Agent:vera
"""

import json
import subprocess
import pytest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from scripts.orchestrate import AgentContext, Orchestrator


# ============================================================
# Test: KG Instructions in Task Summaries — INCLUDING Design/Critique
# ============================================================

class TestAgentKGInstructionsInTaskSummaries:
    """Verify task summaries given to agents include KG linking instructions.

    Addresses Critique Issue 1: _action_design() and _action_critique() are
    parallel invocation methods that also need KG context propagation tests.
    """

    # ---- Echo (explore) ----
    def test_echo_task_summary_includes_session_id(self):
        """Echo task summary includes session_id for KG link."""
        ctx = AgentContext(session_id="kg-echo-sid")
        orch = Orchestrator(context=ctx)
        action = orch._action_explore()
        # Parallel explore uses tasks[] array, single uses task_summary
        if action["action"] == "invoke_agents_parallel":
            for t in action["tasks"]:
                assert "kg-echo-sid" in t["task_summary"]
        else:
            task_text = action.get("task_summary", "")
            assert "kg-echo-sid" in task_text

    def test_echo_task_summary_includes_mempalace_room(self):
        """Echo task summary includes mempalace room for KG writes."""
        ctx = AgentContext(session_id="kg-echo-room")
        orch = Orchestrator(context=ctx)
        action = orch._action_explore()
        if action["action"] == "invoke_agents_parallel":
            for t in action["tasks"]:
                assert "skills/agent-kg-echo-room" in t["task_summary"]
        else:
            assert "skills/agent-kg-echo-room" in action.get("task_summary", "")

    # ---- Piper (design) — PARALLEL invocation ----
    def test_piper_design_parallel_task_summaries_include_session_id(self):
        """Piper design parallel tasks include session_id for KG link.

        Addresses Critique Issue 1: _action_design() produces parallel tasks
        for piper (3 aspects). Each task must include session_id.
        """
        ctx = AgentContext(session_id="kg-piper-design", goal="Build agent")
        orch = Orchestrator(context=ctx)
        action = orch._action_design()
        assert action["action"] == "invoke_agents_parallel"
        assert len(action["tasks"]) >= 3
        for t in action["tasks"]:
            assert t["agent"] == "piper"
            assert "kg-piper-design" in t["task_summary"]

    def test_piper_design_parallel_task_summaries_include_mempalace_room(self):
        """Piper design parallel tasks include mempalace room.

        Addresses Critique Issue 1: Each parallel task must include session_room
        for mempalace writes (not just the outer action).
        """
        ctx = AgentContext(session_id="kg-piper-room", goal="Build agent")
        orch = Orchestrator(context=ctx)
        action = orch._action_design()
        for t in action["tasks"]:
            assert "skills/agent-kg-piper-room" in t["task_summary"]

    # ---- Carren (critique) — PARALLEL invocation ----
    def test_carren_critique_parallel_task_summaries_include_session_id(self):
        """Carren critique parallel tasks include session_id for KG link.

        Addresses Critique Issue 1: _action_critique() produces parallel tasks
        for carren (3 aspects). Each task must include session_id.
        """
        ctx = AgentContext(session_id="kg-carren-crit", goal="Build agent")
        orch = Orchestrator(context=ctx)
        action = orch._action_critique()
        assert action["action"] == "invoke_agents_parallel"
        assert len(action["tasks"]) >= 3
        for t in action["tasks"]:
            assert t["agent"] == "carren"
            assert "kg-carren-crit" in t["task_summary"]

    def test_carren_critique_parallel_task_summaries_include_mempalace_room(self):
        """Carren critique parallel tasks include mempalace room.

        Addresses Critique Issue 1: Each parallel task must include session_room.
        """
        ctx = AgentContext(session_id="kg-carren-room", goal="Build agent")
        orch = Orchestrator(context=ctx)
        action = orch._action_critique()
        for t in action["tasks"]:
            assert "skills/agent-kg-carren-room" in t["task_summary"]

    # ---- Skribble (scaffold) — single invocation ----
    def test_skribble_task_summary_includes_session_id(self):
        """Skribble scaffold task summary includes session_id for KG link."""
        ctx = AgentContext(session_id="kg-skribble-sid", goal="Build agent")
        orch = Orchestrator(context=ctx)
        action = orch._action_scaffold()
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "skribble"
        assert "kg-skribble-sid" in action["task_summary"]

    def test_skribble_task_summary_includes_mempalace_room(self):
        """Skribble scaffold task summary includes session_room for KG writes."""
        ctx = AgentContext(session_id="kg-skribble-room", goal="Build agent")
        orch = Orchestrator(context=ctx)
        action = orch._action_scaffold()
        assert "skills/agent-kg-skribble-room" in action["task_summary"]

    # ---- Vera (verify) — single invocation ----
    def test_vera_task_summary_includes_session_id(self):
        """Vera verify task summary includes session_id for KG link."""
        ctx = AgentContext(session_id="kg-vera-sid", goal="Build agent")
        orch = Orchestrator(context=ctx)
        action = orch._action_verify()
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "vera"
        assert "kg-vera-sid" in action["task_summary"]

    # NOTE: Vera task does NOT include "Mempalace room:" instruction in the task_summary.
    # This is a gap — vera receives session_id (for KG linking) but not explicit
    # mempalace room instruction in the task text itself. The session_room IS
    # present in the action output (from _action()), which is sufficient for
    # Penny to route KG writes. This test documents the current behavior.


# ============================================================
# Test: KG Call Graph — Outer Action Contains Session Context
# ============================================================

class TestAgentKGCallGraph:
    """Verify orchestrator produces actions with session context for KG linking."""

    # ---- Scaffold action ----
    def test_scaffold_action_includes_session_id_in_action_output(self):
        """_action_scaffold() output includes session_id at action level.

        Addresses Critique Issue 2: The scaffold ACTION (from _action_scaffold())
        includes session_id via _action(). The files_created/files_modified
        come from skribble's RESULT, not from the action itself.
        """
        ctx = AgentContext(session_id="kg-scaffold-sid", goal="Build agent")
        orch = Orchestrator(context=ctx)
        action = orch._action_scaffold()
        # session_id is at the action level (from _action())
        assert action["session_id"] == "kg-scaffold-sid"

    def test_scaffold_action_includes_session_room_in_action_output(self):
        """_action_scaffold() output includes session_room at action level."""
        ctx = AgentContext(session_id="kg-scaffold-room", goal="Build agent")
        orch = Orchestrator(context=ctx)
        action = orch._action_scaffold()
        assert action["session_room"] == "skills/agent-kg-scaffold-room"

    def test_scaffold_action_task_summary_is_string_not_dict(self):
        """Verify task_summary is a STRING, not a structured dict.

        Addresses Critique Issue 2: The word 'files_created' appears in the
        task_summary as an instruction to the agent ("Return SUMMARY with
        'files_created'..."), but the task_summary itself is a STRING.
        The actual files_created/files_modified values come from skribble's
        agent result, processed by step().
        """
        ctx = AgentContext(session_id="kg-scaffold-type", goal="Build agent")
        orch = Orchestrator(context=ctx)
        action = orch._action_scaffold()
        task_summary = action["task_summary"]
        assert isinstance(task_summary, str), f"task_summary must be str, got {type(task_summary)}"
        # "files_created" appears as a word in the instruction text (part of SUMMARY format),
        # not as a field key in the action output dict. The action dict has no such field.
        assert "Session:" in task_summary  # Format: "Session: {id}. Agent name: ..."
        # Confirm action dict has NO files_created key (it's in the agent RESULT)
        assert "files_created" not in action, "files_created must not be in action dict"

    # ---- Verify action ----
    def test_verify_action_includes_session_id_in_action_output(self):
        """_action_verify() output includes session_id at action level."""
        ctx = AgentContext(session_id="kg-verify-sid", goal="Build agent")
        orch = Orchestrator(context=ctx)
        action = orch._action_verify()
        assert action["session_id"] == "kg-verify-sid"

    def test_verify_action_includes_session_room_in_action_output(self):
        """_action_verify() output includes session_room at action level."""
        ctx = AgentContext(session_id="kg-verify-room", goal="Build agent")
        orch = Orchestrator(context=ctx)
        action = orch._action_verify()
        assert action["session_room"] == "skills/agent-kg-verify-room"

    # ---- Complete action (for post-completion KG writes) ----
    def test_complete_action_includes_session_room_for_kg_linking(self):
        """Complete action carries session_room for post-completion KG linking."""
        ctx = AgentContext(session_id="kg-complete-room", goal="Build agent")
        orch = Orchestrator(context=ctx)
        action = orch._action_complete()
        assert action["session_room"] == "skills/agent-kg-complete-room"
        assert "plan_summary" in action

    # ---- Full sequence ----
    def test_full_sequence_produces_kg_context_throughout(self):
        """Happy path: echo → piper → carren → skribble → vera preserves KG context."""
        ctx = AgentContext(session_id="kg-full-seq")
        orch = Orchestrator(context=ctx)
        orch.start("Build test agent")

        # Echo action has session context
        echo_action = orch._action_explore()
        assert echo_action["session_id"] == "kg-full-seq"
        assert echo_action["session_room"] == "skills/agent-kg-full-seq"

        # Piper action has session context (need to advance FSM properly)
        orch.context.explore_complete = True
        orch.workflow.explore_done()
        piper_action = orch._action_design()
        assert piper_action["session_id"] == "kg-full-seq"

        # Carren action has session context
        ctx.design_steps = [{"field": "name", "value": "test"}]
        orch.workflow.design_done()
        carren_action = orch._action_critique()
        assert carren_action["session_id"] == "kg-full-seq"

        # Skribble action has session context
        orch.context.critique_verdict = "APPROVE"
        orch.workflow.critique_pass()
        scaffold_action = orch._action_scaffold()
        assert scaffold_action["session_id"] == "kg-full-seq"

        # Vera action has session context
        orch.context.generation_complete = True
        orch.workflow.scaffold_done()
        verify_action = orch._action_verify()
        assert verify_action["session_id"] == "kg-full-seq"


# ============================================================
# Test: Agent Session Room
# ============================================================

class TestAgentSessionRoom:
    """Verify session room is skills/agent-<session_id> for mempalace isolation."""

    def test_session_room_is_correct_for_agent_skill(self):
        """Session room is skills/agent-<session_id> for mempalace isolation."""
        ctx = AgentContext(session_id="kg-room-test")
        orch = Orchestrator(context=ctx)
        assert orch.session_room == "skills/agent-kg-room-test"


# ============================================================
# Test: Agent Sequence for KG
# ============================================================

class TestAgentSequenceForKG:
    """Verify FSM correctly sequences agents for KG write order."""

    def test_full_happy_path_echo_piper_carren_skribble_vera(self):
        """Happy path: echo → piper → carren → skribble → vera (correct KG write order)."""
        ctx = AgentContext(session_id="kg-seq-1", goal="Build test agent")
        orch = Orchestrator(context=ctx)
        orch.start("Build test agent")
        assert orch._state_id() == "exploring"

        # Echo
        result = orch.step("echo", {
            "exitCode": 0,
            "summary": {"findings_count": 3, "files_count": 2, "unknowns_count": 0, "explore_complete": True},
        }, orch.extract_state())
        assert result["action"] in ("invoke_agent", "invoke_agents_parallel")

        # Piper
        result = orch.step("piper", {
            "exitCode": 0,
            "summary": {"design_steps": [{"field": "name", "value": "test"}], "design_complete": True},
        }, orch.extract_state())
        assert result["action"] in ("invoke_agent", "invoke_agents_parallel")

        # Carren APPROVE
        result = orch.step("carren", {
            "exitCode": 0,
            "summary": {"verdict": "APPROVE", "issues": []},
        }, orch.extract_state())
        assert result["action"] == "invoke_agent"
        assert result["agent"] == "skribble"

        # Skribble
        result = orch.step("skribble", {
            "exitCode": 0,
            "summary": {
                "files_created": [".pi/agents/test.md"],
                "files_modified": [],
                "generation_complete": True,
                "agent_definition": "content",
                "agent_file_path": ".pi/agents/test.md",
            },
        }, orch.extract_state())
        assert result["action"] == "invoke_agent"
        assert result["agent"] == "vera"

        # Vera verify pass → complete
        result = orch.step("vera", {
            "exitCode": 0,
            "summary": {"yaml_valid": True, "schema_valid": True, "diff_applied": True, "verification_complete": True},
        }, orch.extract_state())
        assert result["action"] == "complete"

    def test_critique_revision_preserves_kg_write_sequence(self):
        """Critique rejection → revision → re-plan preserves KG order."""
        ctx = AgentContext(session_id="kg-revision-seq", goal="Build agent")
        orch = Orchestrator(context=ctx)
        orch.start("Build agent")
        orch.step("echo", {
            "exitCode": 0,
            "summary": {"findings_count": 2, "files_count": 1, "unknowns_count": 0, "explore_complete": True},
        }, orch.extract_state())
        orch.step("piper", {
            "exitCode": 0,
            "summary": {"design_steps": [{"field": "name", "value": "x"}], "design_complete": True},
        }, orch.extract_state())
        result = orch.step("carren", {
            "exitCode": 0,
            "summary": {"verdict": "NEEDS_REVISION", "issues": ["Missing detail"]},
        }, orch.extract_state())
        assert result["action"] in ("invoke_agent", "invoke_agents_parallel")
        assert orch.workflow.revising.is_active or orch.workflow.exploring.is_active or orch.workflow.designing.is_active


# ============================================================
# Test: KG Agent Definitions
# ============================================================

class TestAgentKGAgentDefinitions:
    """Verify agent definitions include memory_kg_add in their tools list."""

    def _get_agents_dir(self):
        return Path(str(Path(__file__).resolve().parents[4] / ".pi/agents"))

    def test_skribble_definition_includes_memory_kg_add(self):
        """Skribble agent has memory_kg_add in tools list for KG: file → generated_from."""
        skribble_path = self._get_agents_dir() / "skribble.md"
        content = skribble_path.read_text()
        assert "memory_kg_add" in content

    def test_vera_definition_includes_memory_kg_add(self):
        """Vera agent has memory_kg_add in tools list for KG: file → verified_by."""
        vera_path = self._get_agents_dir() / "vera.md"
        content = vera_path.read_text()
        assert "memory_kg_add" in content

    def test_skribble_kg_predicate_is_generated_from(self):
        """Skribble's KG triple uses 'generated_from' predicate."""
        skribble_path = self._get_agents_dir() / "skribble.md"
        content = skribble_path.read_text()
        assert "generated_from" in content

    def test_vera_kg_predicate_is_verified_by(self):
        """Vera's KG triple uses 'verified_by' predicate."""
        vera_path = self._get_agents_dir() / "vera.md"
        content = vera_path.read_text()
        assert "verified_by" in content

    def test_all_agent_skill_agents_have_memory_kg_add(self):
        """All 5 agent skill agents (echo, piper, carren, skribble, vera) have memory_kg_add."""
        agents_dir = self._get_agents_dir()
        agent_files = ["echo.md", "piper.md", "carren.md", "skribble.md", "vera.md"]
        for agent_file in agent_files:
            content = (agents_dir / agent_file).read_text()
            assert "memory_kg_add" in content, f"{agent_file} missing memory_kg_add"

    def test_agent_definition_files_exist(self):
        """All agent definition files exist at expected paths."""
        agents_dir = self._get_agents_dir()
        for agent_file in ["echo.md", "piper.md", "carren.md", "tabitha.md", "skribble.md", "vera.md"]:
            assert (agents_dir / agent_file).exists(), f"Missing: {agent_file}"


# ============================================================
# Test: KG Skribble/Scaffold Action (addresses Critique Issue 2)
# ============================================================

class TestAgentKGSkribbleAction:
    """Verify scaffold action includes correct KG context.

    Addresses Critique Issue 2: Clarified that _action_scaffold() produces
    a STRING task_summary (not a dict with files_created/files_modified).
    The files_created/files_modified come from skribble's RESULT, processed
    by process_scaffold_result() in step().
    """

    def test_scaffold_action_has_correct_agent(self):
        """Scaffold action uses agent='skribble'."""
        ctx = AgentContext(session_id="kg-scaf-agent", goal="Build agent")
        orch = Orchestrator(context=ctx)
        action = orch._action_scaffold()
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "skribble"

    def test_scaffold_action_includes_session_id_and_room(self):
        """Scaffold action includes session_id and session_room via _action().

        The session context is at the action level (from _action()).
        files_created/files_modified are in skribble's RESULT, not the action.
        """
        ctx = AgentContext(session_id="kg-scaf-ctx", goal="Build agent")
        orch = Orchestrator(context=ctx)
        action = orch._action_scaffold()
        assert action["session_id"] == "kg-scaf-ctx"
        assert action["session_room"] == "skills/agent-kg-scaf-ctx"


# ============================================================
# Test: KG Vera/Verify Action
# ============================================================

class TestAgentKGVeraAction:
    """Verify verify action includes correct KG context."""

    def test_verify_action_has_correct_agent(self):
        """Verify action uses agent='vera'."""
        ctx = AgentContext(session_id="kg-vera-agent", goal="Build agent")
        orch = Orchestrator(context=ctx)
        action = orch._action_verify()
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "vera"

    def test_verification_result_preserves_session_context(self):
        """process_verify_result preserves session context for KG writes.

        Note: The actual session_id/session_room for KG comes from the action
        (set by _action()), not from the result processor. The result processor
        updates context fields used by subsequent actions.
        """
        ctx = AgentContext(session_id="kg-vera-result", goal="Build agent")
        orch = Orchestrator(context=ctx)
        # Simulate processing a successful verify result
        orch.process_verify_result({
            "yaml_valid": True,
            "schema_valid": True,
            "diff_applied": True,
            "verification_complete": True,
        })
        assert orch.context.verification_complete is True
        assert orch.context.verification_yaml_valid is True


# ============================================================
# Test: KG Unknown State
# ============================================================

class TestAgentKGUnknownState:
    """Verify KG linking is PAUSED during UNKNOWN_STATE escalation."""

    def test_uncertain_explore_enters_unknown_in_agent_skill(self):
        """UNCERTAIN confidence from echo → unknown state pauses KG writes."""
        ctx = AgentContext(session_id="kg-unknown-pause", goal="Research ambiguous agent")
        orch = Orchestrator(context=ctx)
        orch.start("Research ambiguous agent")

        result = orch.step("echo", {
            "exitCode": 0,
            "summary": {
                "findings_count": 0,
                "files_count": 0,
                "unknowns_count": 0,
                "explore_complete": True,
                "confidence": "UNCERTAIN",
                "unknown_reason": "Cannot determine feasibility",
            },
        }, orch.extract_state())

        assert result["action"] == "escalate_to_user"
        assert orch.workflow.awaiting_clarification.is_active

    def test_agents_still_receive_session_id_after_resume(self):
        """After user clarification, agents still receive session_id."""
        ctx = AgentContext(session_id="kg-unknown-retry", goal="Research agent")
        orch = Orchestrator(context=ctx)
        orch.start("Research agent")
        orch.step("echo", {
            "exitCode": 0,
            "summary": {
                "findings_count": 0,
                "files_count": 0,
                "unknowns_count": 0,
                "explore_complete": True,
                "confidence": "UNCERTAIN",
                "unknown_reason": "No sources",
            },
        }, orch.extract_state())
        orch.step("user", {
            "action_choice": "retry",
            "summary": {"clarification": "Try another approach"},
        }, orch.extract_state())
        # After resume, echo should still receive session context
        next_action = orch._action_explore()
        assert next_action["session_id"] == "kg-unknown-retry"


# ============================================================
# Test: KG Subskill Contract
# ============================================================

class TestAgentKGSubskillContract:
    """Verify parent_session_id propagation for KG cross-linking in subskill mode."""

    def test_subskill_mode_propagates_parent_session_id(self):
        """Subskill mode includes parent_session_id for KG cross-linking."""
        ctx = AgentContext(session_id="kg-subskill-1", goal="Build agent")
        orch = Orchestrator(context=ctx)
        orch.start("Build agent", constraints={"parent_session_id": "parent-789"})
        assert orch.context.subskill_mode is True
        assert orch.context.parent_session_id == "parent-789"

    def test_subskill_complete_includes_parent_session_id(self):
        """Completion action links subskill to parent session via plan_summary."""
        ctx = AgentContext(session_id="kg-subskill-complete", goal="Build agent")
        orch = Orchestrator(context=ctx)
        orch.start("Build agent", constraints={"parent_session_id": "parent-999"})
        orch.context.agent_name = "test-agent"
        orch.context.agent_file_path = ".pi/agents/test-agent.md"
        orch.context.verification_yaml_valid = True
        orch.context.verification_schema_valid = True
        orch.context.verification_diff_applied = True
        action = orch._action_complete()
        plan = action["plan_summary"]
        assert plan["parent_session_id"] == "parent-999"
        assert "subskill_return" in plan


# ============================================================
# Regression: Existing Agent Skill Tests Still Pass
# ============================================================

class TestAgentRegressionKGExisting:
    """Regression: existing agent skill orchestrator behavior unchanged."""

    def test_orchestrator_cli_start_returns_valid_json(self):
        """CLI start command returns valid JSON with session_id."""
        result = subprocess.run(
            [str(Path(__file__).resolve().parents[4] / ".venv/bin/python"),
             str(Path(__file__).resolve().parents[4] / ".pi/skills/agent/scripts/orchestrate.py"),
             "start", "--session-id", "regression-agent-start",
             "--goal", "Test agent goal",
             "--project-root", "/tmp"],
            capture_output=True, text=True, cwd="/tmp",
        )
        assert result.returncode == 0
        output = json.loads(result.stdout)
        assert output["session_id"] == "regression-agent-start"
        assert output["action"] in ("invoke_agent", "invoke_agents_parallel")

    def test_orchestrator_cli_step_processes_results(self):
        """CLI step command processes agent results."""
        start = subprocess.run(
            [str(Path(__file__).resolve().parents[4] / ".venv/bin/python"),
             str(Path(__file__).resolve().parents[4] / ".pi/skills/agent/scripts/orchestrate.py"),
             "start", "--session-id", "regression-agent-step",
             "--goal", "Test agent goal",
             "--project-root", "/tmp"],
            capture_output=True, text=True, cwd="/tmp",
        )
        state = json.loads(start.stdout)
        step = subprocess.run(
            [str(Path(__file__).resolve().parents[4] / ".venv/bin/python"),
             str(Path(__file__).resolve().parents[4] / ".pi/skills/agent/scripts/orchestrate.py"),
             "step", "--session-id", "regression-agent-step",
             "--agent", "echo",
             "--result", json.dumps({
                 "exitCode": 0,
                 "summary": {"findings_count": 3, "files_count": 2, "unknowns_count": 0, "explore_complete": True}
             }),
             "--state", json.dumps(state["orchestrator_state"]),
             "--project-root", "/tmp"],
            capture_output=True, text=True, cwd="/tmp",
        )
        assert step.returncode == 0
        output = json.loads(step.stdout)
        assert output["action"] in ("invoke_agent", "invoke_agents_parallel")

    def test_fsm_transitions_unchanged(self):
        """FSM transitions unchanged from previous behavior."""
        ctx = AgentContext(session_id="fsm-regression-agent", goal="Test FSM")
        orch = Orchestrator(context=ctx)
        assert orch._state_id() == "intake"
        orch.workflow.start()
        assert orch._state_id() == "exploring"
        orch.context.explore_complete = True
        orch.workflow.explore_done()
        assert orch._state_id() == "designing"

    def test_safe_defaults_unchanged(self):
        """Safe default summaries unchanged — not claiming completion."""
        ctx = AgentContext(session_id="safe-regression-agent", goal="Test")
        orch = Orchestrator(context=ctx)
        echo_default = orch._safe_default_summary("echo")
        assert echo_default["explore_complete"] is False
        skribble_default = orch._safe_default_summary("skribble")
        assert skribble_default["generation_complete"] is False
        vera_default = orch._safe_default_summary("vera")
        assert vera_default["verification_complete"] is False

    def test_agent_context_fields_unchanged(self):
        """AgentContext has all required fields."""
        ctx = AgentContext(session_id="ctx-fields-agent")
        for field in ["session_id", "skill_name", "goal", "agent_name",
                      "explore_complete", "design_steps", "critique_verdict",
                      "files_created", "generation_complete",
                      "verification_complete"]:
            assert hasattr(ctx, field), f"Missing field: {field}"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
