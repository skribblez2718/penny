"""Tests for PageCard, ModuleCard, FlowCard dataclasses."""

import sys
from pathlib import Path

import pytest

# Add the scripts directory to the path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from page_card import (
    PageCard,
    RequestSnapshot,
    ResponseSnapshot,
    ScriptFile,
    DOMInventory,
    WAFAlert,
)
from module_card import (
    ModuleCard,
    DangerousPattern,
    ASTSummary,
)
from flow_card import (
    FlowCard,
    FlowEndpoint,
    FlowStep,
    SanitizerInfo,
    RuntimeEvidence,
)


class TestRequestSnapshot:
    def test_defaults(self):
        s = RequestSnapshot()
        assert s.method == ""
        assert s.headers == {}
        assert s.body is None
        assert s.source == ""

    def test_to_dict(self):
        s = RequestSnapshot(
            method="POST",
            url="https://example.com/api",
            headers={"Content-Type": "application/json"},
            body='{"x":1}',
            source="caido",
        )
        d = s.to_dict()
        assert d["method"] == "POST"
        assert d["url"] == "https://example.com/api"
        assert d["headers"]["Content-Type"] == "application/json"
        assert d["body"] == '{"x":1}'
        assert d["source"] == "caido"


class TestResponseSnapshot:
    def test_defaults(self):
        r = ResponseSnapshot()
        assert r.status_code == 0
        assert r.headers == {}
        assert r.body is None

    def test_to_dict(self):
        r = ResponseSnapshot(
            status_code=200,
            headers={"Server": "nginx"},
            body_snippet="<html>...</html>",
            mime_type="text/html",
            source="caido",
        )
        d = r.to_dict()
        assert d["status_code"] == 200
        assert d["headers"]["Server"] == "nginx"
        assert d["mime_type"] == "text/html"


class TestPageCard:
    def test_defaults(self):
        p = PageCard()
        assert p.page_id == ""
        assert p.url == ""
        assert p.method == "GET"
        assert p.request is None
        assert p.response is None
        assert p.technologies == []
        assert p.runtime_versions == []
        assert p.sources == []
        assert p.http_history_unavailable is False

    def test_to_dict_with_request_response(self):
        p = PageCard(
            page_id="test-123",
            url="https://example.com/",
            method="GET",
            sources=["caido"],
        )
        p.request = RequestSnapshot(method="GET", url="https://example.com/")
        p.response = ResponseSnapshot(status_code=200)
        d = p.to_dict()
        assert d["page_id"] == "test-123"
        assert d["url"] == "https://example.com/"
        assert d["request"]["method"] == "GET"
        assert d["response"]["status_code"] == 200
        assert d["sources"] == ["caido"]

    def test_from_dict_round_trip(self):
        original = PageCard(
            page_id="rt-1",
            url="https://example.com/path",
            method="POST",
        )
        original.request = RequestSnapshot(method="POST", url="https://example.com/path")
        original.response = ResponseSnapshot(status_code=201, mime_type="application/json")
        original.sources = ["caido", "playwright"]
        d = original.to_dict()
        restored = PageCard.from_dict(d)
        assert restored.page_id == "rt-1"
        assert restored.url == "https://example.com/path"
        assert restored.method == "POST"
        assert restored.request is not None
        assert restored.request.method == "POST"
        assert restored.response is not None
        assert restored.response.status_code == 201
        assert restored.sources == ["caido", "playwright"]


class TestScriptFile:
    def test_defaults(self):
        s = ScriptFile()
        assert s.filename == ""
        assert s.url == ""
        assert s.integrity is None
        assert s.local_path == ""


class TestDOMInventory:
    def test_defaults(self):
        d = DOMInventory()
        assert d.dom_ids == []
        assert d.form_actions == []
        assert d.csp_header is None


class TestWAFAlert:
    def test_defaults(self):
        w = WAFAlert()
        assert w.rule_id == 0
        assert w.severity == ""


class TestModuleCard:
    def test_defaults(self):
        m = ModuleCard()
        assert m.filename == ""
        assert m.url is None
        assert m.source_map_url is None
        assert m.detections == []
        assert m.ast_summary is None
        assert m.dangerous_patterns == []

    def test_to_dict_with_ast(self):
        m = ModuleCard(
            filename="app.js",
            url="https://cdn.example.com/app.js",
            source_length=12345,
            hash="abc123def",
        )
        m.ast_summary = ASTSummary(
            function_count=10,
            class_count=2,
            call_count=50,
            imports=["react", "lodash"],
        )
        m.dangerous_patterns = [
            DangerousPattern(
                pattern_id="innerHTML",
                description="innerHTML assignment",
                line=42,
                severity="high",
                suggested_vuln_classes=["dom_xss"],
            )
        ]
        d = m.to_dict()
        assert d["filename"] == "app.js"
        assert d["source_length"] == 12345
        assert d["ast_summary"]["function_count"] == 10
        assert d["dangerous_patterns"][0]["line"] == 42
        assert d["dangerous_patterns"][0]["severity"] == "high"

    def test_from_dict_minimal(self):
        d = {
            "filename": "bundle.js",
            "url": "https://cdn.example.com/bundle.js",
            "page_card_ids": ["page-1", "page-2"],
        }
        m = ModuleCard.from_dict(d)
        assert m.filename == "bundle.js"
        assert m.url == "https://cdn.example.com/bundle.js"
        assert m.page_card_ids == ["page-1", "page-2"]
        assert m.classification is None
        assert m.ast_summary is None


class TestASTSummary:
    def test_defaults(self):
        a = ASTSummary()
        assert a.function_count == 0
        assert a.class_count == 0
        assert a.call_count == 0
        assert a.parse_errors == 0
        assert a.parse_error_rate == 0.0
        assert a.imports == []
        assert a.exports == []


class TestDangerousPattern:
    def test_defaults(self):
        d = DangerousPattern()
        assert d.pattern_id == ""
        assert d.severity == "info"
        assert d.suggested_vuln_classes == []


class TestFlowCard:
    def test_defaults(self):
        f = FlowCard()
        assert f.flow_id == ""
        assert f.vulnerability_class == ""
        assert f.confidence == "candidate"
        assert f.lane == ""
        assert f.source is None
        assert f.sink is None
        assert f.steps == []
        assert f.evidence == []
        assert f.runtime_evidence == []
        assert f.confirmed is False
        assert f.sources == []

    def test_to_dict_with_endpoints(self):
        f = FlowCard(
            flow_id="flow-1",
            vulnerability_class="dom_xss",
            cwe_id="CWE-79",
            confidence="probable",
            lane="code_static",
        )
        f.source = FlowEndpoint(
            type="location.search",
            detail="location.search.note",
            line=42,
        )
        f.sink = FlowEndpoint(
            type="element.innerHTML",
            detail="el.innerHTML = note",
            line=100,
        )
        f.steps = [
            FlowStep(step_type="assignment", expression="var note = ...", line=80),
            FlowStep(step_type="call", expression="el.innerHTML = note", line=100),
        ]
        f.sanitizer_chain = [
            SanitizerInfo(name="DOMPurify.sanitize", covers_sink=False)
        ]
        f.severity = "high"
        d = f.to_dict()
        assert d["flow_id"] == "flow-1"
        assert d["vulnerability_class"] == "dom_xss"
        assert d["source"]["type"] == "location.search"
        assert d["sink"]["type"] == "element.innerHTML"
        assert len(d["steps"]) == 2
        assert d["sanitizer_chain"][0]["name"] == "DOMPurify.sanitize"
        assert d["severity"] == "high"

    def test_from_dict_round_trip(self):
        original = FlowCard(
            flow_id="rt-flow",
            vulnerability_class="prototype_pollution",
            cwe_id="CWE-1321",
            confidence="candidate",
            lane="code_static",
        )
        original.source = FlowEndpoint(type="req.body", line=10)
        original.sink = FlowEndpoint(type="Object.assign", line=50)
        original.module_card_ids = ["mod-1", "mod-2"]
        original.page_card_ids = ["page-1"]
        d = original.to_dict()
        restored = FlowCard.from_dict(d)
        assert restored.flow_id == "rt-flow"
        assert restored.vulnerability_class == "prototype_pollution"
        assert restored.source is not None
        assert restored.source.type == "req.body"
        assert restored.sink is not None
        assert restored.sink.type == "Object.assign"
        assert restored.module_card_ids == ["mod-1", "mod-2"]
        assert restored.page_card_ids == ["page-1"]


class TestFlowEndpoint:
    def test_defaults(self):
        e = FlowEndpoint()
        assert e.type == ""
        assert e.page_card_id is None
        assert e.module_card_id is None
        assert e.line == 0


class TestFlowStep:
    def test_defaults(self):
        s = FlowStep()
        assert s.step_type == ""
        assert s.expression == ""
        assert s.line == 0


class TestSanitizerInfo:
    def test_defaults(self):
        s = SanitizerInfo()
        assert s.name == ""
        assert s.covers_sink is False


class TestRuntimeEvidence:
    def test_defaults(self):
        r = RuntimeEvidence()
        assert r.page_loaded_sink is False
        assert r.request_urls == []
        assert r.event_listeners == []
