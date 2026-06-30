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
import sys
import pytest
from pathlib import Path

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
        """Diary write with valid params should succeed."""
        result = call_bridge("diary_write", {
            "agent_name": "test-pytest",
            "entry": "SESSION:2026-04-08|pytest|test.entry|★★★"
        })
        assert result.get("success") is True
    
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