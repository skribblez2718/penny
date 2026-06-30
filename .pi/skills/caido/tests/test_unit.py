"""Unit tests for caido skill orchestrator."""
import json
import sys
import os

# Add skill directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import pytest
from orchestrate import CaidoContext, Orchestrator


def test_context_defaults():
    ctx = CaidoContext(session_id="test-1", goal="Create a header injector plugin")
    assert ctx.extension_type == ""
    assert ctx.explore_complete is False


def test_intake_detects_backend():
    ctx = CaidoContext(session_id="test-1", goal="Create a backend plugin for headers")
    orch = Orchestrator(ctx)
    result = orch.handle_intake()
    assert ctx.extension_type == "backend-only"
    assert result["action"] == "explore"


def test_intake_detects_fullstack():
    ctx = CaidoContext(session_id="test-1", goal="Build a full-stack Caido plugin with frontend and backend")
    orch = Orchestrator(ctx)
    orch.handle_intake()
    assert ctx.extension_type == "full-stack"


def test_intake_detects_workflow():
    ctx = CaidoContext(session_id="test-1", goal="Create a passive workflow for headers")
    orch = Orchestrator(ctx)
    orch.handle_intake()
    assert ctx.extension_type == "workflow"


def test_state_progression():
    ctx = CaidoContext(session_id="test-1", goal="Create a plugin")
    orch = Orchestrator(ctx)

    orch.handle_intake()
    assert orch.state_id == "exploring"

    orch._apply_summary({"explore_complete": True, "extension_type": "backend-only", "apis": [], "unknowns_count": 0})
    assert ctx.explore_complete
    
    # After explore, we'd transition to designing but that happens via next()
    # Test that context reflects the summary
    assert ctx.recommended_type == "backend-only"


def test_extract_state():
    ctx = CaidoContext(session_id="test-1", goal="Test plugin")
    orch = Orchestrator(ctx)
    state = orch.extract_state()
    assert state["goal"] == "Test plugin"
    assert state["extension_type"] == ""


def test_error_state():
    ctx = CaidoContext(session_id="test-1", goal="Broken plugin")
    orch = Orchestrator(ctx)
    ctx.errors.append("Something went wrong")
    result = orch.handle_error()
    assert result["action"] == "error"
    assert "Something went wrong" in str(result["errors"])


def test_summary_apply_explore():
    ctx = CaidoContext(session_id="test-1", goal="Test")
    orch = Orchestrator(ctx)
    orch.handle_intake()
    orch._apply_summary({"explore_complete": True, "extension_type": "full-stack", "apis": ["onUpstream"], "unknowns_count": 0})
    assert ctx.explore_complete
    assert ctx.recommended_type == "full-stack"
    assert ctx.required_apis == ["onUpstream"]
