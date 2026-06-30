"""jsa Skill — Playwright Proxy Capture Helper

Wraps Playwright to drive a browser through a proxy (e.g., Caido) and
capture HTTP request/response data into a structured format.

This module talks to the Playwright extension's tools via subprocess
or via a direct Python script that uses the Playwright npm package.

Why a separate module:
- The Playwright extension in this project is TypeScript
- Our jsa skill is Python
- This module provides a Python interface that agents can use directly
  without spawning Node.js subprocesses per page

Primary use case:
- STRUCTURE phase: navigate to a page URL, capture the resulting
  request/response, return a PageCard-compatible dict
- Fallback when Caido HTTP history is unavailable
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Union


@dataclass
class PlaywrightCapture:
    """Result of capturing a page with Playwright."""
    url: str = ""
    method: str = "GET"
    status_code: int = 0
    status_text: str = ""
    request_headers: dict[str, str] = field(default_factory=dict)
    response_headers: dict[str, str] = field(default_factory=dict)
    body: Optional[str] = None
    body_snippet: Optional[str] = None
    mime_type: str = ""
    resource_type: str = ""
    duration_ms: int = 0
    error: Optional[str] = None
    source: str = "playwright"


# ---------------------------------------------------------------------------
# Direct Playwright API (Python async)
# ---------------------------------------------------------------------------


async def capture_page_async(
    url: str,
    proxy_server: Optional[str] = None,
    proxy_username: Optional[str] = None,
    proxy_password: Optional[str] = None,
    timeout_ms: int = 30000,
    user_agent: str = "Mozilla/5.0 (compatible; jsa-capture/1.0)",
) -> PlaywrightCapture:
    """Capture a page's request/response using Playwright Python API.

    Args:
        url: URL to navigate to.
        proxy_server: Optional proxy server URL (e.g., "http://localhost:8080").
        proxy_username: Optional proxy auth username.
        proxy_password: Optional proxy auth password.
        timeout_ms: Navigation timeout in milliseconds.
        user_agent: User-Agent string to use.

    Returns:
        PlaywrightCapture with request/response data.
    """
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        return PlaywrightCapture(
            url=url,
            error="playwright Python package not installed. Install with: pip install playwright",
        )

    capture = PlaywrightCapture(url=url, method="GET")
    start = __import__("time").time()

    try:
        async with async_playwright() as p:
            launch_kwargs = {"headless": True}
            if proxy_server:
                proxy_opts = {"server": proxy_server}
                if proxy_username:
                    proxy_opts["username"] = proxy_username
                if proxy_password:
                    proxy_opts["password"] = proxy_password
                launch_kwargs["proxy"] = proxy_opts

            browser = await p.chromium.launch(**launch_kwargs)
            context = await browser.new_context(user_agent=user_agent)
            page = await context.new_page()

            # Capture request/response events
            request_data = {}
            response_data = {}

            async def handle_request(request):
                if request.url == url:
                    request_data["headers"] = await request.all_headers()
                    request_data["method"] = request.method

            async def handle_response(response):
                if response.url == url:
                    response_data["status"] = response.status
                    response_data["status_text"] = response.status_text
                    response_data["headers"] = await response.all_headers()

            page.on("request", lambda r: asyncio.create_task(handle_request(r)))
            page.on("response", lambda r: asyncio.create_task(handle_response(r)))

            response = await page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
            if response is not None:
                capture.status_code = response.status
                capture.status_text = response.status_text
                capture.request_headers = request_data.get("headers", {})
                capture.response_headers = response_data.get("headers", {})
                capture.mime_type = response.headers.get("content-type", "")

                # Get body (truncated for safety)
                try:
                    body_bytes = await response.body()
                    capture.body_snippet = body_bytes[:8192].decode("utf-8", errors="replace")
                except Exception as e:
                    capture.body_snippet = f"/* Failed to read body: {e} */"

            await browser.close()

    except Exception as e:
        capture.error = str(e)

    capture.duration_ms = int((__import__("time").time() - start) * 1000)
    return capture


def capture_page_sync(
    url: str,
    proxy_server: Optional[str] = None,
    proxy_username: Optional[str] = None,
    proxy_password: Optional[str] = None,
    timeout_ms: int = 30000,
) -> PlaywrightCapture:
    """Synchronous wrapper around capture_page_async."""
    return asyncio.run(capture_page_async(
        url, proxy_server, proxy_username, proxy_password, timeout_ms
    ))


# ---------------------------------------------------------------------------
# Node.js script fallback (for when Python playwright isn't installed)
# ---------------------------------------------------------------------------


NODE_CAPTURE_SCRIPT = """
const { chromium } = require('playwright');

(async () => {
    const url = process.argv[2];
    const proxyServer = process.argv[3] || null;

    if (!url) {
        console.error('Usage: node capture.js <url> [proxy_server]');
        process.exit(1);
    }

    const launchOpts = { headless: true };
    if (proxyServer) {
        launchOpts.proxy = { server: proxyServer };
    }

    const browser = await chromium.launch(launchOpts);
    const context = await browser.newContext();
    const page = await context.newPage();

    let requestData = {};
    let responseData = {};
    let bodySnippet = '';

    page.on('request', async (request) => {
        if (request.url() === url) {
            requestData = {
                method: request.method(),
                headers: await request.allHeaders(),
            };
        }
    });

    page.on('response', async (response) => {
        if (response.url() === url) {
            responseData = {
                status: response.status(),
                statusText: response.statusText(),
                headers: await response.allHeaders(),
            };
            try {
                const body = await response.body();
                bodySnippet = body.toString('utf-8', 0, 8192);
            } catch (e) {
                bodySnippet = '/* Failed to read body: ' + e.message + ' */';
            }
        }
    });

    const start = Date.now();
    try {
        const response = await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });
        if (response) {
            const out = {
                url,
                status: response.status(),
                request: requestData,
                response: responseData,
                bodySnippet,
                durationMs: Date.now() - start,
                source: 'playwright',
            };
            console.log(JSON.stringify(out));
        }
    } catch (err) {
        console.log(JSON.stringify({
            url,
            error: err.message,
            durationMs: Date.now() - start,
            source: 'playwright',
        }));
    }

    await browser.close();
})();
"""


def capture_page_via_node(
    url: str,
    proxy_server: Optional[str] = None,
    node_path: str = "node",
    work_dir: Optional[Union[str, Path]] = None,
) -> PlaywrightCapture:
    """Capture a page using Node.js + Playwright.

    Fallback when Python playwright isn't available. Writes the script
    to a temp file, runs it, and parses the JSON output.

    Args:
        url: URL to navigate to.
        proxy_server: Optional proxy server URL.
        node_path: Path to node executable.
        work_dir: Working directory (must have playwright installed).

    Returns:
        PlaywrightCapture with parsed output.
    """
    capture = PlaywrightCapture(url=url)

    if work_dir is None:
        work_dir = os.getcwd()

    # Write script
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".js", delete=False, encoding="utf-8"
    ) as f:
        f.write(NODE_CAPTURE_SCRIPT)
        script_path = f.name

    try:
        cmd = [node_path, script_path, url]
        if proxy_server:
            cmd.append(proxy_server)
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60,
            cwd=work_dir,
        )
        if result.returncode != 0:
            capture.error = f"Node.js script failed: {result.stderr[:500]}"
            return capture
        try:
            data = json.loads(result.stdout.strip())
        except json.JSONDecodeError as e:
            capture.error = f"Failed to parse Node.js output: {e}"
            return capture
        capture.status_code = data.get("status", 0)
        capture.request_headers = data.get("request", {}).get("headers", {})
        capture.response_headers = data.get("response", {}).get("headers", {})
        capture.body_snippet = data.get("bodySnippet")
        capture.duration_ms = data.get("durationMs", 0)
        if data.get("error"):
            capture.error = data["error"]
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as e:
        capture.error = str(e)
    finally:
        try:
            os.unlink(script_path)
        except OSError:
            pass

    return capture


# ---------------------------------------------------------------------------
# PageCard conversion
# ---------------------------------------------------------------------------


def capture_to_page_card(capture: PlaywrightCapture, page_id: str = "") -> dict:
    """Convert a PlaywrightCapture to a PageCard-compatible dict.

    Returns a dict suitable for building a PageCard.
    """
    from page_card import RequestSnapshot, ResponseSnapshot

    request_snap = RequestSnapshot(
        method=capture.method,
        url=capture.url,
        headers=capture.request_headers,
        body=None,
        source="playwright",
    )
    response_snap = ResponseSnapshot(
        status_code=capture.status_code,
        status_text=capture.status_text,
        headers=capture.response_headers,
        body=None,
        body_snippet=capture.body_snippet,
        mime_type=capture.mime_type,
        source="playwright",
    )

    return {
        "page_id": page_id,
        "url": capture.url,
        "method": capture.method,
        "request": request_snap.to_dict() if hasattr(request_snap, "to_dict") else None,
        "response": response_snap.to_dict() if hasattr(response_snap, "to_dict") else None,
        "sources": ["playwright"],
        "http_history_unavailable": capture.error is not None,
    }
