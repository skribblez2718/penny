"""jsa_domain — runtime bridge between the engine JSAPlaybook tool states and the
legacy deterministic domain layer (fsm.py handlers + the standalone scan modules).

Loaded LAZILY by ``JSAPlaybook._domain_run`` / ``_read_mempalace_stubs`` (never at
import time, never in tests — the tool seam is overridden there). It uses FLAT
imports among the skill-dir modules (``import fsm`` …), so the playbook must put
``.pi/skills/jsa/scripts`` on ``sys.path`` first (it does, via
``_ensure_skill_tools`` before importing this module).

Responsibilities:
  * ``run_phase(phase, jsa, constraints)`` — reconstruct/restore the heavy
    ``fsm.JSAState`` for this run, execute the matching legacy handler, persist it
    back to ``{output_dir}/session.json``, and stash lean counts into the engine's
    ``ctx.extras["jsa"]`` dict (which the checkpointer serializes);
  * the mempalace-stub writers (ported from orchestrate.py) — the subprocess
    cannot call MCP tools, so SAST/CVE summaries are appended to
    ``{output_dir}/mempalace_stubs.json`` for Penny to replay;
  * ``read_mempalace_stubs(output_dir)`` — surfaced in the completion result;
  * ``build_auth_katana_args(intake)`` — credential passing via env vars, never
    argv (ported verbatim — security critical);
  * ``is_out_of_scope(url, patterns)`` — scope enforcement helper.

The heavy JSAState is kept in a per-``output_dir`` process cache so the run of
consecutive tool states inside a single ``_advance_to`` call reuses one object; on
a fresh process (crash-resume mid-tool) it is restored from ``session.json`` —
mirroring the legacy ``restore_state``.

NOTE (known integration gap): the richest ACQUIRE crawl (katana/curl/jsluice) and
the semgrep first/third-party classifier lived in the pre-engine ``orchestrate.py``,
which was removed in the engine migration. This bridge wires ACQUIRE / SAST_SCAN to
the corresponding ``fsm.py`` handlers and writes the mempalace stubs; the richer
crawl and classifier are NOT yet ported onto the engine path and remain a gap to
close in a focused jsa build (they are pure subprocess orchestration — no engine
concern). Object<->dict fidelity across the process boundary must be preserved when
``_restore_state`` rehydrates ``JSAState`` from ``session.json``.
"""

from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path
from typing import Any

import fsm  # skill-dir flat import (JSAState + *_handler domain functions)

# ---------------------------------------------------------------------------
# Per-run JSAState cache (keyed by output_dir)
# ---------------------------------------------------------------------------

_STATES: dict[str, Any] = {}


def _session_path(output_dir: str) -> Path:
    return Path(output_dir) / "session.json"


def _new_state(jsa: dict) -> Any:
    st = fsm.JSAState()
    st.session_id = str(jsa.get("session_id") or st.session_id)
    st.target_url = jsa.get("target_url", "")
    st.output_dir = jsa.get("output_dir", "")
    intake = jsa.get("intake") or {}
    st.metadata.setdefault("intake", intake)
    # Effective out-of-scope list (playbook writes jsa["out_of_scope"]; fall back
    # to the intake record). ACQUIRE reads this to skip out-of-scope JS/URLs.
    oos = jsa.get("out_of_scope") or intake.get("out_of_scope") or []
    st.metadata.setdefault("out_of_scope", list(oos) if isinstance(oos, (list, tuple)) else [oos])
    st.metadata.setdefault("phase_history", [])
    if st.output_dir:
        try:
            st.ensure_dirs()
        except Exception:
            pass
    return st


def _restore_state(output_dir: str) -> Any | None:
    """Restore a JSAState from disk (best-effort). Cards/findings come back as
    plain dicts — the fsm handlers tolerate this (see JSAState.to_dict)."""
    p = _session_path(output_dir)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text())
    except Exception:
        return None
    st = fsm.JSAState()
    for attr in (
        "session_id",
        "target_url",
        "output_dir",
        "analyzers",
        "sast_findings",
        "sast_validated",
        "module_cards",
        "page_cards",
        "flow_cards",
        "raw_findings",
        "merged_findings",
        "verified_findings",
        "metadata",
        "errors",
        "current_phase",
    ):
        if attr in data and data[attr] is not None:
            setattr(st, attr, data[attr])
    return st


def _get_state(jsa: dict) -> Any:
    output_dir = jsa.get("output_dir", "")
    if output_dir in _STATES:
        return _STATES[output_dir]
    st = _restore_state(output_dir) if output_dir else None
    if st is None:
        st = _new_state(jsa)
    if output_dir:
        _STATES[output_dir] = st
    return st


def _save_state(st: Any) -> None:
    if not st.output_dir:
        return
    st.updated_at = _dt.datetime.now(_dt.timezone.utc).isoformat()
    try:
        _session_path(st.output_dir).write_text(json.dumps(st.to_dict(), indent=2))
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Phase dispatch
# ---------------------------------------------------------------------------

# Deterministic phases -> the fsm.py handler that owns each. Some handlers mutate
# in place and return None; others return the state. We ignore the return and read
# the mutated state object.
_PHASE_HANDLERS = {
    "acquire": lambda st: fsm.acquire_handler(st),
    "cve_research": lambda st: fsm.cve_research_handler(st),
    "sast_scan": lambda st: fsm.sast_scan_handler(st),
    "normalize": lambda st: fsm.normalize_handler(st),
    "dedup_within_source": lambda st: fsm.dedup_within_source_handler(st),
    "correlate_evidence": lambda st: fsm.correlate_evidence_handler(st),
    "agent_review": lambda st: fsm.agent_reviewer_handler(st),
    "sast_validate": lambda st: fsm.sast_validate_handler(st),
    "structure": lambda st: fsm.structure_handler(st),
    "slice": lambda st: fsm.slice_handler(st),
    "collect": lambda st: fsm.collect_handler(st),
}


def run_phase(phase: str, jsa: dict, constraints: dict) -> dict:
    """Execute one deterministic phase and update the lean ``jsa`` dict in place.

    ``jsa`` is the engine's ``ctx.extras["jsa"]`` — round-tripped by the
    checkpointer, so only JSON-safe scalar counts/pointers are written back here.
    The heavy JSAState lives on disk under ``output_dir``.
    """
    st = _get_state(jsa)
    handler = _PHASE_HANDLERS.get(phase)
    if handler is None:
        raise ValueError(f"jsa_domain.run_phase: unknown phase '{phase}'")

    try:
        handler(st)
    except Exception as exc:  # surface as a phase error but keep the run honest
        st.errors.append(f"{phase}: {exc}")

    # Phase-specific mempalace-stub side effects (subprocess can't call MCP).
    if phase == "cve_research":
        _write_cve_research_stub(st)
    elif phase == "sast_scan":
        _write_sast_stub(st)

    _save_state(st)

    # Update lean counts for the checkpointed context.
    jsa["counts"] = {
        "sast_findings": len(st.sast_findings or []),
        "module_cards": len(st.module_cards or []),
        "page_cards": len(st.page_cards or []),
        "flow_cards": len(st.flow_cards or []),
        "raw_findings": len(st.raw_findings or []),
    }

    if phase == "slice":
        # Compute the F0 needs_llm count for the INVESTIGATE wave plan. The
        # PythonVerifier populates metadata['python_verification'] during the
        # investigate pre-pass; run it here so the wave count is known when the
        # engine dispatches annie.
        needs_llm = _compute_needs_llm(st)
        inv = jsa.setdefault("investigate", {})
        inv["needs_llm"] = needs_llm
        jsa["needs_llm"] = needs_llm
        # Surface the distinct candidate vuln classes so _investigate_task can name
        # each class's reference catalog for annie (replaces the old, false
        # "guidance loaded alongside this prompt" claim in annie-base.md).
        inv["candidate_classes"] = _candidate_classes(st)

    return jsa


def _candidate_classes(st: Any) -> list:
    """Distinct vuln classes that have SLICE candidates this run, filtered to the
    known analyzer set (``lane_router`` is the single source of truth for that set,
    not a table frozen here). FlowCards may be objects (fresh) or plain dicts
    (restored from ``session.json``) — handle both. Surfaced into the lean engine
    state so the INVESTIGATE task can name ``assets/references/<class>.md`` per
    candidate class."""
    try:
        import lane_router

        known = set(lane_router.get_all_analyzers())
    except Exception:
        known = set()
    out: set = set()
    for card in st.flow_cards or []:
        cls = (
            card.get("vulnerability_class")
            if isinstance(card, dict)
            else getattr(card, "vulnerability_class", "")
        )
        cls = str(cls or "").strip()
        if cls and (not known or cls in known):
            out.add(cls)
    return sorted(out)


def _compute_needs_llm(st: Any) -> int:
    """Run the F0 PythonVerifier pre-pass (idempotent) and count needs_llm
    findings. Falls back to the flow-card count if verification data is absent."""
    try:
        if not st.metadata.get("investigate_started"):
            fsm.investigate_handler(st)
    except Exception as exc:
        st.errors.append(f"investigate_prepass: {exc}")
    pv = st.metadata.get("python_verification", {}) or {}
    results = pv.get("verification_results", []) or []
    needs = [r for r in results if isinstance(r, dict) and r.get("needs_llm_verify")]
    if needs:
        return len(needs)
    # No verifier output — fall back to the flow-card count as the sweep budget.
    return len(st.flow_cards or [])


# ---------------------------------------------------------------------------
# MemPalace stub writers (ported from orchestrate.py — MCP-call handoff)
# ---------------------------------------------------------------------------


def _stubs_path(output_dir: str) -> Path:
    return Path(output_dir) / "mempalace_stubs.json"


def _load_stubs(output_dir: str) -> list[dict]:
    p = _stubs_path(output_dir)
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text())
    except Exception:
        return []


def _write_sast_stub(st: Any) -> None:
    if not st.output_dir:
        return
    existing = _load_stubs(st.output_dir)
    room = f"{st.session_id}-sast-findings"
    existing = [s for s in existing if s.get("room") != room]
    findings = st.sast_findings or []
    content = (
        f"## SAST Findings — session {st.session_id}\n\n"
        f"**Target:** {st.target_url}\n"
        f"**Semgrep/jsluice findings:** {len(findings)}\n\n"
        "### Findings (full JSON, agents read this):\n```json\n"
        + json.dumps(findings, indent=2)
        + "\n```\n"
    )
    existing.append(
        {
            "wing": "wing_jsa",
            "room": room,
            "content": content,
            "added_by": "jsa_domain._write_sast_stub",
            "added_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        }
    )
    _stubs_path(st.output_dir).write_text(json.dumps(existing, indent=2))


def _write_cve_research_stub(st: Any) -> None:
    if not st.output_dir:
        return
    existing = _load_stubs(st.output_dir)
    room = f"{st.session_id}-cve-research"
    existing = [s for s in existing if s.get("room") != room]
    cve_meta = st.metadata.get("cve_research", {}) or {}
    versions = cve_meta.get("versions", {}) or {}
    cves = cve_meta.get("cves", []) or []
    tech_hints = cve_meta.get("tech_stack_hints", {}) or {}
    content = (
        f"## CVE Research — session {st.session_id}\n\n"
        f"**Target:** {st.target_url}\n"
        f"**Technologies detected:** {cve_meta.get('technologies_detected', 0)}\n"
        f"**Versions extracted:** {len(versions)}\n"
        f"**CVEs found:** {cve_meta.get('cve_count', len(cves))}\n"
        f"**Tech stack:** {list(tech_hints.keys())}\n\n### Detected tech + versions:\n"
    )
    for tech, ver in sorted(versions.items()):
        content += f"- **{tech}** v{ver}\n"
    if cves:
        content += "\n### Top CVEs:\n"
        for cve in cves[:10]:
            content += (
                f"- **{cve.get('cve_id', 'unknown')}** "
                f"({cve.get('library', '?')}, CVSS {cve.get('cvss_score', '?')})\n"
            )
    existing.append(
        {
            "wing": "wing_jsa",
            "room": room,
            "content": content,
            "added_by": "jsa_domain._write_cve_research_stub",
            "added_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        }
    )
    _stubs_path(st.output_dir).write_text(json.dumps(existing, indent=2))


def read_mempalace_stubs(output_dir: str) -> list[dict]:
    """Return the accumulated mempalace stubs for Penny to replay via
    memory_add_drawer. Shape per entry: {wing, room, content, added_by, added_at}."""
    return _load_stubs(output_dir)


def write_learned_rules(new_rules: list) -> dict:
    """Persist REFLECT-authored semgrep rules to the shared learned-rules dir
    (self-improving SAST). Bridges to ``learned_rules.write_learned_rules``;
    returns ``{written, rejected, dir}``. Never raises."""
    try:
        from learned_rules import write_learned_rules as _write

        return _write(new_rules)
    except Exception as exc:  # noqa: BLE001
        return {"written": [], "rejected": [{"filename": "*", "reason": str(exc)}], "dir": ""}


# ---------------------------------------------------------------------------
# Security-critical helpers (ported verbatim from orchestrate.py)
# ---------------------------------------------------------------------------


def build_auth_katana_args(intake: dict) -> tuple[list[str], dict]:
    """Build auth args for katana/curl from intake. Tokens go via env vars, NEVER
    literal argv (prevents credential leak in ``ps aux``). Ported verbatim."""
    args: list[str] = []
    env: dict = {}
    auth_mode = intake.get("authenticated_testing", "anonymous_only")
    if auth_mode == "anonymous_only":
        return args, env
    session_mgmt = intake.get("session_management", "")
    session_details = intake.get("session_details", "")
    if session_mgmt == "cookie":
        cookie_value = session_details.strip()
        if cookie_value:
            if "=" in cookie_value and "\n" not in cookie_value:
                args.extend(["-H", f"Cookie: {cookie_value}"])
            else:
                env["JSA_COOKIE"] = cookie_value
                args.extend(["-H", "Cookie: $JSA_COOKIE"])
    elif session_mgmt == "jwt_header":
        token = session_details.strip()
        if token:
            env["JSA_TOKEN"] = token
            args.extend(["-H", "Authorization: Bearer $JSA_TOKEN"])
    elif session_mgmt == "custom_header":
        for line in session_details.split("\n"):
            line = line.strip()
            if ":" in line:
                key, val = line.split(":", 1)
                key, val = key.strip(), val.strip()
                env_key = f"JSA_HDR_{key.upper().replace('-', '_')}"
                env[env_key] = val
                args.extend(["-H", f"{key}: ${env_key}"])
    elif session_mgmt == "mixed":
        for line in session_details.split("\n"):
            line = line.strip()
            if not line:
                continue
            if "=" in line and ":" not in line:
                env["JSA_COOKIE"] = line
                args.extend(["-H", "Cookie: $JSA_COOKIE"])
            elif ":" in line:
                key, val = line.split(":", 1)
                key, val = key.strip(), val.strip()
                env_key = f"JSA_HDR_{key.upper().replace('-', '_')}"
                env[env_key] = val
                args.extend(["-H", f"{key}: ${env_key}"])
    return args, env


def is_out_of_scope(url: str, patterns: list[str]) -> bool:
    """Substring scope enforcement (ported). True if ``url`` matches any
    out-of-scope pattern."""
    if not patterns:
        return False
    return any(p and p in url for p in patterns)
