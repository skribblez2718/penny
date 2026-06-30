"""
End-to-end tests for the research skill.

These tests simulate full skill invocations by exercising the orchestrator
through multiple state transitions as the skill extension would.
"""

import json
import pytest
from scripts.orchestrate import ResearchOrchestrator


class TestQuickModeE2E:
    """Full quick mode research simulation."""

    def test_quick_research_flow(self):
        orch = ResearchOrchestrator("s1", "What is TDD?", "quick")

        # Step 1: Initial action → Echo
        action = orch.next_action()
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "echo"
        assert action["state_id"] == "researching"

        # Step 2: Echo completes → Synthia
        action = orch.advance({
            "findings_count": 3,
            "sources_count": 2,
            "t1_count": 1,
            "t2_count": 1,
            "confidence": "Medium",
            "explore_complete": True,
            "mempalace_drawer": "s1-echo-1",
        })
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "synthia"
        assert action["state_id"] == "synthesizing"

        # Step 3: Synthia completes → Skribble writes report
        action = orch.advance({
            "report_word_count": 800,
            "theme_count": 2,
            "source_count": 2,
            "confidence": "Medium",
            "synthesis_complete": True,
            "mempalace_drawer": "s1-synthesis",
        })
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "skribble"
        assert action["state_id"] == "report_writing"

        # Step 4: Skribble completes → done
        action = orch.advance({
            "write_complete": True,
            "files_written": ["report.md", "sources.md", "README.md"],
            "word_count": 800,
        })
        assert action["action"] == "complete"
        assert action["state_id"] == "complete"
        assert action["result"]["mode"] == "quick"

        assert orch.is_terminal


class TestStandardModeE2E:
    """Full standard mode research simulation."""

    def test_standard_research_flow(self):
        orch = ResearchOrchestrator("s1", "What are TDD best practices?", "standard")

        # Step 1: Initial action → Piper
        action = orch.next_action()
        assert action["agent"] == "piper"

        # Step 2: Piper completes → parallel Echo
        action = orch.advance({
            "plan_complete": True,
            "plan_steps": [
                "What is the RED-GREEN-REFACTOR cycle?",
                "What are common TDD anti-patterns?",
                "What tools support TDD workflows?",
            ],
        })
        assert action["action"] == "invoke_agents_parallel"
        assert len(action["tasks"]) == 3

        # Step 3: All Echo tasks complete → Synthia (parallel batch via step)
        action = orch.step("echo", [
            {"exitCode": 0, "summary": {
                "findings_count": 5, "sources_count": 3, "confidence": "Medium",
                "explore_complete": True, "mempalace_drawer": "s1-echo-1"
            }},
            {"exitCode": 0, "summary": {
                "findings_count": 5, "sources_count": 3, "confidence": "Medium",
                "explore_complete": True, "mempalace_drawer": "s1-echo-2"
            }},
            {"exitCode": 0, "summary": {
                "findings_count": 5, "sources_count": 3, "confidence": "Medium",
                "explore_complete": True, "mempalace_drawer": "s1-echo-3"
            }},
        ])
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "synthia"

        # Step 4: Synthia completes → Skribble
        action = orch.advance({
            "report_word_count": 2000,
            "theme_count": 4,
            "source_count": 9,
            "confidence": "Medium",
            "synthesis_complete": True,
            "mempalace_drawer": "s1-synthesis",
        })
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "skribble"
        assert action["state_id"] == "report_writing"

        # Step 5: Skribble completes → done
        action = orch.advance({
            "write_complete": True,
            "files_written": ["report.md", "sources.md", "README.md"],
            "word_count": 2000,
        })
        assert action["action"] == "complete"
        assert action["result"]["mode"] == "standard"


class TestDeepModeE2E:
    """Full deep mode research simulation with all gates."""

    def test_deep_research_flow(self):
        orch = ResearchOrchestrator(
            "s1",
            "Comprehensive analysis of microservices vs monoliths tradeoffs",
            "deep",
        )

        # Step 1: Piper plans
        action = orch.next_action()
        assert action["agent"] == "piper"

        # Step 2: Piper completes → Carren critique
        action = orch.advance({
            "plan_complete": True,
            "plan_steps": [
                "Real-world failure modes of microservices",
                "Cost differences from published case studies",
                "Team size thresholds for microservices viability",
                "Performance benchmarks comparing both architectures",
            ],
        })
        assert action["agent"] == "carren"

        # Step 3: Carren approves → parallel Echo
        action = orch.advance({
            "verdict": "APPROVE",
            "issues": [],
        })
        assert action["action"] == "invoke_agents_parallel"
        assert len(action["tasks"]) == 4

        # Step 4: All Echo tasks complete → Synthia (parallel batch via step)
        action = orch.step("echo", [
            {"exitCode": 0, "summary": {
                "findings_count": 8, "sources_count": 5,
                "t1_count": 2, "t2_count": 2, "t3_count": 1,
                "confidence": "High",
                "explore_complete": True, "mempalace_drawer": "s1-echo-1"
            }},
            {"exitCode": 0, "summary": {
                "findings_count": 8, "sources_count": 5,
                "t1_count": 2, "t2_count": 2, "t3_count": 1,
                "confidence": "High",
                "explore_complete": True, "mempalace_drawer": "s1-echo-2"
            }},
            {"exitCode": 0, "summary": {
                "findings_count": 8, "sources_count": 5,
                "t1_count": 2, "t2_count": 2, "t3_count": 1,
                "confidence": "High",
                "explore_complete": True, "mempalace_drawer": "s1-echo-3"
            }},
            {"exitCode": 0, "summary": {
                "findings_count": 8, "sources_count": 5,
                "t1_count": 2, "t2_count": 2, "t3_count": 1,
                "confidence": "High",
                "explore_complete": True, "mempalace_drawer": "s1-echo-4"
            }},
        ])
        assert action["agent"] == "synthia"

        # Step 5: Synthia synthesizes → Carren report critique
        action = orch.advance({
            "report_word_count": 3500,
            "theme_count": 6,
            "source_count": 18,
            "confidence": "High",
            "synthesis_complete": True,
        })
        assert action["agent"] == "carren"

        # Step 6: Carren approves report → Skribble
        action = orch.advance({
            "verdict": "APPROVE",
            "issues": [],
        })
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "skribble"
        assert action["state_id"] == "report_writing"

        # Step 7: Skribble writes report → complete
        action = orch.advance({
            "write_complete": True,
            "files_written": ["report.md", "sources.md", "README.md"],
            "word_count": 3500,
        })
        assert action["action"] == "complete"
        assert action["result"]["mode"] == "deep"

    def test_deep_with_plan_revision(self):
        orch = ResearchOrchestrator("s1", "test", "deep")

        # Piper plans
        action = orch.next_action()
        assert action["agent"] == "piper"

        # Piper completes → Carren
        action = orch.advance({
            "plan_complete": True,
            "plan_steps": ["q1", "q2"],
        })
        assert action["agent"] == "carren"

        # Carren rejects → revise → replan → Carren approves
        action = orch.advance({
            "verdict": "NEEDS_REVISION",
            "issues": ["Sub-query 1 is too broad", "Need more specific angle"],
        })
        # After revision, the state machine transitions back to planning
        assert action["state_id"] == "planning"

        # Piper replans
        action = orch.advance({
            "plan_complete": True,
            "plan_steps": ["more specific q1", "q2"],
        })
        assert action["agent"] == "carren"

        # Carren approves
        action = orch.advance({
            "verdict": "APPROVE",
            "issues": [],
        })
        assert action["action"] == "invoke_agents_parallel"


class TestResumeFromState:
    """Test resuming a research session from saved state."""

    def test_resume_mid_research(self):
        # Create an in-progress session by simulating the flow
        orch = ResearchOrchestrator("s1", "test", "standard")
        # Advance to planning
        action = orch.next_action()
        assert action["agent"] == "piper"

        # Piper completes
        action = orch.advance({
            "plan_complete": True,
            "plan_steps": ["q1", "q2", "q3"],
        })
        assert action["action"] == "invoke_agents_parallel"

        # Complete 2 of 3 research tasks (no explore_complete — partial progress)
        action = orch.advance({"mempalace_drawer": "t1"})
        assert action is None  # Still waiting for more tasks
        action = orch.advance({"mempalace_drawer": "t2"})
        assert action is None  # Still waiting for t3

        # Save state at this point (researching, 2/3 done)
        state = orch.extract_state()
        assert orch.current_state_id == "researching"

        # Resume
        orch2 = ResearchOrchestrator("s1", "test", "standard")
        orch2.restore_state(state)

        # Should be in researching state
        assert orch2.current_state_id == "researching"

        # Complete the last task
        action = orch2.advance({"explore_complete": True, "mempalace_drawer": "t3"})
        assert action["agent"] == "synthia"

        # Complete the last task
        action = orch.advance({"explore_complete": True, "mempalace_drawer": "t3"})
        assert action["agent"] == "synthia"
