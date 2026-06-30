"""
Unit tests for the research skill state machine and orchestrator.
"""

import json
import pytest
from scripts.orchestrate import ResearchOrchestrator, ResearchWorkflow, ResearchContext


class TestModeDetection:
    """Tests for automatic mode detection from queries."""

    def test_deep_keywords(self):
        orch = ResearchOrchestrator("s1", "comprehensive analysis of microservices", "auto")
        assert orch.context.detected_mode == "deep"

    def test_quick_keywords(self):
        orch = ResearchOrchestrator("s1", "what is RED-GREEN-REFACTOR?", "auto")
        assert orch.context.detected_mode == "quick"

    def test_quick_short_query(self):
        orch = ResearchOrchestrator("s1", "What is TDD?", "auto")
        assert orch.context.detected_mode == "quick"

    def test_standard_default(self):
        orch = ResearchOrchestrator("s1", "What are best practices for test-driven development in Python projects?", "auto")
        assert orch.context.detected_mode == "standard"

    def test_explicit_quick(self):
        orch = ResearchOrchestrator("s1", "some query", "quick")
        assert orch.context.detected_mode == "quick"

    def test_explicit_deep(self):
        orch = ResearchOrchestrator("s1", "some query", "deep")
        assert orch.context.detected_mode == "deep"


class TestStateMachineTransitions:
    """Tests for ResearchWorkflow state transitions."""

    def test_quick_flow(self):
        ctx = ResearchContext(detected_mode="quick", query="test")
        sm = ResearchWorkflow(model=ctx)
        assert list(sm.configuration)[0].id == "intake"
        sm.send("quick_research")
        assert list(sm.configuration)[0].id == "researching"
        ctx.research_complete = True
        sm.send("quick_to_synth")
        assert list(sm.configuration)[0].id == "synthesizing"
        ctx.synthesis_complete = True
        sm.send("synth_to_report")
        assert list(sm.configuration)[0].id == "report_writing"
        ctx.report_written = True
        sm.send("report_done")
        assert list(sm.configuration)[0].id == "complete"
        assert sm.is_terminated

    def test_standard_flow(self):
        ctx = ResearchContext(detected_mode="standard", query="test")
        sm = ResearchWorkflow(model=ctx)
        sm.send("start")
        assert list(sm.configuration)[0].id == "planning"
        ctx.plan_complete = True
        sm.send("plan_to_research")
        assert list(sm.configuration)[0].id == "researching"
        ctx.research_complete = True
        sm.send("research_to_synth_std")
        assert list(sm.configuration)[0].id == "synthesizing"
        ctx.synthesis_complete = True
        sm.send("synth_to_report")
        assert list(sm.configuration)[0].id == "report_writing"
        ctx.report_written = True
        sm.send("report_done")
        assert list(sm.configuration)[0].id == "complete"

    def test_deep_flow(self):
        ctx = ResearchContext(detected_mode="deep", query="test")
        sm = ResearchWorkflow(model=ctx)
        sm.send("start")
        assert list(sm.configuration)[0].id == "planning"
        ctx.plan_complete = True
        sm.send("plan_done_deep")
        assert list(sm.configuration)[0].id == "critiquing_plan"
        ctx.plan_critique_verdict = "APPROVE"
        sm.send("critique_pass")
        assert list(sm.configuration)[0].id == "researching"
        ctx.research_complete = True
        sm.send("research_done_deep")
        assert list(sm.configuration)[0].id == "synthesizing"
        ctx.synthesis_complete = True
        sm.send("synthesize_done_deep")
        assert list(sm.configuration)[0].id == "critiquing_report"
        ctx.report_critique_verdict = "APPROVE"
        sm.send("report_pass")
        assert list(sm.configuration)[0].id == "report_writing"
        ctx.report_written = True
        sm.send("report_done")
        assert list(sm.configuration)[0].id == "complete"

    def test_deep_flow_with_revision(self):
        ctx = ResearchContext(detected_mode="deep", query="test")
        sm = ResearchWorkflow(model=ctx)
        sm.send("start")
        ctx.plan_complete = True
        sm.send("plan_done_deep")
        ctx.plan_critique_verdict = "NEEDS_REVISION"
        ctx.plan_critique_issues = ["too broad"]
        sm.send("critique_revise")
        assert list(sm.configuration)[0].id == "revising_plan"
        sm.send("revise_plan_done")
        assert list(sm.configuration)[0].id == "planning"

    def test_unknown_state(self):
        ctx = ResearchContext(detected_mode="standard", query="test")
        sm = ResearchWorkflow(model=ctx)
        sm.send("start")
        ctx.plan_complete = True
        sm.send("plan_to_research")
        ctx.last_confidence = "UNCERTAIN"
        sm.send("research_unknown")
        assert list(sm.configuration)[0].id == "unknown"
        sm.send("escalate")
        assert list(sm.configuration)[0].id == "awaiting_clarification"
        ctx.clarification_text = "more context"
        sm.send("resume_research")
        assert list(sm.configuration)[0].id == "researching"


class TestOrchestratorActions:
    """Tests for orchestrator action generation."""

    def test_quick_initial_action(self):
        orch = ResearchOrchestrator("s1", "What is TDD?", "quick")
        action = orch.next_action()
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "echo"
        assert "TDD" in action["task_summary"]

    def test_standard_initial_action(self):
        orch = ResearchOrchestrator("s1", "What are TDD best practices?", "standard")
        action = orch.next_action()
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "piper"

    def test_deep_initial_action(self):
        orch = ResearchOrchestrator("s1", "Comprehensive TDD analysis", "deep")
        action = orch.next_action()
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "piper"

    def test_parallel_research_dispatch(self):
        orch = ResearchOrchestrator("s1", "test", "standard")
        orch.context.sub_queries = ["q1", "q2", "q3"]
        orch.context.plan_complete = True
        # Advance to researching
        action = orch.advance({"plan_complete": True, "plan_steps": ["q1", "q2", "q3"]})
        assert action["action"] == "invoke_agents_parallel"
        assert len(action["tasks"]) == 3
        assert action["tasks"][0]["agent"] == "echo"

    def test_state_serialization(self):
        orch = ResearchOrchestrator("s1", "test", "standard")
        state = orch.extract_state()
        assert state["session_id"] == "s1"
        assert "context" in state
        assert state["context"]["query"] == "test"
        assert state["current_state_id"] == "intake"

    def test_state_restore(self):
        orch = ResearchOrchestrator("s1", "test", "standard")
        orch.context.sub_queries = ["q1", "q2"]
        orch.context.plan_complete = True
        state = orch.extract_state()

        orch2 = ResearchOrchestrator("s1", "test", "standard")
        orch2.restore_state(state)
        assert orch2.context.sub_queries == ["q1", "q2"]
        assert orch2.context.plan_complete is True

    def test_parallel_results_aggregation(self):
        """Parallel Echo results should be aggregated and advance once."""
        orch = ResearchOrchestrator("s1", "test", "standard")
        orch.context.sub_queries = ["q1", "q2", "q3"]
        orch.context.plan_complete = True
        orch.machine.send("start")
        orch.machine.send("plan_to_research")

        # Simulate 3 parallel Echo results
        result_data = [
            {"exitCode": 0, "summary": {"mempalace_drawer": "echo-1", "findings": ["f1"]}},
            {"exitCode": 0, "summary": {"mempalace_drawer": "echo-2", "findings": ["f2"]}},
            {"exitCode": 0, "summary": {"mempalace_drawer": "echo-3", "findings": ["f3"]}},
        ]
        action = orch.step("echo", result_data)
        assert orch.context.completed_tasks == ["echo-1", "echo-2", "echo-3"]
        assert orch.context.research_complete is True
        # Should have transitioned to synthesizing (standard mode)
        assert orch.current_state_id == "synthesizing"
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "synthia"

    def test_parallel_results_with_partial_failure(self):
        """Parallel results with some failures should still continue if >=50% succeed."""
        orch = ResearchOrchestrator("s1", "test", "standard")
        orch.context.sub_queries = ["q1", "q2", "q3"]
        orch.context.plan_complete = True
        orch.machine.send("start")
        orch.machine.send("plan_to_research")

        result_data = [
            {"exitCode": 0, "summary": {"mempalace_drawer": "echo-1"}},
            {"exitCode": 1, "summary": {}, "agent": "echo", "error": "timeout"},
            {"exitCode": 0, "summary": {"mempalace_drawer": "echo-3"}},
        ]
        action = orch.step("echo", result_data)
        assert "Parallel agent echo failed" in str(orch.context.errors)
        assert "2 of 3 parallel research tasks succeeded — proceeding with partial data" in orch.context.errors
        assert orch.current_state_id == "synthesizing"

    def test_parallel_results_with_majority_failure(self):
        """Parallel results with <50% success should abort to error."""
        orch = ResearchOrchestrator("s1", "test", "standard")
        orch.context.sub_queries = ["q1", "q2", "q3", "q4"]
        orch.context.plan_complete = True
        orch.machine.send("start")
        orch.machine.send("plan_to_research")

        result_data = [
            {"exitCode": 0, "summary": {"mempalace_drawer": "echo-1"}},
            {"exitCode": 1, "summary": {}, "agent": "echo", "error": "timeout"},
            {"exitCode": 1, "summary": {}, "agent": "echo", "error": "timeout"},
            {"exitCode": 1, "summary": {}, "agent": "echo", "error": "timeout"},
        ]
        action = orch.step("echo", result_data)
        assert "1 of 4 parallel research tasks succeeded — insufficient data" in orch.context.errors
        assert orch.current_state_id == "error"
        # Terminal states return None from next_action() — this is existing behavior
        assert action is None

    def test_graceful_synthesis_completion_inference(self):
        """Synthia without explicit synthesis_complete should infer from content."""
        orch = ResearchOrchestrator("s1", "test", "standard")
        orch.context.sub_queries = ["q1"]
        orch.context.plan_complete = True
        orch.context.research_complete = True
        orch.context.completed_tasks = ["echo-1"]
        orch.machine.send("start")
        orch.machine.send("plan_to_research")
        orch.machine.send("research_to_synth_std")

        # Synthia returns content but no synthesis_complete flag
        action = orch.step("synthia", {
            "exitCode": 0,
            "summary": {"theme_count": 3, "key_findings": ["finding 1"]}
        })
        assert orch.context.synthesis_complete is True
        # Should be in report_writing (not complete yet — skribble needs to write)
        assert orch.current_state_id == "report_writing"
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "skribble"




class TestModeDefaults:
    """Tests for mode-specific configuration defaults."""

    def test_quick_defaults(self):
        orch = ResearchOrchestrator("s1", "test", "quick")
        assert orch.context.max_sub_queries == 1

    def test_standard_defaults(self):
        orch = ResearchOrchestrator("s1", "test", "standard")
        assert orch.context.max_sub_queries == 3

    def test_deep_defaults(self):
        orch = ResearchOrchestrator("s1", "test", "deep")
        assert orch.context.max_sub_queries == 4

    def test_override_max_sub_queries(self):
        orch = ResearchOrchestrator(
            "s1", "test", "standard",
            constraints={"max_sub_queries": 5}
        )
        assert orch.context.max_sub_queries == 5
