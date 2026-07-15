"""Source-agnostic outcome capture — give the ledger a source that matches reality.

The engine writer (`apps/orchestration/.../outcome_writer.py`) only fires at an
orchestration-engine TERMINAL state. In production Penny does most work via
direct agent/subagent calls that never drive the engine to completion, so that
seam almost never fires and the ledger stays empty — while `ledger.py`'s clean
write API sits orphaned.

`record_work_outcome` is the shared entry point ANY source can call — a human
quick-rating, a per-agent hook, a session backfill — to append one outcome that
the downstream consumers (compression clustering, quality evals, digest) can
actually mine. Critically it carries a **reason** field: the groupable failure
signature the compression loop clusters MISMATCHes on. Records written without
it (the old gap) are invisible to pattern mining.

The drawer content matches the engine writer's contract (a header line with the
mismatch-signal fields first — they survive the 200-char summary truncation —
then a JSON body) so both sources are read identically by
`eval_lib.parse_outcome` and `run_compression._parse_outcome_record`.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parents[3]

VALID_DELTA = ("MATCH", "PARTIAL", "MISMATCH")
VALID_CONFIDENCE = ("CERTAIN", "PROBABLE", "POSSIBLE", "UNCERTAIN", "")

# Controlled failure-mode vocabulary — the categorical clustering key the
# compression loop groups on. Free-text `reason` rarely repeats verbatim (judge
# and human WHY sentences almost never match), so exact-string clustering never
# fires; a fixed enum recurs reliably. `reason` survives as human-readable
# detail on each record. "other" is the catch-all and is deliberately NOT a
# clustering key (see compression_loop._grouping_key) so it can't over-cluster
# unrelated failures. Empty ("") means "not classified" (e.g. a MATCH, or an
# older record) and also does not cluster.
FAILURE_MODES = (
    "misread_request",     # misunderstood / misinterpreted what was asked
    "incomplete",          # partially done; left part of the goal unmet
    "wrong_result",        # produced an incorrect result
    "unverified_claim",    # asserted something without grounding / evidence
    "missing_constraint",  # ignored a stated constraint / requirement
    "wrong_intermediate",  # a mediating inference / step was wrong
    "scope_creep",         # did more or different than was asked
    "refused_wrongly",     # declined a valid, in-scope request
    "other",               # none of the above
)


def normalize_failure_mode(value: str) -> str:
    """Normalize a (possibly LLM-authored) failure tag.

    #19 OPEN-VOCABULARY: ``FAILURE_MODES`` is a suggested STARTER vocab, not a
    ceiling. An unrecognized tag is PRESERVED as a compact snake_case token
    (letters/digits/underscore, <=40 chars) instead of being flattened to
    "other", so specific failures stay distinguishable and semantic clustering
    (compression_loop) can group the open vocabulary by meaning. Empty / "none"
    stays empty (unclassified — e.g. a MATCH). Never raises."""
    v = (value or "").strip().lower()
    if not v or v in ("none", "n/a", "na"):
        return ""
    tag = re.sub(r"[^a-z0-9]+", "_", v).strip("_")
    return tag[:40] or "other"


# Keyword → domain, matched against the goal text (first hit wins). Mirrors the
# DomainCategory literals in schema.py; falls back to "other".
_DOMAIN_KEYWORDS = (
    ("coding", ("code", "bug", "refactor", "implement", "function", "test", "extension", "script")),
    ("research", ("research", "investigate", "find out", "analyze", "cve", "vulnerab", "audit")),
    ("planning", ("plan", "design", "architect", "roadmap", "decompose", "prd")),
    ("communication", ("email", "message", "reply", "draft", "summarize for", "write to")),
    ("learning", ("learn", "explain", "understand", "how does", "what is")),
    ("events", ("schedule", "calendar", "remind", "event", "meeting")),
    ("decision", ("decide", "should i", "choose", "which", "recommend")),
)


def infer_domain(goal: str) -> str:
    # Word-boundary match so "plan" doesn't fire on "plants" (and "code" not on
    # "encode"). Keyword phrases match on their whole span.
    text = (goal or "").lower()
    for domain, keywords in _DOMAIN_KEYWORDS:
        if any(re.search(rf"\b{re.escape(k)}\b", text) for k in keywords):
            return domain
    return "other"


# ── Model domain classifier (#11 — classify by model; keyword as the fallback) ──
# infer_domain's keyword routing mis-tags sessions, biasing every per-domain
# metric downstream (dashboard/digest/watchers). classify_domain asks a cheap
# model to pick from the SAME fixed menu (soft menu + explicit "other", so no
# novel label ever reaches a dashboard) and falls back to the keyword table on
# ANY failure — the doctrine's default+fallback: the keyword scaffold is retired
# to a resilient backstop, not deleted. Gated behind PI_LEDGER_DOMAIN_MODEL
# (unset => keyword only) so the ambient cron stays cheap/offline-safe unless an
# operator opts in; set it to a cheap `provider/model` spec, e.g.
# "anthropic/claude-haiku-4-5" or the alias "anthropic/haiku".
DOMAIN_MENU = (
    "planning", "coding", "research", "communication",
    "learning", "events", "decision", "other",
)
DOMAIN_MODEL_ENV = "PI_LEDGER_DOMAIN_MODEL"

_DOMAIN_SYSTEM = (
    "You are a precise task-domain classifier. Choose the single best-fitting "
    "domain for a work goal. Reply with EXACTLY one JSON object and nothing else: "
    '{"domain": "<label>"}. Allowed labels: ' + ", ".join(DOMAIN_MENU)
    + '. Use "other" only when none clearly fit.'
)


def normalize_domain(value: str) -> str:
    """Coerce a (possibly model-authored) domain to the controlled menu — the mirror
    of ``normalize_failure_mode``. An unrecognized non-empty value buckets to
    "other" (a dashboard never sees a novel label); empty stays empty."""
    v = (value or "").strip().lower()
    if not v:
        return ""
    return v if v in DOMAIN_MENU else "other"


def _build_domain_prompt(goal: str, action: str = "") -> str:
    parts = [f"GOAL:\n{(goal or '').strip()[:1000]}"]
    act = (action or "").strip()
    if act:
        parts.append(f"WHAT WAS DONE (context only):\n{act[:600]}")
    parts.append('Return one JSON object: {"domain": "<label>"}.')
    return "\n\n".join(parts)


def _extract_domain(text: Optional[str]) -> Optional[str]:
    """A menu label from the model text: JSON ``{"domain": X}`` first, then a bare
    menu word. None when nothing recognizable is present (=> keyword fallback)."""
    if not text:
        return None
    match = re.search(r"\{[^{}]*\}", text)
    if match:
        try:
            obj = json.loads(match.group(0))
        except (json.JSONDecodeError, ValueError):
            obj = None
        if isinstance(obj, dict) and str(obj.get("domain", "")).strip():
            return normalize_domain(str(obj["domain"]))
    low = text.lower()
    for label in DOMAIN_MENU:
        if re.search(rf"\b{re.escape(label)}\b", low):
            return label
    return None


def _load_pi_json_call():
    """Lazy-import the shared headless-pi caller (scripts/system/lib, #8)."""
    lib = str(REPO_ROOT / "scripts" / "system" / "lib")
    if lib not in sys.path:
        sys.path.insert(0, lib)
    from detect import pi_json_call  # type: ignore[import-not-found]
    return pi_json_call


def classify_domain(
    goal: str, *, action: str = "", cwd: Optional[str] = None,
    timeout_s: int = 30, runner: Optional[Callable] = None,
) -> str:
    """Classify the outcome domain (#11). Model-first when PI_LEDGER_DOMAIN_MODEL is
    set (a ``provider/model`` spec), else keyword. Falls back to the keyword
    ``infer_domain`` on ANY failure or unrecognized output — never raises, so the
    ambient cron stays resilient and the dashboard label set stays stable."""
    spec = os.environ.get(DOMAIN_MODEL_ENV, "").strip()
    if not spec:
        return infer_domain(goal)
    try:
        text = _load_pi_json_call()(
            _build_domain_prompt(goal, action), model_spec=spec,
            system=_DOMAIN_SYSTEM, cwd=cwd or str(REPO_ROOT),
            timeout_s=timeout_s, runner=runner,
        )
        label = _extract_domain(text)
    except Exception:  # noqa: BLE001 - capture must never raise; degrade to keyword
        label = None
    return label if label else infer_domain(goal)


def default_decision_id(session_id: str, goal: str) -> str:
    """A stable id derived from (session, goal) so re-capturing the same work
    dedups instead of double-recording."""
    digest = hashlib.sha256(f"{session_id}\n{goal}".encode("utf-8")).hexdigest()[:12]
    return f"decision_{digest}"


def _bridge_writer(payload: Dict[str, str]) -> Dict[str, str]:
    bridge_dir = str(REPO_ROOT / "scripts" / "system" / "bridge")
    if bridge_dir not in sys.path:
        sys.path.insert(0, bridge_dir)
    from memory_bridge import tool_add_drawer  # type: ignore[import-not-found]

    return tool_add_drawer(
        {
            "wing": payload["wing"],
            "room": payload["room"],
            "content": payload["content"],
            "added_by": payload.get("added_by", "capture"),
            "type": "outcome",
        }
    )


def build_content(record: Dict[str, object]) -> str:
    """Header line (truncation-durable mismatch signal) + JSON body."""
    header = (
        f"decision_id: {record['decision_id']} | delta_score: {record['delta_score']} | "
        f"domain: {record['domain']} | session_id: {record['session_id']} | "
        f"confidence_at_action: {record['confidence_at_action']} | timestamp: {record['timestamp']}"
    )
    return header + "\n" + json.dumps(record)


def record_work_outcome(
    *,
    goal: str,
    action_taken: str,
    delta_score: str,
    confidence: str = "",
    domain: str = "",
    reason: str = "",
    failure_mode: str = "",
    session_id: str = "",
    decision_id: str = "",
    actual_outcome: str = "",
    user_feedback: str = "",
    source: str = "",
    existing_ids: Optional[set] = None,
    writer: Optional[Callable[[Dict[str, str]], Dict[str, str]]] = None,
) -> Optional[str]:
    """Append one outcome to penny/outcomes. Returns the decision_id on write,
    None if it was a duplicate or the write failed. Never raises.

    ``delta_score`` must be MATCH/PARTIAL/MISMATCH. For MISMATCH/PARTIAL,
    ``failure_mode`` (from FAILURE_MODES) is the categorical key the compression
    loop clusters on — the field that actually makes pattern mining fire — while
    ``reason`` carries the human-readable detail. An unrecognized failure_mode
    buckets to "other" (never raises).
    """
    if delta_score not in VALID_DELTA:
        raise ValueError(f"delta_score must be one of {VALID_DELTA}, got {delta_score!r}")
    if confidence not in VALID_CONFIDENCE:
        raise ValueError(f"confidence must be one of {VALID_CONFIDENCE}, got {confidence!r}")

    did = decision_id or default_decision_id(session_id, goal)
    if existing_ids is not None and did in existing_ids:
        return None

    record = {
        "decision_id": did,
        "session_id": session_id,
        "action_taken": action_taken,
        "expected_outcome": goal,
        "actual_outcome": actual_outcome,
        "delta_score": delta_score,
        "outcome": delta_score,  # alias some readers key on
        "confidence_at_action": confidence,
        "domain": domain or classify_domain(goal, action=action_taken),
        "reason": reason,
        "failure_mode": normalize_failure_mode(failure_mode),
        "user_feedback": user_feedback,
        "source": source or "capture",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    try:
        result = (writer or _bridge_writer)(
            {
                "wing": "penny",
                "room": "outcomes",
                "content": build_content(record),
                "added_by": f"capture:{source or 'unknown'}",
            }
        )
    except Exception:
        return None
    if isinstance(result, dict) and result.get("success"):
        if existing_ids is not None:
            existing_ids.add(did)
        return did
    return None


def existing_decision_ids(
    reader: Optional[Callable[[], List[Dict[str, object]]]] = None,
) -> set:
    """The decision_ids already in penny/outcomes, for dedup. reader() returns a
    list of drawer dicts with 'content'; defaults to the live bridge."""
    drawers = (reader or _bridge_reader)()
    ids = set()
    for d in drawers:
        content = str(d.get("content", ""))
        first = content.splitlines()[0] if content else ""
        # header form: "decision_id: X | ..."
        if first.startswith("decision_id:"):
            ids.add(first.split("|", 1)[0].split(":", 1)[1].strip())
            continue
        try:
            obj = json.loads(content.splitlines()[0]) if content else {}
            if obj.get("decision_id"):
                ids.add(obj["decision_id"])
        except (json.JSONDecodeError, ValueError, IndexError):
            continue
    return ids


def _bridge_reader() -> List[Dict[str, object]]:
    bridge_dir = str(REPO_ROOT / "scripts" / "system" / "bridge")
    if bridge_dir not in sys.path:
        sys.path.insert(0, bridge_dir)
    from memory_bridge import tool_list_drawers  # type: ignore[import-not-found]

    res = tool_list_drawers(
        {"wing": "penny", "room": "outcomes", "include_content": True, "limit": 10000, "offset": 0}
    )
    if not isinstance(res, dict):
        return []
    return res.get("drawers", res.get("results", [])) or []


def parse_outcome_drawer(drawer: Dict[str, object]) -> Optional[Dict[str, object]]:
    """Parse an outcome drawer's JSON body; attach its drawer id for updates."""
    content = str(drawer.get("content", ""))
    lines = content.splitlines()
    if not lines:
        return None
    body = lines[1] if len(lines) > 1 and lines[0].startswith("decision_id:") else lines[0]
    try:
        record = json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(record, dict):
        return None
    record["_drawer_id"] = drawer.get("id") or drawer.get("drawer_id")
    return record


def load_outcomes_by_source(
    source: str, reader: Optional[Callable[[], List[Dict[str, object]]]] = None
) -> List[Dict[str, object]]:
    """Parsed outcome records whose ``source`` matches, newest-ish first."""
    drawers = (reader or _bridge_reader)()
    out = []
    for d in drawers:
        record = parse_outcome_drawer(d)
        if record and str(record.get("source")) == source:
            out.append(record)
    out.sort(key=lambda r: str(r.get("timestamp", "")), reverse=True)
    return out


def _parse_iso(ts: str) -> Optional[datetime]:
    """Parse an ISO-8601 timestamp (a structured field — NO regex); None if unparseable.
    A naive timestamp is treated as UTC so it compares against an aware cutoff."""
    ts = (ts or "").strip()
    if not ts:
        return None
    if ts.endswith("Z"):
        ts = ts[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(ts)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def load_recent_outcomes(
    window_days: int = 7,
    reader: Optional[Callable[[], List[Dict[str, object]]]] = None,
) -> List[Dict[str, object]]:
    """All outcome records within the last ``window_days``, read STRUCTURALLY from the
    outcome ledger (#18): an exhaustive drawer listing + header/JSON parse
    (``parse_outcome_drawer``) + the structured ``timestamp`` field. No fuzzy semantic
    search and no regex-prose parsing — the compression loop's data foundation. A record
    whose timestamp is missing/unparseable is KEPT (fail-open) so a producer that omitted
    it is never silently dropped. Newest first. Never raises."""
    drawers = (reader or _bridge_reader)()
    cutoff = datetime.now(timezone.utc) - timedelta(days=max(0, window_days))
    out: List[Dict[str, object]] = []
    for d in drawers:
        record = parse_outcome_drawer(d)
        if not record:
            continue
        ts = _parse_iso(str(record.get("timestamp", "")))
        if ts is not None and ts < cutoff:
            continue
        if record.get("outcome") or record.get("delta_score") or record.get("decision_id"):
            out.append(record)
    out.sort(key=lambda r: str(r.get("timestamp", "")), reverse=True)
    return out


def override_outcome(
    record: Dict[str, object],
    new_delta: str,
    user_feedback: str,
    reason: str = "",
    writer: Optional[Callable[[Dict[str, str]], Dict[str, str]]] = None,
    deleter: Optional[Callable[[str], object]] = None,
) -> bool:
    """Replace an existing outcome's verdict with the human's (delete old, write new).

    The human verdict is authoritative for the ledger label. Returns True on
    success. Never raises.
    """
    if new_delta not in VALID_DELTA:
        raise ValueError(f"delta_score must be one of {VALID_DELTA}, got {new_delta!r}")
    drawer_id = record.get("_drawer_id")
    updated = {k: v for k, v in record.items() if k != "_drawer_id"}
    updated["delta_score"] = new_delta
    updated["outcome"] = new_delta
    updated["user_feedback"] = user_feedback or "human-override"
    if reason:
        updated["reason"] = reason
    updated["source"] = "human_override"
    try:
        if drawer_id and deleter:
            deleter(str(drawer_id))
        result = (writer or _bridge_writer)(
            {
                "wing": "penny",
                "room": "outcomes",
                "content": build_content(updated),
                "added_by": "capture:human_override",
            }
        )
    except Exception:
        return False
    return bool(isinstance(result, dict) and result.get("success"))


def _bridge_deleter(drawer_id: str) -> object:
    bridge_dir = str(REPO_ROOT / "scripts" / "system" / "bridge")
    if bridge_dir not in sys.path:
        sys.path.insert(0, bridge_dir)
    from memory_bridge import tool_delete_drawer  # type: ignore[import-not-found]

    return tool_delete_drawer({"drawer_id": drawer_id})
