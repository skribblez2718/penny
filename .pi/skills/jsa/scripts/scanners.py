"""jsa deterministic external-tool layer — ACQUIRE + SAST_SCAN.

Shells out to the CLI tools directly (katana / curl / semgrep / jsluice) because
the jsa run executes in a subprocess that cannot call Penny's MCP tools. Ported
from the pre-engine ``orchestrate.py`` acquisition + SAST scan onto the engine's
per-phase handler model.

Every step degrades gracefully: a missing binary, a failed fetch, or an empty
corpus records an error on ``state.errors`` (or simply yields nothing) and leaves
the pipeline able to continue. This is the "cheap-deterministic-first" pass — it
populates ``state.sast_findings`` (and the file manifest + page/endpoint context)
so the NORMALIZE → DEDUP → CORRELATE_EVIDENCE → SAST_VALIDATE spine has real
input and the INVESTIGATE agents get a deterministic baseline to build on.

ACQUIRE runs a full katana crawl (depth-bounded) with authenticated fetch, then
recursively discovers JS via jsluice; it falls back to a curl homepage fetch when
katana is unavailable or returns nothing.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import urljoin, urlparse

# <script src="..."> and inline <script>...</script> extraction (any quote/type).
SCRIPT_SRC_RE = re.compile(r'<script\b[^>]*?\bsrc\s*=\s*["\']([^"\']+)["\']', re.IGNORECASE)
INLINE_SCRIPT_RE = re.compile(
    r"<script\b(?![^>]*\bsrc\s*=)[^>]*>(.*?)</script>", re.IGNORECASE | re.DOTALL
)

# Curated CE-compatible registry rulesets that complement the bundled local
# rules without duplicating them. Each is one --config arg (keeps argv small).
JSA_REGISTRY_RULES = [
    "p/javascript", "p/typescript", "p/nodejs", "p/expressjs", "p/eslint",
    "p/xss", "p/owasp-top-ten", "p/cwe-top-25", "p/secrets",
    "p/security-audit", "p/sql-injection", "p/command-injection",
    "p/jwt", "p/insecure-transport",
]

_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico", ".avif")
# jsluice url `type`s that denote an API/behavioral endpoint worth collecting.
_ENDPOINT_TYPES = ("fetch", "xhr", "locationAssignment", "open", "jqueryAjax")

CURL_TIMEOUT = 20
SEMGREP_TIMEOUT = 600
JSLUICE_TIMEOUT = 30
KATANA_DEPTH = 5
KATANA_TIMEOUT = 300
MAX_CRAWL_DEPTH = 5  # recursive jsluice JS-discovery depth cap
TRUFFLEHOG_TIMEOUT = 180  # optional best-in-class secret scanner (graceful if absent)
GITLEAKS_TIMEOUT = 180


# ---------------------------------------------------------------------------
# Tool discovery
# ---------------------------------------------------------------------------

def _semgrep_bin() -> str:
    """Discover semgrep: $SEMGREP_BIN → project venv → PATH → bare 'semgrep'."""
    env = os.environ.get("SEMGREP_BIN")
    if env and Path(env).exists():
        return env
    here = Path(__file__).resolve().parent
    for anc in [here, *here.parents][:6]:
        cand = anc / ".venv" / "bin" / "semgrep"
        if cand.is_file():
            return str(cand)
    for pdir in os.environ.get("PATH", "").split(os.pathsep):
        cand = Path(pdir) / "semgrep"
        if cand.is_file():
            return str(cand)
    return "semgrep"


def _rules_base() -> Path | None:
    """Locate the bundled semgrep rules tree (.pi/extensions/semgrep/rules).

    Passing the whole tree as a single --config means any rules written under it
    (including reflect-authored / learned rules — see Stage E) are picked up on
    the next run for free.
    """
    here = Path(__file__).resolve().parent
    for anc in [here, *here.parents][:6]:
        cand = anc / ".pi" / "extensions" / "semgrep" / "rules"
        if cand.is_dir():
            return cand
    return None


def _jsluice_bin() -> str | None:
    cand = Path.home() / "go" / "bin" / "jsluice"
    if cand.exists():
        return str(cand)
    for pdir in os.environ.get("PATH", "").split(os.pathsep):
        c = Path(pdir) / "jsluice"
        if c.is_file():
            return str(c)
    return None


def _katana_bin() -> str | None:
    cand = Path.home() / "go" / "bin" / "katana"
    if cand.exists():
        return str(cand)
    for pdir in os.environ.get("PATH", "").split(os.pathsep):
        c = Path(pdir) / "katana"
        if c.is_file():
            return str(c)
    return None


def _find_bin(name: str) -> str | None:
    """Discover an OPTIONAL CLI on PATH or in ~/go/bin (Go binaries). Returns None
    when absent so the caller degrades gracefully — the tool is a bonus, not a
    dependency."""
    cand = Path.home() / "go" / "bin" / name
    if cand.exists():
        return str(cand)
    for pdir in os.environ.get("PATH", "").split(os.pathsep):
        c = Path(pdir) / name
        if c.is_file():
            return str(c)
    return None


def _trufflehog_bin() -> str | None:
    return _find_bin("trufflehog")


def _gitleaks_bin() -> str | None:
    return _find_bin("gitleaks")


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _is_image_asset_url(url: str) -> bool:
    """True if the URL points to a static image asset (endpoint-discovery noise)."""
    base = url.split("?", 1)[0].split("#", 1)[0].lower()
    return base.endswith(_IMAGE_EXTS)


def _is_js_file_url(entry: dict) -> bool:
    """True if a jsluice url entry points to a JavaScript file (or dynamic import)."""
    if entry.get("type", "") == "import":
        return True
    base = entry.get("url", "").split("?")[0].split("#")[0]
    return base.lower().endswith(".js")


def _is_out_of_scope(url: str, patterns: list[str]) -> bool:
    try:
        from jsa_domain import is_out_of_scope

        return is_out_of_scope(url, patterns)
    except Exception:  # noqa: BLE001
        return any(p and p in url for p in (patterns or []))


def _safe_js_name(url: str, index: int, seen: set[str]) -> str:
    """Derive a safe, collision-free *.js filename from a script URL."""
    name = Path(urlparse(url).path).name
    if not name.endswith(".js"):
        name = f"{name}.js" if name else f"script_{index}.js"
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)
    base = name[:-3]  # strip .js
    candidate, n = name, 1
    while candidate in seen:
        candidate = f"{base}_{n}.js"
        n += 1
    seen.add(candidate)
    return candidate


def _url_to_slug(url: str, seen_slugs: set[str]) -> str:
    """Filesystem-safe slug for an HTML page filename (deduped against seen)."""
    path = (urlparse(url).path or "/").rstrip("/")
    if not path:
        slug = "homepage"
    else:
        slug = re.sub(r"_+", "_", re.sub(r"[^a-zA-Z0-9._-]", "_", path.lstrip("/"))).strip("_")[:200]
        slug = slug or "page"
    base, n = slug, 2
    while f"{slug}.html" in seen_slugs:
        slug = f"{base}_{n}"
        n += 1
    return slug


def _resolved_auth_headers(intake: dict) -> list[str]:
    """Real ``Name: Value`` header strings from the intake questionnaire.

    ``jsa_domain.build_auth_katana_args`` returns header args that reference the
    token via ``$VAR`` plus an env dict (to keep secrets out of argv). Those refs
    only expand under a shell; here we resolve them ourselves so the fetch
    actually authenticates. For anonymous runs this is an empty list.
    """
    try:
        from jsa_domain import build_auth_katana_args
    except Exception:  # noqa: BLE001
        return []
    args, env = build_auth_katana_args(intake or {})
    headers: list[str] = []
    it = iter(args)
    for flag in it:
        if flag == "-H":
            val = next(it, "")
            for k, v in env.items():
                val = val.replace(f"${k}", v)
            if val:
                headers.append(val)
    return headers


def _write_curl_auth_config(headers: list[str], output_dir: str) -> str | None:
    """Write auth headers to a mode-0600 curl config file (``--config``), keeping
    the token out of argv / ps output. Returns the path, or None if no headers."""
    if not headers:
        return None
    cfg = Path(output_dir) / ".curl_auth.conf"
    lines = [f'header = "{h}"' for h in headers]
    cfg.write_text("\n".join(lines) + "\n")
    try:
        os.chmod(cfg, 0o600)
    except OSError:
        pass
    return str(cfg)


# ---------------------------------------------------------------------------
# ACQUIRE
# ---------------------------------------------------------------------------

def run_acquire(state) -> None:
    """Crawl the target (katana, authenticated + depth-bounded), extract HTML +
    inline/external JS, recursively discover more JS via jsluice, then build the
    FileMap manifest + AST index the STRUCTURE phase consumes. Mutates ``state``
    in place; never raises.
    """
    state.ensure_dirs()
    counts = {
        "meaningful_html": 0, "static_html": 0, "inline_scripts": 0,
        "external_scripts": 0, "downloaded": 0,
    }
    target = state.target_url
    if not target:
        state.errors.append("acquire: no target_url")
        _finalize_acquire(state, counts, endpoints=[], page_entries=[], depth=0)
        return

    intake = state.metadata.get("intake", {}) or {}
    out_of_scope = state.metadata.get("out_of_scope", []) or []
    auth_headers = _resolved_auth_headers(intake)
    curl_cfg = _write_curl_auth_config(auth_headers, state.output_dir)

    seen_urls: set[str] = set()
    seen_slugs: set[str] = set()
    seen_names: set[str] = set()
    endpoints: list[dict] = []
    page_entries: list[dict] = []
    script_srcs: list[str] = []

    # ── Step 1: katana crawl ──
    entries = _run_katana_crawl(state, target, auth_headers)

    # ── Step 2: process crawled pages ──
    for entry in entries:
        url = entry.get("request", {}).get("endpoint", "") or target
        body = _katana_body(entry)
        if not body:
            continue
        classification = _classify_html(body, url)
        slug = _url_to_slug(url, seen_slugs)
        seen_slugs.add(f"{slug}.html")
        if not classification["meaningful"]:
            counts["static_html"] += 1
            continue
        counts["meaningful_html"] += 1
        try:
            (state.html_dir / f"{slug}.html").write_text(body)
        except OSError:
            continue
        inline_entries = _extract_inline_scripts(state, slug, body, counts)
        for m in SCRIPT_SRC_RE.finditer(body):
            src = m.group(1).strip()
            if src:
                full = urljoin(url, src)
                if full not in seen_urls:
                    script_srcs.append(full)
        page_entries.append({
            "html_file": f"{slug}.html",
            "html_url": url,
            "inline_scripts": inline_entries,
            "external_scripts": classification["external_scripts"],
            "page_type": "meaningful",
            "forms": classification["forms"],
            "api_calls": classification["api_calls"],
        })

    # Fallback: if the crawl surfaced nothing usable (katana absent, empty, or
    # bodyless responses), fetch the homepage directly with curl so we still
    # capture the homepage's inline + external scripts.
    if not script_srcs and counts["meaningful_html"] == 0 and counts["inline_scripts"] == 0:
        _acquire_homepage_fallback(state, target, curl_cfg, script_srcs, counts)

    counts["external_scripts"] = len(script_srcs)

    # ── Step 3: recursive JS discovery (jsluice urls → queue JS imports) ──
    jbin = _jsluice_bin()
    queue = list(dict.fromkeys(script_srcs))
    depth = 0
    url_by_dest: dict[str, str] = {}  # local path -> origin URL (for external .map fetch)
    while queue and depth < MAX_CRAWL_DEPTH:
        next_queue: list[str] = []
        for url in queue:
            if url in seen_urls or _is_image_asset_url(url) or _is_out_of_scope(url, out_of_scope):
                continue
            seen_urls.add(url)
            dest = _download_js(state, url, curl_cfg, seen_names)
            if dest is None:
                continue
            counts["downloaded"] += 1
            url_by_dest[str(dest)] = url
            if jbin:
                for e in _run_jsluice(jbin, "urls", dest):
                    if e.get("type", "") in _ENDPOINT_TYPES:
                        endpoints.append(e)
                    if _is_js_file_url(e):
                        full = urljoin(url, e.get("url", ""))
                        if full not in seen_urls:
                            next_queue.append(full)
        queue = next_queue
        depth += 1

    # ── Step 4: reconstruct first-party ORIGINAL source from source maps ──
    _reconstruct_source_maps(state, url_by_dest, curl_cfg)

    _finalize_acquire(state, counts, endpoints, page_entries, depth)


def _run_katana_crawl(state, target: str, auth_headers: list[str]) -> list[dict]:
    """Run a depth-bounded katana crawl and return parsed JSONL entries. Returns
    [] if katana is absent or fails (caller falls back to a curl homepage fetch)."""
    kbin = _katana_bin()
    if kbin is None:
        return []
    response_dir = state.assets_dir / "katana_responses"
    try:
        response_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    cmd = [
        kbin, "-u", target, "-d", str(KATANA_DEPTH), "-jsonl", "-silent",
        "-store-response", "-store-response-dir", str(response_dir),
        "-field-scope", "fqdn", "-filter-similar", "-kf", "all",
    ]
    for h in auth_headers:
        cmd += ["-H", h]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=KATANA_TIMEOUT)
    except Exception as e:  # noqa: BLE001
        state.errors.append(f"acquire: katana failed ({e}); falling back to curl homepage")
        return []
    entries: list[dict] = []
    for line in res.stdout.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return entries


def _katana_body(entry: dict) -> str:
    """Extract the response body from a katana JSONL entry (inline or on disk)."""
    resp = entry.get("response", {}) or {}
    body = resp.get("body", "") or ""
    if body:
        return body
    stored = resp.get("stored_response_path", "")
    if stored:
        try:
            return Path(stored).read_text(errors="replace")
        except OSError:
            return ""
    return ""


def _acquire_homepage_fallback(state, target, curl_cfg, script_srcs, counts) -> None:
    """Curl the homepage and seed inline scripts + external <script src> URLs."""
    html_path = state.html_dir / "homepage.html"
    cmd = ["curl", "-sL", "--max-time", "15"]
    if curl_cfg:
        cmd += ["--config", curl_cfg]
    cmd += ["-o", str(html_path), target]
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=CURL_TIMEOUT, check=True)
    except Exception as e:  # noqa: BLE001
        state.errors.append(f"acquire: curl homepage failed: {e}")
        return
    if not html_path.exists() or html_path.stat().st_size == 0:
        state.errors.append("acquire: homepage not downloaded")
        return
    html = html_path.read_text(errors="replace")
    for i, m in enumerate(INLINE_SCRIPT_RE.finditer(html)):
        code = m.group(1).strip()
        if code:
            (state.js_dir / f"homepage_inline_{i}.js").write_text(code)
            counts["inline_scripts"] += 1
    for m in SCRIPT_SRC_RE.finditer(html):
        src = m.group(1).strip()
        if src:
            script_srcs.append(urljoin(target, src))


def _extract_inline_scripts(state, slug: str, html: str, counts: dict) -> list[dict]:
    """Write each inline <script> to its own file and return per-page index entries."""
    entries: list[dict] = []
    for i, m in enumerate(INLINE_SCRIPT_RE.finditer(html)):
        code = m.group(1).strip()
        if not code:
            continue
        name = f"{slug}_inline_{i}.js"
        try:
            (state.js_dir / name).write_text(code)
        except OSError:
            continue
        counts["inline_scripts"] += 1
        entries.append({
            "js_file": name,
            "line_start": html[: m.start()].count("\n") + 1,
            "line_end": html[: m.end()].count("\n") + 1,
        })
    return entries


def _classify_html(html: str, url: str) -> dict:
    """Classify a page as meaningful (has forms / interactive elements / event
    handlers / API calls) and extract structured data. Mirrors the ported logic."""
    result = {
        "meaningful": False, "forms": [], "api_calls": [],
        "external_scripts": [], "interactive_elements": [], "inline_script_count": 0,
    }
    if url.split("?")[0].lower().endswith(
        (".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".woff", ".woff2", ".ttf", ".ico", ".pdf")
    ):
        return result
    if len(html.strip()) < 200:
        return result
    if html.count("<form") > 0:
        result["meaningful"] = True
    interactive = [t for t in ("<button", "<input", "<select", "<textarea") if t in html]
    if interactive:
        result["meaningful"] = True
        result["interactive_elements"] = [t.strip("<") for t in interactive]
    if any(eh in html for eh in ("onclick=", "onsubmit=", "onchange=", "oninput=")):
        result["meaningful"] = True
    api_re = re.compile(
        r"fetch\s*\(|XMLHttpRequest|\$\.ajax\s*\(|\$\.get\s*\(|\$\.post\s*\(|axios\.",
        re.IGNORECASE,
    )
    api_matches = api_re.findall(html)
    if api_matches:
        result["meaningful"] = True
        result["api_calls"] = api_matches[:50]
    result["external_scripts"] = SCRIPT_SRC_RE.findall(html)[:100]
    result["inline_script_count"] = len(INLINE_SCRIPT_RE.findall(html))
    return result


def _download_js(state, url: str, curl_cfg: str | None, seen_names: set[str]) -> Path | None:
    """Download a single JS file (authenticated) into js_dir; return its path."""
    dest = state.js_dir / _safe_js_name(url, len(seen_names), seen_names)
    cmd = ["curl", "-sL", "--max-time", "15"]
    if curl_cfg:
        cmd += ["--config", curl_cfg]
    cmd += ["-o", str(dest), url]
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=CURL_TIMEOUT, check=True)
    except Exception as e:  # noqa: BLE001
        state.errors.append(f"acquire: download {url} failed: {e}")
        return None
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    return None


def _finalize_acquire(state, counts: dict, endpoints: list, page_entries: list, depth: int) -> None:
    """Write the inline-index correlation manifest, build the FileMap manifest +
    AST index from whatever JS landed in js_dir, and record acquire metadata."""
    inline_index = {"schema_version": 1, "total_pages": counts["meaningful_html"], "entries": page_entries}
    try:
        (state.assets_dir / "inline_index.json").write_text(json.dumps(inline_index, indent=2))
    except OSError:
        pass

    js_files: list[tuple[str, str]] = []
    if state.js_dir.exists():
        for p in sorted(state.js_dir.glob("*.js")):
            try:
                js_files.append((str(p), p.read_text(errors="replace")))
            except OSError:
                continue
    if js_files:
        try:
            from structure_analysis import build_ast_index, build_file_manifest

            state.file_map = build_file_manifest(js_files)
            state.typed_store = {"manifest": state.file_map, "ast_indexes": build_ast_index(js_files)}
        except Exception as e:  # noqa: BLE001
            state.errors.append(f"acquire: manifest build failed: {e}")

    state.metadata["endpoints"] = endpoints
    state.metadata["acquire_started"] = True
    state.metadata["acquire_result"] = {
        **counts,
        "total_js_files": len(js_files),
        "html_files": len(list(state.html_dir.glob("*.html"))) if state.html_dir.exists() else 0,
        "endpoints_found": len(endpoints),
        "recursion_depth": depth,
        "pages_with_forms": sum(1 for e in page_entries if e.get("forms")),
        "pages_with_api_calls": sum(1 for e in page_entries if e.get("api_calls")),
    }


# ---------------------------------------------------------------------------
# SAST_SCAN
# ---------------------------------------------------------------------------

def run_sast_scan(state) -> None:
    """Run semgrep + jsluice (+ optional trufflehog/gitleaks) over the acquired
    JS/HTML and populate ``state.sast_findings`` (+ ``state.metadata['sast']``
    counts). Deduped secrets are appended as first-class SAST findings so they flow
    to candidate generation (a ``secret_disclosure`` investigation), not just
    stashed in metadata. Mutates ``state`` in place; never raises.
    """
    sast = state.metadata.setdefault("sast", {})
    js_files = list(state.js_dir.glob("*.js")) if state.js_dir.exists() else []

    raw = _run_semgrep(state) if js_files else []
    findings = [
        {
            "rule_id": f.get("check_id", ""),
            "severity": f.get("extra", {}).get("severity", "INFO"),
            "path": f.get("path", ""),
            "line": f.get("start", {}).get("line", 0),
            "message": f.get("extra", {}).get("message", ""),
            "code": f.get("extra", {}).get("lines", ""),
            "source": "semgrep",
        }
        for f in raw
    ]
    sast["semgrep_count"] = len(findings)

    jbin = _jsluice_bin()
    secrets: list[dict] = []
    urls: list[dict] = []
    filtered = 0
    if jbin and js_files:
        for jf in js_files:
            for sec in _run_jsluice(jbin, "secrets", jf):
                if isinstance(sec, dict):
                    sec.setdefault("source", "jsluice")
                secrets.append(sec)
        for jf in js_files:
            for entry in _run_jsluice(jbin, "urls", jf):
                u = entry.get("url", "")
                if u and _is_image_asset_url(u):
                    filtered += 1
                    continue
                urls.append(entry)
    sast["jsluice_secrets_count"] = len(secrets)
    sast["jsluice_urls_count"] = len(urls)
    sast["jsluice_urls_filtered"] = filtered

    # ── Optional best-in-class named-secret scanners (graceful) ──
    # trufflehog / gitleaks bring hundreds of provider-specific detectors (and
    # trufflehog can live-VERIFY a key against the provider) that jsluice +
    # semgrep p/secrets don't cover. They are a BONUS, not a dependency: absent
    # binary -> skipped, nothing added, no error. Scans the whole acquired tree
    # once (js_dir + html_dir), not per-file.
    scan_roots = [str(state.js_dir)]
    if state.html_dir.exists() and any(state.html_dir.glob("*.html")):
        scan_roots.append(str(state.html_dir))
    tbin = _trufflehog_bin()
    th_secrets = _run_trufflehog(tbin, scan_roots) if (tbin and js_files) else []
    gbin = _gitleaks_bin()
    gl_secrets = _run_gitleaks(gbin, scan_roots) if (gbin and js_files) else []
    sast["trufflehog_secrets_count"] = len(th_secrets)
    sast["gitleaks_secrets_count"] = len(gl_secrets)
    sast["trufflehog_available"] = tbin is not None
    sast["gitleaks_available"] = gbin is not None

    secrets = _dedup_secrets(secrets + th_secrets + gl_secrets)
    sast["secrets_count"] = len(secrets)
    state.metadata["sast_secrets"] = secrets
    state.metadata["sast_urls"] = urls

    # Surface deduped secrets as first-class SAST findings so candidate generation
    # routes them to a secret_disclosure investigation (the rule_id carries 'secret'
    # so the SAST->vuln-class map picks it up) and annie sees them in the stub.
    for s in secrets:
        kind = str(s.get("kind", "unknown")).lower().replace(" ", "_")
        findings.append(
            {
                "rule_id": f"jsa.secret.{kind}",
                "severity": str(s.get("severity", "MEDIUM")),
                "path": str(s.get("path", "")),
                "line": int(s.get("line", 0) or 0),
                "message": (
                    f"Potential secret ({s.get('kind', 'unknown')}) detected by "
                    f"{s.get('source', 'scanner')}"
                    + (" [VERIFIED against provider]" if s.get("verified") else "")
                ),
                "code": str(s.get("secret", ""))[:200],
                "source": str(s.get("source", "secret-scanner")),
            }
        )
    state.sast_findings = findings


def _run_semgrep(state) -> list[dict]:
    """Invoke semgrep over js_dir (+ html_dir) and return the raw results list."""
    cmd = [_semgrep_bin(), "scan", "--json", "--metrics=off"]
    rules = _rules_base()
    if rules is not None:
        cmd += ["--config", str(rules)]
    for r in JSA_REGISTRY_RULES:
        cmd += ["--config", r]
    cmd.append(str(state.js_dir))
    if state.html_dir.exists() and any(state.html_dir.glob("*.html")):
        cmd.append(str(state.html_dir))
    # Reconstructed first-party source (from source maps) is readable TS/JSX/JS that
    # semgrep parses well — scan it too when present (Gap 2).
    sources_dir = Path(state.output_dir) / "sources"
    if sources_dir.exists() and any(sources_dir.rglob("*.*")):
        cmd.append(str(sources_dir))

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=SEMGREP_TIMEOUT)
    except FileNotFoundError as e:
        state.errors.append(f"sast_scan: semgrep not found ({e}); install it or set $SEMGREP_BIN")
        return []
    except Exception as e:  # noqa: BLE001
        state.errors.append(f"sast_scan: semgrep failed: {e}")
        return []

    # rc 0 = clean, rc 1 = findings present (semgrep convention) — both carry JSON.
    if res.stdout.strip():
        try:
            return json.loads(res.stdout).get("results", [])
        except json.JSONDecodeError:
            pass
    if res.returncode not in (0, 1):
        state.errors.append(f"sast_scan: semgrep rc={res.returncode}: {res.stderr[:200]}")
    return []


def _run_jsluice(jbin: str, mode: str, js_file: Path) -> list[dict]:
    """Run `jsluice <mode> <file>` and parse its JSONL output. Never raises."""
    try:
        res = subprocess.run(
            [jbin, mode, str(js_file)], capture_output=True, text=True, timeout=JSLUICE_TIMEOUT
        )
    except Exception:  # noqa: BLE001
        return []
    out: list[dict] = []
    for line in res.stdout.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return out


def _run_trufflehog(tbin: str, roots: list[str]) -> list[dict]:
    """Run trufflehog (filesystem mode) over the acquired tree and normalize its
    JSONL output into secret findings. ``Verified`` flags a key trufflehog live-
    checked against the provider (upgraded to HIGH severity). Never raises;
    returns [] on any failure. Non-JSON progress/log lines are skipped."""
    out: list[dict] = []
    cmd = [tbin, "filesystem", *roots, "--json", "--no-update"]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=TRUFFLEHOG_TIMEOUT)
    except Exception:  # noqa: BLE001
        return []
    for line in (res.stdout or "").splitlines():
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict) or "DetectorName" not in obj:
            continue  # skip trufflehog log/progress objects
        fs = ((obj.get("SourceMetadata") or {}).get("Data") or {}).get("Filesystem") or {}
        out.append(
            {
                "kind": str(obj.get("DetectorName", "unknown")),
                "secret": str(obj.get("Redacted") or obj.get("Raw") or "")[:200],
                "verified": bool(obj.get("Verified", False)),
                "severity": "HIGH" if obj.get("Verified") else "MEDIUM",
                "path": str(fs.get("file", "")),
                "line": int(fs.get("line", 0) or 0),
                "source": "trufflehog",
            }
        )
    return out


def _run_gitleaks(gbin: str, roots: list[str]) -> list[dict]:
    """Run gitleaks (no-git directory scan) over the acquired tree and normalize its
    JSON-array report into secret findings. Never raises; returns [] on any failure.
    gitleaks exits 1 when leaks are found — both 0 and 1 carry a report on stdout."""
    out: list[dict] = []
    for root in roots:
        cmd = [
            gbin, "detect", "--no-git", "--redact",
            "--report-format", "json", "--report-path", "/dev/stdout",
            "--source", root,
        ]
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=GITLEAKS_TIMEOUT)
        except Exception:  # noqa: BLE001
            continue
        body = (res.stdout or "").strip()
        if not body:
            continue
        try:
            report = json.loads(body)
        except json.JSONDecodeError:
            continue
        if not isinstance(report, list):
            continue
        for f in report:
            if not isinstance(f, dict):
                continue
            out.append(
                {
                    "kind": str(f.get("RuleID", "unknown")),
                    "secret": str(f.get("Secret") or f.get("Match") or "")[:200],
                    "verified": False,
                    "severity": "MEDIUM",
                    "path": str(f.get("File", "")),
                    "line": int(f.get("StartLine", 0) or 0),
                    "source": "gitleaks",
                }
            )
    return out


# ---------------------------------------------------------------------------
# Source-map reconstruction (recover analyzable first-party source)
# ---------------------------------------------------------------------------

MAX_RECONSTRUCTED_SOURCES = 2000  # per-run cap (a big app's map can hold thousands)


def _curl_get_text(url: str, curl_cfg: str | None) -> str | None:
    """Fetch a URL's body as text via curl (auth config reused). None on any
    failure. Used to pull external ``.map`` files. Never raises."""
    cmd = ["curl", "-sSL", "--max-time", str(CURL_TIMEOUT)]
    if curl_cfg:
        cmd += ["--config", curl_cfg]
    cmd.append(url)
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=CURL_TIMEOUT + 5)
    except Exception:  # noqa: BLE001
        return None
    return res.stdout if (res.returncode == 0 and res.stdout) else None


def _sanitize_source_rel(src_path: str) -> str:
    """Turn a source-map ``sources[]`` entry into a SAFE relative path under
    ``sources/`` — strips ``webpack://``/scheme prefixes and any ``../`` so a
    malicious map can't write outside the sources dir (path-traversal guard)."""
    p = str(src_path)
    p = re.sub(r"^[a-zA-Z]+://", "", p)  # webpack://, file://, etc.
    p = re.sub(r"^(\.\./)+", "", p)
    p = p.lstrip("./").lstrip("/")
    parts = [
        re.sub(r"[^A-Za-z0-9._-]+", "_", seg)
        for seg in p.split("/")
        if seg not in ("", ".", "..")
    ]
    return "/".join(parts)[:200]


def _extract_source_map_json(js_text: str, dest: str, url: str | None, curl_cfg: str | None):
    """Return the parsed source-map dict for a JS file, or None. Handles an INLINE
    ``data:...;base64,`` map (self-contained), a co-located ``<file>.map``, or an
    EXTERNAL ``.map`` fetched from ``<url>``'s resolved sourceMappingURL."""
    import base64

    m = re.search(r"//[#@]\s*sourceMappingURL=(\S+)", js_text)
    if not m:
        return None
    ref = m.group(1).strip()
    raw_map: str | None = None
    if ref.startswith("data:"):
        b64 = re.search(r"base64,(.+)$", ref)
        if b64:
            try:
                raw_map = base64.b64decode(b64.group(1)).decode("utf-8", "replace")
            except Exception:  # noqa: BLE001
                raw_map = None
    else:
        local = Path(dest).with_name(Path(dest).name + ".map")
        if local.exists():
            raw_map = local.read_text(errors="replace")
        elif url:
            raw_map = _curl_get_text(urljoin(url, ref), curl_cfg)
    if not raw_map:
        return None
    try:
        return json.loads(raw_map)
    except Exception:  # noqa: BLE001
        return None


def _reconstruct_source_maps(state, url_by_dest: dict, curl_cfg: str | None) -> None:
    """Reconstruct first-party ORIGINAL source from source maps (inline base64,
    co-located, or external ``.map``) into ``{output_dir}/sources/`` so the analyzers
    review readable pre-bundle code instead of minified output. ``node_modules`` /
    bundler-internal sources are skipped (third-party — already fingerprinted for
    CVE). Records ``state.metadata['source_maps']``. Never raises."""
    sources_dir = Path(state.output_dir) / "sources"
    reconstructed = 0
    files_written: list[str] = []
    seen_rel: set[str] = set()
    js_dir = state.js_dir
    js_files = sorted(js_dir.glob("*.js")) if js_dir.exists() else []
    for js_file in js_files:
        if reconstructed >= MAX_RECONSTRUCTED_SOURCES:
            break
        try:
            js_text = js_file.read_text(errors="replace")
        except Exception:  # noqa: BLE001
            continue
        sm = _extract_source_map_json(
            js_text, str(js_file), url_by_dest.get(str(js_file)), curl_cfg
        )
        if not isinstance(sm, dict):
            continue
        sources = sm.get("sources", []) or []
        contents = sm.get("sourcesContent", []) or []
        for i, src_path in enumerate(sources):
            if reconstructed >= MAX_RECONSTRUCTED_SOURCES:
                break
            if i >= len(contents) or not contents[i]:
                continue
            sp = str(src_path)
            if "node_modules" in sp or "/webpack/" in sp or sp.startswith("webpack/"):
                continue  # third-party / bundler internals
            rel = _sanitize_source_rel(sp)
            if not rel or rel in seen_rel:
                continue
            seen_rel.add(rel)
            out_path = sources_dir / rel
            try:
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_text(str(contents[i]))
            except OSError:
                continue
            reconstructed += 1
            files_written.append(str(out_path))
    state.metadata["source_maps"] = {
        "reconstructed_files": reconstructed,
        "sources_dir": str(sources_dir) if reconstructed else "",
        "files": files_written[:200],
    }


def _dedup_secrets(secrets: list[dict]) -> list[dict]:
    """Collapse the same secret reported by more than one scanner. Key = (normalized
    kind, secret snippet) — deliberately NOT path, so a hit jsluice (no path) and
    trufflehog (with path) both surface is collapsed once. A VERIFIED duplicate wins
    over an unverified one. First-seen order is preserved."""
    best: dict[tuple, dict] = {}
    order: list[tuple] = []
    for s in secrets:
        if not isinstance(s, dict):
            continue
        key = (
            str(s.get("kind", "")).lower(),
            str(s.get("secret", s.get("data", "")))[:120],
        )
        prev = best.get(key)
        if prev is None:
            best[key] = s
            order.append(key)
        elif s.get("verified") and not prev.get("verified"):
            best[key] = s  # prefer the verified duplicate
    return [best[k] for k in order]
