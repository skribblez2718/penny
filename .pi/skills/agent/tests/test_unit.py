"""
Unit tests for agent skill orchestrator.
"""

import pytest
from scripts.orchestrate import AgentContext, AgentWorkflow, Orchestrator


class TestAgentContext:
    def test_default_context(self):
        ctx = AgentContext(session_id="test")
        assert ctx.session_id == "test"
        assert ctx.skill_name == "agent"
        assert ctx.complete is False
        assert ctx.create_skill_scaffold is False
        assert ctx.subskill_mode is False

    def test_context_with_constraints(self):
        ctx = AgentContext(session_id="test", constraints={"parent_session_id": "parent-123"})
        assert ctx.constraints["parent_session_id"] == "parent-123"


class TestAgentWorkflowGuards:
    def _make(self, **kwargs):
        ctx = AgentContext(session_id="test", **kwargs)
        return AgentWorkflow(model=ctx)

    def test_has_goal_true(self):
        wf = self._make(goal="Build agent")
        assert wf.has_goal() is True

    def test_has_goal_false(self):
        wf = self._make(goal="")
        assert wf.has_goal() is False

    def test_explore_complete_true(self):
        wf = self._make(goal="test", explore_complete=True)
        assert wf.explore_complete() is True

    def test_explore_complete_false(self):
        wf = self._make(goal="test", explore_complete=False)
        assert wf.explore_complete() is False

    def test_design_complete_true(self):
        wf = self._make(goal="test", design_steps=[{"field": "name", "value": "test"}])
        assert wf.design_complete() is True

    def test_design_complete_false(self):
        wf = self._make(goal="test", design_steps=[])
        assert wf.design_complete() is False

    def test_critique_approved(self):
        wf = self._make(goal="test", critique_verdict="APPROVE")
        assert wf.critique_approved() is True

    def test_has_issues_true(self):
        wf = self._make(goal="test", critique_verdict="NEEDS_REVISION", critique_issues=["issue1"])
        assert wf.has_issues() is True

    def test_has_issues_false_approved(self):
        wf = self._make(goal="test", critique_verdict="APPROVE", critique_issues=[])
        assert wf.has_issues() is False

    def test_generation_complete_true(self):
        wf = self._make(goal="test", generation_complete=True)
        assert wf.generation_complete() is True

    def test_verification_complete_true(self):
        wf = self._make(
            goal="test",
            verification_yaml_valid=True,
            verification_schema_valid=True,
            verification_diff_applied=True,
        )
        assert wf.verification_complete() is True

    def test_verification_complete_false(self):
        wf = self._make(goal="test")
        assert wf.verification_complete() is False

    def test_verification_failed(self):
        wf = self._make(goal="test")
        assert wf._verification_fails() is True

    def test_needs_more_context(self):
        wf = self._make(goal="test", exploration_iterations=0)
        assert wf.needs_more_context() is True

    def test_can_fix_design(self):
        wf = self._make(goal="test", exploration_iterations=5)
        assert wf.can_fix_design() is True

    def test_confidence_is_uncertain(self):
        wf = self._make(goal="test", last_confidence="UNCERTAIN")
        assert wf.confidence_is_uncertain() is True

    def test_has_clarification(self):
        wf = self._make(goal="test", clarification_text="more info")
        assert wf.has_clarification() is True


class TestAgentWorkflowTransitions:
    def test_initial_state(self):
        ctx = AgentContext(session_id="test", goal="test")
        wf = AgentWorkflow(model=ctx)
        assert wf.intake.is_active

    def test_start_transition(self):
        ctx = AgentContext(session_id="test", goal="test")
        wf = AgentWorkflow(model=ctx)
        wf.start()
        assert wf.exploring.is_active

    def test_explore_done_transition(self):
        ctx = AgentContext(session_id="test", goal="test", explore_complete=True)
        wf = AgentWorkflow(model=ctx)
        wf.start()
        wf.explore_done()
        assert wf.designing.is_active


class TestOrchestratorActions:
    def test_start_opens_explore(self):
        ctx = AgentContext(session_id="test-001")
        orch = Orchestrator(context=ctx)
        action = orch.start("Build research agent")
        assert action["action"] in ("invoke_agent", "invoke_agents_parallel")
        assert action["session_id"] == "test-001"

    def test_intake_extracts_agent_name(self):
        ctx = AgentContext(session_id="test")
        orch = Orchestrator(context=ctx)
        orch.start("Build climate agent")
        assert orch.context.agent_name == "Build"

    def test_intake_with_agent_name_constraint(self):
        ctx = AgentContext(session_id="test")
        orch = Orchestrator(context=ctx)
        orch.start("Build agent", constraints={"agent_name": "climate-research"})
        assert orch.context.agent_name == "climate-research"

    def test_intake_enforces_scaffold_false(self):
        ctx = AgentContext(session_id="test")
        orch = Orchestrator(context=ctx)
        orch.start("test", constraints={"create_skill_scaffold": True})
        assert orch.context.create_skill_scaffold is False

    def test_intake_sets_subskill_mode(self):
        ctx = AgentContext(session_id="test")
        orch = Orchestrator(context=ctx)
        orch.start("test", constraints={"parent_session_id": "parent-123"})
        assert orch.context.subskill_mode is True
        assert orch.context.parent_session_id == "parent-123"

    def test_action_explore_parallel(self):
        ctx = AgentContext(session_id="test", goal="test")
        orch = Orchestrator(context=ctx)
        orch.workflow.start()
        action = orch._action_explore()
        assert action["action"] == "invoke_agents_parallel"
        assert len(action["tasks"]) >= 3

    def test_action_design_parallel(self):
        ctx = AgentContext(session_id="test", goal="test", explore_complete=True)
        orch = Orchestrator(context=ctx)
        orch.workflow.start()
        orch.workflow.explore_done()
        action = orch._action_design()
        assert action["action"] == "invoke_agents_parallel"
        assert len(action["tasks"]) >= 3

    def test_action_critique_parallel(self):
        ctx = AgentContext(session_id="test", goal="test", explore_complete=True)
        orch = Orchestrator(context=ctx)
        orch.workflow.start()
        orch.workflow.explore_done()
        ctx.design_steps = [{"field": "name", "value": "x"}]
        orch.workflow.design_done()
        action = orch._action_critique()
        assert action["action"] == "invoke_agents_parallel"
        assert len(action["tasks"]) >= 3

    def test_action_scaffold_single(self):
        ctx = AgentContext(session_id="test", goal="test", explore_complete=True)
        orch = Orchestrator(context=ctx)
        orch.workflow.start()
        orch.workflow.explore_done()
        ctx.design_steps = [{"field": "name", "value": "x"}]
        orch.workflow.design_done()
        ctx.critique_verdict = "APPROVE"
        orch.workflow.critique_pass()
        action = orch._action_scaffold()
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "skribble"

    def test_action_complete_subskill_format(self):
        ctx = AgentContext(session_id="test", goal="test", agent_name="test-agent")
        orch = Orchestrator(context=ctx)
        orch.context.subskill_mode = True
        orch.context.parent_session_id = "parent-123"
        action = orch._action_complete()
        assert action["action"] == "complete"
        plan = action["plan_summary"]
        assert plan["subskill_return"]["agent_name"] == "test-agent"


class TestValidation:
    def test_validate_summary_echo_valid(self):
        ctx = AgentContext(session_id="test")
        orch = Orchestrator(context=ctx)
        valid, msg = orch._validate_summary("echo", {"explore_complete": True})
        assert valid is True

    def test_validate_summary_echo_missing_field(self):
        ctx = AgentContext(session_id="test")
        orch = Orchestrator(context=ctx)
        valid, msg = orch._validate_summary("echo", {"findings_count": 3})
        assert valid is False
        assert "explore_complete" in msg

    def test_validate_summary_vera_valid(self):
        ctx = AgentContext(session_id="test")
        orch = Orchestrator(context=ctx)
        valid, msg = orch._validate_summary("vera", {"verification_complete": True, "yaml_valid": True})
        assert valid is True

    def test_validate_summary_vera_missing_field(self):
        ctx = AgentContext(session_id="test")
        orch = Orchestrator(context=ctx)
        valid, msg = orch._validate_summary("vera", {"findings_count": 3})
        assert valid is False
        assert any(k in msg for k in ("verification_complete", "yaml_valid", "schema_valid", "diff_applied"))

    def test_validate_summary_empty(self):
        ctx = AgentContext(session_id="test")
        orch = Orchestrator(context=ctx)
        valid, msg = orch._validate_summary("piper", {})
        assert valid is False


class TestSafeDefaults:
    def test_echo_default_never_complete(self):
        ctx = AgentContext(session_id="test")
        orch = Orchestrator(context=ctx)
        default = orch._safe_default_summary("echo")
        assert default["explore_complete"] is False

    def test_vera_default_never_complete(self):
        ctx = AgentContext(session_id="test")
        orch = Orchestrator(context=ctx)
        default = orch._safe_default_summary("vera")
        assert default["verification_complete"] is False
        assert "yaml_valid" in default

    def test_skribble_default_never_complete(self):
        ctx = AgentContext(session_id="test")
        orch = Orchestrator(context=ctx)
        default = orch._safe_default_summary("skribble")
        assert default["generation_complete"] is False

    def test_carren_default_needs_revision(self):
        ctx = AgentContext(session_id="test")
        orch = Orchestrator(context=ctx)
        default = orch._safe_default_summary("carren")
        assert default["verdict"] != "APPROVE"


class TestIterationGuard:
    def test_max_iterations_prevents_infinite_loop(self):
        ctx = AgentContext(session_id="test", goal="test")
        ctx.exploration_iterations = 5
        wf = AgentWorkflow(model=ctx)
        assert wf.can_fix_design() is True


class TestStatePersistence:
    def test_extract_restore_roundtrip(self):
        ctx = AgentContext(session_id="test", goal="test", agent_name="foo")
        orch = Orchestrator(context=ctx)
        state = orch.extract_state()

        ctx2 = AgentContext(session_id="x", goal="x")
        orch2 = Orchestrator(context=ctx2)
        orch2.restore_state(state)
        assert orch2.context.agent_name == "foo"


class TestConfidenceHandling:
    @pytest.fixture(autouse=True)
    def setup(self):
        self.ctx = AgentContext(session_id="test", goal="test")
        self.orch = Orchestrator(context=self.ctx)
        self.orch.workflow.start()

    def test_uncertain_triggers_escalation(self):
        summary = {"confidence": "UNCERTAIN", "unknown_reason": "ambiguous goal"}
        assert self.orch._check_confidence(summary) is True
        assert self.orch.context.last_confidence == "UNCERTAIN"
