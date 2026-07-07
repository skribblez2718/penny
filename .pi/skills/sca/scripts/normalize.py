"""
sca Skill — Findings normalization layer (Phase 5).

Standalone, importable primitives that turn heterogeneous tool output into a
single unified schema. NOTHING here is wired into orchestrate.py yet (P8/P12
wiring lands in a later phase); these are pure functions with no network and
no subprocess.

Provided primitives:

  NormalizedFinding
      A dataclass carrying the unified schema. ``confidence`` and ``severity``
      are GENUINELY INDEPENDENT fields — a parser never derives one from the
      other. A CRITICAL-severity finding may legitimately hold LOW confidence
      (e.g. pending analyst verification). The default confidence is a fixed
      constant (``DEFAULT_CONFIDENCE``), never a function of severity.

  parse_sarif(sarif_dict)          -> list[NormalizedFinding]
  parse_json(json_data, tool_name) -> list[NormalizedFinding]
  parse_osv_scanner_json(json_data) -> list[NormalizedFinding]
  parse_jsonl(jsonl_text, tool_name) -> list[NormalizedFinding]
      Each extracts file/line/rule/message from a real tool output shape. The
      supported shapes are grounded in the sca tool extensions:
        * SARIF 2.1.0 (semgrep --sarif): runs[].results[] + rule properties.
        * semgrep native --json: {"results":[{check_id,path,start,extra{...}}]}.
        * gitleaks flat JSON array: PascalCase records (File/StartLine/RuleID/
          Description/Match/Secret/...).
        * osv-scanner native --format json: the DEEPLY-NESTED real shape
          results[].packages[].vulnerabilities[] (NOT flat records). Grounded in
          the SAME schema the Phase 4a TS extension
          (.pi/extensions/osv-scanner/index.ts countFindings) walks and in
          osv-scanner's public JSON schema. Its per-vulnerability ``severity``
          is a LIST of {type, score} CVSS-vector objects (never a plain word);
          the parser derives a canonical tier from those vectors via the real
          ``cvss`` library, falling back to "unknown" when none can be derived
          (never a fabricated tier).

SECURITY (Truth-priority): a secrets scanner record (gitleaks) carries the raw
secret in its ``Match``/``Secret`` keys. This module NEVER copies that plaintext
into any NormalizedFinding field — the description is taken from the rule
``Description``, and the raw value is dropped entirely. Redaction/hashing of any
secret that must be surfaced is handled by ``redact.py``.

ROBUSTNESS: malformed / empty / wrong-shape input returns an empty list and
logs a warning via ``logging`` (stderr-equivalent, never stdout — matching
orchestrate.py's stdout-JSON-only discipline if these are ever called from
there later). No parser raises on bad input.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, List, Optional, Tuple

from cvss import CVSS2, CVSS3, CVSS4  # the REAL PyPI package (installed in .venv)


logger = logging.getLogger("sca.normalize")

# Default confidence for freshly-parsed findings. A CONSTANT, deliberately
# decoupled from severity — confidence is a separate analyst/heuristic axis
# populated/adjusted in a later triage phase.
DEFAULT_CONFIDENCE = "unknown"

# Default severity when a tool provides none (e.g. gitleaks reports no severity
# field). We never INVENT a severity tier — absence is recorded honestly.
DEFAULT_SEVERITY = "unknown"

# Valid enumerations (documented; not strictly enforced at construction so the
# schema stays a light dataclass, but parsers only ever emit these).
EVIDENCE_BASIS_VALUES = ("observed", "inferred", "assumed", "unknown")
STATUS_VALUES = ("open", "false_positive", "verified", "mitigated")

_CWE_RE = re.compile(r"CWE-\d+")


# ── Unified schema ───────────────────────────────────────────────────────


@dataclass
class NormalizedFinding:
    """Unified representation of a single security finding.

    Required identity/location fields come first; optional/defaulted fields
    follow. ``confidence`` and ``severity`` are independent — never derive one
    from the other.
    """

    id: str
    tool: str
    rule_id: str
    title: str
    description: str
    file: str
    line: int
    severity: str  # tool-native string (preserved verbatim)
    confidence: str  # independent analyst/heuristic axis
    evidence_basis: str  # one of EVIDENCE_BASIS_VALUES

    column: Optional[int] = None
    linked_sr_ids: List[str] = field(default_factory=list)
    linked_t_ids: List[str] = field(default_factory=list)
    cwe_ids: List[str] = field(default_factory=list)
    asvs_references: List[str] = field(default_factory=list)
    api_top10_2023_mapping: List[str] = field(default_factory=list)
    status: str = "open"
    cvss_4_0_vector: Optional[str] = None
    cvss_4_0_score: Optional[float] = None
    analyst_notes: Optional[str] = None


# ── ID generation (deterministic, content-derived) ───────────────────────


def _make_id(tool: str, rule_id: str, file: str, line: Any, title: str,
             description: str) -> str:
    """Return a deterministic, content-derived finding id.

    Stable across runs for identical inputs (so dedup merge-records and tests
    are reproducible) and distinct for materially different findings.
    """
    basis = "|".join(
        str(x) for x in (tool, rule_id, file, line, title, description)
    )
    digest = hashlib.sha1(basis.encode("utf-8")).hexdigest()[:12]
    return f"F-{digest}"


def _as_int(value: Any, default: Optional[int] = None) -> Optional[int]:
    """Best-effort int coercion; returns ``default`` on failure."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _extract_cwes(items: Any) -> List[str]:
    """Extract CWE-<n> ids from a list of strings / a single string."""
    if items is None:
        return []
    if isinstance(items, str):
        items = [items]
    if not isinstance(items, (list, tuple)):
        return []
    found: List[str] = []
    for item in items:
        for match in _CWE_RE.findall(str(item)):
            if match not in found:
                found.append(match)
    return found


def _as_str_list(value: Any) -> List[str]:
    """Coerce a value into a list of strings (empty on None/unknown shapes)."""
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple)):
        return [str(v) for v in value]
    return []


# ── SARIF (SARIF 2.1.0, e.g. semgrep --sarif) ────────────────────────────


def parse_sarif(sarif_dict: Any) -> List[NormalizedFinding]:
    """Parse a SARIF 2.1.0 document into NormalizedFinding records.

    Grounded in REAL ``semgrep scan --sarif`` output (verified against semgrep
    OSS, see tests/test_normalize.py fixture). Per result we extract ruleId,
    message.text, and the first physicalLocation (file uri + region start
    line/column). Two fields require a JOIN against the driver's rules array
    (keyed by matching ``result.ruleId`` to ``rule.id``):

      * SEVERITY comes from ``rule.defaultConfiguration.level`` (real SARIF does
        NOT put a ``level`` on the per-result object). Falls back to a
        per-result ``level`` if present, then to DEFAULT_SEVERITY ("unknown").
      * CWEs come from ``rule.properties.tags`` (freeform strings such as
        "CWE-918: ..."), with a legacy fallback to ``rule.properties.cwe``.

    Malformed / empty input returns ``[]`` (never raises).
    """
    if not isinstance(sarif_dict, dict):
        logger.warning("parse_sarif: input is not a dict (%s)", type(sarif_dict).__name__)
        return []
    runs = sarif_dict.get("runs")
    if not isinstance(runs, list):
        if runs is not None:
            logger.warning("parse_sarif: 'runs' is not a list; ignoring")
        return []

    findings: List[NormalizedFinding] = []
    for run in runs:
        if not isinstance(run, dict):
            continue
        driver = (run.get("tool") or {}).get("driver") or {}
        tool_name = driver.get("name") or "sarif"
        rules_index = _index_sarif_rules(driver.get("rules"))
        for result in run.get("results") or []:
            if not isinstance(result, dict):
                continue
            finding = _finding_from_sarif_result(result, tool_name, rules_index)
            if finding is not None:
                findings.append(finding)
    return findings


def _index_sarif_rules(rules: Any) -> dict:
    """Map ruleId -> rule dict for lookups (severity level, cwe/asvs/owasp)."""
    index: dict = {}
    if isinstance(rules, list):
        for rule in rules:
            if isinstance(rule, dict) and "id" in rule:
                index[rule["id"]] = rule
    return index


def _finding_from_sarif_result(result: dict, tool_name: str,
                               rules_index: dict) -> Optional[NormalizedFinding]:
    rule_id = result.get("ruleId") or result.get("rule", {}).get("id") or "unknown"
    rule = rules_index.get(rule_id, {})

    # SEVERITY: real semgrep SARIF puts severity on the RULE, not the result.
    # Join result.ruleId -> driver.rules[].id, then read
    # defaultConfiguration.level. Fall back to a per-result `level` (some SARIF
    # producers set one) and finally to the honest "unknown" default.
    default_config = rule.get("defaultConfiguration") or {}
    severity = (
        default_config.get("level")
        or result.get("level")
        or DEFAULT_SEVERITY
    )
    message = ""
    msg = result.get("message")
    if isinstance(msg, dict):
        message = msg.get("text") or ""
    elif isinstance(msg, str):
        message = msg

    file_path = ""
    line: Optional[int] = None
    column: Optional[int] = None
    locations = result.get("locations")
    if isinstance(locations, list) and locations:
        phys = (locations[0] or {}).get("physicalLocation") or {}
        artifact = phys.get("artifactLocation") or {}
        file_path = artifact.get("uri") or ""
        region = phys.get("region") or {}
        line = _as_int(region.get("startLine"))
        column = _as_int(region.get("startColumn"))

    if not file_path or line is None:
        # Without a usable location we cannot place the finding; drop it rather
        # than emit an ambiguous record.
        logger.warning(
            "parse_sarif: dropping result for rule %r with no usable location",
            rule_id,
        )
        return None

    props = rule.get("properties") or {}
    # CWE: real semgrep SARIF encodes CWEs as freeform strings in
    # properties.tags (e.g. "CWE-918: ..."). Parse those first, then merge in a
    # legacy structured properties.cwe (other producers / older shapes).
    cwe_ids = _extract_cwes(props.get("tags"))
    for cwe in _extract_cwes(props.get("cwe")):
        if cwe not in cwe_ids:
            cwe_ids.append(cwe)
    asvs = _as_str_list(props.get("asvs"))
    api10 = _as_str_list(props.get("api-top10-2023") or props.get("api"))

    title = rule_id
    return NormalizedFinding(
        id=_make_id(tool_name, rule_id, file_path, line, title, message),
        tool=tool_name,
        rule_id=rule_id,
        title=title,
        description=message,
        file=file_path,
        line=line,
        column=column,
        severity=severity,
        confidence=DEFAULT_CONFIDENCE,
        evidence_basis="inferred",  # SAST pattern match, not a direct observation
        cwe_ids=cwe_ids,
        asvs_references=asvs,
        api_top10_2023_mapping=api10,
    )


# ── JSON (dict or flat array), dispatched by tool_name ───────────────────


def parse_json(json_data: Any, tool_name: str) -> List[NormalizedFinding]:
    """Parse a tool's native JSON (dict or flat array) into findings.

    Dispatches on ``tool_name`` (case-insensitive):
      * "semgrep"  -> expects ``{"results": [...]}`` (native --json shape).
      * "gitleaks" -> expects a flat JSON array of PascalCase records.
      * otherwise  -> generic best-effort (dict-with-"results" or a flat list).

    Malformed / wrong-shape input returns ``[]`` (never raises).
    """
    name = (tool_name or "").strip().lower()

    if name == "semgrep":
        if not isinstance(json_data, dict):
            logger.warning("parse_json[semgrep]: expected dict, got %s",
                           type(json_data).__name__)
            return []
        results = json_data.get("results")
        if not isinstance(results, list):
            logger.warning("parse_json[semgrep]: 'results' is not a list")
            return []
        return [
            f for f in (_finding_from_semgrep_result(r) for r in results)
            if f is not None
        ]

    if name == "gitleaks":
        records = json_data
        if isinstance(records, dict):
            # tolerate a wrapper dict that carries the array under a key
            records = records.get("findings") or records.get("results")
        if not isinstance(records, list):
            logger.warning("parse_json[gitleaks]: expected a JSON array")
            return []
        return [
            f for f in (_finding_from_gitleaks_record(r) for r in records)
            if f is not None
        ]

    # Generic best-effort.
    records = None
    if isinstance(json_data, dict):
        records = json_data.get("results") or json_data.get("findings")
    elif isinstance(json_data, list):
        records = json_data
    if not isinstance(records, list):
        logger.warning("parse_json[%s]: no recognizable findings array", name or "?")
        return []
    return [
        f for f in (_finding_from_generic_record(r, tool_name) for r in records)
        if f is not None
    ]


# ── osv-scanner (deeply-nested real shape) ───────────────────────────────


def parse_osv_scanner_json(json_data: Any) -> List[NormalizedFinding]:
    """Parse REAL ``osv-scanner --format json`` output into findings.

    The real shape is deeply nested (NOT flat records) — each top-level
    ``results[]`` entry is a scanned SOURCE (e.g. a lockfile), carrying:

        results[]
          .source.path                 -> the source lockfile path (finding.file)
          .packages[]                  -> one per affected dependency
            .package{name,version,ecosystem}
            .vulnerabilities[]         -> the actual CVE-level findings
              .id / .summary / .details
              .severity[]              -> a LIST of {type, score} CVSS-vector
                                          objects (NOT a plain word)

    We emit ONE NormalizedFinding per vulnerability. This walks exactly the same
    ``results[].packages[].vulnerabilities[]`` path the Phase 4a TS extension's
    countFindings() already uses, so the two agree on the real shape.

    CRITICAL (Carren): a generic flat-record parser silently drops every one of
    these findings (they have no top-level file/line), making a real "N CVEs"
    scan look identical to a clean scan. This dedicated parser is what prevents
    that silent data loss.

    Malformed / wrong-shape input returns ``[]`` (never raises).
    """
    if not isinstance(json_data, dict):
        logger.warning(
            "parse_osv_scanner_json: expected dict, got %s",
            type(json_data).__name__,
        )
        return []
    results = json_data.get("results")
    if not isinstance(results, list):
        if results is not None:
            logger.warning("parse_osv_scanner_json: 'results' is not a list")
        return []

    findings: List[NormalizedFinding] = []
    for result in results:
        if not isinstance(result, dict):
            continue
        source = result.get("source")
        file_path = ""
        if isinstance(source, dict):
            file_path = source.get("path") or ""
        packages = result.get("packages")
        if not isinstance(packages, list):
            continue
        for pkg in packages:
            if not isinstance(pkg, dict):
                continue
            pkg_info = pkg.get("package")
            pkg_name = pkg_version = None
            if isinstance(pkg_info, dict):
                pkg_name = pkg_info.get("name")
                pkg_version = pkg_info.get("version")
            vulns = pkg.get("vulnerabilities")
            if not isinstance(vulns, list):
                continue
            for vuln in vulns:
                finding = _finding_from_osv_vuln(
                    vuln, file_path, pkg_name, pkg_version
                )
                if finding is not None:
                    findings.append(finding)
    return findings


def _finding_from_osv_vuln(
    vuln: Any,
    file_path: str,
    pkg_name: Optional[str],
    pkg_version: Optional[str],
) -> Optional[NormalizedFinding]:
    """Build one NormalizedFinding from a single OSV vulnerability object.

    A dependency-level finding has NO source line, so ``line`` is 0 (a sentinel
    for "whole-manifest", never a fabricated code location). It is deliberately
    NOT dropped for lacking a line — dropping it is the exact silent-data-loss
    bug this parser fixes.
    """
    if not isinstance(vuln, dict):
        return None
    rule_id = vuln.get("id") or "unknown"
    summary = vuln.get("summary") or ""
    details = vuln.get("details") or ""
    title = summary or str(rule_id)
    description = details or summary or ""
    if pkg_name:
        pkg_label = f"{pkg_name}@{pkg_version}" if pkg_version else str(pkg_name)
        description = (
            f"[{pkg_label}] {description}".strip() if description else pkg_label
        )

    # OSV severity is a LIST of {type, score} CVSS-vector objects — derive a
    # canonical tier from the vectors via the real cvss library. Never a word.
    severity = _osv_severity_tier(vuln.get("severity"))

    db = vuln.get("database_specific")
    cwe_ids = _extract_cwes(db.get("cwe_ids")) if isinstance(db, dict) else []

    line = 0  # dependency-level finding: no in-file line to report
    return NormalizedFinding(
        id=_make_id("osv-scanner", str(rule_id), file_path, line, title,
                    description),
        tool="osv-scanner",
        rule_id=str(rule_id),
        title=title,
        description=description,
        file=file_path,
        line=line,
        column=None,
        severity=severity,
        confidence=DEFAULT_CONFIDENCE,
        # a known-vulnerable dependency VERSION is actually present in the
        # manifest -> a direct observation (reachability is a separate axis).
        evidence_basis="observed",
        cwe_ids=cwe_ids,
    )


def _osv_severity_tier(severity_entries: Any) -> str:
    """Derive a canonical CVSS tier from an OSV vulnerability's severity list.

    OSV encodes severity as ``[{"type": "CVSS_V2|V3|V4", "score": "<vector>"}]``.
    Each vector is parsed with the REAL ``cvss`` library; we take the HIGHEST
    base score and return that object's authoritative qualitative band
    (lowercased) when it is one of {critical, high, medium, low}. If nothing
    parses (or only a "none" band results), we return DEFAULT_SEVERITY
    ("unknown") — following the codebase's "never fabricate confidence"
    discipline rather than guessing a tier.
    """
    if not isinstance(severity_entries, list):
        return DEFAULT_SEVERITY
    best_score = -1.0
    best_tier = DEFAULT_SEVERITY
    for entry in severity_entries:
        if not isinstance(entry, dict):
            continue
        vector = entry.get("score")
        if not isinstance(vector, str) or not vector.strip():
            continue
        parsed = _cvss_score_and_band(str(entry.get("type") or ""), vector)
        if parsed is None:
            continue
        score, band = parsed
        if score > best_score:
            best_score = score
            best_tier = band if band in CANONICAL_TIERS else DEFAULT_SEVERITY
    return best_tier


def _cvss_score_and_band(
    score_type: str, vector: str
) -> Optional[Tuple[float, str]]:
    """Return (base_score, band-lowercased) for a CVSS vector, or None.

    Uses the REAL cvss library (authoritative; no hand-rolled scoring). The OSV
    ``type`` selects the CVSS version; we also fall back to the vector prefix so
    a mislabeled/absent type still parses.
    """
    stype = (score_type or "").upper()
    try:
        if "V4" in stype or vector.startswith("CVSS:4"):
            obj: Any = CVSS4(vector)
        elif "V2" in stype:
            obj = CVSS2(vector)
        elif "V3" in stype or vector.startswith("CVSS:3"):
            obj = CVSS3(vector)
        elif vector.startswith("CVSS:4"):
            obj = CVSS4(vector)
        else:
            # Legacy CVSS v2 vectors have no "CVSS:" prefix.
            obj = CVSS2(vector)
        band = obj.severities()[0].lower()
        return float(obj.base_score), band
    except Exception as exc:  # cvss raises CVSS*Error on malformed input
        logger.warning(
            "parse_osv_scanner_json: unparseable CVSS vector %r (%s): %s",
            vector, score_type, exc,
        )
        return None


# ── CANONICAL_TIERS (shared with cvss4_map) ──────────────────────────────
# The canonical CVSS-tier vocabulary. Kept local (not imported from cvss4_map)
# so normalize.py stays a leaf module with no dependency on the scoring layer.
CANONICAL_TIERS = frozenset(("critical", "high", "medium", "low"))


def parse_jsonl(jsonl_text: Any, tool_name: str) -> List[NormalizedFinding]:
    """Parse JSONL (one JSON record per line) into findings.

    Each non-blank line is decoded independently; a malformed line is skipped
    with a warning (never aborts the whole parse). Per-record interpretation
    follows the same tool dispatch as ``parse_json``.

    Malformed / empty input returns ``[]`` (never raises).
    """
    if not isinstance(jsonl_text, str) or not jsonl_text.strip():
        return []

    name = (tool_name or "").strip().lower()
    findings: List[NormalizedFinding] = []
    for lineno, raw in enumerate(jsonl_text.splitlines(), start=1):
        stripped = raw.strip()
        if not stripped:
            continue
        try:
            record = json.loads(stripped)
        except json.JSONDecodeError as exc:
            logger.warning("parse_jsonl: skipping malformed line %d: %s", lineno, exc)
            continue
        if name == "semgrep":
            finding = _finding_from_semgrep_result(record)
        elif name == "gitleaks":
            finding = _finding_from_gitleaks_record(record)
        else:
            finding = _finding_from_generic_record(record, tool_name)
        if finding is not None:
            findings.append(finding)
    return findings


# ── per-record parsers ───────────────────────────────────────────────────


def _finding_from_semgrep_result(result: Any) -> Optional[NormalizedFinding]:
    """Parse one semgrep native --json result entry."""
    if not isinstance(result, dict):
        return None
    rule_id = result.get("check_id") or "unknown"
    file_path = result.get("path") or ""
    start = result.get("start") or {}
    line = _as_int(start.get("line"))
    column = _as_int(start.get("col"))
    extra = result.get("extra") or {}
    severity = extra.get("severity") or DEFAULT_SEVERITY
    message = extra.get("message") or ""
    metadata = extra.get("metadata") or {}
    cwe_ids = _extract_cwes(metadata.get("cwe"))
    asvs = _as_str_list(metadata.get("asvs"))
    api10 = _as_str_list(metadata.get("api-top10-2023") or metadata.get("api"))

    if not file_path or line is None:
        logger.warning("parse_json[semgrep]: dropping result %r without location",
                       rule_id)
        return None

    return NormalizedFinding(
        id=_make_id("semgrep", rule_id, file_path, line, rule_id, message),
        tool="semgrep",
        rule_id=rule_id,
        title=rule_id,
        description=message,
        file=file_path,
        line=line,
        column=column,
        severity=severity,
        confidence=DEFAULT_CONFIDENCE,
        evidence_basis="inferred",
        cwe_ids=cwe_ids,
        asvs_references=asvs,
        api_top10_2023_mapping=api10,
    )


def _finding_from_gitleaks_record(record: Any) -> Optional[NormalizedFinding]:
    """Parse one gitleaks flat-array record.

    SECURITY: the ``Match``/``Secret`` keys carry the raw secret. They are
    deliberately NOT read into any output field — description comes from the
    rule ``Description`` only.
    """
    if not isinstance(record, dict):
        return None
    rule_id = record.get("RuleID") or "unknown"
    file_path = record.get("File") or ""
    line = _as_int(record.get("StartLine"))
    column = _as_int(record.get("StartColumn"))
    description = record.get("Description") or rule_id
    severity = record.get("severity") or record.get("Severity") or DEFAULT_SEVERITY

    if not file_path or line is None:
        logger.warning("parse_json[gitleaks]: dropping record %r without location",
                       rule_id)
        return None

    return NormalizedFinding(
        id=_make_id("gitleaks", rule_id, file_path, line, rule_id, description),
        tool="gitleaks",
        rule_id=rule_id,
        title=description,
        description=description,
        file=file_path,
        line=line,
        column=column,
        severity=severity,
        confidence=DEFAULT_CONFIDENCE,
        # a secret string was actually matched in-file -> a direct observation
        evidence_basis="observed",
    )


def _finding_from_generic_record(record: Any, tool_name: str) -> Optional[NormalizedFinding]:
    """Best-effort parse of an unknown tool's record using common key names."""
    if not isinstance(record, dict):
        return None
    tool = tool_name or record.get("tool") or "unknown"
    rule_id = (record.get("rule_id") or record.get("ruleId")
               or record.get("check_id") or record.get("RuleID") or "unknown")
    file_path = (record.get("file") or record.get("path")
                 or record.get("File") or "")
    line = _as_int(record.get("line") or record.get("StartLine"))
    message = (record.get("message") or record.get("description")
               or record.get("Description") or "")
    severity = record.get("severity") or DEFAULT_SEVERITY
    column = _as_int(record.get("column") or record.get("col"))

    if not file_path or line is None:
        logger.warning("parse_json[%s]: dropping generic record without location",
                       tool)
        return None

    return NormalizedFinding(
        id=_make_id(str(tool), str(rule_id), file_path, line, str(rule_id), message),
        tool=str(tool),
        rule_id=str(rule_id),
        title=str(rule_id),
        description=message,
        file=file_path,
        line=line,
        column=column,
        severity=severity,
        confidence=DEFAULT_CONFIDENCE,
        evidence_basis="unknown",
        cwe_ids=_extract_cwes(record.get("cwe") or record.get("cwe_ids")),
    )
