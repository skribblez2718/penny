"""Best-effort capture of a terminal run's outcome into ``penny/outcomes``.

This is the **capture** side of Penny's self-improvement loop. The nightly
compression job (``run_compression.py``), the twice-daily ambient watchers
(``signal_generators.py``), and the weekly digest (``run_digest.py``) all mine
``penny/outcomes`` — but that room went stale the moment the composable-skills
``learn`` skill (its former writer) was deleted in the engine pivot. With no
writer, every miner has been reading an empty room, so the loop produced
nothing. The engine is the single execution substrate now, so the engine's
terminal states are the correct, permanent home for this write.

Design constraints:
  * **Never affect the run.** Every failure is swallowed; capture is advisory.
  * **Format must satisfy all three readers.** The drawer is a compact
    ``key: value`` header line (so the mismatch watcher's 200-char *summary*
    always contains an unquoted ``delta_score: MISMATCH`` its regex can match)
    followed by a full JSON body (so the compression/digest JSON parsers get a
    structured record). See the parsers in ``run_compression._parse_outcome_record``
    and ``signal_generators._parse_outcome_text``.
  * **No test pollution.** The write is skipped under pytest and can be disabled
    with ``PENNY_CAPTURE_OUTCOMES=0``.
"""

from __future__ import annotations

import json
import os
import sys
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Optional, cast  # noqa: F401

from .loans import loan_enabled

if TYPE_CHECKING:  # pragma: no cover
    from .context import RunContext

# Map a playbook NAME onto the outcome-ledger domain enum
# (schema.py DomainCategory). Unmapped playbooks fall back to "other".
_DOMAIN_BY_PLAYBOOK = {
    "code": "coding",
    "coding": "coding",
    "jsa": "coding",
    "sca": "coding",
    "research": "research",
    "plan": "planning",
    "prd": "planning",
    "rez": "communication",
    "agent": "other",
}


def _capture_enabled() -> bool:
    """Capture is on in production, off under tests / when disabled."""
    if os.environ.get("PENNY_CAPTURE_OUTCOMES", "1") == "0":
        return False
    if "PYTEST_CURRENT_TEST" in os.environ or "pytest" in sys.modules:
        return False
    return True


def _resolve_project_root(ctx: "RunContext") -> Optional[Path]:
    candidate = getattr(ctx, "project_root", "") or os.environ.get("PROJECT_ROOT", "")
    if candidate and (Path(candidate) / "scripts" / "system" / "bridge").is_dir():
        return Path(candidate)
    # Fall back to walking up from this file: .../penny/apps/orchestration/src/orchestration/
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "scripts" / "system" / "bridge" / "memory_bridge.py").is_file():
            return parent
    return None


def _delta_score(ctx: "RunContext") -> str:
    """MATCH (goal met) / MISMATCH (goal not met).

    A run that iterated before meeting its goal is still a success — labeling
    it PARTIAL counted it as suboptimal everywhere (mismatch watcher, eval
    suite) and made the staleness watcher flag it "unresolved" forever:
    decision_ids are unique run_ids, so the watcher's "resolved by a newer
    MATCH for the same decision_id" condition can never fire. The iteration
    count is captured separately in the JSON body.
    """
    return "MATCH" if getattr(ctx, "met", False) else "MISMATCH"


def _one_line(text: Any, limit: int = 0) -> str:
    """Collapse a value to a single line. NO truncation by default.

    Newlines are flattened so a value stays one line; the content is preserved in full.
    ``limit > 0`` is only used for the header line, which is a fixed-width *summary*
    surface (the mismatch watcher reads ~200 chars) — the body JSON below carries the
    complete record. Body fields were previously clipped to 160-240 chars and sliced to
    the first 3-5 items, which discarded the captured evidence and gap detail the
    learning loop exists to distil.
    """
    s = str(text or "").replace("\n", " ").replace("\r", " ").strip()
    return s[:limit] if limit > 0 else s


def _reason(ctx: "RunContext", delta: str) -> str:
    """A normalized, GROUPABLE failure reason.

    compression_loop.identify_patterns groups outcomes by this exact field and
    only proposes an amendment when the same reason recurs (>=2). So it must be
    a coarse category (the first error/gap, lowercased + truncated), NOT unique
    per-run text — otherwise every run is its own singleton and no pattern ever
    forms. Without this field the compression job yields zero patterns forever.
    """
    if delta == "MATCH":
        iteration = getattr(ctx, "iteration", 0)
        return (
            "goal met on first pass" if iteration <= 1 else f"goal met after {iteration} iterations"
        )
    errors = list(getattr(ctx, "errors", []) or [])
    gaps = list(getattr(ctx, "verify_gaps", []) or [])
    raw = errors[0] if errors else (gaps[0] if gaps else "")
    norm = _one_line(raw, 80).lower().strip()
    if norm:
        return norm
    return "goal not met" if delta == "MISMATCH" else "partial completion"


# Verifier-gap text → a categorical failure_mode. These values MIRROR
# capture.FAILURE_MODES (the vocabulary the compression loop clusters on); a test
# asserts the subset relationship so the two can't drift. Only VERIFY GAPS —
# genuine work-quality descriptions from vera — are classified this way. A hard
# orchestration error (bad contract, retries exhausted, step cap) is a PROCESS
# failure, not a work-quality category, so it stays "other" and
# compression_loop._grouping_key falls back to its already-repeatable error
# string for clustering.
_FAILURE_MODE_KEYWORDS = (
    (
        "missing_constraint",
        (
            "missing",
            "constraint",
            "requirement",
            "did not address",
            "not addressed",
            "omitted",
            "ignored",
            "left out",
        ),
    ),
    (
        "unverified_claim",
        (
            "unverified",
            "no evidence",
            "unsupported",
            "not grounded",
            "no citation",
            "unsubstantiated",
            "fabricat",
        ),
    ),
    (
        "wrong_result",
        (
            "wrong",
            "incorrect",
            "does not work",
            "doesn't work",
            "broken",
            "fails",
            "failing",
            "bug",
        ),
    ),
    ("incomplete", ("incomplete", "partial", "unfinished", "not implemented", "stub", "todo")),
)


#: Model-judged failure-mode classification. When set to a ``provider/model`` spec, a
#: model reads the gap text and picks from the SAME vocabulary the keyword table
#: encodes; unset, or on ANY failure, the keyword table decides exactly as before.
#: Mirrors the PI_STALL_MODEL / PI_STRATEGY_MODEL pattern: model judgment primary,
#: hand-built strings demoted to the fallback they should be.
_FAILURE_MODE_MODEL_ENV = "PI_FAILURE_MODE_MODEL"

#: The categorical vocabulary. Single source of truth for BOTH the keyword table and
#: the model prompt, so the two classifiers can never drift apart.
FAILURE_MODES: tuple[str, ...] = (
    "missing_constraint",
    "unverified_claim",
    "wrong_result",
    "incomplete",
)


def _load_detect() -> Callable[..., dict[str, Any]] | None:
    """Lazy-import the shared ``detect()`` primitive (scripts/system/lib), or None.

    Deliberately duplicated from ``engine._load_detect`` rather than imported: the
    engine imports THIS module (``record_outcome``), so importing it back would be a
    cycle. Ten lines of duplication beats restructuring the import graph of shared
    code that every skill runs through.
    """
    try:
        for parent in Path(__file__).resolve().parents:
            lib = parent / "scripts" / "system" / "lib"
            if lib.is_dir():
                if str(lib) not in sys.path:
                    sys.path.insert(0, str(lib))
                from detect import detect as _detect

                return cast(Callable[..., dict[str, Any]], _detect)
    except Exception:  # noqa: BLE001 — capture must never raise
        return None
    return None


def _failure_mode_via_model(
    gaps: list[Any], runner: Callable[..., Any] | None = None
) -> Optional[str]:
    """Classify the gap text with a model. Returns a mode, or None on any failure
    (=> the keyword table decides)."""
    spec = os.environ.get(_FAILURE_MODE_MODEL_ENV, "").strip()
    if not spec:
        return None
    detect = _load_detect()
    if detect is None:
        return None
    artifact = "The verifier reported these gaps:\n" + "\n".join(f"- {g}" for g in gaps)
    try:
        result = detect(
            artifact,
            "Which single category best describes why this work failed " "verification?",
            model_spec=spec,
            labels=FAILURE_MODES,
            runner=runner,
        )
    except Exception:  # noqa: BLE001 — capture must never raise
        return None
    if not result.get("ok"):
        return None
    answer = str(result.get("answer", "")).strip().lower()
    return answer if answer in FAILURE_MODES else None


def _failure_mode_via_keywords(gaps: list[Any]) -> str:
    """The hand-built fallback classifier (tagged LOAN ``failure_mode_keywords``)."""
    if not loan_enabled("failure_mode_keywords"):
        return "incomplete"  # scaffold-OFF: no keyword knowledge applied
    text = " ".join(str(g) for g in gaps).lower()
    for mode, keywords in _FAILURE_MODE_KEYWORDS:
        if any(k in text for k in keywords):
            return mode
    return "incomplete"  # verifier found gaps but nothing more specific matched


def _failure_mode(ctx: "RunContext", delta: str, runner: Callable[..., Any] | None = None) -> str:
    """Categorical failure key for the compression loop (mirrors
    capture.FAILURE_MODES). Empty for a MATCH.

    Model judgment first when ``PI_FAILURE_MODE_MODEL`` is set — the keyword table is
    a hand-built substitute for reading the gap text, and it only degrades as models
    improve (it cannot see paraphrase, negation, or a failure mode nobody enumerated).
    Unset or on any failure the table decides, so behaviour is unchanged by default.
    """
    if delta != "MISMATCH":
        return ""
    gaps = list(getattr(ctx, "verify_gaps", []) or [])
    if gaps:
        judged = _failure_mode_via_model(gaps, runner=runner)
        return judged if judged is not None else _failure_mode_via_keywords(gaps)
    # No verify gaps → a hard orchestration error; leave categorical clustering
    # to the (repeatable) error string via compression_loop._grouping_key.
    return "other"


def build_outcome_content(ctx: "RunContext", now: Optional[datetime] = None) -> str:
    """Render the drawer content (header line + JSON body). Pure; unit-tested."""
    now = now or datetime.now(timezone.utc)
    ts = now.isoformat()
    playbook = getattr(ctx, "playbook", "") or "unknown"
    domain = _DOMAIN_BY_PLAYBOOK.get(playbook, "other")
    delta = _delta_score(ctx)
    run_id = getattr(ctx, "run_id", "") or "unknown"
    session_id = getattr(ctx, "session_id", "") or "unknown"
    confidence = getattr(ctx, "last_confidence", "") or ""
    errors = list(getattr(ctx, "errors", []) or [])
    verify_gaps = list(getattr(ctx, "verify_gaps", []) or [])

    # Header line: keep the mismatch-signal fields FIRST so they survive the
    # 200-char summary truncation the mismatch watcher reads.
    #
    # ``verify_verdict`` rides in the header (right after delta_score, omitted when a
    # playbook has no verify signal) because DELIVERY and VERIFICATION are different
    # questions and a watcher must be able to see both. ``delta_score`` answers "did
    # the run produce its artifact?"; a run can answer MATCH there while its
    # verification gate FAILED — research ships a report with unverified claims
    # exactly this way, honestly and by design. With the verdict only in the JSON
    # body, the header-reading watchers saw an unqualified MATCH and such runs were
    # invisible to the improvement loop. Overloading ``met`` to fix that would have
    # conflated "did not deliver" with "delivered unverified"; adding a measurement
    # surface keeps the two facts distinct.
    verify_verdict = str(getattr(ctx, "verify_verdict", "") or "")
    verdict_field = f"verify_verdict: {verify_verdict} | " if verify_verdict else ""
    header = (
        f"decision_id: {run_id} | delta_score: {delta} | {verdict_field}"
        f"domain: {domain} | session_id: {session_id} | "
        f"confidence_at_action: {confidence} | timestamp: {ts}"
    )

    code_state = (getattr(ctx, "extras", {}) or {}).get("code", {})
    terminal_result = code_state.get("terminal_result", {}) if isinstance(code_state, dict) else {}
    body = {
        "decision_id": run_id,
        "run_id": run_id,
        "session_id": session_id,
        "playbook": playbook,
        "domain": domain,
        "action_taken": _one_line(getattr(ctx, "goal", "")),
        "expected_outcome": _one_line(
            "; ".join(str(c) for c in getattr(ctx, "success_criteria", []) or [])
            or "goal satisfied"
        ),
        "actual_outcome": _one_line(
            "met"
            if getattr(ctx, "met", False)
            else "; ".join(str(e) for e in errors[:3]) or "not met"
        ),
        "delta_score": delta,
        "outcome": delta,  # dup for readers that key on `outcome` directly
        # `reason` is the human-readable detail; `failure_mode` is the
        # CATEGORICAL key compression_loop._grouping_key clusters on (empty for a
        # MATCH). Derived from the verifier gaps for engine terminals.
        "reason": _reason(ctx, delta),
        "failure_mode": _failure_mode(ctx, delta),
        "confidence_at_action": confidence,
        "iteration": getattr(ctx, "iteration", 0),
        "verify_verdict": getattr(ctx, "verify_verdict", ""),
        # Full record — every gap, every evidence item, every error.
        "verify_gaps": [_one_line(g) for g in verify_gaps],
        # Ledger records outcome+evidence (atomic-loop checklist).
        "verify_evidence": [_one_line(e) for e in list(getattr(ctx, "verify_evidence", []) or [])],
        "errors": [_one_line(e) for e in errors],
        # P0 code results retain the complete structured terminal references and
        # accepted residual-risk records. Non-P0 playbooks emit empty defaults.
        "terminal_reason": terminal_result.get("terminal_reason", ""),
        "selected_artifacts": terminal_result.get("selected_artifacts", {}),
        "residual_risks": terminal_result.get("residual_risks", []),
        "result_met": terminal_result.get("met", getattr(ctx, "met", False)),
        "timestamp": ts,
    }
    return header + "\n" + json.dumps(body)


# NOTE: there is deliberately NO size trim here. An earlier revision of this file
# capped the record at 3,800 chars on the belief that MemPalace's 4,000-char chunk
# threshold splits a drawer into fragments "no json-parsing reader can reassemble"
# (the same premise ``run_compression.store_amendment`` acts on). That premise is
# FALSE, verified 2026-07-28: chunking is an EMBEDDING-quality measure, chunks are
# non-overlapping and carry ``drawer_key`` + ``chunk_index``, and
# ``tool_smart_search(include_full=True)`` returns the COMPLETE document on every
# chunk hit (measured: a 16,597-char drawer returned whole across 3 chunk hits).
# Every reader of this room already passes ``include_full=True``. The real ceiling is
# the bridge's ``_MAX_DRAWER_CHARS`` (200,000), which REJECTS loudly with an error
# rather than truncating. So the record is written in full.


def record_outcome(ctx: "RunContext", checkpointer: Any | None = None) -> bool:
    """Persist a canonical P0 outcome, then mirror it to MemPalace best-effort.

    Non-P0 outcome capture remains advisory. For P0 code runs the SQLite artifact
    registry is the durable authority, so this function returns false if that
    required write fails and the engine can suppress public success.
    """
    code_state = (getattr(ctx, "extras", {}) or {}).get("code", {})
    p0_enabled = isinstance(code_state, dict) and code_state.get("p0_enabled") is True
    canonical_persisted = False
    try:
        content = build_outcome_content(ctx)
        if p0_enabled:
            from .checkpointer import Checkpointer
            from .code_artifacts import ArtifactRegistry

            owner = checkpointer if checkpointer is not None else Checkpointer()
            artifact_registry = ArtifactRegistry(owner, getattr(ctx, "run_id", ""))
            outcome_payload = {
                "content": content,
                "terminal_result": deepcopy(code_state.get("terminal_result", {})),
            }
            selected_outcome = artifact_registry.selected("outcome")
            if (
                selected_outcome is None
                or artifact_registry.get(selected_outcome).payload != outcome_payload
            ):
                artifact_registry.create_and_register(
                    kind="outcome",
                    payload=outcome_payload,
                    producer="orchestration-engine",
                    authority="terminal-outcome-writer",
                    upstream_refs=tuple(artifact_registry.selections().values()),
                )
            canonical_persisted = True

        if not _capture_enabled():
            return canonical_persisted
        root = _resolve_project_root(ctx)
        if root is None:
            return canonical_persisted
        bridge_dir = str(root / "scripts" / "system" / "bridge")
        if bridge_dir not in sys.path:
            sys.path.insert(0, bridge_dir)
        from memory_bridge import tool_add_drawer

        result = tool_add_drawer(
            {
                "wing": "penny",
                "room": "outcomes",
                "content": content,
                "added_by": f"engine:{getattr(ctx, 'playbook', 'unknown')}",
                "source_file": "apps/orchestration/src/orchestration/engine.py",
                "type": "outcome",
            }
        )
        mirrored = bool(isinstance(result, dict) and result.get("success"))
        return canonical_persisted if p0_enabled else mirrored
    except Exception:
        return False if p0_enabled else canonical_persisted
