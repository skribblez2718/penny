"""
Dispatch unit tests.
"""

import sys
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from dispatch import (
    build_worker_prompt,
    compute_concurrency,
    build_dispatch_plan,
    build_mesh_join_event,
    build_mesh_complete_event,
    build_feed_cross_chunk_hint,
)


def _make_mock_chunk(chunk_id="chunk-0", body="const x = 1;", chunk_index=0, 
                     total_chunks=1, method="ast_aware"):
    """Create a mock ResolvedChunk."""
    chunk = Mock()
    chunk.chunk_id = chunk_id
    chunk.body = body
    chunk.overlap_context = ""
    chunk.metadata = {
        "method": method,
        "chunk_index": chunk_index,
        "total_chunks": total_chunks,
        "concatenated": False,
    }
    chunk.file_spans = [
        Mock(file_path="app.js", start_line=1, end_line=2, 
             start_byte=0, end_byte=len(body), source_text=body)
    ]
    return chunk


class TestBuildWorkerPrompt:
    def test_includes_chunk_id(self):
        chunk = _make_mock_chunk()
        prompt = build_worker_prompt(chunk, "dom_xss", "sess-001")
        assert "chunk-0" in prompt
    
    def test_includes_session_id(self):
        chunk = _make_mock_chunk()
        prompt = build_worker_prompt(chunk, "dom_xss", "sess-001")
        assert "sess-001" in prompt
    
    def test_includes_analyzer_name(self):
        chunk = _make_mock_chunk()
        prompt = build_worker_prompt(chunk, "prototype_pollution", "sess-001")
        assert "prototype_pollution" in prompt.lower() or "prototype pollution" in prompt.lower()
    
    def test_includes_chunk_body(self):
        body = "const user = location.hash.slice(1);"
        chunk = _make_mock_chunk(body=body)
        prompt = build_worker_prompt(chunk, "dom_xss", "sess-001")
        assert body in prompt
    
    def test_missing_analyzer_prompt_fallback(self):
        chunk = _make_mock_chunk()
        prompt = build_worker_prompt(chunk, "nonexistent_vuln", "sess-001")
        # Should still produce a valid prompt with basic guidance
        assert len(prompt) > 100
        assert "nonexistent_vuln" in prompt.lower()

    def test_includes_scope_section_when_out_of_scope_provided(self):
        """Regression: worker prompts must surface hard scope constraints."""
        chunk = _make_mock_chunk()
        prompt = build_worker_prompt(
            chunk, "dom_xss", "sess-001",
            out_of_scope=["https://target.example/admin", "https://target.example/vulns"],
        )
        assert "## Scope (HARD CONSTRAINT)" in prompt
        assert "https://target.example/admin" in prompt
        assert "https://target.example/vulns" in prompt
        # Must explicitly forbid interaction
        prompt_lower = prompt.lower()
        assert "must not" in prompt_lower or "do not" in prompt_lower
        # Section must appear before coordination
        scope_pos = prompt.find("## Scope (HARD CONSTRAINT)")
        coord_pos = prompt.find("## Coordination")
        assert scope_pos < coord_pos, "Scope must come before Coordination section"

    def test_scope_section_handles_empty_out_of_scope(self):
        """When no out_of_scope is configured, section still renders (advisory)."""
        chunk = _make_mock_chunk()
        prompt_no_scope = build_worker_prompt(chunk, "dom_xss", "sess-001")
        assert "## Scope (HARD CONSTRAINT)" in prompt_no_scope
        # Advisory wording
        assert "No explicit" in prompt_no_scope or "no explicit" in prompt_no_scope

    def test_scope_section_handles_none(self):
        chunk = _make_mock_chunk()
        prompt = build_worker_prompt(chunk, "dom_xss", "sess-001", out_of_scope=None)
        assert "## Scope (HARD CONSTRAINT)" in prompt


class TestComputeConcurrency:
    def test_single_item(self):
        assert compute_concurrency([Mock()], 1) == 1
    
    def test_few_items(self):
        assert compute_concurrency([Mock()] * 3, 1) == 3
    
    def test_many_items_higher_concurrency(self):
        result = compute_concurrency([Mock()] * 50, 3)
        assert result >= 4, f"Expected >=4 got {result}"
    
    def test_never_exceeds_25(self):
        result = compute_concurrency([Mock()] * 1000, 10)
        assert result <= 25
    
    def test_with_analyzer_multiplier(self):
        single = compute_concurrency([Mock()] * 10, 1)
        multi = compute_concurrency([Mock()] * 10, 5)
        assert multi >= single  # More analyzers = more total agents


class TestBuildDispatchPlan:
    def test_returns_waves(self):
        chunks = [_make_mock_chunk(f"c{i}") for i in range(3)]
        plan = build_dispatch_plan(chunks, ["dom_xss"], "sess-001", chunks_per_wave=2)
        assert plan["total_agents"] == 3
        assert plan["total_waves"] > 0
        assert len(plan["waves"]) == plan["total_waves"]
    
    def test_multiple_analyzers(self):
        chunks = [_make_mock_chunk("c0")]
        plan = build_dispatch_plan(chunks, ["dom_xss", "sqli"], "sess-001")
        assert plan["total_agents"] == 2  # 1 chunk × 2 analyzers
    
    def test_empty_chunks(self):
        plan = build_dispatch_plan([], ["dom_xss"], "sess-001")
        assert plan["total_agents"] == 0
        assert plan["waves"] == []
    
    def test_empty_analyzers(self):
        chunks = [_make_mock_chunk()]
        plan = build_dispatch_plan(chunks, [], "sess-001")
        assert plan["total_agents"] == 0
    
    def test_wave_tasks_preserve_chunk_and_vuln(self):
        chunks = [_make_mock_chunk("c0")]
        plan = build_dispatch_plan(chunks, ["dom_xss", "prototype_pollution"], "sess-001")
        wave = plan["waves"][0]
        vulns = [t["vuln_class"] for t in wave["tasks"]]
        assert "dom_xss" in vulns
        assert "prototype_pollution" in vulns
    
    def test_mesh_event_in_wave(self):
        chunks = [_make_mock_chunk()]
        plan = build_dispatch_plan(chunks, ["dom_xss"], "sess-001")
        wave = plan["waves"][0]
        assert "mesh_event" in wave
        assert wave["mesh_event"]["event"] == "wave_dispatch"
    
    def test_concurrency_override(self):
        chunks = [_make_mock_chunk() for _ in range(10)]
        plan = build_dispatch_plan(chunks, ["dom_xss"], "sess-001", max_concurrency=8)
        assert plan["concurrency"] == 8


class TestMeshEvents:
    def test_join_event(self):
        event = build_mesh_join_event("annie-1", "chunk-0", "dom_xss")
        assert event["agent"] == "annie-1"
        assert event["chunk_id"] == "chunk-0"
        assert event["vuln_class"] == "dom_xss"
        assert event["status"] == "starting"
    
    def test_complete_event(self):
        event = build_mesh_complete_event("annie-1", 5)
        assert event["agent"] == "annie-1"
        assert event["status"] == "completed"
        assert event["findings_count"] == 5
    
    def test_cross_chunk_hint(self):
        event = build_feed_cross_chunk_hint(
            from_chunk="chunk-0", from_file="app.js", from_line=42,
            pattern="tainted 'user' flows to utils.js", direction="forward"
        )
        assert event["type"] == "cross_chunk_hint"
        assert event["from_chunk"] == "chunk-0"
        assert event["from_file"] == "app.js"
        assert event["from_line"] == 42
        assert event["pattern"] == "tainted 'user' flows to utils.js"



if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
