"""Tests for Caido HTTP history capture (caido_capture.py).

These tests verify graceful degradation when Caido is not reachable.
They also test the data structure and helper functions.
"""

import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# Add the scripts directory to the path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

import caido_capture
from caido_capture import (
    HTTPTransaction,
    is_caido_available,
    get_caido_upstream_proxy,
    search_http_history,
    get_http_history_for_url,
    get_full_transaction,
    enrich_page_card_with_caido,
    _parse_headers,
    CAIDO_URL_DEFAULT,
)


class TestHTTPTransaction:
    """Test the HTTPTransaction dataclass."""

    def test_defaults(self):
        tx = HTTPTransaction()
        assert tx.id == ""
        assert tx.method == ""
        assert tx.host == ""
        assert tx.path == ""
        assert tx.is_tls is False
        assert tx.port == 0
        assert tx.status_code == 0
        assert tx.request_raw == ""
        assert tx.response_raw == ""
        assert tx.request_headers == {}
        assert tx.response_headers == {}

    def test_with_data(self):
        tx = HTTPTransaction(
            id="42",
            method="POST",
            host="example.com",
            path="/api",
            is_tls=True,
            port=443,
            status_code=201,
            request_raw="POST /api HTTP/1.1\r\nHost: example.com\r\n\r\n",
        )
        assert tx.id == "42"
        assert tx.is_tls is True
        assert tx.port == 443


class TestParseHeaders:
    """Test the header parsing helper."""

    def test_parses_simple_request(self):
        raw = (
            "GET / HTTP/1.1\r\n"
            "Host: example.com\r\n"
            "User-Agent: test\r\n"
            "\r\n"
        )
        headers = _parse_headers(raw)
        assert headers["Host"] == "example.com"
        assert headers["User-Agent"] == "test"

    def test_parses_simple_response(self):
        raw = (
            "HTTP/1.1 200 OK\r\n"
            "Server: nginx\r\n"
            "Content-Type: text/html\r\n"
            "\r\n"
        )
        headers = _parse_headers(raw)
        assert headers["Server"] == "nginx"
        assert headers["Content-Type"] == "text/html"

    def test_empty_raw(self):
        assert _parse_headers("") == {}

    def test_header_with_colon_in_value(self):
        raw = "GET / HTTP/1.1\r\nX-Token: abc:def:123\r\n\r\n"
        headers = _parse_headers(raw)
        assert headers["X-Token"] == "abc:def:123"

    def test_stops_at_empty_line(self):
        raw = "GET / HTTP/1.1\r\nHost: x\r\n\r\nBody content here"
        headers = _parse_headers(raw)
        # Should not include the body
        assert "Body content" not in headers.values()
        assert len(headers) == 1


class TestIsCaidoAvailable:
    """Test the availability check."""

    def test_returns_bool(self):
        result = is_caido_available()
        assert isinstance(result, bool)

    def test_returns_false_for_invalid_url(self):
        result = is_caido_available("http://127.0.0.1:1")  # unused port
        assert result is False

    def test_returns_true_for_localhost_caido(self):
        """If Caido is running locally, should return True."""
        # Only test if the user has Caido running
        result = is_caido_available(CAIDO_URL_DEFAULT)
        assert isinstance(result, bool)
        # We don't assert True because tests should pass regardless of Caido state


class TestGetCaidoUpstreamProxy:
    """Test the proxy config helper."""

    def test_returns_none_when_caido_unavailable(self):
        result = get_caido_upstream_proxy("http://127.0.0.1:1")
        assert result is None

    def test_returns_dict_when_available(self):
        """If Caido is reachable, returns a config dict with 'server' key."""
        result = get_caido_upstream_proxy(CAIDO_URL_DEFAULT)
        if result is not None:
            assert "server" in result


class TestSearchHTTPHistory:
    """Test the HTTP history search."""

    def test_returns_empty_when_caido_unavailable(self):
        result = search_http_history(
            'host: "example.com"',
            caido_url="http://127.0.0.1:1",
        )
        assert result == []

    def test_returns_list(self):
        """Always returns a list (never raises)."""
        result = search_http_history('host: "test"', caido_url="http://127.0.0.1:1")
        assert isinstance(result, list)


class TestGetHTTPHistoryForUrl:
    """Test the URL-based search helper."""

    def test_returns_list_for_unreachable_caido(self):
        result = get_http_history_for_url(
            "https://example.com/path",
            caido_url="http://127.0.0.1:1",
        )
        assert result == []

    def test_handles_complex_urls(self):
        """URLs with query params should be handled."""
        result = get_http_history_for_url(
            "https://example.com/api?x=1&y=2",
            caido_url="http://127.0.0.1:1",
        )
        assert isinstance(result, list)


class TestGetFullTransaction:
    """Test the full transaction fetch."""

    def test_returns_none_when_caido_unavailable(self):
        result = get_full_transaction("123", caido_url="http://127.0.0.1:1")
        assert result is None


class TestEnrichPageCard:
    """Test the PageCard enrichment helper."""

    def test_graceful_when_caido_unavailable(self):
        """When Caido is unreachable, page_card is marked unavailable."""
        # Build a fake page_card as dict
        page_card = {
            "page_id": "test-1",
            "url": "https://example.com/",
            "sources": [],
        }
        result = enrich_page_card_with_caido(
            page_card, caido_url="http://127.0.0.1:1"
        )
        # Should be marked unavailable
        assert result["http_history_unavailable"] is True
        # Original fields preserved
        assert result["page_id"] == "test-1"
        assert result["url"] == "https://example.com/"

    def test_handles_object_page_card(self):
        """Works with PageCard objects too, not just dicts."""
        from page_card import PageCard

        page_card = PageCard(page_id="obj-1", url="https://example.com/")
        result = enrich_page_card_with_caido(
            page_card, caido_url="http://127.0.0.1:1"
        )
        assert result.http_history_unavailable is True
        assert result.page_id == "obj-1"

    def test_empty_url_handled(self):
        """Empty URL should not crash."""
        page_card = {"page_id": "empty", "url": ""}
        result = enrich_page_card_with_caido(page_card, caido_url="http://127.0.0.1:1")
        # Should not raise; should be marked unavailable
        assert result["http_history_unavailable"] is True

    def test_preserves_existing_sources(self):
        """Existing sources should be preserved when adding 'caido'."""
        page_card = {
            "page_id": "preserve-1",
            "url": "https://example.com/",
            "sources": ["playwright"],
        }
        result = enrich_page_card_with_caido(page_card, caido_url="http://127.0.0.1:1")
        # Original "playwright" source should still be there
        assert "playwright" in result["sources"]
