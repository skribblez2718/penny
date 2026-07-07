"""Tests for HTML parser (html_parser.py)."""

import sys
from pathlib import Path

import pytest

# Add the scripts directory to the path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from html_parser import (
    parse_html_page,
    parse_html_file,
    find_external_scripts_without_sri,
)


class TestParseHTMLPage:
    """Tests for the main parse_html_page function."""

    def test_simple_page(self):
        html = """
        <html>
        <head><title>Test Page</title></head>
        <body>
            <h1>Hello</h1>
            <p>Some content</p>
        </body>
        </html>
        """
        result = parse_html_page(html, page_url="https://example.com/")
        assert result.title == "Test Page"
        assert result.page_url == "https://example.com/"
        assert len(result.dom_ids) == 0
        assert len(result.external_scripts) == 0

    def test_external_script(self):
        html = """
        <html>
        <head>
            <script src="/static/app.js"></script>
        </head>
        <body></body>
        </html>
        """
        result = parse_html_page(html, page_url="https://example.com/page")
        assert len(result.external_scripts) == 1
        # URL should be resolved relative to page_url
        assert result.external_scripts[0] == "https://example.com/static/app.js"

    def test_external_script_with_integrity(self):
        html = """
        <html>
        <head>
            <script src="/app.js" integrity="sha384-abc123" crossorigin="anonymous"></script>
        </head>
        </html>
        """
        result = parse_html_page(html, page_url="https://example.com/")
        assert result.external_scripts[0] == "https://example.com/app.js"
        assert result.script_integrity[result.external_scripts[0]] == "sha384-abc123"
        assert result.script_crossorigin[result.external_scripts[0]] == "anonymous"

    def test_inline_script(self):
        html = """
        <html>
        <body>
            <script>var x = 1; console.log(x);</script>
        </body>
        </html>
        """
        result = parse_html_page(html, page_url="https://example.com/")
        assert len(result.inline_scripts) == 1
        assert "var x = 1" in result.inline_scripts[0]

    def test_dom_ids(self):
        html = """
        <html>
        <body>
            <div id="main-content">Main</div>
            <input id="email" name="email" type="email">
            <input id="password" name="password" type="password">
        </body>
        </html>
        """
        result = parse_html_page(html)
        assert "main-content" in result.dom_ids
        assert "email" in result.dom_ids
        assert "password" in result.dom_ids

    def test_forms(self):
        html = """
        <html>
        <body>
            <form action="/api/login" method="POST">
                <input name="user" type="text">
                <input name="pass" type="password">
                <button type="submit">Login</button>
            </form>
        </body>
        </html>
        """
        result = parse_html_page(html, page_url="https://example.com/")
        # URL is resolved to absolute; should contain /api/login
        assert any("/api/login" in a for a in result.form_actions)
        assert "POST" in result.form_methods
        assert len(result.form_inputs) == 2
        names = [i["name"] for i in result.form_inputs]
        assert "user" in names
        assert "pass" in names

    def test_inline_event_handlers(self):
        html = """
        <html>
        <body>
            <button onclick="alert('hi')">Click</button>
            <a href="#" onmouseover="track()">Link</a>
        </body>
        </html>
        """
        result = parse_html_page(html)
        assert len(result.inline_event_handlers) >= 2
        # Should capture both onclick and onmouseover
        handler_strs = " ".join(result.inline_event_handlers)
        assert "onclick" in handler_strs
        assert "onmouseover" in handler_strs

    def test_iframe_srcs(self):
        html = """
        <html>
        <body>
            <iframe src="https://www.youtube.com/embed/abc"></iframe>
            <iframe src="/embed/xyz"></iframe>
        </body>
        </html>
        """
        result = parse_html_page(html, page_url="https://example.com/")
        assert len(result.iframe_srcs) == 2
        assert "https://www.youtube.com/embed/abc" in result.iframe_srcs
        # Relative URL should be resolved
        assert "https://example.com/embed/xyz" in result.iframe_srcs

    def test_csp_meta_tag(self):
        html = """
        <html>
        <head>
            <meta http-equiv="Content-Security-Policy" content="default-src 'self'">
        </head>
        </html>
        """
        result = parse_html_page(html)
        assert result.csp_meta == "default-src 'self'"

    def test_meta_tags(self):
        html = """
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <meta name="description" content="Test page">
        </head>
        </html>
        """
        result = parse_html_page(html)
        assert result.meta_tags.get("viewport") == "width=device-width, initial-scale=1"
        assert result.meta_tags.get("description") == "Test page"

    def test_malformed_html_graceful(self):
        # Test that parser doesn't crash on broken HTML
        html = """
        <html>
        <head>
            <title>Test
            <script src="incomplete
        <body>
            <div id="unclosed
        """
        # Should not raise
        result = parse_html_page(html)
        # Should still extract whatever it can
        assert result is not None

    def test_empty_html(self):
        result = parse_html_page("", page_url="https://example.com/")
        assert result.title == ""
        assert len(result.external_scripts) == 0


class TestParseHTMLFile:
    """Tests for parse_html_file."""

    def test_file_not_found(self, tmp_path):
        result = parse_html_file(tmp_path / "nonexistent.html")
        assert result is None

    def test_valid_file(self, tmp_path):
        f = tmp_path / "test.html"
        f.write_text("""
        <html>
        <head><title>From File</title></head>
        <body><script src="/app.js"></script></body>
        </html>
        """)
        result = parse_html_file(f, page_url="https://example.com/")
        assert result is not None
        assert result.title == "From File"
        assert "https://example.com/app.js" in result.external_scripts


class TestFindExternalScriptsWithoutSRI:
    """Tests for the SRI check helper."""

    def test_finds_scripts_without_sri(self):
        html = """
        <html>
        <head>
            <script src="/a.js"></script>
            <script src="/b.js" integrity="sha384-x"></script>
        </head>
        </html>
        """
        missing = find_external_scripts_without_sri(html)
        # /a.js missing, /b.js has integrity
        assert any("a.js" in s for s in missing)
        assert not any("b.js" in s for s in missing)

    def test_all_have_sri(self):
        html = """
        <html>
        <head>
            <script src="/a.js" integrity="sha384-x"></script>
            <script src="/b.js" integrity="sha384-y"></script>
        </head>
        </html>
        """
        missing = find_external_scripts_without_sri(html)
        assert len(missing) == 0
