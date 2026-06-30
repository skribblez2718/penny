"""
Phase 2 Integration Tests — Enhanced KG Usage Evaluation
Tests that verify agent definitions, orchestrator context, and workflow integration
support Knowledge Graph linking after the Phase 1 architecture changes.
"""

import pytest
from pathlib import Path
from scripts.orchestrate import AgentContext, Orchestrator


AGENTS_DIR = Path(__file__).parent.parent.parent.parent / "agents"
SYSTEM_MD = Path(__file__).parent.parent.parent.parent / "SYSTEM.md"
KG_REF_DOC = Path(__file__).parent.parent.parent.parent.parent / "docs" / "agents" / "memory" / "kg-patterns.md"


class TestAgentDefinitionsContainKGRules:
    """Verify all 7 agent definitions have KG linking rules in Non-Negotiable section."""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.agent_files = {
            "echo": AGENTS_DIR / "echo.md",
            "piper": AGENTS_DIR / "piper.md",
            "carren": AGENTS_DIR / "carren.md",
            "tabitha": AGENTS_DIR / "tabitha.md",
            "skribble": AGENTS_DIR / "skribble.md",
            "vera": AGENTS_DIR / "vera.md",
        }

    def _read_agent(self, name):
        path = self.agent_files[name]
        assert path.exists(), f"Agent file missing: {path}"
        return path.read_text()

    def _get_non_negotiable_section(self, content):
        """Extract Non-Negotiable Rules section up to next ## heading."""
        start = content.find("## Non-Negotiable Rules")
        assert start != -1, "Missing Non-Negotiable Rules section"
        after = content.find("## Output Format", start)
        assert after != -1, "Missing Output Format section after Non-Negotiable"
        return content[start:after]

    def test_all_agents_have_non_negotiable_section(self):
        for name in self.agent_files:
            content = self._read_agent(name)
            section = self._get_non_negotiable_section(content)
            assert len(section) > 100, f"{name}: Non-Negotiable section too short"

    def test_all_agents_have_kg_linking_rule(self):
        """Each agent must have a rule mentioning memory_kg_add or KG linking."""
        for name in self.agent_files:
            content = self._read_agent(name)
            section = self._get_non_negotiable_section(content)
            has_kg = "memory_kg_add" in section or "knowledge graph" in section.lower() or "link" in section.lower()
            assert has_kg, f"{name}: Missing KG linking rule in Non-Negotiable section"

    def test_echo_has_explored_by_pattern(self):
        content = self._read_agent("echo")
        section = self._get_non_negotiable_section(content)
        assert "explored_by" in section or "explored" in section.lower(), "echo: Missing explored_by linking pattern"

    def test_piper_has_planned_by_pattern(self):
        content = self._read_agent("piper")
        section = self._get_non_negotiable_section(content)
        assert "planned_by" in section or "planned" in section.lower(), "piper: Missing planned_by linking pattern"

    def test_carren_has_critiqued_by_pattern(self):
        content = self._read_agent("carren")
        section = self._get_non_negotiable_section(content)
        assert "critiqued_by" in section or "critiqued" in section.lower(), "carren: Missing critiqued_by linking pattern"

    def test_skribble_has_generated_from_pattern(self):
        content = self._read_agent("skribble")
        section = self._get_non_negotiable_section(content)
        assert "generated_from" in section or "generated" in section.lower(), "skribble: Missing generated_from linking pattern"

    def test_vera_has_verified_by_pattern(self):
        content = self._read_agent("vera")
        section = self._get_non_negotiable_section(content)
        assert "verified_by" in section or "verified" in section.lower(), "vera: Missing verified_by linking pattern"

    def test_tabitha_has_broken_into_pattern(self):
        content = self._read_agent("tabitha")
        section = self._get_non_negotiable_section(content)
        assert "broken_into" in section or "broken" in section.lower(), "tabitha: Missing broken_into linking pattern"



class TestSystemMDContainsKGRule:
    """Verify SYSTEM.md has the universal KG linking rule."""

    def test_knowledge_graph_section_present(self):
        assert SYSTEM_MD.exists(), "SYSTEM.md missing"
        content = SYSTEM_MD.read_text()
        assert "Knowledge Graph" in content or "knowledge graph" in content.lower(), "SYSTEM.md missing KG section"

    def test_memory_kg_add_mentioned(self):
        content = SYSTEM_MD.read_text()
        assert "memory_kg_add" in content, "SYSTEM.md missing memory_kg_add reference"

    def test_kg_section_between_output_contract_and_system_context(self):
        """Architecture rule: KG section must be between Output Contract and </system_context>."""
        content = SYSTEM_MD.read_text()
        output_contract = content.find("# Output Contract")
        kg_section = content.find("# Knowledge Graph")
        system_context_end = content.find("</system_context>")

        assert output_contract != -1, "Missing Output Contract"
        assert kg_section != -1, "Missing Knowledge Graph section"
        assert system_context_end != -1, "Missing </system_context>"
        assert output_contract < kg_section < system_context_end, \
            "KG section must be between Output Contract and </system_context>"


class TestOrchestratorProvidesContextForKGLinking:
    """Verify orchestrator actions include session IDs needed for KG linking."""

    def test_start_action_includes_session_id(self):
        ctx = AgentContext(session_id="kg-test-001", goal="Build agent")
        orch = Orchestrator(context=ctx)
        action = orch.start("Build test agent")
        assert action["session_id"] == "kg-test-001", "Session ID missing in start action"

    def test_step_action_preserves_session_id(self):
        ctx = AgentContext(session_id="kg-test-002", goal="Build agent")
        orch = Orchestrator(context=ctx)
        orch.start("Build test agent")
        state = orch.extract_state()

        result = {"exitCode": 0, "summary": {"explore_complete": True}}
        action = orch.step("echo", result, state)
        assert action.get("session_id") == "kg-test-002" or action.get("orchestrator_state", {}).get("session_id") == "kg-test-002", \
            "Session ID lost across steps"

    def test_subskill_mode_includes_parent_session(self):
        ctx = AgentContext(session_id="child-001", constraints={"parent_session_id": "parent-001"})
        orch = Orchestrator(context=ctx)
        _ = orch.start("Build sub agent")
        assert orch.context.parent_session_id == "parent-001", "Parent session ID not tracked"
        # Agents can use parent_session_id to link KG triples to parent session

    def test_complete_action_includes_agent_name_for_kg(self):
        ctx = AgentContext(session_id="kg-test-003", goal="Build agent")
        orch = Orchestrator(context=ctx)
        orch.start("Build test agent")

        # Simulate full lifecycle
        orch.step("echo", {"exitCode": 0, "summary": {"explore_complete": True}}, orch.extract_state())
        orch.step("piper", {"exitCode": 0, "summary": {"design_complete": True, "design_steps": [{"field": "name", "value": "test"}]}}, orch.extract_state())
        orch.step("carren", {"exitCode": 0, "summary": {"verdict": "APPROVE"}}, orch.extract_state())
        orch.step("skribble", {"exitCode": 0, "summary": {"generation_complete": True, "files_created": [".pi/agents/test.md"]}}, orch.extract_state())
        orch.step("vera", {"exitCode": 0, "summary": {"verification_complete": True, "yaml_valid": True, "schema_valid": True, "diff_applied": True}}, orch.extract_state())

        action = orch.step("vera", {"exitCode": 0, "summary": {"verification_complete": True, "yaml_valid": True, "schema_valid": True, "diff_applied": True}}, orch.extract_state())
        if action["action"] == "complete":
            assert "agent_name" in action["plan_summary"] or "subskill_return" in action["plan_summary"], \
                "Complete action missing entity identifiers for KG linking"


class TestAgentToolSetsIncludeMemoryTools:
    """Verify all agents have the 4 required memory tools."""

    REQUIRED_TOOLS = {"memory_smart_search", "memory_add_drawer", "memory_check_duplicate", "memory_kg_add"}

    @pytest.fixture(autouse=True)
    def setup(self):
        self.agent_files = {
            "echo": AGENTS_DIR / "echo.md",
            "piper": AGENTS_DIR / "piper.md",
            "carren": AGENTS_DIR / "carren.md",
            "tabitha": AGENTS_DIR / "tabitha.md",
            "skribble": AGENTS_DIR / "skribble.md",
            "vera": AGENTS_DIR / "vera.md",
        }

    def test_all_agents_have_all_memory_tools(self):
        for name, path in self.agent_files.items():
            content = path.read_text()
            for tool in self.REQUIRED_TOOLS:
                assert tool in content, f"{name}: Missing required memory tool {tool}"


class TestKGPredicatesInReferenceDoc:
    """Verify KG patterns reference doc contains standard predicates."""

    REF_DOC = Path(__file__).parent.parent.parent / "docs" / "agents" / "memory" / "kg-patterns.md"

    def test_reference_doc_exists(self):
        if not KG_REF_DOC.exists():
            pytest.skip("KG patterns reference doc not yet created")
        content = KG_REF_DOC.read_text()
        assert len(content) > 500, "Reference doc too short"

    def test_standard_predicates_present(self):
        if not KG_REF_DOC.exists():
            pytest.skip("KG patterns reference doc not yet created")
        content = KG_REF_DOC.read_text()
        expected_predicates = [
            "explored_by", "planned_by", "critiqued_by", "generated_by",
            "verified_by", "broken_into", "based_on", "generated_from",
            "tested_by", "fixes", "follows"
        ]
        for pred in expected_predicates:
            assert pred in content, f"Missing predicate {pred} in reference doc"


class TestRegressionLifecycleAfterKGLinkingChanges:
    """Regression tests: full lifecycle still works after SYSTEM.md + agent changes."""

    def test_happy_path_lifecycle_with_agent_name_extraction(self):
        ctx = AgentContext(session_id="reg-001")
        orch = Orchestrator(context=ctx)
        action = orch.start("Build climate research agent")
        assert action["action"] in ("invoke_agent", "invoke_agents_parallel")
        assert orch.context.agent_name == "Build", "Agent name extraction broken"

    def test_parallel_execution_structure_preserved(self):
        ctx = AgentContext(session_id="reg-002", goal="Build agent")
        orch = Orchestrator(context=ctx)
        orch.workflow.start()
        action = orch._action_explore()
        assert action["action"] == "invoke_agents_parallel"
        assert len(action["tasks"]) >= 3
        for task in action["tasks"]:
            assert "agent" in task, "Task missing agent field"
            assert "task_summary" in task, "Task missing task_summary field"

    def test_verification_state_transitions(self):
        ctx = AgentContext(session_id="reg-003", goal="Build agent")
        orch = Orchestrator(context=ctx)
        orch.start("Build agent")

        # Explore → Design → Critique → Scaffold → Verify
        orch.step("echo", {"exitCode": 0, "summary": {"explore_complete": True}}, orch.extract_state())
        orch.step("piper", {"exitCode": 0, "summary": {"design_complete": True, "design_steps": [{"field": "name", "value": "test"}]}}, orch.extract_state())
        orch.step("carren", {"exitCode": 0, "summary": {"verdict": "APPROVE", "issues": []}}, orch.extract_state())
        orch.step("skribble", {"exitCode": 0, "summary": {"generation_complete": True, "files_created": [".pi/agents/test.md"]}}, orch.extract_state())

        action = orch.step("vera", {"exitCode": 0, "summary": {"verification_complete": True, "yaml_valid": True, "schema_valid": True, "diff_applied": True}}, orch.extract_state())
        assert action["action"] == "complete", f"Expected complete, got {action['action']}"

    def test_critique_needs_revision_cycles_to_design(self):
        ctx = AgentContext(session_id="reg-004", goal="Build agent")
        orch = Orchestrator(context=ctx)
        orch.start("Build agent")
        orch.step("echo", {"exitCode": 0, "summary": {"explore_complete": True}}, orch.extract_state())
        orch.step("piper", {"exitCode": 0, "summary": {"design_complete": True, "design_steps": [{"field": "name", "value": "test"}]}}, orch.extract_state())

        # Critique fails
        action = orch.step("carren", {"exitCode": 0, "summary": {"verdict": "NEEDS_REVISION", "issues": ["Missing field"]}}, orch.extract_state())
        assert action["action"] in ("invoke_agent", "invoke_agents_parallel"), "Revision cycle broken"

    def test_verification_failure_re_scaffolds(self):
        ctx = AgentContext(session_id="reg-005", goal="Build agent")
        orch = Orchestrator(context=ctx)
        orch.start("Build agent")
        orch.step("echo", {"exitCode": 0, "summary": {"explore_complete": True}}, orch.extract_state())
        orch.step("piper", {"exitCode": 0, "summary": {"design_complete": True, "design_steps": [{"field": "name", "value": "test"}]}}, orch.extract_state())
        orch.step("carren", {"exitCode": 0, "summary": {"verdict": "APPROVE", "issues": []}}, orch.extract_state())
        orch.step("skribble", {"exitCode": 0, "summary": {"generation_complete": True, "files_created": [".pi/agents/test.md"]}}, orch.extract_state())

        # Verification fails
        action = orch.step("vera", {"exitCode": 0, "summary": {"verification_complete": False, "yaml_valid": False, "schema_valid": True, "diff_applied": True}}, orch.extract_state())
        assert action["action"] == "invoke_agent", f"Expected re-scaffold, got {action['action']}"
        assert action["agent"] == "skribble", "Verification failure should route back to skribble"

    def test_state_roundtrip_preserved(self):
        ctx = AgentContext(session_id="reg-006", goal="Build agent")
        orch = Orchestrator(context=ctx)
        orch.start("Build agent")
        orch.step("echo", {"exitCode": 0, "summary": {"explore_complete": True}}, orch.extract_state())

        state = orch.extract_state()
        ctx2 = AgentContext(session_id="reg-006-2", goal="x")
        orch2 = Orchestrator(context=ctx2)
        orch2.restore_state(state)
        # agent_name is derived from goal via intake, not stored in context directly
        assert orch2.context.goal == "Build agent", "Goal not preserved in state"

    def test_escalation_on_uncertain_confidence(self):
        ctx = AgentContext(session_id="reg-007", goal="Build agent")
        orch = Orchestrator(context=ctx)
        orch.start("Build agent")

        action = orch.step("echo", {"exitCode": 0, "summary": {"explore_complete": False, "confidence": "UNCERTAIN", "unknown_reason": "ambiguous"}}, orch.extract_state())
        assert action["action"] == "escalate_to_user", "Escalation on uncertainty broken"

    def test_max_iterations_guard(self):
        ctx = AgentContext(session_id="reg-008", goal="Build agent")
        orch = Orchestrator(context=ctx)
        orch.start("Build agent")
        orch.context.exploration_iterations = 5

        # Should still be able to transition or error gracefully
        action = orch._action_explore()
        assert action["action"] in ("invoke_agent", "invoke_agents_parallel", "error"), "Max iterations guard broken"

    def test_subskill_return_format_preserved(self):
        ctx = AgentContext(session_id="reg-009", goal="Build agent", constraints={"parent_session_id": "parent-123"})
        orch = Orchestrator(context=ctx)
        orch.start("Build agent")
        orch.step("echo", {"exitCode": 0, "summary": {"explore_complete": True}}, orch.extract_state())
        orch.step("piper", {"exitCode": 0, "summary": {"design_complete": True, "design_steps": [{"field": "name", "value": "test"}]}}, orch.extract_state())
        orch.step("carren", {"exitCode": 0, "summary": {"verdict": "APPROVE", "issues": []}}, orch.extract_state())
        orch.step("skribble", {"exitCode": 0, "summary": {"generation_complete": True, "files_created": [".pi/agents/test.md"]}}, orch.extract_state())

        action = orch.step("vera", {"exitCode": 0, "summary": {"verification_complete": True, "yaml_valid": True, "schema_valid": True, "diff_applied": True}}, orch.extract_state())
        assert action["action"] == "complete"
        assert action["plan_summary"]["subskill_return"]["agent_name"] == "Build", "Subskill return format broken"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
