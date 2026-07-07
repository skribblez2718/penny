"""
sca Skill — P2_BASELINE_SCAN tool execution (Phase 6a).

This module is the deterministic, in-process execution engine for the
P2_BASELINE_SCAN phase. The orchestrator classifies P2 as a ``'tool'`` phase
(see orchestrate.PHASE_KIND) and calls ``execute_baseline_scan`` SYNCHRONOUSLY
— never via an LLM agent — because a baseline SAST/SCA scan needs no judgement,
only faithful tool invocation + normalization.

WIRING, NOT NEW PRIMITIVES: this module wires together primitives already built
and reviewed in earlier phases:

  * provisioning.check_tool_installed  (Phase 3) — injectable ``which_fn`` PATH
    probing, so tests never depend on the real PATH.
  * normalize.parse_sarif / parse_json (Phase 5) — parse real tool output into
    the unified NormalizedFinding schema. semgrep is invoked with ``--sarif``
    SPECIFICALLY so Phase 5's parse_sarif (already verified against genuine
    ``semgrep scan --sarif`` output, incl. a Carren-caught severity/CWE-join
    fix) consumes it directly.
  * dedup.deduplicate_findings         (Phase 5) — deterministic 0.85-threshold
    dedup (difflib, no ML).
  * cvss4_map.suggest_cvss4_vector     (Phase 5) — library-verified CVSS 4.0
    vector suggestion per finding severity.
  * tool_manifest.required_tools       (Phase 3) — the REQUIRED tier
    (semgrep, osv-scanner, gitleaks).

CONFIDENCE:
  * semgrep path — CERTAIN (semgrep is genuinely installed in this dev env; the
    invocation + SARIF parse are exercised live by the test suite, not mocked).
  * osv-scanner / gitleaks paths — REAL-VERIFIED against osv-scanner 2.4.0 and
    gitleaks 8.30.1 respectively (the pinned tool_manifest.py versions). The
    CLI invocation shapes AND output parsing were exercised against the real
    binaries: osv-scanner's `--format json --recursive` args + parser return
    the correct findings from a real lockfile (and rc=128 == "no lockfile to
    scan" is now classified as an honest coverage gap, not a crash); gitleaks'
    `detect --no-git --source ...` form detects a real secret and drops the
    raw secret. Only these exact versions were verified. When a tool is absent
    it still degrades to a documented coverage gap.

SECURITY:
  * Every subprocess call is ARRAY-FORM (``subprocess.run([...])``) — never a
    shell-interpolated string — so a hostile path can never inject a command.
  * No silent full-blockage bypass: if ZERO required tools are available the
    caller receives ``blocked=True`` and MUST raise a hard error (the pipeline
    never proceeds past a fully-blocked baseline scan with an empty-but-clean
    -looking findings set).
  * Coverage honesty: a partially-degraded scan (e.g. semgrep ran but
    osv-scanner/gitleaks did not) records every unavailable/failed tool in
    ``coverage_gaps`` — persisted to coverage.md — never presented as complete.
  * gitleaks emits raw secrets in its output; normalize.py already drops those
    (description comes from the rule only), so no secret is persisted here.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from cvss4_map import (
    canonical_cvss_tier,
    compute_cvss4_score,
    suggest_cvss4_vector,
)
from dedup import deduplicate_findings
from normalize import (
    NormalizedFinding,
    parse_json,
    parse_osv_scanner_json,
    parse_sarif,
)
from provisioning import check_tool_installed
from tool_manifest import required_tools

logger = logging.getLogger("sca.baseline_scan")

# Default per-tool subprocess timeout (seconds). A scan that overruns is
# recorded as a coverage gap, never silently treated as "zero findings".
DEFAULT_TIMEOUT = 600

# Dedup similarity threshold (Phase 5 spec: 0.85).
DEDUP_THRESHOLD = 0.85

# ── semgrep ruleset resolution ────────────────────────────────────────────
# Mirrors the SCA_PRESET_CONFIGS in .pi/extensions/semgrep/index.ts (Phase 4b):
# vendored library rules + custom Tier-2 rules + a sensible subset of the local
# rulesets. All are LOCAL directories (offline, no registry/network dependency),
# resolved relative to the bundled rules base. We deliberately reuse this preset
# so the Python baseline scan and the TS semgrep_scan tool apply the SAME rules.
#
# `learned/sca` below is a self-improving-SAST addition. The TS semgrep_scan
# preset (index.ts SCA_PRESET_CONFIGS) mirrors it as `learned-sca`, guarded by
# existsSync so a not-yet-created learned dir is skipped — both paths stay in sync.
SCA_PRESET_RULESET_PATHS = (
    "vendor/jose",
    "vendor/jsonwebtoken",
    "vendor/jwt-simple",
    "vendor/passport-jwt",
    "vendor/sequelize",
    "vendor/serialize-javascript",
    "vendor/shelljs",
    "vendor/node-crypto",
    "vendor/vm2",
    "custom",
    "javascript-audit",
    "javascript-lang/security",
    "generic-secrets",
    # Self-improving SAST: rules the sca REFLECT/augment phase authored on prior
    # runs, persisted under the tool's own rules tree. Included only when the dir
    # exists (default_semgrep_config_paths filters non-existent paths), so future
    # runs load accumulated rules and the scanner gets more robust each run.
    "learned/sca",
)


def _rules_base_discovery() -> Optional[Path]:
    """Locate .pi/extensions/semgrep/rules by walking up from this file.

    Mirrors jsa's _rules_base_discovery. Returns None if not found (caller then
    records a semgrep coverage gap rather than scanning with no rules).
    """
    script_root = Path(__file__).resolve().parent
    for ancestor in [script_root, *script_root.parents][:8]:
        candidate = ancestor / ".pi" / "extensions" / "semgrep" / "rules"
        if candidate.is_dir():
            return candidate
    return None


def default_semgrep_config_paths() -> List[str]:
    """Return absolute paths for the SCA-preset local rulesets that exist."""
    base = _rules_base_discovery()
    if base is None:
        return []
    paths: List[str] = []
    for rel in SCA_PRESET_RULESET_PATHS:
        candidate = base / rel
        if candidate.is_dir():
            paths.append(str(candidate))
    return paths


# ── tool version probing (best-effort, never fatal) ───────────────────────


def _tool_version(
    binary_path: str,
    subprocess_run: Callable[..., Any],
    *,
    version_flag: str = "--version",
    timeout: int = 30,
) -> Optional[str]:
    """Best-effort ``<binary> --version`` probe. Returns None on any failure."""
    try:
        result = subprocess_run(
            [binary_path, version_flag],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        out = (result.stdout or result.stderr or "").strip()
        return out.splitlines()[0].strip() if out else None
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("version probe failed for %s: %s", binary_path, exc)
        return None


# ── individual tool runners ───────────────────────────────────────────────
# Each returns (findings, gap): a list of NormalizedFinding on success, or a
# ``gap`` dict {"tool", "reason"} when the tool did not run / failed. Exactly
# one of the two is populated (findings may be an empty list on a clean scan,
# which is DISTINCT from a gap — a tool that ran and found nothing is NOT a gap).


def run_semgrep(
    binary_path: str,
    target_path: str,
    config_paths: List[str],
    subprocess_run: Callable[..., Any],
    *,
    timeout: int = DEFAULT_TIMEOUT,
) -> tuple[Optional[List[NormalizedFinding]], Optional[Dict[str, str]]]:
    """Run ``semgrep scan --sarif`` and parse via Phase 5's parse_sarif.

    --sarif is chosen deliberately so parse_sarif (verified against real semgrep
    SARIF output in Phase 5) consumes the result directly.
    """
    if not config_paths:
        return None, {
            "tool": "semgrep",
            "reason": (
                "no semgrep ruleset could be resolved (bundled rules base not "
                "found); scan skipped"
            ),
        }
    cmd = [binary_path, "scan", "--sarif", "--metrics=off", "--quiet"]
    for cfg in config_paths:
        cmd.extend(["--config", cfg])
    cmd.append(target_path)
    try:
        result = subprocess_run(
            cmd, capture_output=True, text=True, timeout=timeout
        )
    except FileNotFoundError as exc:
        return None, {
            "tool": "semgrep",
            "reason": f"semgrep binary not found at {binary_path!r}: {exc}",
        }
    except subprocess.TimeoutExpired:
        return None, {
            "tool": "semgrep",
            "reason": f"semgrep scan timed out after {timeout}s",
        }
    except Exception as exc:  # pragma: no cover - defensive
        return None, {"tool": "semgrep", "reason": f"semgrep failed: {exc}"}

    # semgrep returns 0 with or without findings; a non-zero rc with no SARIF on
    # stdout is a genuine failure (recorded as a gap, NEVER "zero findings").
    stdout = result.stdout or ""
    if not stdout.strip():
        if result.returncode not in (0, 1):
            return None, {
                "tool": "semgrep",
                "reason": (
                    f"semgrep exited rc={result.returncode} with no output: "
                    f"{(result.stderr or '')[:200]}"
                ),
            }
        return [], None
    try:
        sarif = json.loads(stdout)
    except json.JSONDecodeError as exc:
        return None, {
            "tool": "semgrep",
            "reason": f"semgrep SARIF output was not valid JSON: {exc}",
        }
    # A non-0/1 return code is a genuine semgrep error (e.g. an invalid rule
    # file). semgrep STILL emits a valid SARIF envelope (results=[] plus error
    # notifications) on stdout in that case, so a successful JSON parse is NOT
    # proof the scan ran cleanly. Record a coverage gap rather than silently
    # reporting zero findings (coverage honesty).
    if result.returncode not in (0, 1):
        reason = _sarif_error_reason(sarif) or (
            f"semgrep exited rc={result.returncode}: "
            f"{(result.stderr or '')[:200]}"
        )
        return None, {"tool": "semgrep", "reason": reason}
    return parse_sarif(sarif), None


def _sarif_error_reason(sarif: Any) -> Optional[str]:
    """Extract a concise error message from SARIF error notifications, if any.

    Real semgrep records rule/config errors under
    runs[].invocations[].toolExecutionNotifications[] with level=="error"
    (e.g. an invalid targeted rule file). Returns a short human-readable reason
    or None when there are no error notifications.
    """
    try:
        runs = sarif.get("runs") or []
        messages: List[str] = []
        for run in runs:
            for inv in run.get("invocations") or []:
                for note in inv.get("toolExecutionNotifications") or []:
                    if (note.get("level") or "").lower() == "error":
                        text = ((note.get("message") or {}).get("text") or "").strip()
                        if text:
                            messages.append(text.replace("\n", " ").replace("\t", " "))
        if messages:
            return "semgrep rule/config error: " + "; ".join(messages)[:300]
    except Exception:  # pragma: no cover - defensive
        return None
    return None


def run_osv_scanner(
    binary_path: str,
    target_path: str,
    subprocess_run: Callable[..., Any],
    *,
    timeout: int = DEFAULT_TIMEOUT,
) -> tuple[Optional[List[NormalizedFinding]], Optional[Dict[str, str]]]:
    """Run osv-scanner and parse via parse_osv_scanner_json (REAL-VERIFIED).

    CLI shape ``osv-scanner --format json --recursive <path>``. REAL-VERIFIED
    against osv-scanner **2.4.0** (the pinned tool_manifest.py version): these
    exact args produce correct JSON on stdout, and parse_osv_scanner_json
    correctly parsed the real findings (right severities + CWEs) from a real
    lockfile. Only version 2.4.0 was verified — do not assume other versions.

    EXIT-CODE SEMANTICS (verified against 2.4.0):
      * rc=1  -> vulnerabilities found; JSON on stdout -> parse to findings.
      * rc=0  -> scanned clean; empty findings (a tool that ran and found
                 nothing is NOT a coverage gap).
      * rc=128 -> "no package sources found": there was no dependency lockfile/
                 manifest under the target to scan (osv stderr shows
                 "0 Extract calls"). This is NOT a tool failure — it is an
                 honest coverage gap (dependency-CVE scanning had nothing to
                 scan), recorded with an accurate reason, never a crash message.
      * any other non-zero rc with no parseable JSON -> genuine failure gap
                 (reason names the actual rc).

    PARSING (Carren-caught silent-data-loss fix): osv-scanner's REAL JSON is
    deeply nested (results[].packages[].vulnerabilities[]) — the generic
    parse_json flat-record fallback silently dropped EVERY finding and never
    errored, so a real "N CVEs" scan looked identical to a clean one. We now use
    normalize.parse_osv_scanner_json, which walks the same real shape the Phase
    4a TS extension's countFindings() uses. Both the args and the parser are
    real-verified correct against 2.4.0 and are deliberately left unchanged.
    """
    cmd = [binary_path, "--format", "json", "--recursive", target_path]
    try:
        result = subprocess_run(
            cmd, capture_output=True, text=True, timeout=timeout
        )
    except FileNotFoundError as exc:
        return None, {
            "tool": "osv-scanner",
            "reason": f"osv-scanner binary not found at {binary_path!r}: {exc}",
        }
    except subprocess.TimeoutExpired:
        return None, {
            "tool": "osv-scanner",
            "reason": f"osv-scanner timed out after {timeout}s",
        }
    except Exception as exc:  # pragma: no cover - defensive
        return None, {"tool": "osv-scanner", "reason": f"osv-scanner failed: {exc}"}

    stdout = result.stdout or ""
    # osv-scanner uses rc=1 to mean "vulnerabilities found" and rc=0 to mean
    # "clean"; either way JSON is on stdout. rc=128 means "no package sources
    # found" (no lockfile/manifest to scan) — an honest coverage gap, not a
    # failure. Any OTHER non-zero rc with no JSON is a genuine failure.
    if not stdout.strip():
        rc = result.returncode
        if rc == 128:
            return None, {
                "tool": "osv-scanner",
                "reason": (
                    "osv-scanner found no dependency lockfiles/manifests to "
                    f"scan under {target_path} — dependency-CVE coverage was "
                    "not performed for this target"
                ),
            }
        if rc not in (0, 1):
            return None, {
                "tool": "osv-scanner",
                "reason": (
                    f"osv-scanner exited rc={rc} with no parseable output "
                    f"(genuine failure): {(result.stderr or '')[:200]}"
                ),
            }
        return [], None
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError as exc:
        return None, {
            "tool": "osv-scanner",
            "reason": f"osv-scanner output was not valid JSON: {exc}",
        }
    return parse_osv_scanner_json(data), None


def run_gitleaks(
    binary_path: str,
    target_path: str,
    subprocess_run: Callable[..., Any],
    *,
    timeout: int = DEFAULT_TIMEOUT,
) -> tuple[Optional[List[NormalizedFinding]], Optional[Dict[str, str]]]:
    """Run gitleaks and parse via Phase 5's parse_json (REAL-VERIFIED).

    CLI shape ``gitleaks detect --no-git --source <path> --report-format json
    --report-path <file>`` (gitleaks writes its JSON report to a file, not
    stdout). REAL-VERIFIED against gitleaks **8.30.1** (the pinned
    tool_manifest.py version): the ``detect`` subcommand is still valid, it
    detects a real private key at rc=1, and run_gitleaks parses the report AND
    drops the raw secret. Only version 8.30.1 was verified — do not assume
    other versions. (gitleaks 8.30.1 also offers a newer ``dir`` subcommand,
    but the ``detect --no-git --source`` form is real-verified working and is
    deliberately kept.)

    SECURITY: gitleaks records include the raw secret; normalize.parse_json
    (gitleaks dispatch) drops those fields — no secret is persisted.
    """
    report_fd, report_path = tempfile.mkstemp(suffix=".json", prefix="sca-gitleaks-")
    os.close(report_fd)
    cmd = [
        binary_path,
        "detect",
        "--no-git",
        "--source",
        target_path,
        "--report-format",
        "json",
        "--report-path",
        report_path,
    ]
    try:
        subprocess_run(cmd, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError as exc:
        _safe_unlink(report_path)
        return None, {
            "tool": "gitleaks",
            "reason": f"gitleaks binary not found at {binary_path!r}: {exc}",
        }
    except subprocess.TimeoutExpired:
        _safe_unlink(report_path)
        return None, {
            "tool": "gitleaks",
            "reason": f"gitleaks timed out after {timeout}s",
        }
    except Exception as exc:  # pragma: no cover - defensive
        _safe_unlink(report_path)
        return None, {"tool": "gitleaks", "reason": f"gitleaks failed: {exc}"}

    # gitleaks exit codes are asymmetric (rc=1 == leaks found); its report file
    # is authoritative regardless of rc. (The exit-code asymmetry hardening in
    # the TS extension is Phase 6b; here we read the report file directly.)
    try:
        raw = Path(report_path).read_text(encoding="utf-8")
    except OSError as exc:
        _safe_unlink(report_path)
        return None, {
            "tool": "gitleaks",
            "reason": f"gitleaks report unreadable: {exc}",
        }
    finally:
        _safe_unlink(report_path)

    if not raw.strip():
        return [], None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        return None, {
            "tool": "gitleaks",
            "reason": f"gitleaks report was not valid JSON: {exc}",
        }
    return parse_json(data, "gitleaks"), None


def _safe_unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:  # pragma: no cover - defensive
        pass


# ── orchestration entry point ─────────────────────────────────────────────

_RUNNERS = {
    "semgrep": run_semgrep,
    "osv-scanner": run_osv_scanner,
    "gitleaks": run_gitleaks,
}


def execute_baseline_scan(
    target_path: str,
    output_dir: str,
    session_id: str,
    *,
    which_fn: Callable[[str], Optional[str]] = shutil.which,
    subprocess_run: Callable[..., Any] = subprocess.run,
    semgrep_config_paths: Optional[List[str]] = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> Dict[str, Any]:
    """Execute the P2 baseline scan synchronously and persist its results.

    Returns a dict describing the outcome. Key fields:

      blocked           True IFF ZERO required tools are available (a hard,
                        pipeline-halting condition). When True, ``errors`` holds
                        human-readable messages and NOTHING is persisted.
      available         required tools found on PATH (via which_fn).
      missing_required  required tools NOT found (recorded as coverage gaps when
                        at least one other tool ran).
      coverage_gaps     [{"tool","reason"}] — every tool that did not run or
                        failed (honest partial-coverage accounting).
      findings          deduped, CVSS-suggested findings as plain dicts.
      severity_counts   {severity: count}.
      tool_versions     {tool: version_string_or_None}.
      findings_path     absolute path to the persisted findings.json.
      coverage_path     absolute path to the persisted coverage.md.
      mempalace         {"wing","room","content"} summary drawer stub.
      completed         True when the scan ran to completion (not blocked).

    All PATH probing goes through ``which_fn`` and all process execution through
    ``subprocess_run`` so tests can inject deterministic behaviour. semgrep,
    osv-scanner (2.4.0) and gitleaks (8.30.1) are all real-verified; each is
    exercised live via an opt-in slow/requires-* test and degrades to a
    documented coverage gap when absent.
    """
    if semgrep_config_paths is None:
        semgrep_config_paths = default_semgrep_config_paths()

    # ── Determine required-tool availability (injectable which_fn) ──
    statuses = {
        spec.name: check_tool_installed(spec.name, which_fn=which_fn)
        for spec in required_tools()
    }
    available = [name for name, st in statuses.items() if st.installed]
    missing_required = [name for name, st in statuses.items() if not st.installed]

    # ── HARD BLOCK: zero required tools available ──
    if not available:
        return {
            "blocked": True,
            "completed": False,
            "available": [],
            "missing_required": missing_required,
            "coverage_gaps": [],
            "findings": [],
            "severity_counts": {},
            "tool_versions": {},
            "errors": [
                (
                    "P2_BASELINE_SCAN is blocked: none of the REQUIRED tools "
                    f"({', '.join(missing_required)}) are installed. A baseline "
                    "scan with zero tools would produce an empty findings set "
                    "that falsely looks like a clean scan. Install the required "
                    "tools (see `make setup` / .pi/skills/sca provisioning docs) "
                    "and re-run."
                )
            ],
        }

    # ── Run each available required tool ──
    all_findings: List[NormalizedFinding] = []
    coverage_gaps: List[Dict[str, str]] = []
    tool_versions: Dict[str, Optional[str]] = {}

    # Missing required tools are coverage gaps (not a block: at least one ran).
    for name in missing_required:
        coverage_gaps.append(
            {
                "tool": name,
                "reason": (
                    f"required tool {name!r} not installed; coverage degraded "
                    "(non-blocking because another required tool ran)"
                ),
            }
        )

    for name in available:
        binary_path = statuses[name].path or name
        tool_versions[name] = _tool_version(binary_path, subprocess_run)
        runner = _RUNNERS[name]
        if name == "semgrep":
            findings, gap = runner(
                binary_path,
                target_path,
                semgrep_config_paths,
                subprocess_run,
                timeout=timeout,
            )
        else:
            findings, gap = runner(
                binary_path, target_path, subprocess_run, timeout=timeout
            )
        if gap is not None:
            coverage_gaps.append(gap)
        if findings:
            all_findings.extend(findings)

    # ── Normalize/dedup/CVSS-suggest ──
    deduped, merge_record = deduplicate_findings(all_findings, DEDUP_THRESHOLD)
    for finding in deduped:
        # finding.severity is a NATIVE tool severity string (for SARIF-sourced
        # semgrep findings it is a raw SARIF `level` ∈ {error, warning, note}).
        # It MUST be normalized to the canonical CVSS-tier vocabulary FIRST:
        # calling suggest_cvss4_vector on a raw SARIF level collapses every
        # finding to LOW (Phase 6a live-verified bug). canonical_cvss_tier maps
        # error->high / warning->medium / note->low; canonical severities pass
        # through; unknowns fall through to suggest_cvss4_vector's conservative
        # LOW fallback.
        tier = canonical_cvss_tier(finding.severity)
        finding.cvss_4_0_vector = suggest_cvss4_vector(tier)
        finding.cvss_4_0_score = compute_cvss4_score(finding.cvss_4_0_vector)

    findings_dicts = [asdict(f) for f in deduped]
    severity_counts: Dict[str, int] = {}
    for finding in deduped:
        key = (finding.severity or "unknown")
        severity_counts[key] = severity_counts.get(key, 0) + 1

    scan_timestamp = datetime.now(timezone.utc).isoformat()

    # ── Persist findings.json + coverage.md ──
    baseline_dir = Path(output_dir) / "baseline"
    baseline_dir.mkdir(parents=True, exist_ok=True)
    findings_path = baseline_dir / "findings.json"
    coverage_path = baseline_dir / "coverage.md"

    findings_doc = {
        "schema_version": 1,
        "session_id": session_id,
        "target_path": target_path,
        "scan_timestamp": scan_timestamp,
        "tools_run": available,
        "coverage_gaps": coverage_gaps,
        "tool_versions": tool_versions,
        "severity_counts": severity_counts,
        "merge_record": merge_record,
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
        total=len(findings_dicts),
    )
    coverage_path.write_text(coverage_md)

    # ── mempalace summary drawer stub ──
    # The orchestrator runs as a subprocess and cannot call the mempalace MCP
    # tool directly (mirrors jsa's stub-file pattern): we return the drawer
    # {wing, room, content} and also persist it so Penny/the skill layer can
    # apply it via memory_add_drawer.
    room = f"{session_id}-p2-baseline-findings"
    mempalace_content = _render_mempalace_summary(
        target_path=target_path,
        scan_timestamp=scan_timestamp,
        available=available,
        coverage_gaps=coverage_gaps,
        tool_versions=tool_versions,
        severity_counts=severity_counts,
        total=len(findings_dicts),
        findings_path=str(findings_path),
    )
    mempalace = {"wing": "wing_sca", "room": room, "content": mempalace_content}
    (baseline_dir / "mempalace_summary.json").write_text(
        json.dumps(mempalace, indent=2, default=str)
    )

    return {
        "blocked": False,
        "completed": True,
        "available": available,
        "missing_required": missing_required,
        "coverage_gaps": coverage_gaps,
        "findings": findings_dicts,
        "severity_counts": severity_counts,
        "tool_versions": tool_versions,
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
    total: int,
) -> str:
    lines = [
        "# P2 Baseline Scan — Coverage Report",
        "",
        f"- session: `{session_id}`",
        f"- target: `{target_path}`",
        f"- timestamp: {scan_timestamp}",
        f"- total findings (deduped): {total}",
        "",
        "## Tools run",
    ]
    if available:
        for name in available:
            ver = tool_versions.get(name) or "version unknown"
            lines.append(f"- ✅ {name} ({ver})")
    else:  # pragma: no cover - unreachable (blocked earlier)
        lines.append("- (none)")
    lines.append("")
    lines.append("## Coverage gaps")
    if coverage_gaps:
        for gap in coverage_gaps:
            lines.append(f"- ⚠️ {gap['tool']}: {gap['reason']}")
    else:
        lines.append("- none — all required tools ran successfully.")
    lines.append("")
    lines.append("## Findings by severity")
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
    tool_versions: Dict[str, Optional[str]],
    severity_counts: Dict[str, int],
    total: int,
    findings_path: str,
) -> str:
    sev = ", ".join(f"{k}={v}" for k, v in sorted(severity_counts.items())) or "none"
    gaps = ", ".join(g["tool"] for g in coverage_gaps) or "none"
    vers = ", ".join(
        f"{k} {v or '?'}" for k, v in tool_versions.items()
    ) or "none"
    return (
        "P2 BASELINE SCAN SUMMARY\n"
        f"- target: {target_path}\n"
        f"- timestamp: {scan_timestamp}\n"
        f"- tools run: {', '.join(available) or 'none'}\n"
        f"- tool versions: {vers}\n"
        f"- total findings (deduped): {total}\n"
        f"- by severity: {sev}\n"
        f"- coverage gaps (tools unavailable/failed): {gaps}\n"
        f"- full findings JSON: {findings_path}\n"
    )
