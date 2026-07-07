"""jsa skill — deterministic phase handlers.

This module is a LIBRARY of deterministic, side-effect-light phase handlers
(``acquire_handler``, ``cve_research_handler``, ``sast_scan_handler``,
``normalize_handler``, …) plus their supporting dataclasses. The pipeline FSM
itself lives on the shared orchestration engine (``JSAPlaybook`` in
``apps/orchestration/src/orchestration/playbooks/jsa.py``); the engine invokes
these handlers one phase at a time through ``jsa_domain.run_phase``. There is no
state machine, run loop, or agent dispatch here anymore — those were removed in
the engine migration.
"""

import json
import math
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# Lazy imports - splitter and dedup loaded when needed
# to avoid circular deps during testing


# ---------------------------------------------------------------------------
# State dataclass
# ---------------------------------------------------------------------------

@dataclass
class JSAState:
    """State container for jsa skill execution."""
    session_id: str = field(default_factory=lambda: str(uuid.uuid4())[:12])
    target_url: str = ""
    output_dir: str = ""
    analyzers: list[str] = field(default_factory=list)
    # CHUNK field removed in Phase B (2026-06). The old ResolvedChunk list
    # is no longer used. The pipeline now uses PageCard/ModuleCard/FlowCard
    # emitted by STRUCTURE and SLICE phases.
    file_map: Any = None                                   # FileMap
    raw_findings: list[Any] = field(default_factory=list)  # list[Finding]
    merged_findings: list[Any] = field(default_factory=list)  # list[MergedFinding]
    sast_findings: list[dict] = field(default_factory=list)
    sast_validated: list[dict] = field(default_factory=list)

    # ----- Structure-and-slice architecture (Phase B, 2026-06) -----
    # Typed analysis store produced by STRUCTURE phase
    typed_store: dict = field(default_factory=dict)
    # Card collections produced by STRUCTURE
    module_cards: list[Any] = field(default_factory=list)  # list[ModuleCard]
    page_cards: list[Any] = field(default_factory=list)    # list[PageCard]
    symbol_cards: list[Any] = field(default_factory=list)  # list[SymbolCard] (deferred to Phase 2)
    # Slices + flow cards produced by SLICE
    slices: list[Any] = field(default_factory=list)         # list[DataFlowSlice]
    flow_cards: list[Any] = field(default_factory=list)     # list[FlowCard]
    verified_findings: list[dict] = field(default_factory=list)
    phase_outputs: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    current_phase: str = "INTAKE"
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = ""

    # ── Output directory structure ──

    @property
    def assets_dir(self) -> Path:
        return Path(self.output_dir) / "assets"
    @property
    def js_dir(self) -> Path:
        return self.assets_dir / "js"
    @property
    def html_dir(self) -> Path:
        return self.assets_dir / "html"
    @property
    def sast_dir(self) -> Path:
        return Path(self.output_dir) / "sast"
    @property
    def findings_dir(self) -> Path:
        return Path(self.output_dir) / "findings"
    @property
    def evidence_dir(self) -> Path:
        return Path(self.output_dir) / "evidence"

    def ensure_dirs(self):
        for d in [self.assets_dir, self.js_dir, self.html_dir,
                   self.sast_dir, self.findings_dir, self.evidence_dir]:
            d.mkdir(parents=True, exist_ok=True)

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "target_url": self.target_url,
            "output_dir": self.output_dir,
            "analyzers": self.analyzers,
            "module_card_count": len(self.module_cards),
            "page_card_count": len(self.page_cards),
            "flow_card_count": len(self.flow_cards),
            # Defensive: cards may be raw dicts after restore_state() (which
            # loads them straight from session.json without reconstructing
            # objects), so a restore->save round-trip must not crash. Mirrors
            # the raw_findings handling below.
            "module_cards": [mc.to_dict() if hasattr(mc, "to_dict") else mc for mc in self.module_cards],
            "page_cards": [pc.to_dict() if hasattr(pc, "to_dict") else pc for pc in self.page_cards],
            "flow_cards": [fc.to_dict() if hasattr(fc, "to_dict") else fc for fc in self.flow_cards],
            "raw_finding_count": len(self.raw_findings),
            "merged_finding_count": len(self.merged_findings),
            "verified_finding_count": len(self.verified_findings),
            "sast_findings": self.sast_findings,
            "sast_validated": self.sast_validated,
            "raw_findings": [f.to_dict() if hasattr(f, "to_dict") else f for f in self.raw_findings],
            "merged_findings": [f.to_dict() if hasattr(f, "to_dict") else f for f in self.merged_findings],
            "verified_findings": self.verified_findings,
            "metadata": self.metadata,
            "errors": self.errors,
            "current_phase": self.current_phase,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


# ---------------------------------------------------------------------------
# Acquire handler
# ---------------------------------------------------------------------------

def acquire_handler(state: JSAState) -> JSAState:
    """
    ACQUIRE: download the target's homepage + referenced JS (curl), extract
    inline and external scripts into ``state.js_dir``, and build the FileMap
    manifest + AST index the STRUCTURE phase consumes.

    Deterministic; shells out to curl. Every step degrades gracefully — a failed
    fetch is recorded on ``state.errors`` and the pipeline continues.
    """
    from scanners import run_acquire

    run_acquire(state)
    state.updated_at = datetime.now(timezone.utc).isoformat()
    return state


# ---------------------------------------------------------------------------
# CVE_RESEARCH handler
# ---------------------------------------------------------------------------

def cve_research_handler(state: JSAState) -> JSAState:
    """
    Detect tech stack from acquired JS files using fingerprint matching.

    Primary: Wappalyzer fingerprint database (3,911 technologies)
    for filename-based detection with version extraction.
    Fallback: content-based regex for in-file version comments
    (e.g., /*! jQuery v3.7.1 */) that Wappalyzer doesn't cover.

    Detection is offline (local file I/O only) — no web search.
    Results stored in state.metadata["cve_research"] for downstream use.
    """
    import re

    # ── Primary: Wappalyzer fingerprint engine ──
    tech_stack: dict[str, list[str]] = {}
    versions: dict[str, str] = {}
    detection_details: list[dict] = []
    files_matched_by_scriptsrc: set[str] = set()

    try:
        from fingerprint_loader import load_fingerprints
        from fingerprint_engine import FingerprintEngine

        db = load_fingerprints()
        engine = FingerprintEngine(db)
        engine_loaded = True
    except Exception:
        engine_loaded = False

    js_dir = state.js_dir
    if js_dir.exists() and engine_loaded:
        for js_file in js_dir.glob("*.js"):
            fn = js_file.name.lower()
            if "_inline_" in fn:
                continue

            # Read content for content-based matching
            try:
                head = js_file.read_text(errors="replace")[:65536]
            except Exception:
                head = ""

            # Run fingerprint engine
            detections = engine.detect(js_file.name, head)

            for det in detections:
                name = det.name
                tech_stack.setdefault(name, []).append(js_file.name)
                if det.version and name not in versions:
                    versions[name] = det.version
                detection_details.append({
                    "technology": name,
                    "file": js_file.name,
                    "vector": det.vector,
                    "confidence": det.confidence,
                    "version": det.version,
                    "evidence": det.evidence,
                })

            if detections:
                files_matched_by_scriptsrc.add(js_file.name)

    # ── Source Map Parsing ──
    # Extract versions from //# sourceMappingURL= comments (inline base64
    # and external .map files) in files Wappalyzer scriptSrc didn't match.
    # Source map versions override Wappalyzer (authoritative ground truth).
    source_map_count = _extract_source_map_versions(
        js_dir, versions, tech_stack, files_matched_by_scriptsrc
    )

    # ── Asset Classification (Priority 5) ──
    # Classify each JS file by type: single component, multi-component bundle,
    # first-party code, inline script, CDN bundle, or unknown. This drives
    # correlation strength in CORRELATE_EVIDENCE — single components get full correlation,
    # bundles without source maps get downgraded correlation.
    file_classifications: dict[str, str] = {}
    if js_dir.exists():
        try:
            from asset_classify import classify_file, ClassificationResult
            # Group detection_details by file for the classifier
            details_by_file: dict[str, list[dict]] = {}
            for det in detection_details:
                det_file = det.get("file", "")
                if det_file:
                    details_by_file.setdefault(det_file, []).append(det)

            for js_file in js_dir.glob("*.js"):
                fn = js_file.name
                if "_inline_" in fn:
                    # Already classified as inline
                    file_classifications[fn] = "inline"
                    continue

                # Read content head for banner detection
                try:
                    head = js_file.read_text(errors="replace")[:65536]
                except Exception:
                    head = ""

                result = classify_file(
                    filename=fn,
                    content_head=head,
                    source_map_sources=None,  # Could be enhanced later
                    detection_details=details_by_file.get(fn, []),
                )
                file_classifications[fn] = result.classification
        except Exception as e:
            print(f"[cve_research_handler] Asset classification failed: {e}", flush=True)

    # ── Fallback: content-based version extraction ──
    # Wappalyzer doesn't scan file content for version comments like
    # /*! jQuery v3.7.1 */. These content patterns supplement the
    # filename-based Wappalyzer detection with more version coverage.
    #
    # Bug fix: previous patterns only covered banner-comment formats
    # (`React vX.Y.Z`). Real-world dev/standalone builds use other formats:
    #   - React 18 dev build:    `var ReactVersion = '18.2.0';`
    #   - Angular 1.7.x:         `AngularJS v1.7.7` (banner-style OK)
    #   - Vue 2/3:               `Vue.version = '2.6.14'`
    #   - jQuery 3.x:            `* jQuery JavaScript Library v3.7.1`
    # The list below covers all the variants we've seen in the wild.
    CONTENT_VERSION_PATTERNS: list[tuple[str, str]] = [
        # jQuery — multiple banner variants
        ("jQuery", r"/\*!?\s*jQuery(?: JavaScript Library)? v?(\d+\.\d+\.\d+(?:\.\d+)?)"),
        ("jQuery", r"jQuery(?: JavaScript Library)? v?(\d+\.\d+\.\d+(?:\.\d+)?)\s*(?:\(compatible\)|jQuery)"),
        # React — multiple version-storage patterns
        ("React", r"ReactVersion\s*=\s*['\"](\d+\.\d+\.\d+(?:\.\d+)?)['\"]"),
        ("React", r"@license\s+React\s+v(\d+\.\d+\.\d+(?:\.\d+)?)"),
        ("React", r"/\*!?\s*React\s+v(\d+\.\d+\.\d+(?:\.\d+)?)"),
        ("React", r"react@(\d+\.\d+\.\d+(?:\.\d+)?)"),
        # AngularJS 1.x (legacy) — banner style
        ("AngularJS", r"AngularJS\s+v(\d+\.\d+\.\d+(?:\.\d+)?)"),
        # Angular 2+ — package banner
        ("Angular", r"@angular/[a-z]+@(\d+\.\d+\.\d+(?:\.\d+)?)"),
        # Vue 2/3 — `Vue.version` and banner
        ("Vue.js", r"Vue\.version\s*=\s*['\"](\d+\.\d+\.\d+(?:\.\d+)?)['\"]"),
        ("Vue.js", r"Vue\.js\s+v?(\d+\.\d+\.\d+(?:\.\d+)?)"),
        # Lodash
        ("Lodash", r"lodash[ -]?v?(\d+\.\d+\.\d+(?:\.\d+)?)"),
        # Bootstrap
        ("Bootstrap", r"Bootstrap\s+v?(\d+\.\d+\.\d+(?:\.\d+)?)"),
        # Moment.js
        ("Moment.js", r"moment(?:\.js)?\s+(\d+\.\d+\.\d+(?:\.\d+)?)"),
        # D3
        ("D3", r"\bd3[ -]?v?(\d+\.\d+\.\d+(?:\.\d+)?)\b"),
        # Generic "@version" / "version:" for unknown libs (lowest priority)
        ("Generic", r"@version\s+(\d+\.\d+\.\d+(?:\.\d+)?)"),
    ]

    if js_dir.exists():
        for js_file in js_dir.glob("*.js"):
            fn = js_file.name.lower()
            if "_inline_" in fn:
                continue
            try:
                # Read MORE than 64KB for libraries that put version info deep
                # in the file (e.g. React's ReactVersion is in the first 1KB,
                # but Angular's UMD wrapper may have the version at the end).
                head = js_file.read_text(errors="replace")[:262144]
            except Exception:
                continue

            for lib_name, ver_pattern in CONTENT_VERSION_PATTERNS:
                # Skip the generic fallback unless no specific lib matched
                if lib_name == "Generic":
                    continue
                m = re.search(ver_pattern, head)
                if m:
                    ver = m.group(1)
                    # Map "AngularJS" content match back to "AngularJS" tech name
                    # (Wappalyzer reports AngularJS for v1.x and Angular for 2+)
                    if lib_name == "AngularJS" and "AngularJS" in tech_stack:
                        target_name = "AngularJS"
                    elif lib_name == "AngularJS":
                        target_name = "AngularJS"  # create new entry
                    else:
                        target_name = lib_name
                    # Only fill in version if Wappalyzer didn't already detect one
                    if target_name not in versions:
                        versions[target_name] = ver
                    # Ensure tech is in stack even if filename didn't match
                    if target_name not in tech_stack:
                        tech_stack[target_name] = [js_file.name]
                    break  # First specific match wins per file per library

    # ── CVE Lookup via OSV.dev + Vulnerability-Lookup ──
    # For each detected library+version, query CVE databases and store results.
    # OSV.dev is primary for npm packages (semver-aware matching).
    # Vulnerability-Lookup is fallback (CIRCL's successor to cve-search.org).
    cves: list[dict] = []
    cve_error: str | None = None
    if tech_stack and versions:
        try:
            import sys as _sys
            _scripts_dir = str(Path(__file__).parent)
            if _scripts_dir not in _sys.path:
                _sys.path.insert(0, _scripts_dir)
            from cve_lookup import lookup_cves
            from npm_name_map import wappalyzer_to_npm

            lib_with_versions = {
                lib: ver for lib, ver in versions.items()
                if ver and lib in tech_stack
            }
            cves = lookup_cves(lib_with_versions, wappalyzer_to_npm)
        except Exception as e:
            cves = []
            cve_error = str(e)
            print(f"[cve_research_handler] CVE lookup failed: {e}", file=_sys.stderr)

    # ── Assign initial VEX status to each CVE ──
    # Status: "affected" (component version in CVE range),
    #         "not_affected" (outside range)
    # Reachability/exploitability will be set later by CORRELATE_EVIDENCE.
    if cves:
        try:
            assign_initial_vex_status(cves, versions, detection_details)
        except Exception as e:
            print(f"[cve_research_handler] VEX status assignment failed: {e}", file=_sys.stderr)

    # ── CVE Signature Extraction (Priority 6) ──
    # Extract vulnerable_symbols, required_conditions, and non_vulnerable_patterns
    # for each CVE. This enables correlate_evidence.py to score SAST↔CVE edges
    # meaningfully instead of always scoring 0.0.
    if cves:
        try:
            from cve_signatures import enrich_cves_with_signatures
            enrich_cves_with_signatures(cves)
        except Exception as e:
            print(f"[cve_research_handler] CVE signature extraction failed: {e}", file=_sys.stderr)
            # Ensure every CVE has the required fields even on failure
            for cve in cves:
                cve.setdefault("vulnerable_symbols", [])
                cve.setdefault("required_conditions", [])
                cve.setdefault("non_vulnerable_patterns", [])
                cve.setdefault("exploitability_notes", "")
                cve.setdefault("signature_confidence", "possible")
                cve.setdefault("signature_sources", ["extraction_failed"])

    # ── PoC Research Dispatch ──
    # Dispatch echo agents (one per CVE) to search for PoCs, exploit code,
    # and writeups. Results written to MemPalace for later COLLECT phase.
    # This is part of CVE_RESEARCH so SAST_SCAN can run in parallel.
    poc_plan: list[dict] = []
    if cves:
        for cve in cves:
            cve_id = cve.get("cve_id", "unknown")
            lib = cve.get("library", "unknown")
            ver = cve.get("version", "?")
            summary = cve.get("summary", "")
            poc_plan.append({
                "cve_id": cve_id,
                "library": lib,
                "version": ver,
                "summary": summary,
                "cvss_score": cve.get("cvss_score"),
                "agent": "echo",
                "task": (
                    f"Research PoC for {cve_id} ({lib} v{ver}). "
                    f"Search for public exploit code, GitHub PoCs, writeups. "
                    f"If no PoC found, research the vulnerability mechanics "
                    f"and describe how to test for it in a web application. "
                    f"Summary: {summary[:200]}"
                ),
                "output_room": f"{state.session_id}-cve-validate-{cve_id.replace('/', '_')}",
            })

    state.metadata["cve_validate"] = {
        "status": "dispatched",
        "agent": "echo",
        "total": len(poc_plan),
        "plan": poc_plan,
        "results": [],
        "output_rooms": [p["output_room"] for p in poc_plan],
    }

    # ── Write CVE artifacts to disk ──
    cve_artifacts_dir: str | None = None
    cve_index_path: str | None = None
    cve_report_path: str | None = None
    if cves:
        try:
            cve_artifacts_dir, cve_index_path, cve_report_path = _write_cve_artifacts(
                state.output_dir, cves
            )
        except Exception as e:
            print(f"[cve_research_handler] Failed to write CVE artifacts: {e}", file=_sys.stderr)
    else:
        # ── Bug fix: even with zero CVEs, write a tech-stack report ──
        # Downstream phases (CORRELATE_EVIDENCE, AGENT_REVIEW) need to know
        # what was checked and what versions were considered. Without this
        # artifact, an empty CVE result is indistinguishable from "scan
        # failed silently".
        cve_artifacts_dir, cve_index_path, cve_report_path = _write_empty_cve_report(
            state.output_dir, tech_stack, versions, component_purls_placeholder=None,
        )

    # ── Build canonical purl identifiers for components ──
    # purl is the industry-standard package identifier used by OSV, CycloneDX,
    # Dependency-Track. Provides consistent IDs across Wappalyzer names, npm
    # names, filenames, and source-map names.
    component_purls: dict[str, str] = {}
    if versions:
        try:
            component_purls = build_component_purls(versions, detection_details)
        except Exception as e:
            print(f"[cve_research_handler] purl generation failed: {e}", file=_sys.stderr)

    # ── Store results ──
    technologies_detected = len(tech_stack)
    method = "fingerprint_wappalyzer" if engine_loaded else "legacy_regex"

    state.metadata["cve_research"] = {
        "tech_stack_hints": tech_stack,
        "versions": versions,
        "cve_count": len(cves),
        "cves": cves,
        "cve_error": cve_error,
        "method": method,
        "db_version": "6.11.0" if engine_loaded else "N/A",
        "technologies_detected": technologies_detected,
        "detection_details": detection_details,
        "fallback_content_patterns": len(CONTENT_VERSION_PATTERNS),
        "source_map_libraries": source_map_count,
        "file_classifications": file_classifications,
        "cve_artifacts_dir": cve_artifacts_dir,
        "cve_index_path": cve_index_path,
        "cve_report_path": cve_report_path,
        "component_purls": component_purls,
    }
    state.updated_at = datetime.now(timezone.utc).isoformat()
    return state


# ── Source Map Version Extraction ──

def _read_tail(path: Path, tail_bytes: int = 4096) -> str:
    """Read the last N bytes of a file without loading entire file into memory."""
    with open(path, 'rb') as f:
        f.seek(0, 2)  # seek to end
        fsize = f.tell()
        if fsize <= tail_bytes:
            f.seek(0)
        else:
            f.seek(max(0, fsize - tail_bytes))
        return f.read().decode('utf-8', errors='replace')


# Normalize npm package names → Wappalyzer canonical names to prevent
# duplicate entries (e.g., "jquery" + "jQuery" in same versions dict).
# Source maps use npm names; Wappalyzer uses canonical names.
_NPM_TO_WAPPALYZER: dict[str, str] = {
    "jquery": "jQuery",
    "react": "React",
    "vue": "Vue.js",
    "vue.js": "Vue.js",
    "angular": "Angular",
    "lodash": "Lodash",
    "moment": "Moment.js",
    "moment.js": "Moment.js",
    "bootstrap": "Bootstrap",
    "d3": "D3",
}


def _extract_source_map_versions(
    js_dir: Path,
    versions: dict[str, str],
    tech_stack: dict[str, list[str]],
    files_matched_by_scriptsrc: set[str],
) -> int:
    """
    Parse source maps from .js files that Wappalyzer scriptSrc didn't match.

    Scans last ~4KB of each .js file for //# sourceMappingURL= comment.
    Handles inline (base64-encoded JSON) and external (.map in js_dir).
    Extracts library versions from sources[] referencing node_modules/<pkg>/package.json.
    Source map versions OVERRIDE existing Wappalyzer versions (authoritative).
    Mutates versions and tech_stack in-place.
    Returns count of libraries added or updated via source maps.
    """
    import base64
    import json
    import re

    MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB — skip entirely
    MAX_SOURCE_ENTRIES = 1000
    TAIL_BYTES = 4096  # sourceMappingURL is always in last 1-2KB

    if not js_dir.exists():
        return 0

    source_map_count = 0

    for js_file in js_dir.glob("*.js"):
        fn = js_file.name.lower()
        if "_inline_" in fn:
            continue

        # ── Guardrail: skip files already matched by Wappalyzer ──
        if js_file.name in files_matched_by_scriptsrc:
            continue

        # ── Guardrail: skip large files ──
        try:
            fsize = js_file.stat().st_size
        except OSError:
            continue
        if fsize > MAX_FILE_SIZE:
            continue

        # ── Guardrail: tail-read only ──
        try:
            tail_text = _read_tail(js_file, TAIL_BYTES)
        except Exception:
            continue

        # Find sourceMappingURL in tail text
        m = re.search(
            r"//#\s*sourceMappingURL=(.+)$",
            tail_text,
            re.MULTILINE,
        )
        if not m:
            continue

        map_url = m.group(1).strip()

        # ── Parse source map JSON ──
        source_map: dict | None = None
        if map_url.startswith("data:application/json;base64,"):
            # Inline base64-encoded
            b64_data = map_url[len("data:application/json;base64,"):]
            try:
                decoded = base64.b64decode(b64_data).decode("utf-8")
                source_map = json.loads(decoded)
            except Exception:
                continue
        else:
            # External .map file — resolve relative to js_file location
            map_path = js_file.parent / map_url
            if not map_path.exists():
                continue
            try:
                source_map = json.loads(map_path.read_text(errors="replace"))
            except Exception:
                continue

        if source_map is None:
            continue

        # ── Guardrail: skip massive source maps ──
        sources = source_map.get("sources", [])
        if len(sources) > MAX_SOURCE_ENTRIES:
            continue

        sources_content = source_map.get("sourcesContent", [])

        for i, src_path in enumerate(sources):
            # Match node_modules/<package>/package.json or
            # node_modules/@scope/package/package.json
            m_pkg = re.match(
                r"(?:.*/)?node_modules/((@[^/]+/[^/]+)|([^/]+))/package\.json",
                src_path,
            )
            if not m_pkg:
                continue
            pkg_name = m_pkg.group(1)  # e.g., "lodash" or "@babel/runtime"
            # Strip @version suffix if present (path fallback scenario)
            pkg_name = re.sub(r"@\d+\.\d+\.\d+$", "", pkg_name)

            version: str | None = None

            # Try sourcesContent first (authoritative)
            if i < len(sources_content) and sources_content[i]:
                try:
                    if isinstance(sources_content[i], str):
                        pkg_data = json.loads(sources_content[i])
                        version = pkg_data.get("version")
                except (json.JSONDecodeError, TypeError):
                    pass

            # Fallback: extract version from path (e.g., lodash@4.17.21)
            if version is None:
                m_ver = re.search(r"@(\d+\.\d+\.\d+)", src_path)
                if m_ver:
                    version = m_ver.group(1)

            if version is None:
                continue

            # ── Normalize package name ──
            canonical_name = _NPM_TO_WAPPALYZER.get(
                pkg_name.lower(), pkg_name
            )

            # Source maps are authoritative — always set/overwrite
            versions[canonical_name] = version
            tech_stack.setdefault(canonical_name, []).append(js_file.name)
            source_map_count += 1

    return source_map_count


# ---------------------------------------------------------------------------
# SAST_SCAN handler
# ---------------------------------------------------------------------------

def sast_scan_handler(state: JSAState, js_files: list[tuple[str, str]] | None = None) -> JSAState:
    """
    SAST_SCAN: fast deterministic pre-scan over the acquired JS/HTML.

    Runs semgrep (bundled jsa rules + curated CE registry rulesets) and jsluice
    (secrets + urls), populating ``state.sast_findings`` for the NORMALIZE →
    DEDUP_WITHIN_SOURCE → CORRELATE_EVIDENCE → SAST_VALIDATE correlation spine
    and giving the INVESTIGATE agents a deterministic baseline to build on.

    Shells out to the CLIs directly (the subprocess cannot call MCP tools); a
    missing binary or empty corpus degrades to zero findings, not a crash.
    """
    from scanners import run_sast_scan

    run_sast_scan(state)
    state.metadata.setdefault("sast_scan", {})["status"] = "complete"
    state.updated_at = datetime.now(timezone.utc).isoformat()
    return state


# ---------------------------------------------------------------------------
# NORMALIZE handler
# ---------------------------------------------------------------------------

def normalize_handler(state: JSAState) -> None:
    """
    Normalize components and vulnerabilities (first DEDUP sub-phase).

    Performs two operations:
    1. dedup_components() — normalize library findings using purl as canonical ID
    2. dedup_vulnerabilities() — CVE alias canonicalization

    State metadata keys added:
    - "dedup.components": list of normalized Component dicts
    - "dedup.vulnerabilities": list of normalized Vulnerability dicts
    """
    dedup_meta = state.metadata.setdefault("dedup", {})

    # Read inputs from CVE_RESEARCH and SAST_SCAN state metadata
    cve_research = state.metadata.get("cve_research", {})
    tech_stack = cve_research.get("tech_stack_hints", {})
    versions = cve_research.get("versions", {})
    purls = cve_research.get("component_purls", {})
    detection_details = cve_research.get("detection_details", [])
    raw_cves = cve_research.get("cves", [])

    # ── 1. Component normalization (uses purl) ──
    try:
        from dedup_components import dedup_components, components_to_dicts
        components = dedup_components(
            tech_stack_hints=tech_stack,
            versions=versions,
            component_purls=purls,
            detection_details=detection_details,
        )
        dedup_meta["components"] = components_to_dicts(components)
    except Exception as e:
        print(f"[normalize_handler] Component normalization failed: {e}", flush=True)
        dedup_meta["components"] = []

    # ── 2. Vulnerability alias canonicalization ──
    try:
        from dedup_vulnerabilities import dedup_vulnerabilities, vulnerabilities_to_dicts
        vulns = dedup_vulnerabilities(raw_cves)
        dedup_meta["vulnerabilities"] = vulnerabilities_to_dicts(vulns)
    except Exception as e:
        print(f"[normalize_handler] Vulnerability dedup failed: {e}", flush=True)
        dedup_meta["vulnerabilities"] = []

    state.updated_at = datetime.now(timezone.utc).isoformat()


# DEDUP_WITHIN_SOURCE handler
# ---------------------------------------------------------------------------

def dedup_within_source_handler(state: JSAState) -> None:
    """
    Deduplicate findings within each source (second DEDUP sub-phase).

    Uses scanner_dedup.merge_scanner_findings() to deduplicate SAST findings
    from semgrep and jsluice by SARIF fingerprints and similarity.

    State metadata keys added:
    - "dedup.merged_count": count of merged SAST findings
    """
    try:
        from scanner_dedup import merge_scanner_findings
        state.sast_findings = merge_scanner_findings(state.sast_findings)
    except Exception as e:
        print(f"[dedup_within_source_handler] SAST dedup failed: {e}", flush=True)

    dedup_meta = state.metadata.setdefault("dedup", {})
    dedup_meta["merged_count"] = len(state.sast_findings)
    state.updated_at = datetime.now(timezone.utc).isoformat()


# CORRELATE_EVIDENCE handler
# ---------------------------------------------------------------------------

def correlate_evidence_handler(state: JSAState) -> None:
    """
    Cross-stream correlation via typed edges (third DEDUP sub-phase).

    Links components, vulnerabilities, and SAST findings via explicit edges
    (not merge). Applies hard gates, positive/negative signals, and
    file classification boost/penalty.

    State metadata keys added:
    - "dedup.edges": list of CorrelationEdge dicts
    - "dedup.agent_candidates": list of edge IDs needing agent review
    """
    dedup_meta = state.metadata.setdefault("dedup", {})
    cve_research_meta = state.metadata.get("cve_research", {})
    components_normalized: list[dict] = dedup_meta.get("components", [])
    vulns_normalized: list[dict] = dedup_meta.get("vulnerabilities", [])
    file_classifications: dict[str, str] = cve_research_meta.get("file_classifications", {})

    edges: list[dict] = []
    try:
        from correlate_evidence import (
            correlate_component_vuln,
            correlate_sast_to_vuln,
            select_agent_candidates,
            edges_to_dicts,
            CorrelationEdge,
        )

        # Edge type 1: Component → Vulnerability
        for comp in components_normalized:
            comp_purl = comp.get("purl", "")
            for v in vulns_normalized:
                # Check if CVE applies to this component
                v_library = (v.get("library") or "").lower()
                comp_name = (comp.get("name") or "").lower()
                if v_library and v_library in comp_name:
                    # Mark affected packages for the vulnerability
                    if "affected_packages" not in v:
                        v["affected_packages"] = []
                    v["affected_packages"].append(comp_purl)

                    edge = correlate_component_vuln(
                        component=comp,
                        vulnerability=v,
                    )
                    edges.append(edge)

        # Edge type 2: SAST finding → Vulnerability
        # Bug fix: orchestrator stores the file path under "path" (with full
        # /tmp/... prefix) AND "filepath" alias, with "file" being the basename
        # only. correlate_evidence reads the basename to match against
        # component.files, so we need to use "file" — but fall back to the
        # basename of "path" if "file" is missing (defensive for older sessions
        # that ran before the normalize step).
        for finding in state.sast_findings:
            f_file = finding.get("file") or Path(finding.get("path", "")).name
            # Find which component this file belongs to
            for comp in components_normalized:
                comp_files = comp.get("files", [])
                # Match by basename — components can store either full paths
                # or basenames depending on how dedup_components built them
                comp_basenames = {Path(f).name for f in comp_files}
                if f_file in comp_files or f_file in comp_basenames:
                    # File is in this component — try to correlate to vulnerabilities
                    # Look up actual file classification from metadata (Priority 5)
                    f_class = file_classifications.get(f_file, "unknown")
                    has_sourcemap = f_class != "multi_component_bundle"  # best heuristic
                    for v in vulns_normalized:
                        edge = correlate_sast_to_vuln(
                            code_finding=finding,
                            vulnerability=v,
                            file_classification=f_class,
                            source_map_present=has_sourcemap,
                        )
                        edges.append(edge)
                    break

        # Select candidates for agent review
        edge_objects = [
            CorrelationEdge(
                edge_id=e.get("edge_id", ""),
                edge_type=e.get("edge_type", ""),
                from_id=e.get("from_id", ""),
                to_id=e.get("to_id", ""),
                confidence=e.get("confidence", "possible"),
                score=e.get("score", 0.0),
                evidence=e.get("evidence", []),
                hard_negative=e.get("hard_negative", False),
                reason=e.get("reason", ""),
            )
            for e in edges_to_dicts(edges)
        ]
        candidates = select_agent_candidates(edge_objects)
        # Keep only non-trivial edges in state metadata to avoid bloating
        # session.json (which is passed as a CLI argv to subsequent step()
        # calls — a 130KB state can hit Node.js spawn E2BIG). score > 0 edges
        # represent real signals; agent_candidates are always preserved since
        # they are the small set bound for agent review. If many hard
        # negatives are present, we keep a summary count instead of the full
        # edge list.
        signal_edges = [e for e in edge_objects if e.score > 0.0]
        hard_neg_count = sum(1 for e in edge_objects if e.hard_negative)
        if len(edge_objects) > 100 and len(signal_edges) < 50:
            # Heavily noise-dominated correlation: store only signal edges
            # plus a count of dropped hard negatives.
            dedup_meta["edges"] = [e.__dict__ for e in signal_edges]
            dedup_meta["dropped_hard_negative_count"] = hard_neg_count
        else:
            dedup_meta["edges"] = [e.__dict__ for e in edge_objects]
        dedup_meta["agent_candidates"] = [c.edge_id for c in candidates]
    except Exception as e:
        print(f"[correlate_evidence_handler] Correlation failed: {e}", flush=True)
        dedup_meta["edges"] = []
        dedup_meta["agent_candidates"] = []

    state.updated_at = datetime.now(timezone.utc).isoformat()


# DEDUP handler — backward-compatible wrapper around the three sub-phases
# ---------------------------------------------------------------------------


# AGENT_REVIEW handler — Priority 10: bounded evidence packets
# ---------------------------------------------------------------------------

def agent_reviewer_handler(state: JSAState) -> None:
    """
    Review ambiguous correlation edges using bounded evidence packets.

    Builds structured EvidencePacket objects for each candidate edge (from
    CORRELATE_EVIDENCE phase), then scores them with a local heuristic. This is
    a deterministic tool phase — no agent runs.

    State metadata keys added:
    - "agent_review.packets": list of EvidencePacket dicts
    - "agent_review.verdicts": list of verdict dicts
    - "agent_review.summary": counts by verdict type
    """
    agent_review_meta = state.metadata.setdefault("agent_review", {})
    dedup_meta = state.metadata.get("dedup", {})

    edges: list[dict] = dedup_meta.get("edges", [])
    candidate_ids: list[str] = dedup_meta.get("agent_candidates", [])
    components: list[dict] = dedup_meta.get("components", [])
    vulnerabilities: list[dict] = dedup_meta.get("vulnerabilities", [])

    # Build evidence packets for each candidate edge
    try:
        from correlate_evidence import build_evidence_packets, packets_to_dicts
        packets = build_evidence_packets(
            edges=edges,
            agent_candidate_ids=candidate_ids,
            components=components,
            vulnerabilities=vulnerabilities,
            sast_findings=state.sast_findings,
        )
        agent_review_meta["packets"] = packets_to_dicts(packets)
    except Exception as e:
        print(f"[agent_reviewer_handler] Evidence packet build failed: {e}", flush=True)
        agent_review_meta["packets"] = []

    # Produce verdicts (local heuristic for testing, agent-dispatched in production)
    verdicts = _local_agent_review(packets if "packets" in locals() else [])
    agent_review_meta["verdicts"] = verdicts
    agent_review_meta["total_candidates"] = len(candidate_ids)
    agent_review_meta["verdicts_exploitable"] = sum(1 for v in verdicts if v.get("verdict") == "exploitable")
    agent_review_meta["verdicts_not_exploitable"] = sum(1 for v in verdicts if v.get("verdict") == "not_exploitable")
    agent_review_meta["verdicts_needs_deeper"] = sum(1 for v in verdicts if v.get("verdict") == "needs_deeper")

    state.metadata["agent_review"] = agent_review_meta
    state.updated_at = datetime.now(timezone.utc).isoformat()


def _local_agent_review(packets) -> list[dict]:
    """
    Local heuristic review over the evidence packets: produces verdicts from
    deterministic signal combination. This is the operative behavior — the
    agent_review phase is a deterministic tool state, not an agent dispatch.
    """
    verdicts = []
    for pkt in (packets or []):
        # Support both EvidencePacket objects and dicts (for backward compat)
        if hasattr(pkt, "to_dict"):
            pkt_dict = pkt.to_dict()
        elif isinstance(pkt, dict):
            pkt_dict = pkt
        else:
            pkt_dict = {}

        edge_data = pkt_dict.get("edge", {})
        score = edge_data.get("score", 0.0) if isinstance(edge_data, dict) else getattr(edge_data, "score", 0.0)
        confidence = edge_data.get("confidence", "possible") if isinstance(edge_data, dict) else getattr(edge_data, "confidence", "possible")
        sast_findings = pkt_dict.get("sast_findings", [])
        sast_count = len(sast_findings)
        vuln = pkt_dict.get("vulnerability", {})
        has_vuln_context = bool(vuln.get("summary")) if isinstance(vuln, dict) else bool(getattr(vuln, "summary", None))
        comp = pkt_dict.get("component", {})
        has_component_context = bool(comp.get("purl")) if isinstance(comp, dict) else bool(getattr(comp, "purl", None))

        # Heuristic verdict logic
        verdict = "needs_deeper"  # default
        conf_override = confidence

        # High score + first-party SAST findings → exploitable
        if score >= 0.70 and sast_count >= 1:
            symbol_match = any(
                (s.get("symbols", []) if isinstance(s, dict) else getattr(s, "symbols", []))
                and len(s.get("symbols", []) if isinstance(s, dict) else getattr(s, "symbols", [])) > 0
                for s in sast_findings
            )
            if symbol_match:
                verdict = "exploitable"
                conf_override = "probable"

        # Very low score or unlikely confidence → not exploitable
        elif score < 0.40 or confidence == "unlikely":
            verdict = "not_exploitable"
            conf_override = "unlikely"

        # Missing context → needs deeper
        if not has_vuln_context or not has_component_context:
            verdict = "needs_deeper"
            conf_override = "possible"

        reasoning = (
            f"Score {score:.2f}, confidence {confidence}, "
            f"{sast_count} related SAST findings. "
            f"Verdict: {verdict}."
        )

        verdicts.append({
            "packet_id": pkt_dict.get("packet_id", ""),
            "verdict": verdict,
            "confidence_override": conf_override,
            "reasoning": reasoning,
            "recommended_action": _map_verdict_to_action(verdict),
        })

    return verdicts


def _map_verdict_to_action(verdict: str) -> str:
    """Map agent review verdict to recommended downstream action."""
    return {
        "exploitable": "report",
        "not_exploitable": "skip",
        "needs_deeper": "dispatch_to_specialist",
    }.get(verdict, "dispatch_to_specialist")


# ---------------------------------------------------------------------------
# CVE artifact writing
# ---------------------------------------------------------------------------

def _write_cve_artifacts(output_dir: str, cves: list[dict]) -> tuple[str, str, str]:
    """
    Write CVE artifacts to disk for human review and machine processing.

    Directory structure created under {output_dir}/cves/:
        cves.json              — All CVEs in one JSON file (machine-readable)
        cves.md                — Human-readable summary report
        CVE-XXXX-XXXXX/        — Per-CVE directory
            cve.json          — Single CVE in JSON
            description.md     — Human-readable CVE description

    Returns:
        (cves_dir_path, cves_json_path, cves_md_path)
    """
    cves_dir = Path(output_dir) / "cves"
    cves_dir.mkdir(parents=True, exist_ok=True)

    # ── Combined cves.json (machine-readable, downstream consumption) ──
    cves_json_path = cves_dir / "cves.json"
    cves_json_path.write_text(
        json.dumps(
            {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "cve_count": len(cves),
                "cves": cves,
            },
            indent=2,
        )
    )

    # ── Combined cves.md (human-readable summary) ──
    cves_md_path = cves_dir / "cves.md"
    md_lines = [
        f"# CVE Report",
        f"",
        f"**Generated:** {datetime.now(timezone.utc).isoformat()}",
        f"**Total CVEs:** {len(cves)}",
        f"",
        f"## Summary by Library",
        f"",
    ]
    by_lib: dict[str, list[dict]] = {}
    for cve in cves:
        lib = cve.get("library", "unknown")
        by_lib.setdefault(lib, []).append(cve)
    for lib in sorted(by_lib):
        md_lines.append(f"- **{lib}** (v{by_lib[lib][0].get('version', '?')}): {len(by_lib[lib])} CVE{'s' if len(by_lib[lib]) != 1 else ''}")

    md_lines.extend(["", "## CVEs", ""])
    for cve in cves:
        cve_id = cve.get("cve_id", "unknown")
        lib = cve.get("library", "unknown")
        ver = cve.get("version", "?")
        summary = cve.get("summary", "(no summary)")
        score = cve.get("cvss_score")
        source = cve.get("source", "?")
        date = cve.get("published_date", "?")
        md_lines.extend([
            f"### [{cve_id}](./{cve_id}/description.md) — {lib} v{ver}",
            f"",
            f"- **Published:** {date}",
            f"- **Source:** {source}",
        ])
        if score:
            md_lines.append(f"- **CVSS Score:** {score}")
        md_lines.extend([
            f"- **Summary:** {summary}",
            f"",
        ])
    cves_md_path.write_text("\n".join(md_lines))

    # ── Per-CVE directory with JSON + markdown ──
    for cve in cves:
        cve_id = cve.get("cve_id", "unknown")
        # Sanitize CVE ID for filesystem (shouldn't need it, but safe)
        safe_id = cve_id.replace("/", "_").replace("\\", "_")
        cve_dir = cves_dir / safe_id
        cve_dir.mkdir(parents=True, exist_ok=True)

        # Single-CVE JSON
        (cve_dir / "cve.json").write_text(json.dumps(cve, indent=2))

        # Human-readable description
        desc_lines = [
            f"# {cve_id}",
            f"",
            f"**Library:** {cve.get('library', 'unknown')} v{cve.get('version', '?')}",
            f"**Published:** {cve.get('published_date', '?')}",
            f"**Source:** {cve.get('source', '?')}",
        ]
        score = cve.get("cvss_score")
        if score:
            desc_lines.append(f"**CVSS Score:** {score}")
        desc_lines.extend([
            f"",
            f"## Summary",
            f"",
            cve.get("summary", "(no summary)"),
            f"",
            f"## Full Record",
            f"",
            f"```json",
            json.dumps(cve, indent=2),
            f"```",
        ])
        (cve_dir / "description.md").write_text("\n".join(desc_lines))

    return str(cves_dir), str(cves_json_path), str(cves_md_path)


# ---------------------------------------------------------------------------
# VEX (Vulnerability Exploitability eXchange) status assignment
# ---------------------------------------------------------------------------

# Valid VEX statuses (per CycloneDX VEX spec):
VEX_STATUSES = (
    "affected",              # Component version is in CVE affected range
    "not_affected",          # Version is outside affected range
    "loaded",                # Component is loaded on an in-scope page
    "loaded_not_reachable",  # Loaded but app doesn't call vulnerable function
    "potentially_reachable", # App calls vulnerable function, source unknown
    "exploitable",           # Confirmed via dynamic probe or clear static evidence
    "not_exploitable",       # Sanitizer or input control confirmed
    "under_investigation",   # Agent review needed
    "fixed",                 # Patched version deployed
)

# VEX status action statements (per CycloneDX spec):
# not_affected → "does not affect"
# affected, loaded, loaded_not_reachable, etc. → "affects"


def assign_initial_vex_status(
    cves: list[dict],
    versions: dict[str, str],
    detection_details: list[dict] | None = None,
) -> None:
    """Assign initial VEX status to each CVE based on component detection.

    Called after CVE_RESEARCH lookup, before CORRELATE_EVIDENCE.
    Sets each CVE's:
    - vex_status: "affected" (we know the version is in range — OSV.dev confirms)
    - component_confidence: certain/probable/possible based on detection source
    - reachability: "unknown" (no SAST correlation yet)
    - exploitability: "unknown" (no dynamic probe yet)

    Mutates each CVE dict in place.
    """
    detection_details = detection_details or []

    # Build a confidence map from detection_details
    confidence_by_lib: dict[str, str] = {}
    for det in detection_details:
        lib = det.get("technology", "")
        if not lib:
            continue
        # Wappalyzer + source map + content match = certain
        # Single Wappalyzer match = probable
        # Heuristic = possible
        if det.get("vector") in ("scriptSrc", "sourceMap") and det.get("version"):
            confidence_by_lib[lib] = "certain"
        elif det.get("vector") == "content":
            confidence_by_lib[lib] = "probable"
        else:
            confidence_by_lib.setdefault(lib, "possible")

    for cve in cves:
        lib = cve.get("library", "")
        version = cve.get("version", "")

        # If we have a detected version that matches the CVE's version, it's affected
        if version and version in versions.values():
            cve["vex_status"] = "affected"
        else:
            cve["vex_status"] = "not_affected"

        # Component confidence
        cve["component_confidence"] = confidence_by_lib.get(lib, "possible")

        # Reachability and exploitability are unknown at this stage
        cve["reachability"] = "unknown"
        cve["exploitability"] = "unknown"

        # Action statement (per CycloneDX VEX spec)
        cve["vex_action"] = "affects" if cve["vex_status"] != "not_affected" else "does not affect"


def build_component_purls(
    versions: dict[str, str],
    detection_details: list[dict],
) -> dict[str, str]:
    """
    Build canonical Package URL (purl) identifiers for each detected component.

    Args:
        versions: dict of Wappalyzer canonical name → version string.
        detection_details: list of detection detail dicts (used to extract
            evidence like source URL for ecosystem detection).

    Returns:
        dict mapping Wappalyzer canonical name → purl string.
        Example: {"jQuery": "pkg:npm/jquery@1.9.0", "Lodash": "pkg:npm/lodash@4.17.20"}

    purl is the industry-standard package identifier used by OSV, CycloneDX,
    Dependency-Track, and others. It provides consistent identification
    across Wappalyzer names, npm names, filenames, and source-map names.
    """
    try:
        from purl import make_purl, build_purl_from_detection
        from npm_name_map import wappalyzer_to_npm
    except ImportError:
        return {}

    # Build evidence lookup: lib_name → list of (url, filename) for ecosystem detection
    evidence_by_lib: dict[str, list[dict]] = {}
    for det in detection_details:
        lib = det.get("technology", "")
        if not lib:
            continue
        evidence_by_lib.setdefault(lib, []).append({
            "file": det.get("file", ""),
            "evidence": det.get("evidence", ""),
        })

    purls: dict[str, str] = {}
    for lib_name, version in versions.items():
        # Get npm name from the mapping (preferred over Wappalyzer name)
        npm_info = wappalyzer_to_npm(lib_name)
        npm_name = npm_info["npm"] if npm_info else None

        # Look for URL hints in evidence (URLs often have CDN info)
        evidence = evidence_by_lib.get(lib_name, [{}])[0] if evidence_by_lib.get(lib_name) else {}
        # If evidence contains a URL, use it for ecosystem detection
        evidence_str = evidence.get("evidence", "") or ""
        url = ""
        # Check if evidence string contains a URL
        if "://" in evidence_str:
            # Extract first URL from evidence
            import re
            url_match = re.search(r"https?://[^\s\)]+", evidence_str)
            if url_match:
                url = url_match.group(0)

        purl = build_purl_from_detection(
            lib_name,
            version,
            url=url,
            filename=evidence.get("file", ""),
            npm_name=npm_name,
        )
        purls[lib_name] = purl

    return purls


def _write_empty_cve_report(
    output_dir: str,
    tech_stack: dict[str, list[str]],
    versions: dict[str, str],
    component_purls_placeholder: dict[str, str] | None = None,
) -> tuple[str, str, str]:
    """Write a 'no CVEs found' report so downstream phases can see what was checked.

    Bug fix: previously when 0 CVEs were found, nothing was written. The
    CORRELATE_EVIDENCE and AGENT_REVIEW phases couldn't distinguish between
    "no CVEs because nothing was scanned" and "no CVEs because everything is
    up to date". This report fixes that by recording:
      - Which technologies were detected
      - Which versions were extracted
      - That CVE databases were queried (and returned 0 hits)

    Returns (cves_dir_path, components_json_path, report_md_path) — same
    shape as _write_cve_artifacts so downstream code can use either.
    """
    cves_dir = Path(output_dir) / "cves"
    cves_dir.mkdir(parents=True, exist_ok=True)

    # ── components.json — same shape as cves.json but empty cves list ──
    components_json = cves_dir / "cves.json"
    components_json.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "cve_count": 0,
        "cves": [],
        "technologies_detected": len(tech_stack),
        "tech_stack": tech_stack,
        "versions": versions,
        "note": "No CVEs found in OSV.dev or Vulnerability-Lookup for the detected tech stack.",
    }, indent=2))

    # ── Human-readable report ──
    report_md = cves_dir / "cves.md"
    md = [
        f"# CVE Research Report",
        f"",
        f"**Generated:** {datetime.now(timezone.utc).isoformat()}",
        f"**Technologies detected:** {len(tech_stack)}",
        f"**Versions extracted:** {len(versions)}",
        f"**CVEs found:** 0",
        f"",
        f"## Detected Technology Stack",
        f"",
    ]
    for tech, files in sorted(tech_stack.items()):
        ver = versions.get(tech, "unknown")
        md.append(f"- **{tech}** v{ver}")
        for f in files:
            md.append(f"  - `{f}`")
    if not tech_stack:
        md.append("_(no technologies detected)_")
    md.append("")
    md.append("## Result")
    md.append("")
    md.append("No CVEs were found in OSV.dev or Vulnerability-Lookup for the detected tech stack.")
    md.append("This could mean:")
    md.append("- All detected versions are patched")
    md.append("- The libraries are not in the CVE databases")
    md.append("- Versions could not be extracted (see Detection details below)")
    md.append("")
    md.append("## Notes")
    md.append("")
    md.append("Even with 0 CVEs, CORRELATE_EVIDENCE still ran to correlate SAST findings")
    md.append("against the detected tech stack. See `dedup.edges` in session.json for results.")
    md.append("")
    report_md.write_text("\n".join(md))

    return (str(cves_dir), str(components_json), str(report_md))


def _write_cve_validation_to_artifacts(
    output_dir: str, validation_results: list[dict]
) -> None:
    """
    Append CVE validation results (PoCs, test approaches) to existing CVE artifact files.

    Called after CVE_VALIDATE agents return results. Appends to:
      - per-CVE description.md: adds "## PoC & Validation" section
      - per-CVE cve.json: adds validation key
      - cves.md: updates validation status column

    Idempotent — safe to call multiple times as results trickle in.
    """
    cves_dir = Path(output_dir) / "cves"
    if not cves_dir.exists():
        return

    for result in validation_results:
        cve_id = result.get("cve_id", "")
        if not cve_id:
            continue
        safe_id = cve_id.replace("/", "_").replace("\\", "_")
        cve_dir = cves_dir / safe_id
        if not cve_dir.exists():
            continue

        poc_found = result.get("poc_found", False)
        poc_urls = result.get("poc_urls", [])
        poc_code = result.get("poc_code", "")
        mechanics = result.get("mechanics", "")
        test_approach = result.get("test_approach", "")
        confidence = result.get("confidence", "UNCERTAIN")

        # ── Update per-CVE cve.json ──
        cve_json_path = cve_dir / "cve.json"
        if cve_json_path.exists():
            try:
                cve_data = json.loads(cve_json_path.read_text())
            except Exception:
                continue
            cve_data["validation"] = {
                "poc_found": poc_found,
                "poc_urls": poc_urls,
                "poc_code": poc_code[:5000],  # Truncate large code blocks
                "mechanics": mechanics[:3000],
                "test_approach": test_approach,
                "confidence": confidence,
            }
            cve_json_path.write_text(json.dumps(cve_data, indent=2))

        # ── Append to per-CVE description.md ──
        desc_path = cve_dir / "description.md"
        if desc_path.exists():
            existing = desc_path.read_text()
            # Remove any previous validation section to keep idempotent
            if "\n## PoC & Validation\n" in existing:
                existing = existing.split("\n## PoC & Validation\n")[0]

            validation_section = [
                "",
                "## PoC & Validation",
                "",
                f"**PoC Found:** {'Yes' if poc_found else 'No'}",
                f"**Confidence:** {confidence}",
            ]
            if poc_urls:
                validation_section.append("")
                validation_section.append("### PoC URLs")
                for url in poc_urls:
                    validation_section.append(f"- {url}")
            if poc_code:
                validation_section.append("")
                validation_section.append("### PoC Code")
                validation_section.append("```javascript")
                validation_section.append(poc_code[:5000])
                validation_section.append("```")
            if mechanics:
                validation_section.append("")
                validation_section.append("### Vulnerability Mechanics")
                validation_section.append(mechanics[:3000])
            if test_approach:
                validation_section.append("")
                validation_section.append("### Test Approach")
                validation_section.append(test_approach)

            desc_path.write_text(existing + "\n".join(validation_section))

    # ── Update cves.md with validation status ──
    cves_md_path = cves_dir / "cves.md"
    if cves_md_path.exists():
        md_content = cves_md_path.read_text()
        # Add validation status after each CVE summary line
        for result in validation_results:
            cve_id = result.get("cve_id", "")
            if not cve_id:
                continue
            poc_found = result.get("poc_found", False)
            status = "✅ PoC found" if poc_found else "🔍 No PoC — manual testing needed"
            # Replace the summary line with one that includes validation status
            old_line = f"**Summary:** {result.get('summary', '')}"
            if old_line in md_content:
                new_line = f"{old_line}\n- **Validation:** {status}"
                md_content = md_content.replace(old_line, new_line)
        cves_md_path.write_text(md_content)


# ---------------------------------------------------------------------------
# SAST_VALIDATE handler
# ---------------------------------------------------------------------------

def sast_validate_handler(state: JSAState) -> JSAState:
    """
    Validate SAST findings: classify as confirmed, false_positive, or needs_deeper.

    Runs as a local deterministic heuristic informed by the correlation
    evidence — no agent runs. Validated findings are stored in sast_validated
    and made available to the INVESTIGATE agents so they know what to skip.
    """
    state.metadata["sast_validate"] = {
        "status": "local_heuristic",
        "input_room": f"{state.session_id}-sast-findings",
        "output_room": f"{state.session_id}-sast-validated",
    }

    # Always initialize counts to 0
    state.metadata["sast_validate"]["total"] = 0
    state.metadata["sast_validate"]["confirmed"] = 0
    state.metadata["sast_validate"]["false_positive"] = 0
    state.metadata["sast_validate"]["needs_deeper"] = 0

    # If SAST findings already exist, classify them
    if state.sast_findings:
        validated = []
        for f in state.sast_findings:
            # Quick heuristic validation (production uses annie agent)
            classification = _quick_validate_sast(f)
            validated.append({**f, "validation": classification})
        state.sast_validated = validated
        state.metadata["sast_validate"]["total"] = len(validated)
        state.metadata["sast_validate"]["confirmed"] = sum(1 for v in validated if v["validation"] == "confirmed")
        state.metadata["sast_validate"]["false_positive"] = sum(1 for v in validated if v["validation"] == "false_positive")
        state.metadata["sast_validate"]["needs_deeper"] = sum(1 for v in validated if v["validation"] == "needs_deeper")

    state.updated_at = datetime.now(timezone.utc).isoformat()
    return state


def _quick_validate_sast(finding: dict) -> str:
    """Quick heuristic validation of a SAST finding."""
    # In production, annie agent does this with full code context.
    # This heuristic provides reasonable defaults for testing.
    sev = finding.get("severity", "").upper()
    msg = finding.get("message", "").lower()

    # Hardcoded secrets are usually real
    if "secret" in msg or "api key" in msg or "credential" in msg:
        return "confirmed"

    # XSS patterns need deeper analysis
    if "xss" in msg or "innerhtml" in msg or "html" in msg:
        return "needs_deeper"

    # Critical/high severity from trusted scanners
    if sev in ("CRITICAL", "HIGH", "ERROR"):
        return "needs_deeper"

    return "needs_deeper"  # Default: let vuln class agents decide


# ---------------------------------------------------------------------------
# CHUNK handler
# ---------------------------------------------------------------------------


def structure_handler(state: JSAState, js_files: list[tuple[str, str]] | None = None) -> JSAState:
    """
    STRUCTURE phase: Build typed analysis store and emit PageCard/ModuleCard.

    Replaces CHUNK. Runs after SAST_VALIDATE (and optionally STOP). Reads:
    - state.file_map (from ACQUIRE) — file metadata
    - state.sast_findings / state.sast_validated (from SAST_VALIDATE)
    - state.metadata["cve_research"] (from CVE_RESEARCH) — tech stack
    - state.metadata["dedup"] (from NORMALIZE) — normalized components/vulns

    Produces:
    - state.typed_store — unified typed analysis store
    - state.module_cards — one per JS/HTML file
    - state.page_cards — one per HTTP-interacted page (Caido + Playwright)

    Builds the file manifest + AST index, extracts dangerous patterns via
    tree-sitter, and emits one ModuleCard per JS/HTML file plus one PageCard per
    crawled page.

    Args:
        state: Current JSAState.
        js_files: Optional list of (filename, content) tuples from ACQUIRE.

    Returns:
        Updated state.
    """
    import time
    import uuid
    start = time.time()
    state.metadata["structure_started"] = True

    # Lazy imports to avoid circular deps
    from structure_analysis import (
        build_file_manifest,
        build_ast_index,
        extract_dangerous_patterns,
    )
    from module_card import ModuleCard, DangerousPattern, ASTSummary
    from page_card import (
        PageCard, RequestSnapshot, ResponseSnapshot, ScriptFile, DOMInventory
    )

    # If js_files not passed directly, try to read from state.file_map
    if not js_files:
        if state.file_map is not None and hasattr(state.file_map, "files"):
            js_files = []
            for f in state.file_map.files:
                try:
                    with open(f.path, "r", encoding="utf-8", errors="replace") as fp:
                        js_files.append((f.path, fp.read()))
                except (OSError, IOError):
                    pass
        elif state.metadata.get("acquire", {}).get("crawled_pages"):
            # No JS files but we have crawled pages — proceed to build PageCards
            state.metadata["structure_warning"] = "No JS files; building PageCards from ACQUIRE only"
        else:
            state.metadata["structure_warning"] = "No JS files available"
            return state

    if not js_files:
        # If we got here via the file_map branch, that's a real empty
        # If we got here via the ACQUIRE branch, we want to still process page cards
        if not state.metadata.get("acquire", {}).get("crawled_pages"):
            state.metadata["structure_warning"] = "Empty file list"
            return state
        state.metadata["structure_warning"] = "Empty file list; building PageCards from ACQUIRE only"

    # 1. Build file manifest
    manifest_entries = build_file_manifest(js_files)
    state.typed_store["file_manifest"] = manifest_entries

    # 2. Build AST index
    ast_indices = build_ast_index(js_files, include_source=False)
    state.typed_store["ast_indices"] = {
        path: {
            "file_path": idx.file_path,
            "function_count": idx.function_count,
            "class_count": idx.class_count,
            "call_count": idx.call_count,
            "top_level_names": idx.top_level_names,
            "imports": idx.imports,
            "exports": idx.exports,
            "parse_errors": idx.parse_errors,
            "parse_error_rate": idx.parse_error_rate,
        }
        for path, idx in ast_indices.items()
    }

    # 3. Extract dangerous patterns
    dangerous = extract_dangerous_patterns(js_files)
    state.typed_store["dangerous_patterns"] = dangerous

    # 4. Build ModuleCards
    cve_research = state.metadata.get("cve_research", {})
    file_classifications = cve_research.get("file_classifications", {})

    for path, content in js_files:
        from asset_classify import classify_file
        try:
            classification = classify_file(
                path,
                source_map_sources=None,
                file_classifications=file_classifications,
            )
        except Exception:
            classification = None

        # Build ASTSummary
        ast_idx = ast_indices.get(path)
        ast_summary = None
        if ast_idx is not None:
            ast_summary = ASTSummary(
                function_count=ast_idx.function_count,
                class_count=ast_idx.class_count,
                arrow_function_count=0,
                call_count=ast_idx.call_count,
                imports=ast_idx.imports,
                exports=ast_idx.exports,
                top_level_names=ast_idx.top_level_names,
                parse_errors=ast_idx.parse_errors,
                parse_error_rate=ast_idx.parse_error_rate,
            )

        # Get detections from fingerprint_engine
        detections = []
        try:
            from fingerprint_engine import FingerprintEngine
            from fingerprint_loader import FingerprintDB
            from pathlib import Path as _P
            fp_path = _P(__file__).parent / "wappalyzer" / "categories.json"
            if fp_path.exists():
                fp_db = FingerprintDB.from_json(fp_path)
                engine = FingerprintEngine(fp_db)
                detections = engine.detect_from_filename(path)
        except Exception:
            pass

        # Build DangerousPattern list for this file
        file_dangerous = [
            DangerousPattern(
                pattern_id=d["pattern_id"],
                description=d["description"],
                line=d["line"],
                column=d["column"],
                code_snippet=d["code_snippet"],
                severity=d["severity"],
                suggested_vuln_classes=d["suggested_vuln_classes"],
            )
            for d in dangerous if d["file"] == path
        ]

        module_card = ModuleCard(
            filename=path,
            url=None,
            page_card_ids=[],
            source_length=len(content),
            hash=next(
                (m["sha1"] for m in manifest_entries if m["path"] == path),
                "",
            ),
            source_map_url=None,
            classification=classification,
            detections=detections,
            ast_summary=ast_summary,
            dangerous_patterns=file_dangerous,
            sources=["structure_analysis", "asset_classify", "fingerprint_engine"],
        )
        state.module_cards.append(module_card)

    # 5. Build PageCards for HTML pages
    html_files = [(p, c) for p, c in js_files if p.endswith((".html", ".htm"))]
    for path, content in html_files:
        try:
            from html_parser import parse_html_page
            parsed = parse_html_page(content, page_url=path)
        except Exception:
            continue

        page_card = PageCard(
            page_id=str(uuid.uuid4()),
            url=path,
            method="GET",
            timestamp="",
            request=RequestSnapshot(method="GET", url=path, source="html"),
            response=ResponseSnapshot(
                status_code=200,
                headers={"content-type": "text/html"},
                body_snippet=content[:2000] if content else None,
                source="html",
            ),
            technologies=[],
            runtime_versions=[],
            classification=None,
            script_files=[
                ScriptFile(filename=script_url, url=script_url)
                for script_url in parsed.external_scripts
            ],
            dom_inventory=DOMInventory(
                dom_ids=parsed.dom_ids,
                form_actions=parsed.form_actions,
                inline_event_handlers=parsed.inline_event_handlers,
                iframe_srcs=parsed.iframe_srcs,
                meta_tags=parsed.meta_tags,
                csp_header=parsed.csp_meta,
            ),
            sources=["html_parser"],
        )
        state.page_cards.append(page_card)

    # 6. Build PageCards from ACQUIRE's crawled page URLs
    acquire_meta = state.metadata.get("acquire", {})
    crawled_urls = acquire_meta.get("crawled_pages", [])
    for url in crawled_urls:
        page_card = PageCard(
            page_id=str(uuid.uuid4()),
            url=url,
            method="GET",
            timestamp="",
            sources=["acquire"],
        )
        state.page_cards.append(page_card)

    # Summary
    state.metadata["structure_cards_built"] = (
        len(state.module_cards) + len(state.page_cards)
    )
    state.metadata["structure_module_cards"] = len(state.module_cards)
    state.metadata["structure_page_cards"] = len(state.page_cards)
    state.metadata["structure_dangerous_patterns"] = len(dangerous)
    state.metadata["structure_duration_ms"] = int((time.time() - start) * 1000)

    return state


def slice_handler(state: JSAState) -> JSAState:
    """
    SLICE phase: Per-class candidate generation + vulnerability-specific slice extraction.

    Replaces the chunk-based approach. For each vuln class:
    1. Run class-specific candidate generation against state.module_cards
    2. Run Joern data flow queries (if available) for code-centric classes
    3. Build FlowCards with evidence from correlation + Joern + SAST

    Produces:
    - state.slices — raw data flow slices (from Joern)
    - state.flow_cards — one per vuln-class candidate flow

    Generates per-class candidates from SAST findings + dangerous patterns,
    runs Joern data-flow queries when available (graceful degradation), and
    emits one FlowCard per candidate flow.

    Args:
        state: Current JSAState.

    Returns:
        Updated state.
    """
    import time
    import uuid
    from flow_card import (
        FlowCard, FlowEndpoint, FlowStep, SanitizerInfo, RuntimeEvidence
    )
    from lane_router import select_lane, get_lane_for_analyzer

    start = time.time()
    state.metadata["slice_started"] = True

    # Note: we proceed even without module_cards (for SAST-only mode)

    # 1. Collect SAST findings into a per-vuln-class candidate list
    sast_candidates = {}  # vuln_class → list of finding dicts
    for finding in state.sast_findings:
        # Heuristic: infer vuln class from rule_id
        rule_id = finding.get("rule_id", "").lower()
        vuln_class = _infer_vuln_class_from_rule(rule_id, finding)
        if vuln_class:
            sast_candidates.setdefault(vuln_class, []).append(finding)

    # 2. Collect dangerous patterns into vuln-class candidates
    # (a ModuleCard's dangerous_patterns field has suggested_vuln_classes)
    for mc in state.module_cards:
        for pattern in getattr(mc, "dangerous_patterns", []):
            for vc in pattern.suggested_vuln_classes:
                candidate = {
                    "file": mc.filename,
                    "line": pattern.line,
                    "column": pattern.column,
                    "code_snippet": pattern.code_snippet,
                    "severity": pattern.severity,
                    "pattern_id": pattern.pattern_id,
                    "source": "dangerous_pattern",
                }
                sast_candidates.setdefault(vc, []).append(candidate)

    # 3. Try Joern data flow queries (with graceful degradation)
    joern_slices = []
    if state.module_cards:
        try:
            from joern_integration import is_joern_available, run_joern_for_files
            if is_joern_available():
                # Collect JS file paths from module cards
                js_paths = [mc.filename for mc in state.module_cards
                            if mc.filename.endswith((".js", ".mjs", ".cjs"))]
                if js_paths:
                    vuln_classes = list(sast_candidates.keys()) or None
                    result = run_joern_for_files(
                        js_paths,
                        vuln_classes=vuln_classes,
                    )
                    if result.slices:
                        joern_slices = result.slices
                        state.metadata["joern_status"] = "available"
                        state.metadata["joern_slices_count"] = len(joern_slices)
                    else:
                        state.metadata["joern_status"] = "ran_no_slices"
                else:
                    state.metadata["joern_status"] = "no_js_files"
            else:
                state.metadata["joern_status"] = "unavailable"
        except Exception as e:
            state.metadata["joern_status"] = f"error: {str(e)[:100]}"
    else:
        state.metadata["joern_status"] = "no_module_cards"

    state.slices = joern_slices

    # 4. Build FlowCards
    # Each candidate pattern gets a FlowCard
    flow_cards_built = 0
    for vuln_class, candidates in sast_candidates.items():
        # Limit to top N candidates per vuln class to avoid card explosion
        for cand in candidates[:20]:
            lane = get_lane_for_analyzer(vuln_class) or "code_static"
            # Preserve the finding's file provenance. SAST findings carry
            # "path"; dangerous-pattern candidates carry "file". Without this,
            # cards get empty module_card_ids and _consolidate_flow_cards()
            # (which keys on the primary file) over-merges distinct findings at
            # different files into a single card.
            cand_file = cand.get("file") or cand.get("path") or ""
            cand_module_ids = [mc.filename for mc in state.module_cards
                               if mc.filename == cand_file]
            if not cand_module_ids and cand_file:
                cand_module_ids = [cand_file]
            flow_card = FlowCard(
                flow_id=str(uuid.uuid4()),
                vulnerability_class=vuln_class,
                cwe_id=_infer_cwe_for_vuln(vuln_class),
                confidence="candidate",
                lane=lane,
                source=FlowEndpoint(
                    type="user_input",
                    detail=cand.get("code_snippet", "")[:100],
                    line=cand.get("line", 0),
                ),
                sink=FlowEndpoint(
                    type=_infer_sink_for_vuln(vuln_class),
                    detail=cand.get("code_snippet", "")[:100],
                    line=cand.get("line", 0),
                ),
                steps=[FlowStep(
                    step_type="detection",
                    expression=cand.get("code_snippet", "")[:200],
                    line=cand.get("line", 0),
                )],
                sanitizer_chain=[],
                module_card_ids=cand_module_ids,
                page_card_ids=[],
                evidence=[],
                runtime_evidence=[],
                severity=cand.get("severity", "medium"),
                cvss_score=None,
                cwe_vuln=None,
                discovered=time.strftime("%Y-%m-%dT%H:%M:%S"),
                confirmed=False,
                sources=[cand.get("source", "sast")],
            )
            state.flow_cards.append(flow_card)
            flow_cards_built += 1

    # 5. Optionally create FlowCards from Joern data flow slices
    for slice_data in joern_slices[:10]:  # Limit to top 10
        vuln_class = slice_data.vuln_class
        if not vuln_class:
            continue
        lane = get_lane_for_analyzer(vuln_class) or "code_static"
        # Build a flow card from the slice
        source_node = slice_data.nodes[0] if slice_data.nodes else None
        sink_node = slice_data.nodes[-1] if slice_data.nodes else None
        flow_card = FlowCard(
            flow_id=str(uuid.uuid4()),
            vulnerability_class=vuln_class,
            cwe_id=_infer_cwe_for_vuln(vuln_class),
            confidence="probable" if slice_data.nodes else "candidate",
            lane=lane,
            source=FlowEndpoint(
                type=source_node.get("name", "") if source_node else "unknown",
                detail=source_node.get("code", "")[:100] if source_node else "",
                line=source_node.get("lineNumber", 0) if source_node else 0,
            ),
            sink=FlowEndpoint(
                type=sink_node.get("name", "") if sink_node else "unknown",
                detail=sink_node.get("code", "")[:100] if sink_node else "",
                line=sink_node.get("lineNumber", 0) if sink_node else 0,
            ),
            steps=[
                FlowStep(
                    step_type="data_flow",
                    expression=n.get("code", "")[:200],
                    line=n.get("lineNumber", 0),
                    joern_node_id=n.get("id"),
                )
                for n in slice_data.nodes[:5]
            ],
            sanitizer_chain=[],
            module_card_ids=[],
            page_card_ids=[],
            evidence=[],
            runtime_evidence=[],
            severity="medium",
            cvss_score=None,
            cwe_vuln=None,
            discovered=time.strftime("%Y-%m-%dT%H:%M:%S"),
            confirmed=False,
            sources=["joern"],
        )
        state.flow_cards.append(flow_card)
        flow_cards_built += 1

    # 5b. Build FlowCards from CVE findings
    # CVEs detected in CVE_RESEARCH are currently orphaned — they're stored
    # in metadata but never flow through SAST_VALIDATE or INVESTIGATE.
    # This injects each CVE as a FlowCard tied to the affected component's
    # ModuleCard, so it gets the same validation treatment as SAST findings.
    cve_cards_built = 0
    cve_data = state.metadata.get("cve_research", {}).get("cves", [])
    for cve in cve_data:
        cve_id = cve.get("cve_id", "")
        if not cve_id:
            continue
        library = cve.get("library", "")
        version = cve.get("version", "")
        cvss = cve.get("cvss_score")
        summary = cve.get("summary", "")[:500]
        # Find ModuleCards for the affected library (case-insensitive substring match)
        affected_mc_ids = [
            mc.filename for mc in state.module_cards
            if library.lower() in mc.filename.lower()
            or any(library.lower() in str(getattr(mc, f, "")).lower()
                   for f in ["classification", "url"])
        ]
        # Fallback: if no match, try matching just the library name parts
        if not affected_mc_ids:
            lib_lower = library.lower()
            # Strip common suffixes that won't appear in filenames (js, ts, etc.)
            for suffix in ["js", "ts", "jsx", "tsx"]:
                if lib_lower.endswith(suffix) and len(lib_lower) > len(suffix) + 1:
                    lib_lower = lib_lower[:-len(suffix)]
                    break
            lib_parts = lib_lower.replace(".", " ").replace("-", " ").replace("_", " ").split()
            affected_mc_ids = [
                mc.filename for mc in state.module_cards
                if any(part in mc.filename.lower() for part in lib_parts if len(part) > 2)
            ]
        # Map CVSS to severity
        if cvss and cvss >= 9.0:
            sev = "critical"
        elif cvss and cvss >= 7.0:
            sev = "high"
        elif cvss and cvss >= 4.0:
            sev = "medium"
        else:
            sev = "low"
        lane = get_lane_for_analyzer("cve") or "code_static"
        cve_card = FlowCard(
            flow_id=str(uuid.uuid4()),
            vulnerability_class="cve",
            cwe_id=cve_id,  # Store CVE ID in cwe_id (cwe_vuln has serialization issues)
            confidence="candidate",
            lane=lane,
            source=FlowEndpoint(
                type="known_vulnerability",
                detail=f"{library}@{version}",
            ),
            sink=FlowEndpoint(
                type=cve_id,  # Use CVE ID as sink_type for unique consolidation keys
                detail=cve_id,
            ),
            steps=[FlowStep(
                step_type="detection",
                expression=summary[:200],
            )],
            sanitizer_chain=[],
            module_card_ids=affected_mc_ids,
            page_card_ids=[],
            evidence=[{"cve_id": cve_id, "summary": summary}],
            runtime_evidence=[],
            severity=sev,
            cvss_score=cvss,
            cwe_vuln=cve_id,
            discovered=time.strftime("%Y-%m-%dT%H:%M:%S"),
            confirmed=False,
            sources=["cve_research"],
        )
        state.flow_cards.append(cve_card)
        cve_cards_built += 1
        flow_cards_built += 1

    # 6. Consolidate duplicate FlowCards before summary
    # Same (vuln_class, source_type, sink_type) = same vulnerability.
    # Merge duplicates: keep one representative, record duplicate count,
    # merge module_card_ids so no file provenance is lost.
    pre_consolidation = len(state.flow_cards)
    state.flow_cards = _consolidate_flow_cards(state.flow_cards)
    post_consolidation = len(state.flow_cards)

    # Summary
    state.metadata["slice_cards_built"] = flow_cards_built
    state.metadata["slice_cve_cards"] = cve_cards_built
    state.metadata["slice_consolidated"] = pre_consolidation - post_consolidation
    state.metadata["slice_duration_ms"] = int((time.time() - start) * 1000)
    state.metadata["slice_vuln_classes"] = list(sast_candidates.keys())

    return state


def _infer_vuln_class_from_rule(rule_id: str, finding: dict) -> Optional[str]:
    """Heuristically map a SAST rule_id to a vuln class name.

    Uses word-boundary matching to avoid false positives like "dom"
    matching "random" or "postmessage" matching "repostmessage".
    """
    import re
    rid = rule_id.lower()

    # Use word boundaries (\b) to avoid substring false positives
    if re.search(r"\bxss\b|\bdom[-_]?xss\b|\bdomxss\b|innerhtml|outerhtml|insertadjacenthtml", rid):
        return "dom_xss"
    if re.search(r"\bprototype\b|\bpollution\b|object\.assign|merge|extend|deep[-_]?merge", rid):
        return "prototype_pollution"
    # SQL injection MUST come BEFORE generic "injection" (which is command injection)
    if re.search(r"\bsqli?\b|sql[-_]?injection|sql[-_]?query|\bsql\b", rid):
        return "sqli"
    if re.search(r"\beval\b|\binjection\b|\bexec\b|command[-_]?injection|code[-_]?injection", rid):
        return "command_injection"
    if re.search(r"\bssrf\b|server[-_]?side[-_]?request", rid):
        return "ssrf"
    if re.search(r"\bpostmessage\b|post[-_]?message", rid):
        return "postmessage"
    if re.search(r"open[-_]?redirect|\bredirect\b", rid):
        return "open_redirect"
    if re.search(r"\bsecret\b|hardcoded|api[-_]?key|exposed[-_]?token|leaked[-_]?credential", rid):
        return "secret_disclosure"
    if re.search(r"\bcsrf\b", rid):
        return "csrf"
    if re.search(r"\bcors\b", rid):
        return "cors"
    # Try to extract from finding's rule name (semgrep format)
    rule_name = str(finding.get("rule_id", ""))
    if "javascript.lang.security" in rule_name:
        path = str(finding.get("path", ""))
        if re.search(r"xss|innerhtml|dom", path.lower()):
            return "dom_xss"
        if re.search(r"eval|exec|injection", path.lower()):
            return "command_injection"
        if re.search(r"sql", path.lower()):
            return "sqli"
    return None


def _infer_cwe_for_vuln(vuln_class: str) -> Optional[str]:
    """Map a vuln class to its canonical CWE ID."""
    cwe_map = {
        "dom_xss": "CWE-79",
        "reflected_xss": "CWE-79",
        "stored_xss": "CWE-79",
        "prototype_pollution": "CWE-1321",
        "command_injection": "CWE-78",
        "ssrf": "CWE-918",
        "sqli": "CWE-89",
        "postmessage": "CWE-345",
        "open_redirect": "CWE-601",
        "secret_disclosure": "CWE-798",
        "csrf": "CWE-352",
        "cors": "CWE-942",
        "clickjacking": "CWE-1021",
        "idor": "CWE-639",
        "cache_poisoning": "CWE-349",
        "http_smuggling": "CWE-444",
        "dom_clobbering": "CWE-79",
        "csti": "CWE-94",
        "request_override": "CWE-639",
        "link_manipulation": "CWE-451",
        "dom_data_manipulation": "CWE-20",
    }
    return cwe_map.get(vuln_class)


def _infer_sink_for_vuln(vuln_class: str) -> str:
    """Map a vuln class to its typical sink type."""
    sink_map = {
        "dom_xss": "innerHTML",
        "reflected_xss": "innerHTML",
        "stored_xss": "innerHTML",
        "prototype_pollution": "Object.assign",
        "command_injection": "eval",
        "ssrf": "fetch",
        "sqli": "query",
        "postmessage": "postMessage",
        "open_redirect": "location.href",
        "secret_disclosure": "exposed_token",
        "csrf": "request_without_token",
        "cors": "Access-Control-Allow-Origin",
        "clickjacking": "frame_target",
        "idor": "direct_object_reference",
        "cache_poisoning": "cache_key",
        "http_smuggling": "smuggled_request",
    }
    return sink_map.get(vuln_class, "unknown")


def _consolidate_flow_cards(flow_cards: list) -> list:
    """Merge duplicate FlowCards by (vuln_class, source_type, sink_type, file).

    Two FlowCards with the same vulnerability class, same source endpoint
    type, same sink endpoint type, AND same primary file represent the
    same vulnerability instance. Merging them:
    - Keeps one representative (the first encountered)
    - Merges module_card_ids so no file provenance is lost
    - Merges sources list
    - Records duplicate_count on the representative
    - Preserves the highest confidence and severity

    IMPORTANT: Same vuln class on DIFFERENT files is kept separate.
    Reflected XSS on /login and reflected XSS on /search are two distinct
    findings — they have different attack surfaces, different contexts,
    and may require different remediation. Only exact duplicates within
    the same file are merged.
    """
    from collections import defaultdict

    groups: dict[tuple, list] = defaultdict(list)
    for fc in flow_cards:
        src_type = getattr(fc.source, "type", "") if fc.source else ""
        sink_type = getattr(fc.sink, "type", "") if fc.sink else ""
        # Primary file: first module_card_id, or empty string
        primary_file = fc.module_card_ids[0] if fc.module_card_ids else ""
        # For CVE cards, sink_type is the CVE ID itself (unique per CVE).
        # For all other cards, sink_type is the vuln-class sink (e.g., "innerHTML").
        # This keeps different CVEs separate while still merging SAST duplicates.
        key = (fc.vulnerability_class, src_type, sink_type, primary_file)
        groups[key].append(fc)

    consolidated = []
    for cards in groups.values():
        rep = cards[0]
        # Merge module_card_ids from all duplicates
        all_module_ids: set[str] = set(rep.module_card_ids)
        all_sources: set[str] = set(rep.sources)
        for dup in cards[1:]:
            all_module_ids.update(dup.module_card_ids)
            all_sources.update(dup.sources)
            # Promote confidence if any duplicate has higher confidence
            if _confidence_rank(dup.confidence) > _confidence_rank(rep.confidence):
                rep.confidence = dup.confidence
            # Promote severity if any duplicate has higher severity
            if _severity_rank(dup.severity) > _severity_rank(rep.severity):
                rep.severity = dup.severity
        rep.module_card_ids = sorted(all_module_ids)
        rep.sources = sorted(all_sources)
        # Attach duplicate metadata (non-dataclass field, set via __dict__)
        rep.__dict__["duplicate_count"] = len(cards)
        consolidated.append(rep)

    return consolidated


def _confidence_rank(conf: str) -> int:
    """Rank confidence levels for promotion during consolidation."""
    ranks = {"confirmed": 3, "probable": 2, "candidate": 1}
    return ranks.get(conf, 0)


def _severity_rank(sev: str) -> int:
    """Rank severity levels for promotion during consolidation."""
    ranks = {"critical": 5, "high": 4, "medium": 3, "low": 2, "info": 1}
    return ranks.get(sev.lower(), 0)


def investigate_handler(state: JSAState) -> JSAState:
    """
    INVESTIGATE phase: Per-lane agent dispatch consuming FlowCards.

    Renamed from DISPATCH (Phase B, 2026-06). Now consumes flow cards
    (from SLICE) rather than raw chunks (from CHUNK).

    Lane routing (per the document):
    - code_static lane: receives FlowCard
    - page_dom lane: receives PageCard + relevant FlowCards
    - network_behavior lane: receives PageCard with Caido HTTP history

    Phase D: Full implementation with per-lane work item generation.

    Args:
        state: Current JSAState.

    Returns:
        Updated state.
    """
    import time
    import uuid
    start = time.time()
    state.metadata["investigate_started"] = True

    # 1. Group flow cards by lane
    flow_cards_by_lane = {
        "code_static": [],
        "page_dom": [],
        "network_behavior": [],
    }
    for fc in state.flow_cards:
        lane = getattr(fc, "lane", "code_static") or "code_static"
        if lane in flow_cards_by_lane:
            flow_cards_by_lane[lane].append(fc)

    # 2. Group page cards by lane
    # All page cards are candidates for page_dom AND network_behavior lanes
    # (they have different evidence needs: HTML structure vs HTTP history)
    page_cards = state.page_cards

    # 3. Build per-lane work items
    # Each work item is a dict with:
    #   - work_id: UUID
    #   - lane: lane name
    #   - vuln_class: which analyzer to invoke
    #   - packet_type: what evidence to send
    #   - flow_card / page_card: the evidence
    work_items = []

    # 3a. Code-static work items: one per FlowCard
    for fc in flow_cards_by_lane["code_static"]:
        work_items.append({
            "work_id": str(uuid.uuid4()),
            "lane": "code_static",
            "vuln_class": fc.vulnerability_class,
            "packet_type": "flow_card",
            "flow_card": fc,
            "page_card_ids": fc.page_card_ids,
        })

    # 3b. Page-DOM work items: one per FlowCard, with page context
    for fc in flow_cards_by_lane["page_dom"]:
        work_items.append({
            "work_id": str(uuid.uuid4()),
            "lane": "page_dom",
            "vuln_class": fc.vulnerability_class,
            "packet_type": "page_card_with_flow_cards",
            "flow_card": fc,
            "page_card_ids": fc.page_card_ids,
        })

    # 3c. Network-behavior work items: one per PageCard
    # (each PageCard triggers a network analysis pass)
    for pc in page_cards:
        # Skip pages with no analyzers configured for network behavior
        network_analyzers = ["cors", "clickjacking", "idor",
                              "cache_poisoning", "http_smuggling", "csrf"]
        relevant_analyzers = [a for a in network_analyzers
                              if a in state.analyzers or not state.analyzers]
        for vuln_class in relevant_analyzers:
            work_items.append({
                "work_id": str(uuid.uuid4()),
                "lane": "network_behavior",
                "vuln_class": vuln_class,
                "packet_type": "page_card_with_caido_history",
                "flow_card": None,
                "page_card": pc,
                "page_card_ids": [pc.page_id] if pc.page_id else [],
            })

    # 4. If no work items but we have analyzers, create one
    # general "site survey" work item per analyzer
    if not work_items and state.analyzers:
        for vuln_class in state.analyzers:
            work_items.append({
                "work_id": str(uuid.uuid4()),
                "lane": "code_static",
                "vuln_class": vuln_class,
                "packet_type": "empty",
                "flow_card": None,
                "page_card": None,
                "page_card_ids": [],
            })

    # 5. Compute waves (4 work items per wave)
    chunks_per_wave = 4
    total_waves = max(1, math.ceil(len(work_items) / chunks_per_wave))

    # 6. Build investigate plan
    state.metadata["investigate_plan"] = {
        "flow_cards": len(state.flow_cards),
        "page_cards": len(state.page_cards),
        "analyzers": state.analyzers,
        "chunks_per_wave": chunks_per_wave,
        "total_agents": len(work_items),
        "total_waves": total_waves,
        "lanes": {
            "code_static": len(flow_cards_by_lane["code_static"]),
            "page_dom": len(flow_cards_by_lane["page_dom"]),
            # Count network_behavior work items (one per page card per network analyzer)
            "network_behavior": sum(
                1 for wi in work_items if wi["lane"] == "network_behavior"
            ),
        },
        "work_items": [
            {
                "work_id": wi["work_id"],
                "lane": wi["lane"],
                "vuln_class": wi["vuln_class"],
                "packet_type": wi["packet_type"],
                "page_card_ids": wi["page_card_ids"],
            }
            for wi in work_items
        ],
        "context_included": {
            "sast_validated": len(state.sast_validated) > 0,
            "tech_stack_available": len(state.metadata.get("cve_research", {}).get("tech_stack_hints", {})) > 0,
            "cve_count": len(state.metadata.get("cve_research", {}).get("cves", [])),
            "joern_status": state.metadata.get("joern_status", "unknown"),
        },
    }
    state.metadata["investigate_work_items"] = work_items
    state.metadata["investigate_duration_ms"] = int((time.time() - start) * 1000)

    # F0.7: Run Python verification on flow cards (hybrid Python+LLM)
    # This produces findings with confidence scores + LLM packet decisions
    _run_python_verification(state, flow_cards_by_lane)

    return state


def _run_python_verification(
    state: JSAState,
    flow_cards_by_lane: dict[str, list],
) -> None:
    """
    F0.7: Run Python verification on flow cards.

    Uses the existing analyzers/verifier.py to:
    1. Assess exploitability for each FlowCard
    2. Compute confidence scores
    3. Build LLM packets for findings that need verification
    4. Store results in state.metadata["python_verification"]

    This is the deterministic layer of the F3 hybrid architecture.
    The LLM layer (F2) consumes the packets built here.
    """
    import sys
    from pathlib import Path as _Path
    scripts_dir = _Path(__file__).parent
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))

    from analyzers.verifier import PythonVerifier
    from dedup import Finding

    # Combine all flow cards
    all_flow_cards = []
    for cards in flow_cards_by_lane.values():
        all_flow_cards.extend(cards)

    if not all_flow_cards:
        state.metadata["python_verification"] = {
            "enabled": True,
            "total_flow_cards": 0,
            "findings_produced": 0,
            "needs_llm_verify": 0,
            "needs_llm_deep": 0,
            "confidence_distribution": {},
        }
        return

    # Build findings from flow cards
    # In a full pipeline, findings would come from semgrep/Joern earlier.
    # For now, we create candidate findings from flow cards so the
    # verifier can assess them.
    findings = []
    for fc in all_flow_cards:
        source = ""
        if fc.source:
            source = fc.source.type
            if fc.source.detail:
                source += f".{fc.source.detail}"

        sink = ""
        if fc.sink:
            sink = fc.sink.type
            if fc.sink.detail:
                sink += f".{fc.sink.detail}"

        line = fc.sink.line if fc.sink else 0

        finding = Finding(
            finding_id=str(uuid.uuid4()),
            chunk_id=fc.flow_id,
            file=fc.module_card_ids[0] if fc.module_card_ids else "",
            vuln_class=fc.vulnerability_class,
            source=source,
            sink=sink,
            line_start=line,
            line_end=line,
            description=f"User input from {source} flows to {sink}",
            code_snippet=fc.sink.code_snippet if fc.sink else "",
            data_flow="",
            scanner="slice",
        )
        findings.append(finding)

    # Run Python verifier
    verifier = PythonVerifier()
    results = verifier.verify_batch(findings, all_flow_cards)

    # Aggregate results
    confidence_dist: dict[str, int] = {}
    needs_verify = 0
    needs_deep = 0
    for r in results:
        confidence_dist[r.confidence_level] = confidence_dist.get(r.confidence_level, 0) + 1
        if r.needs_llm_verify:
            needs_verify += 1
        if r.needs_llm_deep:
            needs_deep += 1

    # Store findings on state (the COLLECT phase will pick them up)
    state.raw_findings.extend(findings)

    # Store metadata for inspection + F2 (LLM verification) to consume
    state.metadata["python_verification"] = {
        "enabled": True,
        "total_flow_cards": len(all_flow_cards),
        "findings_produced": len(findings),
        "needs_llm_verify": needs_verify,
        "needs_llm_deep": needs_deep,
        "confidence_distribution": confidence_dist,
        "verification_results": [
            {
                "finding_id": r.finding.finding_id,
                "vuln_class": r.finding.vuln_class,
                "python_verdict": r.python_verdict,
                "python_difficulty": r.python_difficulty,
                "confidence_score": r.confidence_score,
                "confidence_level": r.confidence_level,
                "needs_llm_verify": r.needs_llm_verify,
                "needs_llm_deep": r.needs_llm_deep,
                "has_llm_packet": r.llm_packet is not None,
            }
            for r in results
        ],
    }


# Backward-compat alias — old code may import dispatch_handler


# ---------------------------------------------------------------------------
# 1.3.7 Collect handler
# ---------------------------------------------------------------------------

def collect_handler(state: JSAState) -> JSAState:
    """
    Gather findings from all chunk workers.

    In production, reads from MemPalace {session_id}-findings room.
    For unit testing, findings are set directly on state.
    """
    state.metadata["collect_completed"] = True
    state.metadata["collect_raw_count"] = len(state.raw_findings)
    state.updated_at = datetime.now(timezone.utc).isoformat()

    return state



