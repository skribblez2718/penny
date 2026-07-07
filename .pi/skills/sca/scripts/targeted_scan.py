"""
sca Skill — P7_TARGETED_SCAN tool execution (Phase 7).

This module is the deterministic, in-process execution engine for the
P7_TARGETED_SCAN phase. Like P2_BASELINE_SCAN (Phase 6a), the orchestrator
classifies P7 as a ``'tool'`` phase (see orchestrate.PHASE_KIND) and calls
``execute_targeted_scan`` SYNCHRONOUSLY — never via an LLM agent.

WHY A SEPARATE MODULE (not an extension of baseline_scan.py):
  P7 shares P2's semgrep-invocation primitive but differs in three ways that
  keep it a distinct concern:
    1. It is semgrep-ONLY (no osv-scanner/gitleaks — dependency/secrets scanning
       stays P2's job).
    2. It MERGES/DEDUPES its findings against P2's already-persisted baseline
       rather than producing a standalone set.
    3. It is best-effort (NEVER blocks the pipeline) and re-entrant (the
       augmentation loop re-runs it).
  To avoid duplicating the semgrep-invocation logic verbatim, we REUSE
  ``baseline_scan.run_semgrep`` (and its ruleset-resolution helpers). Only the
  P7-specific merge/persistence wiring lives here.

WHAT P7 SCANS:
  * The SAME ``SCA_PRESET_RULESET_PATHS`` local rule set P2 uses (resolved via
    baseline_scan.default_semgrep_config_paths) — the "base preset".
  * PLUS any rule files present under the well-known, initially-EMPTY directory
    ``{output_dir}/targeted/custom-rules/``. On a first pass this is empty; the
    future P9 augmentation loop (Phase 8) will author rules there. This phase
    only proves the pickup/merge mechanism works when something is placed there.

MERGE SEMANTICS:
  P7's newly-found findings are combined with the PRIOR accumulated findings
  (P2's baseline on a first pass, or the current targeted/findings.json on a
  re-entrant pass) and deduplicated via dedup.deduplicate_findings (0.85
  threshold, same primitives as Phase 5/6a). The net result is the prior set
  PLUS genuinely-new findings, with duplicates collapsed — never a naive
  concatenation.

IDEMPOTENCY (nuanced, documented — IDEAL_STATE edge case):
  Unlike P2's simple "do not re-run the subprocess on resume" guard, P7 has NO
  such guard because the augmentation loop legitimately re-runs it. Instead,
  idempotency is guaranteed STRUCTURALLY: finding ids are content-derived
  (normalize._make_id) and dedup collapses identical findings, so re-running P7
  with UNCHANGED rules against the CURRENT accumulated set yields an identical
  merged set — the findings set never grows without genuinely-new findings.

SECURITY:
  * Every subprocess call is ARRAY-FORM (via baseline_scan.run_semgrep) — never
    a shell-interpolated string.
  * The targeted-rules directory is CONTAINED within output_dir: its resolved
    path (symlinks followed) must stay inside the resolved output_dir, and any
    individual rule file that resolves outside output_dir is skipped. A
    directory that symlinks outside output_dir is refused entirely (recorded as
    a coverage gap), mirroring the containment discipline hardened in the
    Phase 7 skillContext fix.
  * A malformed/invalid targeted rule file surfaces a real semgrep parse error;
    P7 isolates it (the targeted-rules scan is a SEPARATE semgrep invocation
    from the base-preset scan), records a coverage gap, and preserves the
    base-preset findings — it never crashes the whole phase over one bad rule.

CONFIDENCE: semgrep path — CERTAIN (genuinely installed; exercised live by the
test suite, not mocked).
"""

from __future__ import annotations

import dataclasses
import json
import logging
import os
import shutil
import subprocess
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from baseline_scan import (
    DEDUP_THRESHOLD,
    DEFAULT_TIMEOUT,
    _tool_version,
    default_semgrep_config_paths,
    run_semgrep,
)
from cvss4_map import (
    canonical_cvss_tier,
    compute_cvss4_score,
    suggest_cvss4_vector,
)
from dedup import deduplicate_findings
from normalize import NormalizedFinding
from provisioning import check_tool_installed

logger = logging.getLogger("sca.targeted_scan")

# The well-known, initially-empty "targeted rules" directory (relative to
# output_dir). Future P9 rule-authoring (Phase 8) populates it; this phase only
# detects+includes whatever is present.
TARGETED_RULES_SUBPATH = os.path.join("targeted", "custom-rules")

# Rule-file extensions semgrep understands.
_RULE_EXTENSIONS = (".yml", ".yaml")

# NormalizedFinding field names (for reconstructing persisted dicts).
_FINDING_FIELDS = {f.name for f in dataclasses.fields(NormalizedFinding)}


# ── containment + rule-file discovery ──────────────────────────────────────


def _is_within(base: Path, candidate: Path) -> bool:
    """True if ``candidate`` is ``base`` or a descendant of it (no escape)."""
    try:
        base_r = base.resolve()
        cand_r = candidate.resolve()
    except OSError:  # pragma: no cover - defensive
        return False
    return cand_r == base_r or base_r in cand_r.parents


def _resolve_targeted_rules_dir(output_dir: str) -> Optional[Path]:
    """Return the contained targeted-rules dir Path, or None if it escapes.

    The path is fixed-relative to output_dir, so the only way it can escape is
    via a symlink; ``resolve()`` follows symlinks, and we refuse any resolved
    path that is not within output_dir (containment discipline).
    """
    base = Path(output_dir).resolve()
    targeted = base / TARGETED_RULES_SUBPATH
    resolved = targeted.resolve() if targeted.exists() else targeted
    if not _is_within(base, resolved):
        return None
    return resolved


def _gather_targeted_rule_files(
    targeted_dir: Optional[Path], output_base: Path
) -> List[str]:
    """Return absolute paths of contained YAML rule files under targeted_dir.

    A non-existent directory (first-ever run) yields ``[]`` (not an error). Any
    rule file whose resolved path escapes output_dir is skipped (containment).
    """
    if targeted_dir is None or not targeted_dir.is_dir():
        return []
    files: List[str] = []
    for path in sorted(targeted_dir.rglob("*")):
        if path.suffix.lower() not in _RULE_EXTENSIONS:
            continue
        if not path.is_file():
            continue
        if not _is_within(output_base, path):
            continue
        files.append(str(path.resolve()))
    return files


# ── prior-findings resolution + reconstruction ──────────────────────────────


def _load_prior_findings(output_dir: str) -> List[Dict[str, Any]]:
    """Load the CURRENT accumulated prior findings (as plain dicts).

    Re-entrancy: prefer the accumulated ``targeted/findings.json`` (so a second
    pass merges against the current set, not the original baseline); fall back
    to P2's ``baseline/findings.json``; else an empty prior set. Never raises.
    """
    base = Path(output_dir)
    for rel in ("targeted/findings.json", "baseline/findings.json"):
        candidate = base / rel
        try:
            if candidate.is_file():
                doc = json.loads(candidate.read_text(encoding="utf-8"))
                findings = doc.get("findings")
                if isinstance(findings, list):
                    return findings
        except (OSError, json.JSONDecodeError) as exc:  # pragma: no cover
            logger.warning("could not read prior findings %s: %s", candidate, exc)
            continue
    return []


def _finding_from_dict(data: Any) -> Optional[NormalizedFinding]:
    """Rebuild a NormalizedFinding from a persisted dict (None on bad shape)."""
    if not isinstance(data, dict):
        return None
    kwargs = {k: v for k, v in data.items() if k in _FINDING_FIELDS}
    try:
        return NormalizedFinding(**kwargs)
    except TypeError:
        return None


def _apply_cvss4(findings: List[NormalizedFinding]) -> None:
    """Assign CVSS 4.0 vector/score per finding (same rule as baseline_scan).

    Severity is a NATIVE tool string (raw SARIF level for semgrep). It MUST be
    normalized to the canonical CVSS-tier vocabulary FIRST via
    canonical_cvss_tier, otherwise suggest_cvss4_vector collapses everything to
    LOW (the Phase 6a live-verified bug).
    """
    for finding in findings:
        tier = canonical_cvss_tier(finding.severity)
        finding.cvss_4_0_vector = suggest_cvss4_vector(tier)
        finding.cvss_4_0_score = compute_cvss4_score(finding.cvss_4_0_vector)


# ── orchestration entry point ───────────────────────────────────────────────


def execute_targeted_scan(
    target_path: str,
    output_dir: str,
    session_id: str,
    *,
    prior_findings: Optional[List[Dict[str, Any]]] = None,
    which_fn: Callable[[str], Optional[str]] = shutil.which,
    subprocess_run: Callable[..., Any] = subprocess.run,
    semgrep_config_paths: Optional[List[str]] = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> Dict[str, Any]:
    """Execute the P7 targeted scan synchronously and persist the MERGED set.

    Args:
      prior_findings: P2's (or the accumulated) findings as plain dicts. When
        None, resolved from disk (targeted/findings.json, else
        baseline/findings.json, else empty).
      semgrep_config_paths: the base preset. When None, resolved via
        baseline_scan.default_semgrep_config_paths().

    Returns a dict describing the outcome. Key fields:

      blocked            ALWAYS False — P7 is best-effort and NEVER blocks the
                         pipeline (unlike P2's all-tools-missing hard block).
      completed          True when the phase ran to persistence.
      semgrep_available  whether semgrep was found on PATH (via which_fn).
      coverage_gaps      [{"tool","reason"}] — semgrep unavailable / a failed
                         base or targeted scan (honest partial coverage).
      findings           the MERGED+DEDUPED findings as plain dicts.
      prior_findings_count / new_findings_count / merged_count
      targeted_rules_dir / targeted_rule_files
      findings_path / coverage_path / mempalace / severity_counts /
      tool_versions
    """
    if semgrep_config_paths is None:
        semgrep_config_paths = default_semgrep_config_paths()
    if prior_findings is None:
        prior_findings = _load_prior_findings(output_dir)

    output_base = Path(output_dir).resolve()
    coverage_gaps: List[Dict[str, str]] = []
    tool_versions: Dict[str, Optional[str]] = {}
    available: List[str] = []

    # ── Resolve the (contained) targeted-rules directory + rule files ──
    targeted_dir = _resolve_targeted_rules_dir(output_dir)
    if targeted_dir is None:
        coverage_gaps.append(
            {
                "tool": "targeted-rules",
                "reason": (
                    "targeted-rules directory resolves OUTSIDE output_dir "
                    "(path-traversal containment); skipped"
                ),
            }
        )
        targeted_rule_files: List[str] = []
    else:
        targeted_rule_files = _gather_targeted_rule_files(targeted_dir, output_base)

    # ── Reconstruct the prior findings set ──
    prior_norm: List[NormalizedFinding] = []
    for item in prior_findings:
        rebuilt = _finding_from_dict(item)
        if rebuilt is not None:
            prior_norm.append(rebuilt)

    # ── semgrep availability (best-effort; NEVER a hard block) ──
    status = check_tool_installed("semgrep", which_fn=which_fn)
    new_findings: List[NormalizedFinding] = []
    if not status.installed:
        coverage_gaps.append(
            {
                "tool": "semgrep",
                "reason": (
                    "semgrep not installed at P7 time; targeted scan skipped. "
                    "P7 is best-effort (semgrep-only) — the pipeline advances "
                    "with P2's findings carried forward, never blocked."
                ),
            }
        )
    else:
        available.append("semgrep")
        binary_path = status.path or "semgrep"
        tool_versions["semgrep"] = _tool_version(binary_path, subprocess_run)

        # Base-preset scan (the SAME rules P2 uses). A SEPARATE invocation from
        # the targeted-rules scan so one bad targeted rule can never lose these.
        base_findings, base_gap = run_semgrep(
            binary_path,
            target_path,
            semgrep_config_paths,
            subprocess_run,
            timeout=timeout,
        )
        if base_gap is not None:
            coverage_gaps.append(base_gap)
        if base_findings:
            new_findings.extend(base_findings)

        # Targeted-rules scan (only when rule files are present). Isolated so a
        # malformed rule file degrades to a coverage gap, not a phase crash.
        if targeted_rule_files:
            tgt_findings, tgt_gap = run_semgrep(
                binary_path,
                target_path,
                targeted_rule_files,
                subprocess_run,
                timeout=timeout,
            )
            if tgt_gap is not None:
                coverage_gaps.append(
                    {
                        "tool": "targeted-rules",
                        "reason": (
                            "targeted custom-rules scan failed "
                            f"({tgt_gap.get('reason', 'unknown error')}); "
                            "base-preset findings preserved"
                        ),
                    }
                )
            if tgt_findings:
                new_findings.extend(tgt_findings)

    # ── Merge prior + new, dedupe, CVSS-suggest ──
    combined = prior_norm + new_findings
    deduped, merge_record = deduplicate_findings(combined, DEDUP_THRESHOLD)
    _apply_cvss4(deduped)

    findings_dicts = [asdict(f) for f in deduped]
    severity_counts: Dict[str, int] = {}
    for finding in deduped:
        key = finding.severity or "unknown"
        severity_counts[key] = severity_counts.get(key, 0) + 1

    scan_timestamp = datetime.now(timezone.utc).isoformat()

    # ── Persist findings.json + coverage.md ──
    targeted_out = Path(output_dir) / "targeted"
    targeted_out.mkdir(parents=True, exist_ok=True)
    findings_path = targeted_out / "findings.json"
    coverage_path = targeted_out / "coverage.md"

    findings_doc = {
        "schema_version": 1,
        "session_id": session_id,
        "target_path": target_path,
        "scan_timestamp": scan_timestamp,
        "tools_run": available,
        "coverage_gaps": coverage_gaps,
        "tool_versions": tool_versions,
        "severity_counts": severity_counts,
        "prior_findings_count": len(prior_norm),
        "new_findings_count": len(new_findings),
        "merge_record": merge_record,
        "targeted_rule_files": targeted_rule_files,
        "findings": findings_dicts,
    }
    findings_path.write_text(json.dumps(findings_doc, indent=2, default=str))

    coverage_md = _render_coverage_md(
        session_id=session_id,
        target_path=target_path,
        scan_timestamp=scan_timestamp,
        available=available,
        coverage_gaps=coverage_gaps,
        tool_versions=tool_versions,
        severity_counts=severity_counts,
        prior_count=len(prior_norm),
        new_count=len(new_findings),
        total=len(findings_dicts),
        targeted_rule_files=targeted_rule_files,
    )
    coverage_path.write_text(coverage_md)

    # ── mempalace summary drawer stub (same pattern as P2) ──
    room = f"{session_id}-p7-targeted-findings"
    mempalace_content = _render_mempalace_summary(
        target_path=target_path,
        scan_timestamp=scan_timestamp,
        available=available,
        coverage_gaps=coverage_gaps,
        severity_counts=severity_counts,
        prior_count=len(prior_norm),
        new_count=len(new_findings),
        total=len(findings_dicts),
        targeted_rule_files=targeted_rule_files,
        findings_path=str(findings_path),
    )
    mempalace = {"wing": "wing_sca", "room": room, "content": mempalace_content}
    (targeted_out / "mempalace_summary.json").write_text(
        json.dumps(mempalace, indent=2, default=str)
    )

    return {
        "blocked": False,  # P7 NEVER blocks the pipeline
        "completed": True,
        "semgrep_available": status.installed,
        "available": available,
        "coverage_gaps": coverage_gaps,
        "findings": findings_dicts,
        "prior_findings_count": len(prior_norm),
        "new_findings_count": len(new_findings),
        "merged_count": len(findings_dicts),
        "severity_counts": severity_counts,
        "tool_versions": tool_versions,
        "targeted_rules_dir": str(targeted_dir) if targeted_dir else None,
        "targeted_rule_files": targeted_rule_files,
        "findings_path": str(findings_path),
        "coverage_path": str(coverage_path),
        "mempalace": mempalace,
        "errors": [],
    }


def _render_coverage_md(
    *,
    session_id: str,
    target_path: str,
    scan_timestamp: str,
    available: List[str],
    coverage_gaps: List[Dict[str, str]],
    tool_versions: Dict[str, Optional[str]],
    severity_counts: Dict[str, int],
    prior_count: int,
    new_count: int,
    total: int,
    targeted_rule_files: List[str],
) -> str:
    lines = [
        "# P7 Targeted Scan — Coverage Report",
        "",
        f"- session: `{session_id}`",
        f"- target: `{target_path}`",
        f"- timestamp: {scan_timestamp}",
        f"- prior (P2/accumulated) findings: {prior_count}",
        f"- new findings this pass: {new_count}",
        f"- total findings (merged + deduped): {total}",
        f"- targeted custom-rule files picked up: {len(targeted_rule_files)}",
        "",
        "## Tools run",
    ]
    if available:
        for name in available:
            ver = tool_versions.get(name) or "version unknown"
            lines.append(f"- ✅ {name} ({ver})")
    else:
        lines.append("- (none — semgrep unavailable; best-effort skip)")
    lines.append("")
    lines.append("## Coverage gaps")
    if coverage_gaps:
        for gap in coverage_gaps:
            lines.append(f"- ⚠️ {gap['tool']}: {gap['reason']}")
    else:
        lines.append("- none — semgrep ran successfully.")
    lines.append("")
    lines.append("## Findings by severity (merged set)")
    if severity_counts:
        for sev, count in sorted(severity_counts.items()):
            lines.append(f"- {sev}: {count}")
    else:
        lines.append("- none")
    lines.append("")
    return "\n".join(lines)


def _render_mempalace_summary(
    *,
    target_path: str,
    scan_timestamp: str,
    available: List[str],
    coverage_gaps: List[Dict[str, str]],
    severity_counts: Dict[str, int],
    prior_count: int,
    new_count: int,
    total: int,
    targeted_rule_files: List[str],
    findings_path: str,
) -> str:
    sev = ", ".join(f"{k}={v}" for k, v in sorted(severity_counts.items())) or "none"
    gaps = ", ".join(g["tool"] for g in coverage_gaps) or "none"
    return (
        "P7 TARGETED SCAN SUMMARY\n"
        f"- target: {target_path}\n"
        f"- timestamp: {scan_timestamp}\n"
        f"- tools run: {', '.join(available) or 'none (semgrep unavailable)'}\n"
        f"- targeted custom-rule files: {len(targeted_rule_files)}\n"
        f"- prior (P2/accumulated) findings: {prior_count}\n"
        f"- new findings this pass: {new_count}\n"
        f"- total findings (merged + deduped): {total}\n"
        f"- by severity: {sev}\n"
        f"- coverage gaps: {gaps}\n"
        f"- full merged findings JSON: {findings_path}\n"
    )
