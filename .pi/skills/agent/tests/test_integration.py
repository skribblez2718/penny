"""
Integration tests for agent skill orchestrator.
"""

from scripts.orchestrate import AgentContext, Orchestrator


class TestFullLifecycle:
    def test_start_to_complete_happy_path(self):
        ctx = AgentContext(session_id="test-001")
        orch = Orchestrator(context=ctx)
        action = orch.start("Build climate research agent")
        assert action["action"] in ("invoke_agent", "invoke_agents_parallel")

        # Step: explore result
        result = {"exitCode": 0, "summary": {"findings_count": 3, "files_count": 5, "unknowns_count": 0, "explore_complete": True}}
        action = orch.step("echo", result, orch.extract_state())
        assert action["action"] in ("invoke_agent", "invoke_agents_parallel")

        # Step: design result
        result = {"exitCode": 0, "summary": {"design_steps": [{"field": "name", "value": "climate"}], "design_complete": True}}
        action = orch.step("piper", result, orch.extract_state())
        assert action["action"] in ("invoke_agent", "invoke_agents_parallel")

        # Step: critique pass
        result = {"exitCode": 0, "summary": {"verdict": "APPROVE", "issues": []}}
        action = orch.step("carren", result, orch.extract_state())
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "skribble"

        # Step: scaffold done
        result = {"exitCode": 0, "summary": {"files_created": [".pi/agents/climate.md"], "files_modified": [], "generation_complete": True, "agent_definition": "content", "agent_file_path": ".pi/agents/climate.md"}}
        action = orch.step("skribble", result, orch.extract_state())
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "vera"

        # Step: verify pass
        result = {"exitCode": 0, "summary": {"yaml_valid": True, "schema_valid": True, "diff_applied": True, "verification_complete": True}}
        action = orch.step("vera", result, orch.extract_state())
        assert action["action"] == "complete"
        assert action["plan_summary"]["agent_name"] == "Build"

    def test_critique_fail_revision_cycle(self):
        ctx = AgentContext(session_id="test-002")
        orch = Orchestrator(context=ctx)
        orch.start("Build agent")

        # Explore
        r = {"exitCode": 0, "summary": {"findings_count": 2, "files_count": 3, "unknowns_count": 0, "explore_complete": True}}
        orch.step("echo", r, orch.extract_state())

        # Design
        r = {"exitCode": 0, "summary": {"design_steps": [{"field": "name", "value": "x"}], "design_complete": True}}
        orch.step("piper", r, orch.extract_state())

        # Critique FAIL
        r = {"exitCode": 0, "summary": {"verdict": "NEEDS_REVISION", "issues": ["Missing output format"]}}
        action = orch.step("carren", r, orch.extract_state())
        assert action["action"] in ("invoke_agent", "invoke_agents_parallel")
        # Should be in revising, then routes to design or explore
        assert orch.workflow.revising.is_active or orch.workflow.exploring.is_active

    def test_verify_fail_re_scaffold(self):
        ctx = AgentContext(session_id="test-003")
        orch = Orchestrator(context=ctx)
        orch.start("Build agent")
        orch.step("echo", {"exitCode": 0, "summary": {"findings_count": 2, "files_count": 3, "unknowns_count": 0, "explore_complete": True}}, orch.extract_state())
        orch.step("piper", {"exitCode": 0, "summary": {"design_steps": [{"field": "name", "value": "x"}], "design_complete": True}}, orch.extract_state())
        orch.step("carren", {"exitCode": 0, "summary": {"verdict": "APPROVE", "issues": []}}, orch.extract_state())
        orch.step("skribble", {"exitCode": 0, "summary": {"files_created": [".pi/agents/x.md"], "files_modified": [], "generation_complete": True, "agent_definition": "", "agent_file_path": ".pi/agents/x.md"}}, orch.extract_state())

        # Verify FAIL
        r = {"exitCode": 0, "summary": {"yaml_valid": False, "schema_valid": True, "diff_applied": False, "verification_complete": False}}
        action = orch.step("vera", r, orch.extract_state())
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "skribble"


class TestParallelExecution:
    def test_explore_parallel_has_multiple_tasks(self):
        ctx = AgentContext(session_id="test")
        orch = Orchestrator(context=ctx)
        orch.start("Build agent")
        action = orch._action_explore()
        assert action["action"] == "invoke_agents_parallel"
        assert len(action["tasks"]) >= 3

    def test_design_parallel_has_multiple_tasks(self):
        ctx = AgentContext(session_id="test", goal="test")
        orch = Orchestrator(context=ctx)
        orch.workflow.start()
        action = orch._action_design()
        assert action["action"] == "invoke_agents_parallel"
        assert len(action["tasks"]) >= 3

    def test_critique_parallel_has_multiple_tasks(self):
        ctx = AgentContext(session_id="test", goal="test", explore_complete=True)
        orch = Orchestrator(context=ctx)
        orch.workflow.start()
        orch.workflow.explore_done()
        ctx.design_steps = [{"field": "name", "value": "x"}]
        orch.workflow.design_done()
        action = orch._action_critique()
        assert action["action"] == "invoke_agents_parallel"
        assert len(action["tasks"]) >= 3


class TestSubskillIntegration:
    def test_subskill_mode_return_format(self):
        ctx = AgentContext(session_id="test")
        orch = Orchestrator(context=ctx)
        orch.start("Build research agent", constraints={"parent_session_id": "parent-456"})
        assert orch.context.subskill_mode is True

        # Complete action
        orch.context.agent_name = "research"
        orch.context.agent_file_path = ".pi/agents/research.md"
        orch.context.verification_yaml_valid = True
        orch.context.verification_schema_valid = True
        orch.context.verification_diff_applied = True
        action = orch._action_complete()
        plan = action["plan_summary"]
        assert "subskill_return" in plan
        assert plan["subskill_return"]["agent_name"] == "research"
        assert plan["parent_session_id"] == "parent-456"


class TestSessionPersistence:
    def test_state_roundtrip(self):
        ctx = AgentContext(session_id="test", goal="x", agent_name="test-agent")
        ctx.design_steps = [{"field": "name", "value": "x"}]
        ctx.critique_issues = ["issue1"]
        orch = Orchestrator(context=ctx)
        state = orch.extract_state()

        ctx2 = AgentContext(session_id="test")
        orch2 = Orchestrator(context=ctx2)
        orch2.restore_state(state)
        assert orch2.context.agent_name == "test-agent"
        assert len(orch2.context.design_steps) == 1
        assert len(orch2.context.critique_issues) == 1


class TestErrorHandling:
    def test_agent_error_returns_error_action(self):
        ctx = AgentContext(session_id="test")
        orch = Orchestrator(context=ctx)
        orch.start("Build agent")
        result = {"exitCode": 1, "summary": {}, "error": "Agent crashed"}
        action = orch.step("echo", result, orch.extract_state())
        assert action["action"] == "error"
        assert any("Agent crashed" in e for e in action["errors"])

    def test_invalid_summary_returns_error_action(self):
        ctx = AgentContext(session_id="test")
        orch = Orchestrator(context=ctx)
        orch.start("Build agent")
        result = {"exitCode": 0, "summary": {}}  # missing explore_complete
        action = orch.step("echo", result, orch.extract_state())
        assert action["action"] == "error"
