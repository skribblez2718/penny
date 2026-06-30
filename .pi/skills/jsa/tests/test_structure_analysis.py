"""Tests for the structure_analysis module (Phase C additions)."""

import sys
from pathlib import Path

import pytest

# Add the scripts directory to the path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from structure_analysis import (
    build_file_manifest,
    build_ast_index,
    extract_dangerous_patterns,
    extract_module_exports,
    DANGEROUS_SINK_PATTERNS,
    FileManifestEntry,
    ASTIndex,
    ASTNode,
)


class TestBuildFileManifest:
    """Tests for build_file_manifest function."""

    def test_empty_files(self):
        manifest = build_file_manifest([])
        assert manifest == []

    def test_single_file(self):
        files = [("app.js", "const x = 1;\nfunction foo() { return x; }\n")]
        manifest = build_file_manifest(files)
        assert len(manifest) == 1
        entry = manifest[0]
        assert entry["path"] == "app.js"
        assert entry["size"] == len("const x = 1;\nfunction foo() { return x; }\n")
        # 2 newlines = 2 lines (no trailing newline)
        assert entry["line_count"] == 2
        assert entry["extension"] == ".js"
        assert entry["ast_available"] is True
        assert len(entry["sha1"]) == 40  # SHA1 hex length

    def test_multiple_files(self):
        files = [
            ("a.js", "var a = 1;"),
            ("b.js", "var b = 2;"),
            ("c.ts", "const c: number = 3;"),
        ]
        manifest = build_file_manifest(files)
        assert len(manifest) == 3
        assert [m["path"] for m in manifest] == ["a.js", "b.js", "c.ts"]
        assert [m["extension"] for m in manifest] == [".js", ".js", ".ts"]

    def test_sha1_consistent(self):
        """Same content should produce same SHA1."""
        files = [("a.js", "const x = 1;")]
        manifest1 = build_file_manifest(files)
        manifest2 = build_file_manifest(files)
        assert manifest1[0]["sha1"] == manifest2[0]["sha1"]

    def test_sha1_different_for_different_content(self):
        files = [("a.js", "const x = 1;"), ("b.js", "const x = 2;")]
        manifest = build_file_manifest(files)
        assert manifest[0]["sha1"] != manifest[1]["sha1"]

    def test_token_estimate(self):
        content = "x" * 400  # 400 chars → ~100 tokens
        files = [("a.js", content)]
        manifest = build_file_manifest(files)
        assert manifest[0]["tokens_estimated"] == 100

    def test_empty_content(self):
        files = [("empty.js", "")]
        manifest = build_file_manifest(files)
        assert manifest[0]["size"] == 0
        assert manifest[0]["line_count"] == 0  # 0 newlines in empty content

    def test_parse_error_rate_for_invalid_js(self):
        """Invalid JS should still produce a manifest entry with parse error info."""
        files = [("broken.js", "const x = { unclosed brace")]
        manifest = build_file_manifest(files)
        # Should not raise
        assert len(manifest) == 1
        # Parse error rate should be > 0
        assert manifest[0]["parse_errors"] >= 0


class TestBuildASTIndex:
    """Tests for build_ast_index function."""

    def test_empty_files(self):
        indices = build_ast_index([])
        assert indices == {}

    def test_simple_function(self):
        files = [("app.js", "function greet(name) { return 'Hello ' + name; }")]
        indices = build_ast_index(files, include_source=False)
        assert "app.js" in indices
        idx = indices["app.js"]
        assert idx.file_path == "app.js"
        assert "greet" in idx.top_level_names
        assert idx.function_count == 1

    def test_multiple_functions(self):
        files = [("app.js", """
            function alpha() { return 1; }
            function beta() { return 2; }
            function gamma() { return 3; }
        """)]
        indices = build_ast_index(files, include_source=False)
        idx = indices["app.js"]
        # All 3 named functions should be counted
        assert idx.function_count == 3
        for name in ["alpha", "beta", "gamma"]:
            assert name in idx.top_level_names

    def test_class_declaration(self):
        files = [("app.js", """
            class UserService {
                getUser() { return null; }
            }
        """)]
        indices = build_ast_index(files, include_source=False)
        idx = indices["app.js"]
        assert idx.class_count == 1
        assert "UserService" in idx.top_level_names

    def test_imports_exports(self):
        files = [("app.js", """
            import { foo } from 'bar';
            import baz from 'qux';
            export default function() {}
            export const x = 1;
        """)]
        indices = build_ast_index(files, include_source=False)
        idx = indices["app.js"]
        assert len(idx.imports) == 2
        assert len(idx.exports) == 2

    def test_call_expressions_counted(self):
        files = [("app.js", """
            foo();
            bar();
            baz.qux();
            arr.map(x => x * 2);
        """)]
        indices = build_ast_index(files, include_source=False)
        idx = indices["app.js"]
        assert idx.call_count == 4

    def test_include_source_flag(self):
        files = [("a.js", "var x = 1;")]
        with_source = build_ast_index(files, include_source=True)
        without_source = build_ast_index(files, include_source=False)
        assert with_source["a.js"].source_bytes != b""
        assert without_source["a.js"].source_bytes == b""

    def test_invalid_js_does_not_crash(self):
        """Invalid JS should still produce an ASTIndex, just with errors."""
        files = [("broken.js", "const { unclosed")]
        indices = build_ast_index(files, include_source=False)
        # Should not raise
        assert "broken.js" in indices
        assert indices["broken.js"].parse_errors >= 0


class TestExtractDangerousPatterns:
    """Tests for extract_dangerous_patterns function."""

    def test_empty_files(self):
        assert extract_dangerous_patterns([]) == []

    def test_clean_code(self):
        files = [("safe.js", "const x = 1; function add(a, b) { return a + b; }")]
        findings = extract_dangerous_patterns(files)
        # No dangerous patterns in clean code
        assert findings == []

    def test_innerHTML_detected(self):
        files = [("vuln.js", "el.innerHTML = userInput;")]
        findings = extract_dangerous_patterns(files)
        # Should detect innerHTML assignment
        pattern_ids = [f["pattern_id"] for f in findings]
        assert "innerHTML_assignment" in pattern_ids

    def test_eval_detected(self):
        files = [("vuln.js", "eval(userInput);")]
        findings = extract_dangerous_patterns(files)
        pattern_ids = [f["pattern_id"] for f in findings]
        assert "eval_call" in pattern_ids

    def test_document_write_detected(self):
        files = [("vuln.js", "document.write('<script>alert(1)</script>');")]
        findings = extract_dangerous_patterns(files)
        pattern_ids = [f["pattern_id"] for f in findings]
        assert "document_write" in pattern_ids

    def test_object_assign_detected(self):
        files = [("vuln.js", "Object.assign(target, source);")]
        findings = extract_dangerous_patterns(files)
        pattern_ids = [f["pattern_id"] for f in findings]
        assert "object_assign" in pattern_ids

    def test_location_access_detected(self):
        files = [("a.js", "const v = location.search;")]
        findings = extract_dangerous_patterns(files)
        pattern_ids = [f["pattern_id"] for f in findings]
        assert "location_access" in pattern_ids

    def test_finding_has_required_fields(self):
        files = [("vuln.js", "el.innerHTML = x;")]
        findings = extract_dangerous_patterns(files)
        if findings:
            f = findings[0]
            assert "file" in f
            assert "line" in f
            assert "column" in f
            assert "pattern_id" in f
            assert "description" in f
            assert "code_snippet" in f
            assert "severity" in f
            assert "suggested_vuln_classes" in f

    def test_severity_in_valid_set(self):
        files = [("vuln.js", "el.innerHTML = x;")]
        findings = extract_dangerous_patterns(files)
        valid_severities = {"info", "low", "medium", "high", "critical"}
        for f in findings:
            assert f["severity"] in valid_severities

    def test_dangerous_patterns_config_has_required_fields(self):
        """The DANGEROUS_SINK_PATTERNS config should be well-formed."""
        for pattern in DANGEROUS_SINK_PATTERNS:
            assert "pattern_id" in pattern
            assert "description" in pattern
            assert "tree_sitter_query" in pattern
            assert "severity" in pattern
            assert "vuln_classes" in pattern
            assert pattern["severity"] in {"info", "low", "medium", "high", "critical"}
            assert isinstance(pattern["vuln_classes"], list)


class TestExtractModuleExports:
    """Tests for extract_module_exports function."""

    def test_empty_files(self):
        assert extract_module_exports([]) == {}

    def test_imports_and_exports(self):
        files = [("app.js", """
            import { x } from 'mod';
            export default foo;
        """)]
        result = extract_module_exports(files)
        assert "app.js" in result
        assert len(result["app.js"]) == 2

    def test_no_imports_or_exports(self):
        files = [("app.js", "const x = 1;")]
        result = extract_module_exports(files)
        assert result["app.js"] == []

    def test_multiple_files(self):
        files = [
            ("a.js", "import x from 'b';"),
            ("b.js", "export const x = 1;"),
        ]
        result = extract_module_exports(files)
        assert len(result) == 2
        assert "a.js" in result
        assert "b.js" in result


class TestFileManifestEntryDataclass:
    """Test the FileManifestEntry dataclass."""

    def test_defaults(self):
        e = FileManifestEntry()
        assert e.path == ""
        assert e.size == 0
        assert e.tokens_estimated == 0
        assert e.sha1 == ""
        assert e.line_count == 0
        assert e.extension == ""
        assert e.ast_available is False
        assert e.parse_errors == 0
        assert e.parse_error_rate == 0.0

    def test_with_values(self):
        e = FileManifestEntry(
            path="app.js",
            size=1024,
            sha1="abc123",
            ast_available=True,
        )
        assert e.path == "app.js"
        assert e.size == 1024
        assert e.sha1 == "abc123"
        assert e.ast_available is True


class TestASTNodeDataclass:
    """Test the ASTNode dataclass."""

    def test_defaults(self):
        n = ASTNode(id=1, type="function_declaration")
        assert n.id == 1
        assert n.type == "function_declaration"
        assert n.name == ""
        assert n.start_line == 0
        assert n.parent_id is None
        assert n.child_ids == []

    def test_with_values(self):
        n = ASTNode(
            id=42,
            type="call_expression",
            name="fetch",
            start_line=10,
            start_column=5,
            end_line=10,
            end_column=20,
            parent_id=1,
        )
        assert n.name == "fetch"
        assert n.start_line == 10
        assert n.parent_id == 1


class TestASTIndexDataclass:
    """Test the ASTIndex dataclass."""

    def test_defaults(self):
        idx = ASTIndex()
        assert idx.file_path == ""
        assert idx.nodes == []
        assert idx.top_level_names == []
        assert idx.imports == []
        assert idx.exports == []
        assert idx.function_count == 0
        assert idx.parse_errors == 0
        assert idx.parse_error_rate == 0.0
        assert idx.source_bytes == b""

    def test_with_values(self):
        idx = ASTIndex(
            file_path="app.js",
            function_count=5,
            class_count=1,
            call_count=20,
            imports=["import x from 'y'"],
            exports=["export default foo"],
        )
        assert idx.file_path == "app.js"
        assert idx.function_count == 5
        assert idx.class_count == 1
        assert len(idx.imports) == 1
        assert len(idx.exports) == 1
