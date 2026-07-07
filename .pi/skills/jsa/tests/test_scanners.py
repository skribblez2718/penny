"""Hermetic tests for the deterministic ACQUIRE + SAST_SCAN external-tool layer.

No real curl / semgrep / jsluice runs — ``scanners.subprocess.run`` is monkey-
patched to return canned tool output, so these assert the port's parsing,
mapping, filtering, and graceful-degradation behavior.
"""

import json
import subprocess

import pytest

import scanners
from fsm import JSAState, acquire_handler, sast_scan_handler

SEMGREP_JSON = json.dumps(
    {
        "results": [
            {
                "check_id": "javascript.lang.security.dom-xss",
                "path": "/tmp/x/assets/js/app.js",
                "start": {"line": 12},
                "extra": {
                    "severity": "ERROR",
                    "message": "DOM XSS via innerHTML",
                    "lines": "el.innerHTML = location.hash",
                },
            }
        ]
    }
)

HOMEPAGE_HTML = (
    "<html><head>"
    '<script src="/static/app.js"></script>'
    '<script src="https://cdn.example.com/lib.js"></script>'
    "<script>var inline = 1;</script>"
    '<script src="/img/logo.svg"></script>'
    "</head></html>"
)


def _cp(cmd, returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(cmd, returncode, stdout, stderr)


def _state(tmp_path, target="https://example.com"):
    st = JSAState(target_url=target, output_dir=str(tmp_path))
    st.ensure_dirs()
    return st


# ---------------------------------------------------------------------------
# SAST_SCAN
# ---------------------------------------------------------------------------

def test_run_sast_scan_maps_semgrep_and_filters_jsluice(tmp_path, monkeypatch):
    st = _state(tmp_path)
    (st.js_dir / "app.js").write_text("el.innerHTML = location.hash;")

    def fake_run(cmd, **kw):
        exe = cmd[0]
        if "semgrep" in exe:
            return _cp(cmd, returncode=1, stdout=SEMGREP_JSON)  # rc1 = findings present
        if "jsluice" in exe:
            mode = cmd[1]
            if mode == "secrets":
                return _cp(cmd, stdout=json.dumps({"kind": "aws", "secret": "AKIA"}))
            if mode == "urls":
                return _cp(
                    cmd,
                    stdout=json.dumps({"url": "/api/users"}) + "\n" + json.dumps({"url": "/logo.png"}),
                )
        return _cp(cmd)

    monkeypatch.setattr(scanners.subprocess, "run", fake_run)
    monkeypatch.setattr(scanners, "_jsluice_bin", lambda: "/fake/jsluice")

    run_state = sast_scan_handler(st)

    assert len(run_state.sast_findings) == 1
    f = run_state.sast_findings[0]
    assert f == {
        "rule_id": "javascript.lang.security.dom-xss",
        "severity": "ERROR",
        "path": "/tmp/x/assets/js/app.js",
        "line": 12,
        "message": "DOM XSS via innerHTML",
        "code": "el.innerHTML = location.hash",
        "source": "semgrep",
    }
    sast = run_state.metadata["sast"]
    assert sast["semgrep_count"] == 1
    assert sast["jsluice_secrets_count"] == 1
    # /logo.png is an image asset -> filtered out of the URL findings.
    assert sast["jsluice_urls_count"] == 1
    assert sast["jsluice_urls_filtered"] == 1
    assert run_state.metadata["sast_scan"]["status"] == "complete"


def test_run_sast_scan_empty_corpus_skips_semgrep(tmp_path, monkeypatch):
    st = _state(tmp_path)  # no *.js files

    called = {"n": 0}

    def fake_run(cmd, **kw):
        called["n"] += 1
        return _cp(cmd)

    monkeypatch.setattr(scanners.subprocess, "run", fake_run)
    run_sast = sast_scan_handler(st)
    assert run_sast.sast_findings == []
    assert called["n"] == 0  # nothing to scan -> no subprocess spawned
    assert run_sast.metadata["sast"]["semgrep_count"] == 0


def test_run_sast_scan_semgrep_missing_is_graceful(tmp_path, monkeypatch):
    st = _state(tmp_path)
    (st.js_dir / "app.js").write_text("x=1;")

    def fake_run(cmd, **kw):
        if "semgrep" in cmd[0]:
            raise FileNotFoundError("semgrep")
        return _cp(cmd)

    monkeypatch.setattr(scanners.subprocess, "run", fake_run)
    monkeypatch.setattr(scanners, "_jsluice_bin", lambda: None)

    run_sast = sast_scan_handler(st)
    assert run_sast.sast_findings == []
    assert any("semgrep not found" in e for e in run_sast.errors)


# ---------------------------------------------------------------------------
# ACQUIRE
# ---------------------------------------------------------------------------

# A "meaningful" crawled page (has a form + inline API call + external script),
# padded past the 200-byte classify threshold.
CRAWLED_HTML = (
    "<html><body>"
    "<h1>Members Area</h1><p>" + ("welcome " * 20) + "</p>"
    "<form action='/login'><input name='u'><button>go</button></form>"
    "<script src='/static/app.js'></script>"
    "<script>fetch('/api/me'); var x = 1;</script>"
    "</body></html>"
)


def test_run_acquire_katana_crawl_recurses_and_collects(tmp_path, monkeypatch):
    st = _state(tmp_path)
    monkeypatch.setattr(scanners, "_katana_bin", lambda: "/fake/katana")
    monkeypatch.setattr(scanners, "_jsluice_bin", lambda: "/fake/jsluice")

    def fake_run(cmd, **kw):
        exe = cmd[0]
        if "katana" in exe:
            entry = {"request": {"endpoint": "https://example.com/"},
                     "response": {"body": CRAWLED_HTML}}
            return _cp(cmd, stdout=json.dumps(entry))
        if exe == "curl":
            scanners.Path(cmd[cmd.index("-o") + 1]).write_text("var a = 1;")
            return _cp(cmd)
        if "jsluice" in exe:  # [bin, mode, file]
            if cmd[1] == "urls" and "app.js" in cmd[2]:
                return _cp(cmd, stdout="\n".join([
                    json.dumps({"type": "import", "url": "/static/dep.js"}),
                    json.dumps({"type": "fetch", "url": "/api/data"}),
                ]))
            return _cp(cmd)  # dep.js -> no further discovery
        return _cp(cmd)

    monkeypatch.setattr(scanners.subprocess, "run", fake_run)

    run_state = acquire_handler(st)
    res = run_state.metadata["acquire_result"]

    assert res["meaningful_html"] == 1
    assert res["inline_scripts"] == 1
    # app.js (from the page) + dep.js (discovered recursively by jsluice)
    assert res["downloaded"] == 2
    assert res["recursion_depth"] == 2
    assert res["endpoints_found"] == 1  # the /api/data fetch
    assert (st.html_dir / "homepage.html").exists()  # meaningful page saved as slug
    js_names = {p.name for p in st.js_dir.glob("*.js")}
    assert "app.js" in js_names and "dep.js" in js_names
    assert (st.assets_dir / "inline_index.json").exists()
    assert run_state.file_map is not None
    assert run_state.metadata["endpoints"][0]["url"] == "/api/data"


def test_run_acquire_falls_back_to_curl_homepage_when_no_katana(tmp_path, monkeypatch):
    st = _state(tmp_path)
    monkeypatch.setattr(scanners, "_katana_bin", lambda: None)  # katana unavailable
    monkeypatch.setattr(scanners, "_jsluice_bin", lambda: None)

    def fake_run(cmd, **kw):
        dest = scanners.Path(cmd[cmd.index("-o") + 1])
        dest.write_text(HOMEPAGE_HTML if dest.name.endswith(".html") else "var external = 1;")
        return _cp(cmd)

    monkeypatch.setattr(scanners.subprocess, "run", fake_run)

    run_state = acquire_handler(st)
    res = run_state.metadata["acquire_result"]
    assert res["inline_scripts"] == 1
    assert res["external_scripts"] == 3  # app.js, lib.js, logo.svg
    assert res["downloaded"] == 2  # logo.svg image asset filtered
    js_names = {p.name for p in st.js_dir.glob("*.js")}
    assert "app.js" in js_names and "lib.js" in js_names
    assert run_state.file_map is not None


def test_run_acquire_authenticated_fetch_uses_curl_config_and_katana_header(tmp_path, monkeypatch):
    st = _state(tmp_path)
    st.metadata["intake"] = {
        "authenticated_testing": "authenticated_only",
        "session_management": "cookie",
        "session_details": "sessionid=abc123",
    }
    monkeypatch.setattr(scanners, "_katana_bin", lambda: "/fake/katana")
    monkeypatch.setattr(scanners, "_jsluice_bin", lambda: None)
    seen_cmds: list[list[str]] = []

    def fake_run(cmd, **kw):
        seen_cmds.append(cmd)
        if "katana" in cmd[0]:
            entry = {"request": {"endpoint": "https://example.com/"},
                     "response": {"body": CRAWLED_HTML}}
            return _cp(cmd, stdout=json.dumps(entry))
        if cmd[0] == "curl":
            scanners.Path(cmd[cmd.index("-o") + 1]).write_text("var a = 1;")
        return _cp(cmd)

    monkeypatch.setattr(scanners.subprocess, "run", fake_run)
    acquire_handler(st)

    # Real cookie header resolved (NOT the $VAR indirection) and written to a
    # curl config file, kept out of argv.
    cfg_path = scanners.Path(st.output_dir) / ".curl_auth.conf"
    assert cfg_path.exists()
    assert 'Cookie: sessionid=abc123' in cfg_path.read_text()
    # katana carried the header on argv; curl download carried --config.
    katana_cmds = [c for c in seen_cmds if "katana" in c[0]]
    curl_cmds = [c for c in seen_cmds if c and c[0] == "curl"]
    assert any("Cookie: sessionid=abc123" in c for c in katana_cmds)
    assert curl_cmds and all("--config" in c for c in curl_cmds)


def test_run_acquire_out_of_scope_script_skipped(tmp_path, monkeypatch):
    st = _state(tmp_path)
    st.metadata["out_of_scope"] = ["/admin/"]
    monkeypatch.setattr(scanners, "_katana_bin", lambda: None)
    monkeypatch.setattr(scanners, "_jsluice_bin", lambda: None)

    html = (
        "<html><body><p>" + ("x" * 220) + "</p>"
        "<script src='/static/ok.js'></script>"
        "<script src='/admin/secret.js'></script>"
        "</body></html>"
    )

    def fake_run(cmd, **kw):
        dest = scanners.Path(cmd[cmd.index("-o") + 1])
        dest.write_text(html if dest.name.endswith(".html") else "var a=1;")
        return _cp(cmd)

    monkeypatch.setattr(scanners.subprocess, "run", fake_run)
    acquire_handler(st)
    js_names = {p.name for p in st.js_dir.glob("*.js")}
    assert "ok.js" in js_names
    assert "secret.js" not in js_names  # /admin/ is out of scope


def test_run_acquire_no_target_is_graceful(tmp_path, monkeypatch):
    st = _state(tmp_path, target="")
    monkeypatch.setattr(
        scanners.subprocess, "run", lambda *a, **k: pytest.fail("no tool must run")
    )
    run_state = acquire_handler(st)
    assert any("no target_url" in e for e in run_state.errors)
    assert run_state.metadata["acquire_result"]["total_js_files"] == 0


# ---------------------------------------------------------------------------
# unit helpers
# ---------------------------------------------------------------------------

def test_is_image_asset_url():
    assert scanners._is_image_asset_url("https://x/logo.png?v=2")
    assert scanners._is_image_asset_url("/a/b/icon.SVG")
    assert not scanners._is_image_asset_url("https://x/app.js")
    assert not scanners._is_image_asset_url("/api/users")


def test_safe_js_name_dedups():
    seen: set[str] = set()
    assert scanners._safe_js_name("https://a/app.js", 0, seen) == "app.js"
    assert scanners._safe_js_name("https://b/app.js", 1, seen) == "app_1.js"
    assert scanners._safe_js_name("https://c/bundle", 2, seen) == "bundle.js"
