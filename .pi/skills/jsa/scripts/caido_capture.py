"""jsa Skill — Caido HTTP History Capture

Queries Caido for HTTP history matching target URLs and merges the
results into PageCard records.

Two-phase strategy (per the roadmap):
1. Primary: Playwright drives browser through Caido proxy (auto-configured
   via PLAYWRIGHT_PROXY_SERVER or CAIDO_URL auto-derivation)
2. Secondary: Query Caido HTTP history for additional context

Graceful degradation:
- If Caido is not reachable, return page_card unchanged
- If a specific URL has no Caido history, mark http_history_unavailable
- Pipeline continues without error

This module talks to the Caido REST API. For detailed search queries, we
use the HTTPQL filter syntax documented at https://docs.caido.io/.
"""

from __future__ import annotations

import json
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Optional


# Default Caido URL — override via CAIDO_URL env var
CAIDO_URL_DEFAULT = "http://localhost:8080"
CAIDO_HEALTH_TIMEOUT = 3  # seconds
CAIDO_SEARCH_TIMEOUT = 10  # seconds


@dataclass
class HTTPTransaction:
    """A single HTTP transaction from Caido's history."""
    id: str = ""
    method: str = ""
    host: str = ""
    path: str = ""
    query: str = ""
    is_tls: bool = False
    port: int = 0
    status_code: int = 0
    roundtrip_ms: int = 0
    response_length: int = 0
    timestamp: str = ""

    # Full request/response (populated by get_full_transaction)
    request_raw: str = ""
    response_raw: str = ""
    request_headers: dict[str, str] = field(default_factory=dict)
    response_headers: dict[str, str] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Caido availability
# ---------------------------------------------------------------------------


def is_caido_available(caido_url: str = CAIDO_URL_DEFAULT) -> bool:
    """Check if Caido instance is reachable."""
    try:
        with urllib.request.urlopen(f"{caido_url}/health", timeout=CAIDO_HEALTH_TIMEOUT) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError, TimeoutError):
        # Try the root path
        try:
            with urllib.request.urlopen(caido_url, timeout=CAIDO_HEALTH_TIMEOUT) as resp:
                return resp.status < 500
        except (urllib.error.URLError, OSError, TimeoutError):
            return False


def get_caido_upstream_proxy(caido_url: str = CAIDO_URL_DEFAULT) -> Optional[dict]:
    """Return Caido upstream proxy config, or None if not available.

    For use by Playwright extension to route traffic through Caido.

    Returns:
        Dict with 'server' key (e.g., "http://localhost:8080") or None.
    """
    if is_caido_available(caido_url):
        return {"server": caido_url}
    return None


# ---------------------------------------------------------------------------
# HTTP history queries
# ---------------------------------------------------------------------------


def search_http_history(
    httpql_filter: str,
    caido_url: str = CAIDO_URL_DEFAULT,
    limit: int = 50,
) -> list[HTTPTransaction]:
    """Search Caido HTTP history with HTTPQL filter.

    Args:
        httpql_filter: HTTPQL query (e.g., 'host: "example.com"').
        caido_url: Caido base URL.
        limit: Max results.

    Returns:
        List of HTTPTransaction (empty if Caido unavailable or no matches).
    """
    if not is_caido_available(caido_url):
        return []

    # Caido's GraphQL API requires a different approach than the simple
    # search endpoint. We use the REST search endpoint.
    try:
        params = urllib.parse.urlencode({
            "filter": httpql_filter,
            "limit": str(limit),
        })
        url = f"{caido_url}/search?{params}"
        with urllib.request.urlopen(url, timeout=CAIDO_SEARCH_TIMEOUT) as resp:
            data = json.loads(resp.read())
    except (urllib.error.URLError, OSError, TimeoutError, json.JSONDecodeError):
        return []

    transactions = []
    for item in data.get("results", []):
        tx = HTTPTransaction(
            id=str(item.get("id", "")),
            method=item.get("method", ""),
            host=item.get("host", ""),
            path=item.get("path", ""),
            query=item.get("query", ""),
            is_tls=item.get("isTls", False),
            port=item.get("port", 0),
            status_code=item.get("statusCode", 0),
            roundtrip_ms=item.get("roundtrip", 0),
            response_length=item.get("responseLength", 0),
            timestamp=item.get("createdAt", ""),
        )
        transactions.append(tx)
    return transactions


def get_http_history_for_url(
    url: str,
    caido_url: str = CAIDO_URL_DEFAULT,
    limit: int = 50,
) -> list[HTTPTransaction]:
    """Search Caido HTTP history for a specific URL.

    Args:
        url: The URL to search for (e.g., "https://example.com/path").
        caido_url: Caido base URL.
        limit: Max results.

    Returns:
        List of HTTPTransaction matching the URL's host/path.
    """
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or ""
    path = parsed.path or "/"

    # Build HTTPQL filter
    filter_parts = [f'host: "{host}"']
    if path and path != "/":
        filter_parts.append(f'path: "{path}"')

    filter_query = " AND ".join(filter_parts)
    return search_http_history(filter_query, caido_url=caido_url, limit=limit)


def get_full_transaction(
    transaction_id: str,
    caido_url: str = CAIDO_URL_DEFAULT,
) -> Optional[HTTPTransaction]:
    """Fetch full request/response for a specific transaction.

    Args:
        transaction_id: The Caido transaction ID.
        caido_url: Caido base URL.

    Returns:
        HTTPTransaction with full request/response populated, or None.
    """
    if not is_caido_available(caido_url):
        return None

    try:
        url = f"{caido_url}/requests/{transaction_id}"
        with urllib.request.urlopen(url, timeout=CAIDO_SEARCH_TIMEOUT) as resp:
            data = json.loads(resp.read())
    except (urllib.error.URLError, OSError, TimeoutError, json.JSONDecodeError):
        return None

    tx = HTTPTransaction(
        id=str(data.get("id", transaction_id)),
        method=data.get("method", ""),
        host=data.get("host", ""),
        path=data.get("path", ""),
        query=data.get("query", ""),
        is_tls=data.get("isTls", False),
        port=data.get("port", 0),
        request_raw=data.get("raw", ""),
        response_raw=(data.get("response") or {}).get("raw", ""),
    )

    # Parse headers from raw HTTP
    tx.request_headers = _parse_headers(tx.request_raw)
    if data.get("response"):
        tx.response_headers = _parse_headers(tx.response_raw)
        tx.status_code = (data.get("response") or {}).get("statusCode", 0)
        tx.roundtrip_ms = (data.get("response") or {}).get("roundtrip", 0)
        tx.response_length = (data.get("response") or {}).get("length", 0)

    return tx


def _parse_headers(raw_http: str) -> dict[str, str]:
    """Extract HTTP headers from raw HTTP request/response string."""
    headers = {}
    if not raw_http:
        return headers
    lines = raw_http.split("\r\n")
    # First line is request line or status line — skip
    for line in lines[1:]:
        if not line or ":" not in line:
            break
        name, _, value = line.partition(":")
        headers[name.strip()] = value.strip()
    return headers


# ---------------------------------------------------------------------------
# PageCard enrichment
# ---------------------------------------------------------------------------


def enrich_page_card_with_caido(
    page_card: object,
    caido_url: str = CAIDO_URL_DEFAULT,
    max_transactions: int = 20,
) -> object:
    """Query Caido for HTTP history matching the page URL, attach to PageCard.

    This is called by the STRUCTURE phase after Playwright has driven
    the browser through the Caido proxy. It augments the PageCard
    with full request/response data from Caido.

    Args:
        page_card: A PageCard object (or dict with 'url' and 'page_id' keys).
        caido_url: Caido base URL.
        max_transactions: Max transactions to attach per page.

    Returns:
        The same page_card (mutated in place or dict) with caido data added.
        If Caido is unavailable, marks http_history_unavailable=True.
    """
    # Get URL from page_card
    if hasattr(page_card, "url"):
        url = page_card.url
    elif isinstance(page_card, dict):
        url = page_card.get("url", "")
    else:
        return page_card

    if not url:
        # Mark unavailable for empty URL
        if hasattr(page_card, "http_history_unavailable"):
            page_card.http_history_unavailable = True
        elif isinstance(page_card, dict):
            page_card["http_history_unavailable"] = True
        return page_card

    if not is_caido_available(caido_url):
        # Mark unavailable
        if hasattr(page_card, "http_history_unavailable"):
            page_card.http_history_unavailable = True
        elif isinstance(page_card, dict):
            page_card["http_history_unavailable"] = True
        return page_card

    transactions = get_http_history_for_url(url, caido_url=caido_url, limit=max_transactions)

    if not transactions:
        if hasattr(page_card, "http_history_unavailable"):
            page_card.http_history_unavailable = True
        elif isinstance(page_card, dict):
            page_card["http_history_unavailable"] = True
        return page_card

    # Attach first transaction as the primary request/response
    primary = transactions[0]
    full_tx = get_full_transaction(primary.id, caido_url=caido_url) or primary

    # Build RequestSnapshot and ResponseSnapshot
    from page_card import RequestSnapshot, ResponseSnapshot

    request_snap = RequestSnapshot(
        method=full_tx.method,
        url=url,
        headers=full_tx.request_headers,
        body=None,  # Raw body in full_tx.request_raw; extracted on demand
        source="caido",
    )
    response_snap = ResponseSnapshot(
        status_code=full_tx.status_code,
        headers=full_tx.response_headers,
        body=None,
        body_snippet=full_tx.response_raw[:2000] if full_tx.response_raw else None,
        roundtrip_ms=full_tx.roundtrip_ms,
        source="caido",
    )

    # Attach to page_card
    if hasattr(page_card, "request"):
        page_card.request = request_snap
    elif isinstance(page_card, dict):
        page_card["request"] = request_snap.to_dict() if hasattr(request_snap, "to_dict") else None

    if hasattr(page_card, "response"):
        page_card.response = response_snap
    elif isinstance(page_card, dict):
        page_card["response"] = response_snap.to_dict() if hasattr(response_snap, "to_dict") else None

    # Add to sources
    if hasattr(page_card, "sources") and isinstance(page_card.sources, list):
        if "caido" not in page_card.sources:
            page_card.sources.append("caido")
    elif isinstance(page_card, dict):
        if "caido" not in page_card.sources:
            page_card["sources"].append("caido")

    return page_card


# ---------------------------------------------------------------------------
# CLI helpers
# ---------------------------------------------------------------------------


def caido_query_cli(filter_query: str, caido_url: str = CAIDO_URL_DEFAULT) -> str:
    """Use the caido_search CLI tool via subprocess.

    Fallback for when the REST API doesn't return what we need.
    """
    try:
        result = subprocess.run(
            ["caido", "search", filter_query, "--url", caido_url],
            capture_output=True,
            text=True,
            timeout=CAIDO_SEARCH_TIMEOUT,
        )
        return result.stdout
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return ""
