"""Tests for source map deobfuscation (source_map_deob.py)."""

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# Add the scripts directory to the path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from source_map_deob import (
    find_source_map_url,
    fetch_source_map,
    reconstruct_sources,
    deobfuscate_via_source_map,
    DeobfuscationResult,
    SOURCE_MAP_COMMENT_PATTERN,
)


class TestFindSourceMapURL:
    """Tests for the find_source_map_url helper."""

    def test_finds_source_map_url_double_slash(self):
        js = """
        var x = 1;
        //# sourceMappingURL=app.js.map
        """
        assert find_source_map_url(js) == "app.js.map"

    def test_finds_source_map_url_at_sign(self):
        js = """
        //@ sourceMappingURL=bundle.js.map
        """
        assert find_source_map_url(js) == "bundle.js.map"

    def test_finds_with_quoted_url(self):
        js = '//# sourceMappingURL="app.js.map"'
        # Should still find it (quotes are stripped)
        result = find_source_map_url(js)
        assert result in ("app.js.map", '"app.js.map"')  # Acceptable variation

    def test_no_source_map_url(self):
        js = "var x = 1; // some comment"
        assert find_source_map_url(js) is None

    def test_empty_string(self):
        assert find_source_map_url("") is None

    def test_resolves_relative_to_js_url(self):
        js = "//# sourceMappingURL=maps/app.js.map"
        result = find_source_map_url(js, js_url="https://cdn.example.com/js/app.js")
        # Relative URL should be resolved
        assert "app.js.map" in result
        assert result.startswith("https://cdn.example.com")

    def test_absolute_url_unchanged(self):
        js = "//# sourceMappingURL=https://other.com/maps/app.js.map"
        result = find_source_map_url(js, js_url="https://cdn.example.com/js/app.js")
        assert result == "https://other.com/maps/app.js.map"

    def test_data_url_unchanged(self):
        js = "//# sourceMappingURL=data:application/json;base64,eyJ2IjozfQ=="
        result = find_source_map_url(js)
        assert result.startswith("data:")

    def test_inline_source_map_url(self):
        # Real-world example: webpack dev server
        js = """
        (function() {
            console.log("test");
        })();
        //# sourceMappingURL=webpack:///./src/index.js
        """
        result = find_source_map_url(js)
        assert result == "webpack:///./src/index.js"


class TestFetchSourceMap:
    """Tests for fetch_source_map function."""

    def test_fetch_data_url(self):
        """data: URLs should be decoded in-place."""
        # Base64 encoded {"version": 3, "sources": []}
        import base64
        original = json.dumps({"version": 3, "sources": ["a.js"], "mappings": ""})
        encoded = base64.b64encode(original.encode()).decode()
        data_url = f"data:application/json;base64,{encoded}"
        result = fetch_source_map(data_url)
        assert result is not None
        assert result["version"] == 3
        assert result["sources"] == ["a.js"]

    def test_fetch_data_url_invalid(self):
        result = fetch_source_map("data:application/json;base64,not-valid-base64!!!")
        assert result is None

    def test_fetch_invalid_scheme(self):
        # Should not raise; should return None
        result = fetch_source_map("ftp://example.com/map.json")
        assert result is None

    def test_fetch_http_error(self, monkeypatch):
        """If HTTP fails, should return None without raising."""
        # This test will fail to connect, so should return None gracefully
        result = fetch_source_map("http://127.0.0.1:1/nonexistent.json", timeout=1)
        assert result is None


class TestReconstructSources:
    """Tests for the reconstruct_sources function."""

    def test_inline_sources_content(self, tmp_path):
        """When sourcesContent is present, write directly without fetching."""
        sm = {
            "version": 3,
            "sources": ["a.js", "b.js"],
            "sourcesContent": ["var a = 1;", "var b = 2;"],
        }
        written, contents = reconstruct_sources(sm, tmp_path)
        assert len(written) == 2
        assert len(contents) == 2
        # Files should exist on disk
        for path in written:
            assert Path(path).exists()
        # Content should match
        assert "var a = 1" in contents[0]
        assert "var b = 2" in contents[1]

    def test_missing_sources_content_creates_placeholder(self, tmp_path):
        """When sourcesContent is null, create placeholder file."""
        sm = {
            "version": 3,
            "sources": ["a.js"],
            "sourcesContent": [None],
        }
        written, contents = reconstruct_sources(sm, tmp_path, fetch_external=False)
        assert len(written) == 1
        assert Path(written[0]).exists()
        # Content should be None (could not reconstruct)
        assert contents[0] is None
        # File should still have placeholder content
        text = Path(written[0]).read_text()
        assert "not available" in text.lower() or "placeholder" in text.lower() or len(text) > 0

    def test_no_sources_content_field(self, tmp_path):
        """When sourcesContent is missing entirely, treat as null."""
        sm = {
            "version": 3,
            "sources": ["a.js"],
        }
        written, contents = reconstruct_sources(sm, tmp_path, fetch_external=False)
        assert len(written) == 1
        assert Path(written[0]).exists()

    def test_unsafe_source_names_sanitized(self, tmp_path):
        """Path-traversal-like source names should be sanitized."""
        sm = {
            "version": 3,
            "sources": ["../../../etc/passwd", "normal.js"],
            "sourcesContent": ["bad", "good"],
        }
        written, _ = reconstruct_sources(sm, tmp_path)
        # Both files should be created
        for path in written:
            assert Path(path).exists()
        # Names should not contain ../
        for path in written:
            assert "../" not in path

    def test_creates_subdirectories(self, tmp_path):
        """Sources in subdirectories should be created."""
        sm = {
            "version": 3,
            "sources": ["src/components/Button.js"],
            "sourcesContent": ["export const Button = () => null;"],
        }
        written, _ = reconstruct_sources(sm, tmp_path)
        assert Path(written[0]).exists()


class TestDeobfuscateViaSourceMap:
    """Tests for the high-level deobfuscation function."""

    def test_file_not_found(self, tmp_path):
        result = deobfuscate_via_source_map(
            tmp_path / "nonexistent.js",
            tmp_path / "output",
        )
        assert result.error is not None
        assert "not found" in result.error.lower() or "not exist" in result.error.lower()

    def test_no_source_map_url(self, tmp_path):
        """JS file without sourceMappingURL comment should fail gracefully."""
        js_file = tmp_path / "app.js"
        js_file.write_text("var x = 1; // no source map here")
        result = deobfuscate_via_source_map(js_file, tmp_path / "output")
        assert result.error is not None
        assert "sourceMappingURL" in result.error or "source map" in result.error.lower()

    def test_explicit_source_map_url_fails_to_fetch(self, tmp_path):
        """If source map URL doesn't exist, error is set."""
        js_file = tmp_path / "app.js"
        js_file.write_text("var x = 1;")
        result = deobfuscate_via_source_map(
            js_file,
            tmp_path / "output",
            source_map_url="http://127.0.0.1:1/missing.map",
        )
        assert result.error is not None
        assert "source map" in result.error.lower() or "fetch" in result.error.lower()


class TestDeobfuscationResult:
    """Tests for the DeobfuscationResult dataclass."""

    def test_defaults(self):
        r = DeobfuscationResult()
        assert r.original_js_path == ""
        assert r.source_map_url == ""
        assert r.sources == []
        assert r.sources_content == []
        assert r.sources_fetched == 0
        assert r.sources_missing_content == 0
        assert r.error is None

    def test_success_property_no_error(self):
        r = DeobfuscationResult(sources_fetched=3)
        assert r.success is True

    def test_success_property_with_error(self):
        r = DeobfuscationResult(error="something went wrong")
        assert r.success is False

    def test_success_property_zero_fetched(self):
        r = DeobfuscationResult()
        assert r.success is False
