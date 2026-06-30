"""
Integration tests for the research skill — mempalace and state serialization.
"""

import json
import pytest
from scripts.orchestrate import ResearchOrchestrator


class TestStateSerialization:
    """Round-trip state serialization tests."""

    def test_full_state_round_trip(self):
        orch = ResearchOrchestrator("s1", "test query", "deep")
        orch.context.sub_queries = ["q1", "q2", "q3"]
        orch.context.plan_complete = True
        orch.context.plan_critique_verdict = "APPROVE"
        orch.context.research_task_ids = ["t1", "t2", "t3"]
        orch.context.completed_tasks = ["t1", "t2", "t3"]
        orch.context.research_complete = True
        orch.context.synthesis_complete = True
        orch.context.report_critique_verdict = "APPROVE"
        orch.context.report_word_count = 1500

        state = orch.extract_state()

        # Verify all fields present
        assert state["context"]["sub_queries"] == ["q1", "q2", "q3"]
        assert state["context"]["plan_complete"] is True
        assert state["context"]["synthesis_complete"] is True
        assert state["context"]["report_word_count"] == 1500

        # Restore and verify
        orch2 = ResearchOrchestrator("s1", "test query", "deep")
        orch2.restore_state(state)
        assert orch2.context.sub_queries == ["q1", "q2", "q3"]
        assert orch2.context.report_word_count == 1500

    def test_error_state_recovery(self):
        orch = ResearchOrchestrator("s1", "test", "standard")
        orch.context.errors = ["Agent timeout", "Malformed summary"]
        orch.context.unknown_reason = "Agent returned UNCERTAIN"

        state = orch.extract_state()
        orch2 = ResearchOrchestrator("s1", "test", "standard")
        orch2.restore_state(state)
        assert orch2.context.errors == ["Agent timeout", "Malformed summary"]


class TestAdvanceFlow:
    """Tests for the advance() method with simulated agent summaries."""

    def test_standard_advance_plan_to_research(self):
        orch = ResearchOrchestrator("s1", "test", "standard")
        # Simulate Piper completing with sub-queries
        action = orch.advance({
            "plan_complete": True,
            "plan_steps": ["q1", "q2"],
        })
        assert action["action"] == "invoke_agents_parallel"
        assert len(action["tasks"]) == 2

    def test_deep_advance_with_critique(self):
        orch = ResearchOrchestrator("s1", "test", "deep")
        # Piper completes
        action = orch.advance({
            "plan_complete": True,
            "plan_steps": ["q1", "q2", "q3"],
        })
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "carren"

        # Carren approves
        action = orch.advance({
            "verdict": "APPROVE",
            "issues": [],
        })
        assert action["action"] == "invoke_agents_parallel"
        assert len(action["tasks"]) == 3

    def test_quick_advance_no_planning(self):
        orch = ResearchOrchestrator("s1", "What is TDD?", "quick")
        action = orch.next_action()
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "echo"

        # Echo completes
        action = orch.advance({
            "findings_count": 3,
            "explore_complete": True,
            "mempalace_drawer": "drawer-1",
        })
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "synthia"

    def test_deep_advance_full_flow(self):
        orch = ResearchOrchestrator("s1", "test", "deep")

        # Planning
        action = orch.advance({"plan_complete": True, "plan_steps": ["q1", "q2"]})
        assert action["agent"] == "carren"

        # Plan critique
        action = orch.advance({"verdict": "APPROVE", "issues": []})
        assert action["action"] == "invoke_agents_parallel"

        # Research (simulate parallel Echo completion)
        action = orch.step("echo", [
            {"exitCode": 0, "summary": {"explore_complete": True, "mempalace_drawer": "d1"}},
            {"exitCode": 0, "summary": {"explore_complete": True, "mempalace_drawer": "d2"}},
        ])
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "synthia"

        # Synthia synthesizes (no separate validation phase — deep mode goes research→synth)
        action = orch.advance({"synthesis_complete": True, "report_word_count": 2000})
        assert action["agent"] == "carren"

        # Report critique → Skribble
        action = orch.advance({"verdict": "APPROVE", "issues": []})
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "skribble"

        # Skribble writes report → complete
        action = orch.advance({
            "write_complete": True,
            "files_written": ["report.md", "sources.md", "README.md"],
            "word_count": 2000,
        })
        assert action["action"] == "complete"


class TestJsonOutput:
    """Tests that orchestrator output is valid JSON."""

    def test_all_actions_are_json_serializable(self):
        orch = ResearchOrchestrator("s1", "test", "deep")

        # Test each action type by calling the entry action methods directly
        actions = [
            orch.on_enter_planning(),
            orch.on_enter_critiquing_plan(),
            orch.on_enter_researching(),
            orch.on_enter_synthesizing(),
            orch.on_enter_critiquing_report(),
            orch.on_enter_report_writing(),
            orch.on_enter_unknown(),
            orch.on_enter_complete(),
            orch.on_enter_error(),
        ]

        for action in actions:
            # Should be valid JSON
            json_str = json.dumps(action)
            parsed = json.loads(json_str)
            assert parsed is not None
            assert isinstance(parsed, dict)
            assert "action" in parsed
