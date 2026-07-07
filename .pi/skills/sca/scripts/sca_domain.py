"""sca_domain — deterministic domain helpers for the migrated ScaPlaybook.

These are FAITHFUL ports of the heavy, security-critical domain logic that used
to live embedded inside the ~3,400-line SCAPipelineOrchestrator (scripts/
orchestrate.py): the file census, output-dir safety, the P0 charter draft +
questionnaire, the contained P9-authored augmentation-rule writer, the P10
single-shot PoC processor (locked-down Docker sandbox), and the P12 report-
artifact writers. The playbook (apps/orchestration/.../playbooks/sca.py) keeps
only thin overridable seams and delegates the real work here.

Design: every function operates on a plain ``meta`` dict — the sca playbook's
``ctx.extras["sca"]`` — which mirrors the legacy ``state.metadata`` plus the
three run-scoped fields (session_id / target_path / output_dir) it also stores.
Nothing here calls an MCP tool or the engine; the deterministic scanner modules
(baseline_scan / targeted_scan / sandbox / input_validator) are imported LAZILY
so the skill-dir must already be on sys.path (the playbook ensures this).

Behavioral honesty invariants preserved verbatim from the legacy:
  * coverage gaps are recorded, never fabricated away;
  * ``_flag_is_true`` trusts ONLY the literal ``True`` (a crafted string "False"
    never reads as available);
  * PoC results are recorded ``poc_executed_pending_review`` — NEVER auto
    pass/fail;
  * augmentation-rule filenames are containment-checked (path-traversal safe);
  * a missing skribble narrative writes an HONEST fallback, never a fabrication.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

try:  # PyYAML is pinned in requirements.txt; degrade gracefully if absent.
    import yaml as _yaml
except Exception:  # pragma: no cover - environment-dependent
    _yaml = None

# ---------------------------------------------------------------------------
# Constants (ported verbatim)
# ---------------------------------------------------------------------------

EVIDENCE_STANDARD = ["observed", "inferred", "assumed", "unknown"]
MEMPALACE_WING = "wing_sca"
DEFAULT_AUGMENT_CAP = 3
MAX_POCS_PER_BATCH = 50
VERIFICATION_STATUS_PENDING = "poc_executed_pending_review"
REPORT_MD_MAX_CHARS = 100000
SKRIBBLE_REPORT_KEY = "report_md"

_SEVERITY_ORDER = ("critical", "high", "medium", "low", "unknown")
_PROJECT_MARKERS = ("AGENTS.md", ".pi", ".git")

_JS_TS_EXTENSIONS = frozenset(
    {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"}
)
_CENSUS_IGNORE_DIRS = frozenset(
    {
        "node_modules", ".git", ".hg", ".svn", ".venv", "venv", "vendor",
        "__pycache__", ".tox", "dist", "build",
    }
)
_CENSUS_MAX_DEPTH = 12
_CENSUS_MAX_ENTRIES = 100000

_ENRICH_MAX_KEYS = 12
_ENRICH_MAX_VALUE_CHARS = 120
_ENRICH_MAX_CHARS = 1000
_ENRICH_PREVIEW_ITEMS = 6
_STORE_MAX_DEPTH = 24
_STORE_MAX_CHARS = 4000


def ensure_skill_tools(project_root: str, skill: str = "sca") -> str:
    """Put ``.pi/skills/<skill>/scripts`` on sys.path so the flat-importing
    scanner modules resolve, and return that directory. Idempotent."""
    d = os.path.join(project_root or os.getcwd(), ".pi", "skills", skill, "scripts")
    if d and d not in sys.path:
        sys.path.insert(0, d)
    return d


# ---------------------------------------------------------------------------
# Output-directory safety (port of orchestrate._is_inside_project_tree /
# _default_output_dir / _safe_output_dir / fsm.repo_basename)
# ---------------------------------------------------------------------------


def repo_basename(target_path: str) -> str:
    if not target_path:
        return "unknown"
    try:
        name = Path(target_path).resolve().name or "unknown"
    except Exception:
        name = "unknown"
    safe = "".join(c if (c.isalnum() or c in "-_.") else "-" for c in name)
    return safe or "unknown"


def _is_inside_project_tree(path: str) -> bool:
    cursor = os.path.abspath(path)
    while True:
        for marker in _PROJECT_MARKERS:
            if os.path.exists(os.path.join(cursor, marker)):
                return True
        parent = os.path.dirname(cursor)
        if parent == cursor:
            return False
        cursor = parent


def default_output_dir(target_path: str) -> str:
    """/tmp/sca-{repo_basename}-{shorthash(resolved abs path)} — deterministic,
    cross-repo unique, never inside the project tree."""
    basename = repo_basename(target_path)
    if target_path:
        try:
            resolved = str(Path(target_path).resolve())
        except Exception:
            resolved = target_path
    else:
        resolved = "unknown"
    shorthash = hashlib.sha256(resolved.encode("utf-8")).hexdigest()[:12]
    return str(Path("/tmp") / f"sca-{basename}-{shorthash}")


def safe_output_dir(requested: str, target_path: str) -> str:
    resolved = os.path.abspath(requested)
    if not _is_inside_project_tree(resolved):
        return resolved
    fallback = default_output_dir(target_path)
    print(
        f"[sca] output_dir {resolved!r} is inside the project tree. "
        f"Redirecting to {fallback!r} per Penny's 'no temp files in project' rule.",
        file=sys.stderr,
    )
    return fallback


# ---------------------------------------------------------------------------
# Census (port of orchestrate.compute_census / _count_loc)
# ---------------------------------------------------------------------------


def _count_loc(path: str) -> int:
    try:
        count = 0
        with open(path, "rb") as fh:
            for _ in fh:
                count += 1
        return count
    except OSError:  # pragma: no cover - defensive
        return 0


def compute_census(target_path: str) -> dict:
    """Deterministic file/LOC inventory (JS/TS vs UNCOVERED). Never raises;
    degrades to honest zero counts. Bounded in depth + total entries."""
    from input_validator import detect_lockfiles  # lazy skill-dir import

    census: dict = {
        "total_files": 0,
        "js_ts_files": 0,
        "uncovered_files": 0,
        "js_ts_loc": 0,
        "uncovered_loc": 0,
        "lockfiles": [],
        "workspace_count": 1,
    }
    lock = detect_lockfiles(target_path) if target_path else {
        "lockfiles": [], "workspace_count": 1,
    }
    census["lockfiles"] = list(lock["lockfiles"])
    census["workspace_count"] = lock["workspace_count"]
    if not target_path:
        return census
    root = Path(target_path)
    try:
        if not root.is_dir():
            return census
    except OSError:  # pragma: no cover - defensive
        return census
    root_str = str(root)
    entries_seen = 0
    try:
        for dirpath, dirnames, filenames in os.walk(root_str, topdown=True):
            rel = os.path.relpath(dirpath, root_str)
            depth = 0 if rel == "." else rel.count(os.sep) + 1
            if depth >= _CENSUS_MAX_DEPTH:
                dirnames[:] = []
            dirnames[:] = [
                d for d in dirnames
                if d not in _CENSUS_IGNORE_DIRS and not d.startswith(".")
            ]
            entries_seen += len(filenames) + len(dirnames)
            if entries_seen > _CENSUS_MAX_ENTRIES:  # pragma: no cover - DoS guard
                break
            for fn in filenames:
                census["total_files"] += 1
                ext = os.path.splitext(fn)[1].lower()
                loc = _count_loc(os.path.join(dirpath, fn))
                if ext in _JS_TS_EXTENSIONS:
                    census["js_ts_files"] += 1
                    census["js_ts_loc"] += loc
                else:
                    census["uncovered_files"] += 1
                    census["uncovered_loc"] += loc
    except OSError:  # pragma: no cover - defensive
        pass
    return census


# ---------------------------------------------------------------------------
# Target validation (port of orchestrate._validate_target); returns an error
# message list when the target is unsafe/invalid, else None.
# ---------------------------------------------------------------------------


def validate_target(target_path: str) -> Optional[list]:
    from input_validator import URL_KIND_SCP, url_shape_kind  # lazy

    p = target_path
    if not p:
        return None
    kind = url_shape_kind(p)
    if kind is not None:
        reject_as_url = True
        if kind == URL_KIND_SCP:
            try:
                if Path(p).is_dir():
                    reject_as_url = False
            except OSError:  # pragma: no cover - defensive
                reject_as_url = True
        if reject_as_url:
            return [
                f"target_path looks like a URL / remote target ({p}); the sca "
                f"skill analyzes LOCAL source trees only. For live-URL or "
                f"deployed-application analysis, use the 'jsa' skill instead."
            ]
    try:
        path = Path(p)
        if path.is_symlink():
            return [f"target_path is a symlink (rejected for safety): {p}"]
        if not path.exists():
            return [f"target_path does not exist: {p}"]
        if not path.is_dir():
            return [f"target_path is not a directory (expected a source tree): {p}"]
    except Exception as e:  # pragma: no cover - defensive
        return [f"target_path validation failed: {e}"]
    return None


# ---------------------------------------------------------------------------
# P0 charter draft + questionnaire (port of _build_charter_draft /
# _charter_questions / _merge_charter_answer)
# ---------------------------------------------------------------------------


def build_charter_draft(meta: dict) -> dict:
    """Build (and store on ``meta``) the P0 charter draft from the CURRENT
    filesystem. Preserves any previously-merged out_of_scope / scope."""
    from input_validator import detect_lockfiles  # lazy

    target_path = meta.get("target_path", "")
    census = detect_lockfiles(target_path) if target_path else {
        "lockfiles": [], "workspace_count": 1,
    }
    meta["census_preview"] = {
        "lockfiles": list(census["lockfiles"]),
        "workspace_count": census["workspace_count"],
    }
    charter: dict = {
        "target_path": target_path,
        "output_dir": meta.get("output_dir", ""),
        "lockfiles": list(census["lockfiles"]),
        "workspace_count": census["workspace_count"],
        "out_of_scope": [],
        "evidence_standard": list(EVIDENCE_STANDARD),
    }
    existing = meta.get("charter")
    if isinstance(existing, dict):
        if existing.get("out_of_scope"):
            charter["out_of_scope"] = existing["out_of_scope"]
        if existing.get("scope"):
            charter["scope"] = existing["scope"]
    meta["charter"] = charter
    return charter


def charter_questions(meta: dict) -> list:
    charter = build_charter_draft(meta)
    return [
        {
            "id": "p0_charter_gate",
            "label": "Approve analysis charter",
            "prompt": (
                "Review the analysis charter draft below, then approve to "
                "continue or choose revise and provide direction.\n"
                f"- target_path: {charter.get('target_path')}\n"
                f"- output_dir: {charter.get('output_dir')}\n"
                f"- lockfiles: {charter.get('lockfiles')}\n"
                f"- workspace_count: {charter.get('workspace_count')}\n"
                f"- evidence_standard: {charter.get('evidence_standard')}"
            ),
            "options": [
                {"value": "approve", "label": "Approve and continue"},
                {"value": "revise", "label": "Request revisions"},
            ],
            "allowOther": True,
        },
        {
            "id": "out_of_scope",
            "label": "Out-of-scope paths (optional)",
            "prompt": "Optionally list paths/globs to exclude from analysis (one per line).",
            "allowOther": True,
        },
        {
            "id": "scope",
            "label": "Scope override (optional)",
            "prompt": "Optionally edit or narrow the analysis scope.",
            "allowOther": True,
        },
    ]


def merge_charter_answer(meta: dict, response: Any) -> None:
    """Merge a user's out_of_scope / scope submission into the charter."""
    charter = meta.get("charter")
    if not isinstance(charter, dict):
        charter = build_charter_draft(meta)
    oos = _extract_field(response, "out_of_scope")
    if oos:
        charter["out_of_scope"] = _coerce_list(oos)
    scope = _extract_field(response, "scope")
    if scope:
        charter["scope"] = scope
    meta["charter"] = charter


def _coerce_list(value: Any) -> list:
    if isinstance(value, list):
        return [str(v) for v in value]
    if isinstance(value, str):
        return [ln.strip() for ln in value.splitlines() if ln.strip()]
    return [str(value)]


def _extract_field(result: Any, field: str) -> Any:
    if isinstance(result, dict):
        if field in result:
            return result[field]
        nested = result.get("responses")
        if isinstance(nested, dict) and field in nested:
            return nested[field]
    return None


# ---------------------------------------------------------------------------
# Phase-result capture + enrichment rendering (port of the _ENRICH_*/_STORE_*
# discipline: _bound_stored_value / _compact_value / _summarize_prior_result /
# _prior_phase_block + the per-phase enrich builders)
# ---------------------------------------------------------------------------


def _compact_value(value: Any) -> str:
    try:
        if isinstance(value, dict):
            if not value:
                return "{}"
            keys = list(value.keys())[:_ENRICH_PREVIEW_ITEMS]
            body = ", ".join(f"{k}={value[k]}" for k in keys)
            if len(value) > _ENRICH_PREVIEW_ITEMS:
                body += f", +{len(value) - _ENRICH_PREVIEW_ITEMS} more"
            if len(body) > _ENRICH_MAX_VALUE_CHARS:
                return f"{{{len(value)} keys}}"
            return "{" + body + "}"
        if isinstance(value, (list, tuple)):
            if not value:
                return "[]"
            items = list(value)[:_ENRICH_PREVIEW_ITEMS]
            body = ", ".join(str(x) for x in items)
            if len(value) > _ENRICH_PREVIEW_ITEMS:
                body += f", +{len(value) - _ENRICH_PREVIEW_ITEMS} more"
            if len(body) > _ENRICH_MAX_VALUE_CHARS:
                return f"[{len(value)} items]"
            return "[" + body + "]"
        if isinstance(value, str):
            s = value.strip().replace("\n", " ")
            if len(s) > _ENRICH_MAX_VALUE_CHARS:
                return s[:_ENRICH_MAX_VALUE_CHARS] + "…"
            return s
        s = str(value)
        if len(s) > _ENRICH_MAX_VALUE_CHARS:
            return s[:_ENRICH_MAX_VALUE_CHARS] + "…"
        return s
    except Exception:  # pragma: no cover - defensive
        return "(unrenderable)"


def _summarize_prior_result(result: Any) -> str:
    if not isinstance(result, dict) or not result:
        return "(no data)"
    lines: list = []
    for i, (k, v) in enumerate(result.items()):
        if i >= _ENRICH_MAX_KEYS:
            lines.append(f"  ... ({len(result) - _ENRICH_MAX_KEYS} more keys)")
            break
        lines.append(f"  - {k}: {_compact_value(v)}")
    summary = "\n".join(lines)
    if len(summary) > _ENRICH_MAX_CHARS:
        summary = summary[:_ENRICH_MAX_CHARS] + " …[truncated]"
    return summary


def _bound_stored_value(value: Any, depth: int = 0) -> Any:
    try:
        if isinstance(value, dict):
            if depth >= _STORE_MAX_DEPTH:
                return f"{{{len(value)} keys}} …[depth-capped]"
            return {str(k): _bound_stored_value(v, depth + 1) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            if depth >= _STORE_MAX_DEPTH:
                return f"[{len(value)} items] …[depth-capped]"
            return [_bound_stored_value(v, depth + 1) for v in value]
        if isinstance(value, str):
            if len(value) > _ENRICH_MAX_VALUE_CHARS:
                return value[:_ENRICH_MAX_VALUE_CHARS] + "…"
            return value
        if value is None or isinstance(value, (bool, int, float)):
            return value
        return _compact_value(value)
    except Exception:  # pragma: no cover - defensive
        return _compact_value(value)


def capture_phase_result(meta: dict, phase_name: str, result: Any) -> None:
    """Store a size-bounded copy of an agent result for downstream enrichment."""
    if not isinstance(result, dict):
        return
    bounded: Any = _bound_stored_value(result)
    try:
        oversized = len(json.dumps(bounded, default=str)) > _STORE_MAX_CHARS
    except Exception:  # pragma: no cover - defensive
        oversized = True
    if oversized:
        bounded = {"_summary": _summarize_prior_result(bounded), "_truncated": True}
    meta.setdefault("phase_results", {})[phase_name] = bounded


def get_phase_result(meta: dict, phase_name: str) -> Optional[dict]:
    results = meta.get("phase_results")
    if isinstance(results, dict):
        value = results.get(phase_name)
        if isinstance(value, dict):
            return value
    return None


def _prior_phase_block(meta: dict, phase_name: str) -> str:
    result = get_phase_result(meta, phase_name)
    if not isinstance(result, dict) or not result:
        return f"{phase_name} SUMMARY: no {phase_name} context available."
    return (
        f"{phase_name} SUMMARY (concise — from prior agent output):\n"
        + _summarize_prior_result(result)
    )


# Public alias for the playbook's task builders.
prior_phase_block = _prior_phase_block


def _flag_is_true(value: Any) -> bool:
    """Only the literal bool True counts (a crafted string 'False' is NOT true)."""
    return value is True


def _flag_capped(value: Any) -> bool:
    """Disclosure-safe: suppress the cap warning ONLY for literal False."""
    return value is not False


def enrich_census_task(meta: dict, base_task: str) -> str:
    """Append the census summary (computing + storing meta['census'] only if it
    was not already precomputed on a persisted route path)."""
    census = meta.get("census")
    if not (isinstance(census, dict) and census):
        census = compute_census(meta.get("target_path", ""))
        meta["census"] = census
    return base_task + (
        "\n\nPRE-COMPUTED CENSUS (authoritative full inventory — do NOT re-scan "
        "from scratch):\n"
        f"- total files: {census['total_files']}\n"
        f"- JS/TS files: {census['js_ts_files']} ({census['js_ts_loc']} LOC)\n"
        f"- UNCOVERED (non-JS/TS) files: {census['uncovered_files']} "
        f"({census['uncovered_loc']} LOC)\n"
        f"- lockfiles: {census['lockfiles']}\n"
        f"- workspace_count: {census['workspace_count']}"
    )


def enrich_context_task(meta: dict, base_task: str) -> str:
    parts = ["\n\nPRIOR-PHASE CONTEXT (concise summary — do NOT re-derive from scratch):"]
    census = meta.get("census")
    if isinstance(census, dict) and census:
        parts.append(
            "\n[P1 census] "
            f"total_files={census.get('total_files', 0)}, "
            f"js_ts={census.get('js_ts_files', 0)} ({census.get('js_ts_loc', 0)} LOC), "
            f"uncovered={census.get('uncovered_files', 0)}, "
            f"lockfiles={_compact_value(census.get('lockfiles', []))}, "
            f"workspaces={census.get('workspace_count', 1)}"
        )
    else:
        parts.append("\n[P1 census] no census data available")
    baseline = meta.get("baseline_scan")
    if isinstance(baseline, dict) and baseline:
        parts.append(
            "\n[P2 baseline] "
            f"tools_run={_compact_value(baseline.get('available', []))}, "
            f"findings={baseline.get('findings_count', 0)}, "
            f"severity={_compact_value(baseline.get('severity_counts', {}))}, "
            f"coverage_gaps={_compact_value(baseline.get('coverage_gaps', []))}"
        )
    else:
        parts.append("\n[P2 baseline] no baseline scan data available")
    return base_task + "".join(parts)


def enrich_triage_task(meta: dict, base_task: str) -> str:
    parts = [
        "\n\nPRIOR-PHASE CONTEXT (merged scan findings to TRIAGE — read the full "
        "set from findings.json; do NOT re-scan):"
    ]
    targeted = meta.get("targeted_scan")
    baseline = meta.get("baseline_scan")
    label = data = None
    if isinstance(targeted, dict) and _flag_is_true(targeted.get("completed")):
        label, data = "P7 targeted", targeted
    elif isinstance(baseline, dict) and _flag_is_true(baseline.get("completed")):
        label, data = "P2 baseline (P7 degraded/unavailable)", baseline
    if data is not None:
        parts.append(
            f"\n[{label}] findings={data.get('findings_count', 0)}, "
            f"severity={_compact_value(data.get('severity_counts', {}))}, "
            f"coverage_gaps={_compact_value(data.get('coverage_gaps', []))}"
        )
    else:
        parts.append("\n[scan findings] no P7/P2 scan data available to triage")
    return base_task + "".join(parts)


def enrich_fix_verification_task(meta: dict, base_task: str) -> str:
    parts = ["\n\nPRIOR-PHASE CONTEXT (concise — do NOT re-scan or re-run PoCs):"]
    verification = meta.get("verification")
    if isinstance(verification, dict) and verification:
        parts.append(
            "\n[P10 verification] "
            f"sandbox_available={_flag_is_true(verification.get('sandbox_available'))}, "
            f"pocs_requested={verification.get('poc_requested_count', 0)}, "
            f"pocs_executed={verification.get('poc_executed_count', 0)}, "
            f"pocs_skipped={verification.get('poc_skipped_count', 0)}"
        )
        if not _flag_is_true(verification.get("sandbox_available")):
            parts.append(
                "\n  NOTE: the P10 sandbox was UNAVAILABLE — executed PoCs did NOT "
                "run in isolation; treat those findings as UNVERIFIED."
            )
    else:
        parts.append("\n[P10 verification] no verification data available")
    parts.append("\n\n" + _prior_phase_block(meta, "P8_TRIAGE"))
    parts.append(
        "\n\nSCOPE (v1): note whether previously-identified findings appear "
        "remediated based ONLY on the above context; do NOT perform an automated "
        "re-scan or diff against prior findings (deferred to v2)."
    )
    return base_task + "".join(parts)


# ---------------------------------------------------------------------------
# P9 augmentation-rule writing (port of _write_augment_rules /
# _write_single_augment_rule) — path-traversal contained.
# ---------------------------------------------------------------------------


def _yaml_parses(content: Any) -> bool:
    if not isinstance(content, str) or not content.strip():
        return False
    if _yaml is None:  # pragma: no cover - environment-dependent
        return True
    try:
        return _yaml.safe_load(content) is not None
    except Exception:
        return False


def _extract_new_rules(result: dict) -> list:
    raw = _extract_field(result, "new_rules")
    if not isinstance(raw, list):
        return []
    return [entry for entry in raw if isinstance(entry, dict)]


def write_augment_rules(meta: dict, result: dict) -> list:
    """Write P9-authored new_rules into {output_dir}/targeted/custom-rules/.

    Containment enforced with targeted_scan._is_within (path-traversal safe).
    Never raises: every per-rule failure is recorded on meta['augment_rule_errors']
    and the loop continues. Returns the absolute paths actually written."""
    from targeted_scan import (  # lazy skill-dir imports
        TARGETED_RULES_SUBPATH,
        _RULE_EXTENSIONS,
        _is_within as _targeted_is_within,
    )

    def _record(message: str) -> None:
        meta.setdefault("augment_rule_errors", []).append(message)

    new_rules = _extract_new_rules(result)
    if not new_rules:
        return []
    rules_base = Path(meta.get("output_dir", "")).resolve() / TARGETED_RULES_SUBPATH
    try:
        rules_base.mkdir(parents=True, exist_ok=True)
    except OSError as exc:  # pragma: no cover - defensive
        _record(f"could not create targeted-rules directory: {exc}")
        return []
    written: list = []
    for entry in new_rules:
        filename = entry.get("filename")
        content = entry.get("yaml_content")
        if not isinstance(filename, str) or not filename.strip():
            _record("rule skipped: missing/blank filename")
            continue
        if not _yaml_parses(content):
            _record(f"rule {filename!r} skipped: yaml_content empty or does not parse")
            continue
        ext = os.path.splitext(filename)[1].lower()
        if ext not in _RULE_EXTENSIONS:
            _record(
                f"rule {filename!r} skipped: not a {'/'.join(_RULE_EXTENSIONS)} rule "
                f"file (would never be picked up by the targeted scan)"
            )
            continue
        candidate = rules_base / filename
        try:
            contained = _targeted_is_within(rules_base, candidate)
        except Exception:
            contained = False
        if not contained:
            _record(
                f"rule {filename!r} REFUSED: resolves OUTSIDE the targeted-rules "
                f"directory or is not a valid path (path-traversal containment)"
            )
            continue
        try:
            candidate.parent.mkdir(parents=True, exist_ok=True)
            if not _targeted_is_within(rules_base, candidate):
                _record(f"rule {filename!r} REFUSED post-mkdir: escapes containment")
                continue
            candidate.write_text(content, encoding="utf-8")
        except (OSError, ValueError) as exc:  # pragma: no cover - defensive
            _record(f"rule {filename!r} write failed: {exc}")
            continue
        written.append(str(candidate.resolve()))
    if written:
        meta.setdefault("augment_rules_written", []).extend(written)
    return written


# ---------------------------------------------------------------------------
# Cross-run persistence for augment rules (self-improving SAST).
#
# write_augment_rules() above writes rules into the RUN's output_dir for the
# within-run re-scan. persist_learned_rules() ALSO writes the valid ones to the
# shared, per-tool learned dir so FUTURE sca runs load them (via the SCA preset
# entry "learned/sca" in baseline_scan.SCA_PRESET_RULESET_PATHS). Each rule is
# `semgrep --validate`-checked BEFORE it lands, so a malformed rule can never
# break a future baseline scan. Storage route mirrors jsa (learned/<skill>/).
# ---------------------------------------------------------------------------

_MAX_PERSIST_RULES = 20


def _learned_sca_dir() -> Optional[Path]:
    """Resolve .pi/extensions/semgrep/rules/learned/sca by walking up from this
    file (mirrors baseline_scan._rules_base_discovery)."""
    here = Path(__file__).resolve().parent
    for anc in [here, *here.parents][:8]:
        base = anc / ".pi" / "extensions" / "semgrep" / "rules"
        if base.is_dir():
            return base / "learned" / "sca"
    return None


def _yaml_is_semgrep_rule(content: Any) -> bool:
    if not isinstance(content, str) or not content.strip():
        return False
    if _yaml is None:  # no pyyaml — defer to semgrep --validate
        return True
    try:
        doc = _yaml.safe_load(content)
    except Exception:  # noqa: BLE001
        return False
    return isinstance(doc, dict) and isinstance(doc.get("rules"), list) and bool(doc["rules"])


def _semgrep_validates(yaml_content: str) -> bool:
    """`semgrep --validate` on the rule in a TEMP file (never the rules tree).
    Absent semgrep -> accept (parse gate ran); a crash -> reject (fail closed)."""
    import shutil
    import subprocess
    import tempfile

    semgrep = shutil.which("semgrep")
    if not semgrep:
        return True
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as tf:
        tf.write(yaml_content)
        tmp = tf.name
    try:
        res = subprocess.run(
            [semgrep, "--validate", "--config", tmp, "--metrics=off"],
            capture_output=True, text=True, timeout=60,
        )
        return res.returncode == 0
    except FileNotFoundError:
        return True
    except Exception:  # noqa: BLE001
        return False
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def persist_learned_rules(meta: dict, result: dict, dest_dir: Optional[Path] = None) -> list:
    """Validate P9-authored new_rules and persist the valid ones to the shared
    learned dir so future sca runs load them. Records paths on
    ``meta['augment_rules_persisted']`` and failures on
    ``meta['augment_persist_errors']``. Never raises."""
    from targeted_scan import _RULE_EXTENSIONS

    def _err(msg: str) -> None:
        meta.setdefault("augment_persist_errors", []).append(msg)

    new_rules = _extract_new_rules(result)
    if not new_rules:
        return []
    base = dest_dir if dest_dir is not None else _learned_sca_dir()
    if base is None:
        _err("learned/sca dir unresolved")
        return []
    # Resolve the containment root WITHOUT creating it — the dir is created
    # lazily only when a rule actually passes every gate, so an all-rejected run
    # never leaves an empty config dir behind.
    base_resolved = base.resolve()
    written: list = []
    for entry in new_rules[:_MAX_PERSIST_RULES]:
        filename = entry.get("filename")
        content = entry.get("yaml_content")
        if not isinstance(filename, str) or not filename.strip():
            _err("rule skipped: missing/blank filename")
            continue
        if os.path.splitext(filename)[1].lower() not in _RULE_EXTENSIONS:
            _err(f"{filename}: not a .yml/.yaml rule file")
            continue
        if not _yaml_is_semgrep_rule(content):
            _err(f"{filename}: yaml_content is not a semgrep rule (no rules: list)")
            continue
        safe = "".join(c for c in os.path.basename(filename.strip()) if c.isalnum() or c in "._-")
        if not safe.endswith(_RULE_EXTENSIONS):
            safe = (safe or "rule") + ".yaml"
        candidate = (base / safe).resolve()
        if not str(candidate).startswith(str(base_resolved) + os.sep):
            _err(f"{filename}: path-traversal refused")
            continue
        if not _semgrep_validates(content):
            _err(f"{filename}: semgrep --validate failed")
            continue
        try:
            base.mkdir(parents=True, exist_ok=True)  # lazy: only when a rule lands
            candidate.write_text(content, encoding="utf-8")
        except OSError as exc:
            _err(f"{filename}: write failed: {exc}")
            continue
        written.append(str(candidate))
    for entry in new_rules[_MAX_PERSIST_RULES:]:
        _err(f"{entry.get('filename', '?')}: exceeds per-run cap of {_MAX_PERSIST_RULES}")
    if written:
        meta.setdefault("augment_rules_persisted", []).extend(written)
    return written


# ---------------------------------------------------------------------------
# P10 single-shot PoC processing (port of _process_verification_pocs and its
# helpers). The sandbox runner + docker check are injected so tests never need
# Docker (the playbook's _run_pocs seam is what tests override).
# ---------------------------------------------------------------------------


def _extract_run_pocs(result: Any) -> list:
    raw = _extract_field(result, "run_pocs")
    if not isinstance(raw, list):
        return []
    return [entry for entry in raw if isinstance(entry, dict)]


def _poc_entry_valid(entry: dict) -> tuple:
    name = entry.get("name")
    if not isinstance(name, str) or not name.strip():
        return False, "missing/blank 'name'"
    script = entry.get("script")
    if not isinstance(script, str) or not script.strip():
        return False, "missing/blank/whitespace-only 'script'"
    if entry.get("non_destructive") is not True:
        return False, (
            "'non_destructive' is not the literal boolean True "
            "(missing/False/\"true\"/1 are all rejected, never coerced)"
        )
    return True, ""


def _safe_poc_filename(name: str) -> str:
    cleaned = "".join(c if (c.isalnum() or c in "._-") else "_" for c in name).lstrip(".")
    cleaned = cleaned or "poc"
    return cleaned[:80]


def process_verification_pocs(
    meta: dict,
    result: dict,
    *,
    sandbox_runner: Optional[Callable[..., dict]] = None,
    docker_available_check: Optional[Callable[[], bool]] = None,
) -> dict:
    """Execute vera's single-shot run_pocs batch ONCE and persist raw results.

    Each valid PoC runs EXACTLY ONCE through the sandbox; results are recorded
    ``poc_executed_pending_review`` (never auto pass/fail). Records with a
    matching finding_id are appended to that finding's poc_execution list.
    Writes verify/pocs/{name}.log + verify/coverage.md. Never raises."""
    if sandbox_runner is None or docker_available_check is None:
        from sandbox import default_docker_available_check, run_in_sandbox
        if sandbox_runner is None:
            sandbox_runner = run_in_sandbox
        if docker_available_check is None:
            docker_available_check = default_docker_available_check

    from targeted_scan import _is_within as _targeted_is_within  # lazy

    output_dir = meta.get("output_dir", "")
    target_path = meta.get("target_path", "")
    session_id = meta.get("session_id", "")

    pocs = _extract_run_pocs(result)
    executed: list = []
    skipped: list = []
    verify_dir = Path(output_dir) / "verify"
    pocs_dir = verify_dir / "pocs"
    try:
        pocs_dir.mkdir(parents=True, exist_ok=True)
    except OSError:  # pragma: no cover - defensive
        pass

    for index, entry in enumerate(pocs):
        if index >= MAX_POCS_PER_BATCH:
            skipped.append({
                "name": entry.get("name"),
                "reason": f"batch cap ({MAX_POCS_PER_BATCH}) exceeded; entry not executed",
            })
            continue
        ok, reason = _poc_entry_valid(entry)
        if not ok:
            skipped.append({"name": entry.get("name"), "reason": reason})
            continue
        finding_id = entry.get("finding_id")
        sandbox_result = sandbox_runner(
            entry["script"], target_path, docker_available_check=docker_available_check
        )
        record = {
            "name": entry["name"],
            "finding_id": finding_id if isinstance(finding_id, str) else None,
            "verification_status": VERIFICATION_STATUS_PENDING,
            "exit_code": sandbox_result.get("exit_code"),
            "timed_out": bool(sandbox_result.get("timed_out")),
            "sandbox_used": bool(sandbox_result.get("sandbox_used")),
            "duration_s": sandbox_result.get("duration_s"),
            "reason": sandbox_result.get("reason", ""),
            "stdout": sandbox_result.get("stdout", ""),
            "stderr": sandbox_result.get("stderr", ""),
        }
        _persist_poc_log(pocs_dir, record, _targeted_is_within)
        executed.append(record)
        if isinstance(finding_id, str) and finding_id.strip():
            record["finding_matched"] = _attach_poc_to_finding(
                output_dir, finding_id, record
            )

    try:
        sandbox_available = bool(docker_available_check())
    except Exception:  # pragma: no cover - defensive
        sandbox_available = False

    summary = {
        "executed": executed,
        "skipped": skipped,
        "sandbox_available": sandbox_available,
        "poc_requested_count": len(pocs),
        "poc_executed_count": len(executed),
        "poc_skipped_count": len(skipped),
    }
    meta["verification"] = summary
    _persist_verification_coverage(verify_dir, summary, session_id, target_path)
    return summary


def _persist_poc_log(pocs_dir: Path, record: dict, is_within: Callable) -> None:
    stem = _safe_poc_filename(str(record.get("name", "poc")))
    log_path = pocs_dir / f"{stem}.log"
    try:
        if not is_within(pocs_dir, log_path):
            return
    except Exception:  # pragma: no cover - defensive
        return
    body = (
        f"# PoC: {record.get('name')}\n"
        f"# finding_id: {record.get('finding_id')}\n"
        f"# verification_status: {record.get('verification_status')}\n"
        f"# sandbox_used: {record.get('sandbox_used')}\n"
        f"# exit_code: {record.get('exit_code')}\n"
        f"# timed_out: {record.get('timed_out')}\n"
        f"# duration_s: {record.get('duration_s')}\n"
        f"# reason: {record.get('reason')}\n"
        f"\n--- STDOUT ---\n{record.get('stdout', '')}\n"
        f"\n--- STDERR ---\n{record.get('stderr', '')}\n"
    )
    try:
        log_path.write_text(body, encoding="utf-8")
    except OSError:  # pragma: no cover - defensive
        pass


def _attach_poc_to_finding(output_dir: str, finding_id: str, record: dict) -> bool:
    base = Path(output_dir)
    for rel in ("targeted/findings.json", "baseline/findings.json"):
        path = base / rel
        try:
            if not path.is_file():
                continue
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):  # pragma: no cover
            continue
        findings = doc.get("findings") if isinstance(doc, dict) else None
        if not isinstance(findings, list):
            continue
        matched = False
        for finding in findings:
            if isinstance(finding, dict) and finding.get("id") == finding_id:
                bucket = finding.get("poc_execution")
                if not isinstance(bucket, list):
                    bucket = []
                bucket.append(record)
                finding["poc_execution"] = bucket
                finding["verification_status"] = VERIFICATION_STATUS_PENDING
                matched = True
        if matched:
            try:
                path.write_text(json.dumps(doc, indent=2, default=str), encoding="utf-8")
            except OSError:  # pragma: no cover - defensive
                pass
            return True
    return False


def _persist_verification_coverage(
    verify_dir: Path, summary: dict, session_id: str, target_path: str
) -> None:
    try:
        verify_dir.mkdir(parents=True, exist_ok=True)
    except OSError:  # pragma: no cover - defensive
        return
    executed = summary.get("executed", [])
    skipped = summary.get("skipped", [])
    lines = [
        "# P10 Verification — PoC Coverage Report",
        "",
        f"- session: `{session_id}`",
        f"- target: `{target_path}`",
        f"- sandbox available (Docker): "
        f"{'yes' if _flag_is_true(summary.get('sandbox_available')) else 'NO'}",
        f"- PoCs requested: {summary.get('poc_requested_count', 0)}",
        f"- PoCs executed: {summary.get('poc_executed_count', 0)}",
        f"- PoCs skipped: {summary.get('poc_skipped_count', 0)}",
        "",
        "> NOTE: verification_status is "
        f"`{VERIFICATION_STATUS_PENDING}` for every executed PoC — the "
        "orchestrator records RAW results only and NEVER auto-decides a "
        "pass/fail verdict (a human/later-phase judgement).",
        "",
        "## PoCs executed",
    ]
    if executed:
        for rec in executed:
            fid = rec.get("finding_id") or "(no finding_id)"
            matched = rec.get("finding_matched")
            mtag = (
                " [linked]" if matched
                else (" [unmatched finding_id]" if rec.get("finding_id") else "")
            )
            lines.append(
                f"- `{rec.get('name')}` → finding {fid}{mtag}: "
                f"sandbox_used={rec.get('sandbox_used')}, "
                f"exit_code={rec.get('exit_code')}, "
                f"timed_out={rec.get('timed_out')}, "
                f"status={rec.get('verification_status')}"
            )
    else:
        lines.append("- none (no valid PoCs were requested/executed)")
    lines += ["", "## PoCs skipped (not executed)"]
    if skipped:
        for rec in skipped:
            lines.append(f"- `{rec.get('name')}`: {rec.get('reason')}")
    else:
        lines.append("- none")
    lines.append("")
    if not _flag_is_true(summary.get("sandbox_available")):
        lines += [
            "## ⚠️ Sandbox unavailable\n\n"
            "Docker was not available: any PoC above with `sandbox_used=False` "
            "did NOT run in isolation. This is NOT a clean/passing result — it is "
            "an explicit coverage gap.",
            "",
        ]
    try:
        (verify_dir / "coverage.md").write_text("\n".join(lines), encoding="utf-8")
    except OSError:  # pragma: no cover - defensive
        pass


# ---------------------------------------------------------------------------
# P12 report artifacts (port of _build_report_artifacts + the writers). All from
# ALREADY-ACCUMULATED real pipeline data — never fabricated.
# ---------------------------------------------------------------------------


def _escape_md_cell(value: Any) -> str:
    return str(value).replace("|", "\\|")


def _severity_counts(findings: list) -> dict:
    counts: dict = {}
    for f in findings:
        sev = str(f.get("severity", "unknown") or "unknown").lower()
        counts[sev] = counts.get(sev, 0) + 1
    return counts


def _augment_iterations(meta: dict) -> int:
    try:
        return int(meta.get("augment_iterations", 0) or 0)
    except (TypeError, ValueError, OverflowError):  # pragma: no cover - defensive
        return 0


def _resolve_findings_source(meta: dict) -> tuple:
    targeted = meta.get("targeted_scan")
    baseline = meta.get("baseline_scan")
    t_completed = isinstance(targeted, dict) and _flag_is_true(targeted.get("completed"))
    t_semgrep = isinstance(targeted, dict) and _flag_is_true(targeted.get("semgrep_available"))
    b_completed = isinstance(baseline, dict) and _flag_is_true(baseline.get("completed"))
    if t_completed and t_semgrep:
        return ("targeted", targeted.get("findings_path"), False)
    if b_completed:
        return ("baseline", baseline.get("findings_path"), bool(t_completed and not t_semgrep))
    if t_completed:
        return ("targeted (degraded)", targeted.get("findings_path"), True)
    return (None, None, False)


def _load_findings_from_path(path: Any) -> list:
    if not isinstance(path, str) or not path:
        return []
    try:
        p = Path(path)
        if not p.is_file():
            return []
        doc = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    findings = doc.get("findings") if isinstance(doc, dict) else None
    if not isinstance(findings, list):
        return []
    return [f for f in findings if isinstance(f, dict)]


def build_report_artifacts(meta: dict) -> dict:
    """Deterministically compute + persist ALL P12 report artifacts, returning a
    concise summary dict (also stored at meta['report']). Never raises."""
    session_id = meta.get("session_id", "")
    target_path = meta.get("target_path", "")
    report_dir = Path(meta.get("output_dir", "")) / "report"
    try:
        report_dir.mkdir(parents=True, exist_ok=True)
    except OSError:  # pragma: no cover - defensive
        pass

    label, path, degraded = _resolve_findings_source(meta)
    findings = _load_findings_from_path(path)
    severity_counts = _severity_counts(findings)

    _write_report_findings(meta, report_dir, findings, label, path, degraded, severity_counts)
    _write_coverage_md(meta, report_dir, label, degraded)
    _write_requirement_coverage_md(meta, report_dir)
    _write_prose_coverage_md(
        meta, report_dir, "threat-coverage.md",
        title="Threat Coverage (T-###)", id_label="T-###", phase="P6_THREAT_MODEL",
    )
    _write_residual_risk_md(meta, report_dir, findings, severity_counts)

    verification = meta.get("verification")
    sandbox_available = (
        _flag_is_true(verification.get("sandbox_available"))
        if isinstance(verification, dict) else False
    )
    summary = {
        "report_dir": str(report_dir),
        "findings_source": label or "none",
        "findings_source_degraded": bool(degraded),
        "total_findings": len(findings),
        "severity_counts": severity_counts,
        "augment_capped": _flag_capped(meta.get("augment_capped", False)),
        "sandbox_available": sandbox_available,
        "verification_present": bool(isinstance(verification, dict) and verification),
    }
    meta["report"] = summary
    return summary


def _write_report_findings(meta, report_dir, findings, label, path, degraded, severity_counts):
    doc = {
        "schema_version": 1,
        "session_id": meta.get("session_id", ""),
        "target_path": meta.get("target_path", ""),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "findings_source": label or "none",
        "findings_source_path": path if isinstance(path, str) else None,
        "findings_source_degraded": bool(degraded),
        "total_findings": len(findings),
        "severity_counts": severity_counts,
        "findings": findings,
    }
    try:
        (report_dir / "findings.json").write_text(
            json.dumps(doc, indent=2, default=str), encoding="utf-8"
        )
    except OSError:  # pragma: no cover - defensive
        pass


def _write_coverage_md(meta, report_dir, label, degraded):
    session_id = meta.get("session_id", "")
    target_path = meta.get("target_path", "")
    census = meta.get("census")
    baseline = meta.get("baseline_scan")
    targeted = meta.get("targeted_scan")
    lines = [
        "# Coverage Matrix",
        "",
        f"- session: `{session_id}`",
        f"- target: `{target_path}`",
        f"- findings source: **{label or 'none'}**"
        + (" (DEGRADED — semgrep unavailable at P7; fell back to baseline)"
           if degraded else ""),
        "",
        "## File-type coverage (from the P1 census)",
        "",
    ]
    if isinstance(census, dict) and census:
        total_loc = int(census.get("js_ts_loc", 0) or 0) + int(census.get("uncovered_loc", 0) or 0)
        lines += [
            "| File class | Files | LOC | In SAST lane |",
            "| --- | --- | --- | --- |",
            f"| JS/TS (analyzable) | {census.get('js_ts_files', 0)} | "
            f"{census.get('js_ts_loc', 0)} | yes |",
            f"| UNCOVERED (non-JS/TS) | {census.get('uncovered_files', 0)} | "
            f"{census.get('uncovered_loc', 0)} | NO |",
            f"| **total** | {census.get('total_files', 0)} | {total_loc} | — |",
            "",
            "> UNCOVERED (non-JS/TS) files are outside the JS/TS SAST lane — an "
            "explicit, honest coverage gap, NOT a clean result.",
            "",
        ]
    else:
        lines += ["_No P1 census data available._", ""]
    lines += ["## Tool coverage", "", "| Tool (phase) | Status | Notes |", "| --- | --- | --- |"]
    if isinstance(baseline, dict) and baseline:
        for tool in baseline.get("available", []) or []:
            lines.append(f"| {tool} (P2 baseline) | ran | — |")
        for gap in baseline.get("coverage_gaps", []) or []:
            if isinstance(gap, dict):
                lines.append(
                    f"| {gap.get('tool')} (P2 baseline) | UNAVAILABLE | {gap.get('reason', '')} |"
                )
    else:
        lines.append("| (P2 baseline) | no data | baseline metadata absent |")
    if isinstance(targeted, dict) and targeted:
        semg = _flag_is_true(targeted.get("semgrep_available"))
        lines.append(
            f"| semgrep (P7 targeted) | {'ran' if semg else 'UNAVAILABLE'} | "
            f"authored/targeted rules |"
        )
        for gap in targeted.get("coverage_gaps", []) or []:
            if isinstance(gap, dict):
                lines.append(
                    f"| {gap.get('tool')} (P7 targeted) | UNAVAILABLE | {gap.get('reason', '')} |"
                )
    else:
        lines.append("| (P7 targeted) | no data | targeted metadata absent |")
    baseline_has_semgrep = isinstance(baseline, dict) and "semgrep" in (baseline.get("available") or [])
    targeted_has_semgrep_row = isinstance(targeted, dict) and bool(targeted)
    if baseline_has_semgrep and targeted_has_semgrep_row:
        lines += [
            "",
            "> The two `semgrep` rows above are DISTINCT pipeline phases — the P2 "
            "baseline scan and the P7 targeted (authored-rules) scan — not a "
            "duplicate. In a degraded run the P2 baseline can have run while P7 "
            "targeted was unavailable.",
        ]
    lines.append("")
    try:
        (report_dir / "coverage.md").write_text("\n".join(lines), encoding="utf-8")
    except OSError:  # pragma: no cover - defensive
        pass


def _extract_security_requirements(raw: Any) -> list:
    if not isinstance(raw, dict):
        return []
    srs = raw.get("security_requirements")
    if not isinstance(srs, list):
        return []
    return [s for s in srs if isinstance(s, dict) and s.get("sr_id")]


def _write_requirement_coverage_md(meta, report_dir):
    raw = get_phase_result(meta, "P5_REQUIREMENTS")
    srs = _extract_security_requirements(raw)
    if not srs:
        _write_prose_coverage_md(
            meta, report_dir, "requirement-coverage.md",
            title="Requirement Coverage (SR-###)", id_label="SR-###", phase="P5_REQUIREMENTS",
        )
        return
    lines = [
        "# Requirement Coverage (SR-###)",
        "",
        f"> Rendered from the STRUCTURED `security_requirements` list captured in "
        f"P5_REQUIREMENTS ({len(srs)} requirement(s)). Every row below is a real "
        f"`SR-###` that P5 emitted — none are fabricated here.",
        "",
        "| SR-### | ASVS | Requirement | Status |",
        "| --- | --- | --- | --- |",
    ]
    for sr in srs:
        lines.append(
            f"| {_escape_md_cell(sr.get('sr_id', 'SR-???'))} "
            f"| {_escape_md_cell(sr.get('asvs', 'none-applicable'))} "
            f"| {_escape_md_cell(sr.get('text', ''))} "
            f"| {_escape_md_cell(sr.get('status', 'derived (P5)'))} |"
        )
    lines += [
        "",
        "> Per-finding coverage linkage (which finding or `T-###` threat satisfies "
        "each `SR-###`) is not yet tracked structurally — the Status column "
        "reflects only that the requirement was DERIVED in P5, not that it was "
        "verified. A full SR-→finding coverage mapping is a documented v2 gap.",
        "",
    ]
    try:
        (report_dir / "requirement-coverage.md").write_text("\n".join(lines), encoding="utf-8")
    except OSError:  # pragma: no cover - defensive
        pass


def _write_prose_coverage_md(meta, report_dir, filename, title, id_label, phase):
    raw = get_phase_result(meta, phase)
    lines = [
        f"# {title}",
        "",
        f"> **v1 LIMITATION (honest disclosure):** No formal `{id_label}` "
        f"structured coverage ledger exists in this version of the sca skill. "
        f"{phase} remains an agent-prose dispatch, NOT a structured-data extractor "
        f"— so this file does **NOT** contain real structured coverage tracking. "
        f"The content below is the RAW captured {phase} agent output, included as "
        f"informational context ONLY. Building a true `{id_label}` ledger is a "
        f"documented, acknowledged v2 gap.",
        "",
        f"## Raw {phase} agent output (raw agent output, not structured coverage data)",
        "",
    ]
    if isinstance(raw, dict) and raw:
        try:
            rendered = json.dumps(raw, indent=2, default=str)
        except Exception:  # pragma: no cover - defensive
            rendered = _summarize_prior_result(raw)
        lines += ["```json", rendered, "```"]
    else:
        lines.append(f"_No captured {phase} agent output is available._")
    lines.append("")
    try:
        (report_dir / filename).write_text("\n".join(lines), encoding="utf-8")
    except OSError:  # pragma: no cover - defensive
        pass


def _write_residual_risk_md(meta, report_dir, findings, severity_counts):
    session_id = meta.get("session_id", "")
    verification = meta.get("verification")
    sandbox_available = (
        _flag_is_true(verification.get("sandbox_available"))
        if isinstance(verification, dict) else False
    )
    augment_capped = _flag_capped(meta.get("augment_capped", False))
    _raw_iters = meta.get("augment_iterations")
    augment_cap_inconsistent = (
        augment_capped and _raw_iters is not None and _augment_iterations(meta) == 0
    )
    verification_present = bool(isinstance(verification, dict) and verification)
    lines = [
        "# Residual Risk",
        "",
        f"- session: `{session_id}`",
        f"- open findings (total): {len(findings)}",
        "",
        "## Open findings by severity",
        "",
    ]
    if severity_counts:
        lines += ["| Severity | Count |", "| --- | --- |"]
        for sev in _SEVERITY_ORDER:
            if sev in severity_counts:
                lines.append(f"| {_escape_md_cell(sev)} | {severity_counts[sev]} |")
        for sev, cnt in sorted(severity_counts.items()):
            if sev not in _SEVERITY_ORDER:
                lines.append(f"| {_escape_md_cell(sev)} | {cnt} |")
    else:
        lines.append("_No findings recorded._")
    lines += ["", "## Augmentation-loop completeness", ""]
    if augment_cap_inconsistent:
        lines.append(
            "⚠️ The augmentation-cap flag is set (**CAPPED** reported) but the "
            "granted-iteration counter is 0 — an INCONSISTENT state (a cap cannot "
            "have been reached without any granted iterations). This likely "
            "indicates tampered or corrupt session state; treat augmentation "
            "coverage as UNKNOWN (neither exhaustive nor genuinely capped-after-work)."
        )
    elif augment_capped:
        lines.append(
            "⚠️ The P9→P7 augmentation loop was **CAPPED**: further rule-authoring "
            "iterations were refused once the iteration cap was reached. Some "
            "potential targeted-rule iterations may not have run — coverage is NOT "
            "guaranteed exhaustive."
        )
    else:
        lines.append(
            "The augmentation loop was not capped (it completed within its "
            "iteration budget, or was not exercised this session)."
        )
    lines += ["", "## PoC verification status", ""]
    if not verification_present:
        lines.append(
            "No P10 verification data is present — findings are UNVERIFIED (no PoC "
            "execution recorded)."
        )
    elif not sandbox_available:
        lines.append(
            "⚠️ P10's sandbox (Docker) was **UNAVAILABLE**: no PoC executed in "
            "isolation. Findings are UNVERIFIED / pending review — an explicit "
            "coverage gap, NOT a clean verified result."
        )
    else:
        executed = verification.get("poc_executed_count", 0) if isinstance(verification, dict) else 0
        lines.append(
            f"P10's sandbox was available; {executed} PoC(s) executed. Every "
            f"executed PoC is recorded as `{VERIFICATION_STATUS_PENDING}` — raw "
            "evidence pending human review, never an auto-decided pass/fail verdict."
        )
    lines.append("")
    try:
        (report_dir / "residual-risk.md").write_text("\n".join(lines), encoding="utf-8")
    except OSError:  # pragma: no cover - defensive
        pass


def enrich_report_task(meta: dict, base_task: str, report_summary: dict) -> str:
    sc = report_summary.get("severity_counts", {})
    return base_task + "".join([
        "\n\nREPORT DATA (real, pre-computed by the orchestrator — the "
        "authoritative artifacts already live at "
        f"{report_summary.get('report_dir')}; REFERENCE this data, do NOT "
        "fabricate findings or coverage):",
        f"\n- findings source: {report_summary.get('findings_source')}"
        + (" (DEGRADED)" if report_summary.get("findings_source_degraded") else ""),
        f"\n- total findings: {report_summary.get('total_findings', 0)}",
        f"\n- severity breakdown: {_compact_value(sc)}",
        f"\n- augmentation loop capped: {report_summary.get('augment_capped')}",
        f"\n- PoC sandbox available: {report_summary.get('sandbox_available')}",
        "\n\nYOUR OUTPUT CONTRACT: return your human-readable narrative "
        "(executive summary + remediation guidance) under the top-level result "
        f"key `{SKRIBBLE_REPORT_KEY}` (a markdown string). The orchestrator writes "
        "it to report/report.md (size-bounded). Reference the real findings.json / "
        "coverage.md / residual-risk.md — do NOT invent findings. See "
        "assets/prompts/skribble-report.md for the full contract.",
    ])


def write_skribble_report(meta: dict, result: dict) -> bool:
    """Write skribble's report_md to report/report.md (bounded), or an HONEST
    fallback. Returns True iff a valid non-blank narrative was persisted."""
    report_dir = Path(meta.get("output_dir", "")) / "report"
    try:
        report_dir.mkdir(parents=True, exist_ok=True)
    except OSError:  # pragma: no cover - defensive
        pass
    report_md = _extract_field(result, SKRIBBLE_REPORT_KEY)
    is_valid = isinstance(report_md, str) and report_md.strip() != ""
    if is_valid:
        body = report_md
        if len(body) > REPORT_MD_MAX_CHARS:
            body = body[:REPORT_MD_MAX_CHARS] + "\n\n…[report.md truncated by orchestrator size bound]"
    else:
        body = _fallback_report_md(meta)
    try:
        (report_dir / "report.md").write_text(body, encoding="utf-8")
    except OSError:  # pragma: no cover - defensive
        pass
    report_meta = meta.get("report")
    if isinstance(report_meta, dict):
        report_meta["report_md_written"] = True
        report_meta["report_md_fallback"] = not is_valid
    meta["report_md_present"] = bool(is_valid)
    return bool(is_valid)


def _fallback_report_md(meta: dict) -> str:
    report = meta.get("report")
    report = report if isinstance(report, dict) else {}
    return (
        "# Secure-Code Analysis Report — NARRATIVE UNAVAILABLE\n\n"
        "> **Honest fallback:** skribble did not return a valid "
        f"`{SKRIBBLE_REPORT_KEY}` narrative, so no human-readable narrative could "
        "be generated. This is NOT a clean/empty result — the AUTHORITATIVE "
        "analysis data is the machine-generated artifacts in this directory:\n\n"
        "- `findings.json` — the real accumulated findings (never fabricated)\n"
        "- `coverage.md` — census + tool-coverage matrix\n"
        "- `requirement-coverage.md` / `threat-coverage.md` — coverage context\n"
        "- `residual-risk.md` — open findings by severity, augmentation-cap and "
        "PoC-verification disclosures\n\n"
        f"Findings source: {report.get('findings_source', 'unknown')}; total "
        f"findings: {report.get('total_findings', 'unknown')}; severity: "
        f"{report.get('severity_counts', {})}.\n"
    )
