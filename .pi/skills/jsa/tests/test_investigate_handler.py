"""Tests for the full INVESTIGATE handler implementation (Phase D).

Verifies per-lane routing, work item generation, and packet types.
"""

import sys
from pathlib import Path

import pytest

# Add the scripts directory to the path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from fsm import (
    JSAState,
    investigate_handler,
    structure_handler,
    slice_handler,
)


class TestInvestigateHandlerFull:
    """Tests for the full INVESTIGATE handler implementation."""

    def test_empty_state(self):
        state = JSAState(analyzers=["dom_xss"])
        state = investigate_handler(state)
        # No flow cards, no page cards, no analyzers... wait, we do have analyzers
        # Should still produce a plan with 1 work item (site survey)
        plan = state.metadata["investigate_plan"]
        assert plan["total_agents"] >= 1
        assert "work_items" in plan

    def test_no_cards_no_analyzers(self):
        """Without analyzers or cards, no work items."""
        state = JSAState()
        state.analyzers = []
        state = investigate_handler(state)
        plan = state.metadata["investigate_plan"]
        assert plan["total_agents"] == 0

    def test_groups_flow_cards_by_lane(self):
        """FlowCards should be grouped by their lane attribute."""
        state = JSAState()
        from flow_card import FlowCard
        # 3 code_static + 2 page_dom flow cards
        for i in range(3):
            state.flow_cards.append(
                FlowCard(flow_id=f"cs-{i}", vulnerability_class="dom_xss", lane="code_static")
            )
        for i in range(2):
            state.flow_cards.append(
                FlowCard(flow_id=f"pd-{i}", vulnerability_class="reflected_xss", lane="page_dom")
            )
        state = investigate_handler(state)
        plan = state.metadata["investigate_plan"]
        # Should have 3 + 2 = 5 code work items
        assert plan["total_agents"] == 5
        # Lane counts
        assert plan["lanes"]["code_static"] == 3
        assert plan["lanes"]["page_dom"] == 2

    def test_creates_network_behavior_work_items_for_page_cards(self):
        """Each PageCard should create one work item per network-behavior analyzer."""
        state = JSAState()
        state.analyzers = ["cors", "csrf", "idor"]
        # Add 2 page cards
        from page_card import PageCard
        for i in range(2):
            state.page_cards.append(
                PageCard(page_id=f"pc-{i}", url=f"https://example.com/{i}")
            )
        state = investigate_handler(state)
        plan = state.metadata["investigate_plan"]
        # 2 page cards * 3 analyzers = 6 work items
        assert plan["total_agents"] == 6
        # Lane count for network_behavior
        assert plan["lanes"]["network_behavior"] == 6

    def test_work_items_have_correct_packet_types(self):
        """Work items should have packet_type set based on lane."""
        state = JSAState()
        from flow_card import FlowCard
        from page_card import PageCard

        state.flow_cards.append(
            FlowCard(flow_id="cs-1", vulnerability_class="dom_xss", lane="code_static")
        )
        state.flow_cards.append(
            FlowCard(flow_id="pd-1", vulnerability_class="reflected_xss", lane="page_dom")
        )
        state.page_cards.append(
            PageCard(page_id="pc-1", url="https://example.com/")
        )
        state.analyzers = ["cors"]
        state = investigate_handler(state)

        work_items = state.metadata["investigate_work_items"]
        packet_types = {wi["packet_type"] for wi in work_items}
        assert "flow_card" in packet_types
        assert "page_card_with_flow_cards" in packet_types
        assert "page_card_with_caido_history" in packet_types

    def test_work_items_have_unique_ids(self):
        """Each work item should have a unique UUID."""
        state = JSAState()
        from flow_card import FlowCard
        for i in range(5):
            state.flow_cards.append(
                FlowCard(flow_id=f"fc-{i}", vulnerability_class="dom_xss", lane="code_static")
            )
        state = investigate_handler(state)
        work_items = state.metadata["investigate_work_items"]
        ids = [wi["work_id"] for wi in work_items]
        assert len(ids) == len(set(ids)), "Work item IDs should be unique"

    def test_work_items_reference_correct_cards(self):
        """Code-static work items should reference the source flow card."""
        state = JSAState()
        from flow_card import FlowCard
        fc = FlowCard(flow_id="my-flow-card", vulnerability_class="dom_xss", lane="code_static")
        state.flow_cards.append(fc)
        state = investigate_handler(state)
        work_items = state.metadata["investigate_work_items"]
        code_work = [wi for wi in work_items if wi["lane"] == "code_static"]
        assert len(code_work) == 1
        assert code_work[0]["flow_card"] is fc

    def test_page_dom_work_item_references_flow_card(self):
        """Page-DOM work items should reference their flow card AND page card IDs."""
        state = JSAState()
        from flow_card import FlowCard
        fc = FlowCard(
            flow_id="my-pd-flow",
            vulnerability_class="reflected_xss",
            lane="page_dom",  # underscore to match LANE_CONFIGS keys
            page_card_ids=["pc-1", "pc-2"],
        )
        state.flow_cards.append(fc)
        state = investigate_handler(state)
        work_items = state.metadata["investigate_work_items"]
        pd_work = [wi for wi in work_items if wi["lane"] == "page_dom"]
        assert len(pd_work) == 1
        assert pd_work[0]["flow_card"] is fc
        assert pd_work[0]["page_card_ids"] == ["pc-1", "pc-2"]

    def test_network_behavior_work_item_references_page_card(self):
        """Network-behavior work items should reference the page card."""
        state = JSAState()
        from page_card import PageCard
        pc = PageCard(page_id="pc-1", url="https://example.com/")
        state.page_cards.append(pc)
        state.analyzers = ["cors"]
        state = investigate_handler(state)
        work_items = state.metadata["investigate_work_items"]
        net_work = [wi for wi in work_items if wi["lane"] == "network_behavior"]
        assert len(net_work) == 1
        assert net_work[0]["page_card"] is pc

    def test_total_waves_computed(self):
        """Total waves should be ceil(work_items / chunks_per_wave)."""
        state = JSAState()
        from flow_card import FlowCard
        # 7 flow cards / 4 per wave = 2 waves (ceil)
        for i in range(7):
            state.flow_cards.append(
                FlowCard(flow_id=f"fc-{i}", vulnerability_class="dom_xss", lane="code_static")
            )
        state = investigate_handler(state)
        plan = state.metadata["investigate_plan"]
        assert plan["total_waves"] == 2

    def test_minimum_one_wave(self):
        """Even with 0 work items, total_waves should be at least 1."""
        state = JSAState()
        state.analyzers = []
        state = investigate_handler(state)
        plan = state.metadata["investigate_plan"]
        assert plan["total_waves"] == 1

    def test_context_included_in_plan(self):
        """Plan should include context info (SAST, CVEs, Joern)."""
        state = JSAState()
        state.metadata["cve_research"] = {
            "tech_stack_hints": {"jquery": {"version": "1.9.0"}},
            "cves": [{"cve_id": "CVE-2019-11358"}],
        }
        state.sast_validated = [{"validation": "confirmed"}]
        state = investigate_handler(state)
        plan = state.metadata["investigate_plan"]
        ctx = plan["context_included"]
        assert ctx["sast_validated"] is True
        assert ctx["tech_stack_available"] is True
        assert ctx["cve_count"] == 1

    def test_site_survey_work_items_when_no_cards(self):
        """When analyzers are configured but no cards, create one work item per analyzer."""
        state = JSAState()
        state.analyzers = ["dom_xss", "prototype_pollution", "sqli"]
        state = investigate_handler(state)
        plan = state.metadata["investigate_plan"]
        assert plan["total_agents"] == 3
        # Each work item is a "site survey" with empty packet
        for wi in plan["work_items"]:
            assert wi["packet_type"] == "empty"

    def test_full_pipeline_creates_work_items(self):
        """End-to-end: STRUCTURE + SLICE + INVESTIGATE should produce work items."""
        state = JSAState()
        state.analyzers = ["dom_xss", "cors"]
        files = [
            ("vuln.js", "el.innerHTML = userInput; eval(x);"),
            ("page.html", "<html></html>"),
        ]
        state = structure_handler(state, js_files=files)
        state = slice_handler(state)
        state = investigate_handler(state)

        plan = state.metadata["investigate_plan"]
        # At least: 1 dom_xss flow card + 1 page card * 1 cors analyzer
        # Plus 1 site survey for sqli (not in sast but in analyzers)
        assert plan["total_agents"] >= 2
