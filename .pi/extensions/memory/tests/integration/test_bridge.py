"""
Memory Extension Python Bridge Tests

Tests the memory_bridge.py directly:
- Tool routing
- Parameter validation
- Error handling
- JSON serialization

Run with: pytest tests/test_bridge.py -v
"""

import json
import subprocess
import pytest
from pathlib import Path

# This whole module is a live-palace integration suite (subprocess calls into the
# bridge, ~70s), so mark it: the fast `make test` (-m "not integration") skips it,
# while `make test-integration` and `bun run test:python` still run it.
pytestmark = pytest.mark.integration

# Configuration
BRIDGE_PATH = Path(__file__).parent.parent.parent.parent.parent.parent / "scripts" / "system" / "bridge" / "memory_bridge.py"
VENV_PYTHON = Path(__file__).parent.parent.parent.parent.parent.parent / ".venv" / "bin" / "python"


def call_bridge(tool: str, params: dict = None) -> dict:
    """Call the Python bridge directly and return the result."""
    if params is None:
        params = {}

    request = json.dumps({"tool": tool, "params": params})
    proc = subprocess.run(
        [str(VENV_PYTHON), str(BRIDGE_PATH)],
        input=request,
        capture_output=True,
        text=True,
        timeout=30,
    )

    if proc.returncode != 0:
        raise RuntimeError(f"Bridge failed with code {proc.returncode}: {proc.stderr}")

    return json.loads(proc.stdout)


class TestBridgeRouting:
    """Test that the bridge routes to correct mempalace functions."""

    def test_unknown_tool_returns_error(self):
        """Unknown tool should return error response."""
        result = call_bridge("nonexistent_tool", {})
        assert "error" in result

    def test_status_tool(self):
        """Status tool should return palace info."""
        result = call_bridge("status", {})
        assert result.get("success") is True
        assert "total_drawers" in result
        assert "wings" in result
        assert "palace_path" in result

    def test_list_wings_tool(self):
        """List wings should return available wings."""
        result = call_bridge("list_wings", {})
        assert result.get("success") is True
        assert "wings" in result

    def test_list_rooms_tool(self):
        """List rooms should return rooms."""
        result = call_bridge("list_rooms", {})
        assert result.get("success") is True
        assert "rooms" in result

    def test_get_taxonomy_tool(self):
        """Get taxonomy should return hierarchy."""
        result = call_bridge("get_taxonomy", {})
        assert result.get("success") is True
        assert "taxonomy" in result


class TestSearchTools:
    """Test search-related tools."""

    def test_search_requires_query(self):
        """Search without query should return error."""
        result = call_bridge("search", {})
        assert "error" in result
        assert "error" in result

    def test_search_with_query(self):
        """Search with query should return results."""
        result = call_bridge("search", {"query": "test", "limit": 5})
        assert result.get("success") is True
        assert "results" in result

    def test_search_with_filters(self):
        """Search with wing/room filters works."""
        result = call_bridge("search", {
            "query": "test",
            "wing": "wing_penny",
            "limit": 2
        })
        assert result.get("success") is True

    def test_check_duplicate(self):
        """Check duplicate should return similarity assessment."""
        result = call_bridge("check_duplicate", {
            "content": "unique test content"
        })
        assert result.get("success") is True
        assert "is_duplicate" in result


class TestWriteTools:
    """Test write operations."""

    @pytest.fixture(autouse=True)
    def cleanup(self):
        """Track created drawers for cleanup."""
        self.drawer_ids = []
        yield
        # Cleanup
        for drawer_id in self.drawer_ids:
            try:
                call_bridge("delete_drawer", {"drawer_id": drawer_id})
            except Exception:
                pass

    def test_add_drawer_requires_params(self):
        """Add drawer without required params should fail."""
        result = call_bridge("add_drawer", {})
        assert "error" in result

    def test_add_drawer_success(self):
        """Add drawer with all params should succeed."""
        result = call_bridge("add_drawer", {
            "wing": "wing_penny",
            "room": "test_pytest",
            "content": f"Test content from pytest {__import__('time').time()}",
            "added_by": "pytest"
        })
        assert result.get("success") is True
        assert "drawer_id" in result
        if result.get("drawer_id"):
            self.drawer_ids.append(result["drawer_id"])

    def test_delete_nonexistent_drawer(self):
        """Delete nonexistent drawer should fail gracefully."""
        result = call_bridge("delete_drawer", {
            "drawer_id": "nonexistent-id-12345"
        })
        assert "error" in result

    def test_search_track_recall_bumps_recall_count(self):
        """Model-initiated search must record recall on the hit drawers.

        Regression test for the silently-dead recall path: tool_search used to
        pass the library's dict through an isinstance(list) guard (never true),
        and its hits carried no ids anyway — so recall_count stayed 0 forever
        and the archiver's recall-modulated TTL had no signal to work with.
        """
        marker = f"recall-tracking-probe {__import__('time').time()}"
        added = call_bridge("add_drawer", {
            "wing": "wing_penny",
            "room": "test_pytest",
            "content": f"Unique searchable content for {marker}",
            "added_by": "pytest",
        })
        assert added.get("success") is True
        drawer_id = added["drawer_id"]
        try:
            found = call_bridge("search", {
                "query": marker,
                "wing": "penny",
                "room": "test_pytest",
                "limit": 3,
                "track_recall": True,
            })
            assert found.get("success") is True
            hits = found["results"]["results"]
            assert any(h.get("id") == drawer_id for h in hits), hits
            listed = call_bridge("list_drawers", {
                "wing": "penny", "room": "test_pytest", "limit": 1000,
            })
            mine = [d for d in listed.get("drawers", []) if d["id"] == drawer_id]
            assert mine, "probe drawer missing from listing"
            assert int(mine[0].get("recall_count") or 0) >= 1
            assert mine[0].get("last_recalled_at")
        finally:
            call_bridge("delete_drawer", {"drawer_id": drawer_id})

    def test_legacy_wing_filter_round_trips(self):
        """Reads must canonicalize the wing like writes do.

        Regression test for the write-only canonicalization: add under
        'wing_penny' stored the drawer as 'penny', then list/search filtered
        on the raw 'wing_penny' string and found nothing — a silent recall
        failure the extension's own docs steered callers into.
        """
        marker = f"wing-canon-probe {__import__('time').time()}"
        added = call_bridge("add_drawer", {
            "wing": "wing_penny",
            "room": "test_pytest",
            "content": f"Round-trip content for {marker}",
            "added_by": "pytest",
        })
        assert added.get("success") is True
        drawer_id = added["drawer_id"]
        try:
            listed = call_bridge("list_drawers", {
                "wing": "wing_penny", "room": "test_pytest", "limit": 1000,
            })
            assert any(d["id"] == drawer_id for d in listed.get("drawers", [])), (
                "drawer added via 'wing_penny' invisible to a 'wing_penny' listing"
            )
            found = call_bridge("search", {
                "query": marker, "wing": "wing_penny", "room": "test_pytest", "limit": 3,
            })
            assert found.get("success") is True
            assert any(
                h.get("id") == drawer_id for h in found["results"]["results"]
            ), "drawer added via 'wing_penny' invisible to a 'wing_penny' search"
        finally:
            call_bridge("delete_drawer", {"drawer_id": drawer_id})

    def test_delete_drawer_removes_all_chunks(self):
        """Deleting a chunked drawer by its returned id must remove every
        sibling chunk — orphaned fragments would keep retracted content
        surfacing in search forever with no id left to remove them."""
        marker = f"chunk-delete-probe {__import__('time').time()}"
        added = call_bridge("add_drawer", {
            "wing": "penny",
            "room": "test_pytest",
            "content": f"{marker}\n" + ("chunked content line\n" * 400),  # > 4000 chars
            "added_by": "pytest",
        })
        assert added.get("success") is True
        assert added.get("chunks", 1) > 1, "probe content did not chunk"
        drawer_key = added["drawer_key"]
        deleted = call_bridge("delete_drawer", {"drawer_id": added["drawer_id"]})
        assert deleted.get("success") is True
        assert deleted.get("chunks_deleted") == added["chunks"]
        listed = call_bridge("list_drawers", {"wing": "penny", "room": "test_pytest",
                                              "limit": 1000})
        orphans = [d for d in listed.get("drawers", []) if d["id"].startswith(drawer_key)]
        assert not orphans, f"orphaned chunks survive delete: {[d['id'] for d in orphans]}"

    def test_list_drawers_reassembles_chunked_drawer(self):
        """A chunked drawer must surface as ONE logical drawer carrying its FULL
        content in list_drawers — not N fragment rows. Regression for the
        whole-document read gap that broke the prd->code IDEAL_STATE handoff."""
        marker = f"list-reassemble-probe {__import__('time').time()}"
        body = f"{marker}\n" + ("reassembly content line\n" * 400)  # > 4000 chars -> chunks
        added = call_bridge("add_drawer", {
            "wing": "penny", "room": "test_pytest",
            "content": body, "added_by": "pytest",
        })
        assert added.get("success") is True
        assert added.get("chunks", 1) > 1, "probe content did not chunk"
        drawer_id = added["drawer_id"]
        try:
            listed = call_bridge("list_drawers", {
                "wing": "penny", "room": "test_pytest", "limit": 1000,
                "include_content": True,
            })
            mine = [d for d in listed.get("drawers", []) if d["id"] == drawer_id]
            assert len(mine) == 1, f"expected ONE logical drawer, got {len(mine)}"
            assert mine[0]["content"] == body, "content was not fully reassembled"
        finally:
            call_bridge("delete_drawer", {"drawer_id": drawer_id})


class TestKnowledgeGraphTools:
    """Test knowledge graph operations."""

    @pytest.fixture(autouse=True)
    def cleanup(self):
        """Track created facts for cleanup."""
        self.facts = []
        yield
        # Cleanup
        for fact in self.facts:
            try:
                call_bridge("kg_invalidate", {
                    "subject": fact["subject"],
                    "predicate": fact["predicate"],
                    "object": fact["object"]
                })
            except Exception:
                pass

    def test_kg_query_requires_entity(self):
        """KG query without entity should fail."""
        result = call_bridge("kg_query", {})
        assert "error" in result

    def test_kg_add_success(self):
        """KG add with valid params should succeed."""
        result = call_bridge("kg_add", {
            "subject": "TestEntity",
            "predicate": "uses",
            "object": "TestTool"
        })
        assert result.get("success") is True
        self.facts.append({
            "subject": "TestEntity",
            "predicate": "uses",
            "object": "TestTool"
        })

    def test_kg_query_entity(self):
        """KG query for entity should return facts."""
        # First add a fact
        call_bridge("kg_add", {
            "subject": "TestQueryEntity",
            "predicate": "works_on",
            "object": "TestProject"
        })
        self.facts.append({
            "subject": "TestQueryEntity",
            "predicate": "works_on",
            "object": "TestProject"
        })

        # Then query
        result = call_bridge("kg_query", {
            "entity": "TestQueryEntity"
        })
        assert result.get("success") is True
        assert "facts" in result

    def test_kg_timeline(self):
        """KG timeline should return chronological facts."""
        result = call_bridge("kg_timeline", {})
        assert result.get("success") is True
        assert "timeline" in result or result.get("facts") is not None

    def test_kg_stats(self):
        """KG stats should return graph statistics."""
        result = call_bridge("kg_stats", {})
        assert result.get("success") is True
        assert "entity_count" in result or "stats" in result


class TestNavigationTools:
    """Test navigation tools."""

    def test_traverse_without_room(self):
        """Traverse without start_room should fail with error."""
        result = call_bridge("traverse", {})
        # Should return error when start_room is missing
        assert "error" in result

    def test_find_tunnels(self):
        """Find tunnels should work without params."""
        result = call_bridge("find_tunnels", {})
        assert result.get("success") is True

    def test_graph_stats(self):
        """Graph stats should return connectivity info."""
        result = call_bridge("graph_stats", {})
        assert result.get("success") is True


class TestDiaryTools:
    """Test agent diary operations."""

    def test_diary_write_requires_params(self):
        """Diary write without required params should fail."""
        result = call_bridge("diary_write", {})
        assert "error" in result

    def test_diary_write_success(self):
        """Diary write with valid params should succeed.

        Uses a unique entry (diary_write now dedups at 0.9 similarity, like
        add_drawer) and cleans up after itself so the test does not accumulate
        junk in the real palace.
        """
        import uuid
        entry = f"SESSION:2026-04-08|pytest|test.entry|{uuid.uuid4().hex}"
        result = call_bridge("diary_write", {
            "agent_name": "test-pytest",
            "entry": entry,
        })
        assert result.get("success") is True
        entry_id = result.get("entry_id")
        if entry_id:
            call_bridge("delete_drawer", {"drawer_id": entry_id})

    def test_diary_write_dedups_identical_entry(self):
        """A second identical diary entry is rejected as a duplicate."""
        import uuid
        entry = f"SESSION:dedup-check|{uuid.uuid4().hex}"
        first = call_bridge("diary_write", {"agent_name": "test-pytest", "entry": entry})
        assert first.get("success") is True
        second = call_bridge("diary_write", {"agent_name": "test-pytest", "entry": entry})
        assert second.get("success") is False
        assert second.get("reason") == "duplicate"
        entry_id = first.get("entry_id")
        if entry_id:
            call_bridge("delete_drawer", {"drawer_id": entry_id})

    def test_diary_read_requires_agent(self):
        """Diary read without agent_name should fail."""
        result = call_bridge("diary_read", {})
        assert "error" in result

    def test_diary_read_success(self):
        """Diary read should return entries."""
        result = call_bridge("diary_read", {
            "agent_name": "test-pytest",
            "last_n": 5
        })
        assert result.get("success") is True
        assert "entries" in result


class TestAAAKSpec:
    """Test AAAK specification retrieval."""

    def test_get_aaak_spec(self):
        """Get AAAK spec should return format documentation."""
        result = call_bridge("get_aaak_spec", {})
        assert result.get("success") is True
        assert "aaak_spec" in result


class TestListDrawers:
    """Test list_drawers tool."""

    def test_list_drawers_with_wing_and_room(self):
        """List drawers with wing and room filter should return IDs."""
        result = call_bridge("list_drawers", {"wing": "penny", "room": "decisions"})
        assert result.get("success") is True
        assert "drawers" in result
        assert "count" in result
        assert result["count"] >= 0
        if result["count"] > 0:
            drawer = result["drawers"][0]
            assert "id" in drawer
            assert "wing" in drawer
            assert "room" in drawer

    def test_list_drawers_with_wing_only(self):
        """List drawers with only wing filter should return all rooms in wing."""
        result = call_bridge("list_drawers", {"wing": "penny"})
        assert result.get("success") is True
        assert result["count"] >= 0
        if result["count"] > 0:
            drawer = result["drawers"][0]
            assert drawer["wing"] == "penny"

    def test_list_drawers_no_filter(self):
        """List drawers without any filter should return all drawers."""
        result = call_bridge("list_drawers", {})
        assert result.get("success") is True
        assert result["count"] > 0

    def test_list_drawers_nonexistent_room(self):
        """List drawers for nonexistent room should return empty."""
        result = call_bridge("list_drawers", {"wing": "penny", "room": "nonexistent_xyz"})
        assert result.get("success") is True
        assert result["count"] == 0


class TestDeleteDrawersByRoom:
    """Test delete_drawers_by_room tool."""

    @pytest.fixture(autouse=True)
    def setup_and_cleanup(self):
        """Create test drawers and clean up after."""
        # Create a test room with drawers
        self.test_wing = "penny"
        self.test_room = "test_pytest_bulk_delete"
        self.drawer_ids = []
        for i in range(3):
            result = call_bridge("add_drawer", {
                "wing": self.test_wing,
                "room": self.test_room,
                "content": f"Bulk delete test content item {i} - unique token {__import__('uuid').uuid4()}",
                "added_by": "pytest",
            })
            if result.get("success"):
                self.drawer_ids.append(result["drawer_id"])
            elif result.get("reason") == "duplicate":
                # Duplicate check blocked it — add with different content
                result = call_bridge("add_drawer", {
                    "wing": self.test_wing,
                    "room": self.test_room,
                    "content": f"Alternate bulk test {i} - {__import__('uuid').uuid4()}",
                    "added_by": "pytest",
                })
                if result.get("success"):
                    self.drawer_ids.append(result["drawer_id"])
        yield
        # Cleanup: ensure test room is gone
        try:
            call_bridge("delete_drawers_by_room", {"wing": self.test_wing, "room": self.test_room})
        except Exception:
            pass

    def test_delete_drawers_by_room_requires_both_params(self):
        """Delete without both wing and room should fail."""
        result = call_bridge("delete_drawers_by_room", {"wing": "penny"})
        assert "error" in result

        result = call_bridge("delete_drawers_by_room", {"room": "decisions"})
        assert "error" in result

    def test_delete_drawers_by_room_success(self):
        """Delete all drawers in a room should succeed."""
        # Verify we have drawers to delete
        list_result = call_bridge("list_drawers", {"wing": self.test_wing, "room": self.test_room})
        assert list_result["count"] == len(self.drawer_ids)

        # Delete
        result = call_bridge("delete_drawers_by_room", {
            "wing": self.test_wing,
            "room": self.test_room,
        })
        assert result.get("success") is True
        assert result["deleted_count"] == len(self.drawer_ids)
        assert result["wing"] == self.test_wing
        assert result["room"] == self.test_room

        # Verify room is empty
        list_after = call_bridge("list_drawers", {"wing": self.test_wing, "room": self.test_room})
        assert list_after["count"] == 0

    def test_delete_drawers_nonexistent_room(self):
        """Delete nonexistent room should return 0 deleted."""
        result = call_bridge("delete_drawers_by_room", {
            "wing": "penny",
            "room": "nonexistent_room_xyz",
        })
        assert result.get("success") is True
        assert result["deleted_count"] == 0


class TestErrorHandling:
    """Test error handling scenarios."""

    def test_malformed_json_returns_error(self):
        """Malformed input should return error, not crash."""
        proc = subprocess.run(
            [str(VENV_PYTHON), str(BRIDGE_PATH)],
            input="not valid json",
            capture_output=True,
            text=True,
            timeout=30,
        )
        # Should exit with error code
        assert proc.returncode != 0 or "error" in proc.stdout.lower()

    def test_empty_input_returns_error(self):
        """Empty input should return error."""
        proc = subprocess.run(
            [str(VENV_PYTHON), str(BRIDGE_PATH)],
            input="",
            capture_output=True,
            text=True,
            timeout=30,
        )
        # Should exit with error code
        assert proc.returncode != 0 or "error" in proc.stdout.lower()

    def test_missing_tool_returns_error(self):
        """Missing tool parameter should return error."""
        result = call_bridge("search", {"limit": 5})  # No query
        assert "error" in result


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
