"""
Tests for purl.py — Package URL generation and parsing.
"""

import sys
from pathlib import Path

# Ensure scripts directory is importable
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from purl import (
    make_purl,
    parse_purl,
    detect_ecosystem,
    build_purl_from_detection,
    _encode_purl_component,
)


# ---------------------------------------------------------------------------
# make_purl tests
# ---------------------------------------------------------------------------

class TestMakePurl:
    """Tests for purl generation."""

    def test_simple_npm(self):
        assert make_purl("jquery", "1.9.0", "npm") == "pkg:npm/jquery@1.9.0"

    def test_npm_react(self):
        assert make_purl("react", "18.2.0", "npm") == "pkg:npm/react@18.2.0"

    def test_scoped_npm(self):
        # @ in name is URL-encoded as %40 per purl spec
        assert make_purl("@angular/core", "17.0.0", "npm") == "pkg:npm/%40angular/core@17.0.0"

    def test_npm_no_version(self):
        assert make_purl("lodash", None, "npm") == "pkg:npm/lodash"

    def test_npm_empty_version(self):
        assert make_purl("lodash", "", "npm") == "pkg:npm/lodash"

    def test_generic_ecosystem(self):
        assert make_purl("mylib", "1.0", "generic") == "pkg:generic/mylib@1.0"

    def test_cdnjs(self):
        assert make_purl("jquery", "1.9.0", "cdnjs") == "pkg:cdn/cdnjs/jquery@1.9.0"

    def test_jsdelivr(self):
        assert make_purl("jquery", "1.9.0", "jsdelivr") == "pkg:cdn/jsdelivr/jquery@1.9.0"

    def test_unpkg(self):
        assert make_purl("react", "18.0.0", "unpkg") == "pkg:cdn/unpkg/react@18.0.0"

    def test_github_with_namespace(self):
        # GitHub: namespace is the OWNER, name is the REPO
        assert make_purl("jquery", "1.9.0", "github", "jquery") == "pkg:github/jquery/jquery@1.9.0"

    def test_github_no_namespace_fallback(self):
        # Without namespace, falls back to generic
        result = make_purl("jquery", "1.9.0", "github", None)
        assert result == "pkg:generic/jquery@1.9.0"

    def test_special_chars_encoded(self):
        # ? in name should be encoded
        assert make_purl("foo?bar", "1.0", "npm") == "pkg:npm/foo%3Fbar@1.0"

    def test_hyphenated_name(self):
        assert make_purl("query-string", "1.0", "npm") == "pkg:npm/query-string@1.0"

    def test_empty_name(self):
        assert make_purl("", "1.0", "npm") == ""

    def test_unknown_ecosystem_defaults_to_generic(self):
        # An unrecognized ecosystem should be treated as generic
        assert make_purl("mylib", "1.0", "unknown_eco") == "pkg:generic/mylib@1.0"


# ---------------------------------------------------------------------------
# parse_purl tests
# ---------------------------------------------------------------------------

class TestParsePurl:
    """Tests for purl parsing (round-trip with make_purl)."""

    def test_parse_npm(self):
        result = parse_purl("pkg:npm/jquery@1.9.0")
        assert result["ecosystem"] == "npm"
        assert result["name"] == "jquery"
        assert result["version"] == "1.9.0"

    def test_parse_scoped_npm(self):
        result = parse_purl("pkg:npm/%40angular/core@17.0.0")
        assert result["ecosystem"] == "npm"
        assert result["name"] == "@angular/core"
        assert result["version"] == "17.0.0"

    def test_parse_cdn(self):
        result = parse_purl("pkg:cdn/cdnjs/jquery@1.9.0")
        # CDN ecosystem in the parsed result is the provider (cdnjs)
        assert result["ecosystem"] == "cdnjs"
        assert result["name"] == "jquery"
        assert result["version"] == "1.9.0"

    def test_parse_no_version(self):
        result = parse_purl("pkg:generic/jquery")
        assert result["ecosystem"] == "generic"
        assert result["name"] == "jquery"
        assert result["version"] is None

    def test_parse_github(self):
        result = parse_purl("pkg:github/jquery/jquery@1.9.0")
        assert result["ecosystem"] == "github"
        assert result["name"] == "jquery"
        assert result["version"] == "1.9.0"
        assert result["namespace"] == "jquery"

    def test_parse_invalid_empty(self):
        assert parse_purl("") == {}

    def test_parse_invalid_no_prefix(self):
        assert parse_purl("npm/jquery@1.9.0") == {}

    def test_roundtrip_npm(self):
        original = "pkg:npm/jquery@1.9.0"
        parsed = parse_purl(original)
        regenerated = make_purl(parsed["name"], parsed["version"], parsed["ecosystem"])
        assert regenerated == original

    def test_roundtrip_scoped_npm(self):
        original = "pkg:npm/%40angular/core@17.0.0"
        parsed = parse_purl(original)
        regenerated = make_purl(parsed["name"], parsed["version"], parsed["ecosystem"])
        assert regenerated == original


# ---------------------------------------------------------------------------
# detect_ecosystem tests
# ---------------------------------------------------------------------------

class TestDetectEcosystem:
    """Tests for ecosystem detection from URL/filename."""

    def test_cdnjs_url(self):
        assert detect_ecosystem(
            url="https://cdnjs.cloudflare.com/ajax/libs/jquery/1.9.0/jquery.min.js"
        ) == "cdnjs"

    def test_jsdelivr_url(self):
        assert detect_ecosystem(
            url="https://cdn.jsdelivr.net/npm/jquery@1.9.0/dist/jquery.min.js"
        ) == "jsdelivr"

    def test_unpkg_url(self):
        assert detect_ecosystem(
            url="https://unpkg.com/react@18/umd/react.production.min.js"
        ) == "unpkg"

    def test_github_url(self):
        assert detect_ecosystem(
            url="https://github.com/jquery/jquery/blob/main/dist/jquery.js"
        ) == "github"

    def test_default_npm(self):
        # No CDN indicators → defaults to npm
        assert detect_ecosystem(
            url="https://example.com/js/jquery-1.9.0.min.js",
            filename="jquery-1.9.0.min.js",
        ) == "npm"

    def test_empty_inputs_default_npm(self):
        # No URL, no filename → defaults to npm
        assert detect_ecosystem() == "npm"


# ---------------------------------------------------------------------------
# build_purl_from_detection tests
# ---------------------------------------------------------------------------

class TestBuildPurlFromDetection:
    """Tests for the high-level convenience helper."""

    def test_jquery_from_cdnjs(self):
        result = build_purl_from_detection(
            "jQuery", "1.9.0",
            url="https://cdnjs.cloudflare.com/ajax/libs/jquery/1.9.0/jquery.min.js",
        )
        assert result == "pkg:cdn/cdnjs/jquery@1.9.0"

    def test_lodash_with_npm_name_override(self):
        # npm_name is preferred over wappalyzer_name
        result = build_purl_from_detection(
            "Lodash", "4.17.20",
            filename="lodash.min.js",
            npm_name="lodash",
        )
        assert result == "pkg:npm/lodash@4.17.20"

    def test_scoped_package_preserved(self):
        result = build_purl_from_detection(
            "@angular/core", "17.0.0",
        )
        assert result == "pkg:npm/%40angular/core@17.0.0"

    def test_no_version(self):
        result = build_purl_from_detection(
            "jQuery", None,
            filename="jquery.js",
        )
        assert result == "pkg:npm/jquery"

    def test_wappalyzer_name_normalized(self):
        # "Vue.js" → "vue.js" (lowercased, dot preserved as-is)
        # Note: real npm lookup should go through npm_name_map for known libraries
        result = build_purl_from_detection(
            "Vue.js", "3.4.0",
        )
        assert result == "pkg:npm/vue.js@3.4.0"


# ---------------------------------------------------------------------------
# Internal helper tests
# ---------------------------------------------------------------------------

class TestEncodePurlComponent:
    """Tests for the internal URL-encoding helper."""

    def test_encode_at_sign(self):
        # @ in a name is encoded as %40 (but this is handled specially for npm scopes)
        assert _encode_purl_component("foo@bar") == "foo%40bar"

    def test_encode_question_mark(self):
        assert _encode_purl_component("foo?bar") == "foo%3Fbar"

    def test_encode_hash(self):
        assert _encode_purl_component("foo#bar") == "foo%23bar"

    def test_encode_empty(self):
        assert _encode_purl_component("") == ""

    def test_no_special_chars(self):
        assert _encode_purl_component("jquery") == "jquery"
