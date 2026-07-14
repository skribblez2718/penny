"""Generate structured amendment JSON from classified learnings.

Builds amendment records for storage in mempalace (penny/system_amendments).
Handles ID generation, risk scoring, action inference, and validation.
"""

import json
import os
import re
import sys
from datetime import date, datetime
from pathlib import Path
from typing import List, Dict, Any, Optional
from uuid import uuid4

from amendment_applier import _touches_security_block  # the security authority


def _load_pi_json_call():
    """Lazy-import the shared headless-pi caller (scripts/system/lib, #8)."""
    lib = str(Path(__file__).resolve().parents[1] / "lib")
    if lib not in sys.path:
        sys.path.insert(0, lib)
    from detect import pi_json_call  # type: ignore[import-not-found]
    return pi_json_call


_DIFF_MODEL_ENV = "PI_SELFIMPROVE_DIFF_MODEL"
_DIFF_SYSTEM = (
    "You draft a SINGLE concrete edit to a system prompt/config file that would fix "
    "a recurring failure. Reply with EXACTLY one JSON object and nothing else:\n"
    '{"action": "MODIFY" or "ADD", "old_text": "<verbatim slice of the file to '
    'replace; empty for ADD>", "new_text": "<replacement / appended text>", '
    '"rationale": "<one sentence>"}.\n'
    "Rules: for MODIFY, old_text MUST be an EXACT substring copied verbatim from the "
    "file. Prefer a minimal, surgical MODIFY that inserts brief, actionable guidance "
    "near the relevant section; use ADD only when there is no anchor. NEVER touch a "
    "<system_directives> or <system_boundary> block. Keep new_text focused (a few lines)."
)


class AmendmentAction:
    ADD = "ADD"
    MODIFY = "MODIFY"
    REMOVE = "REMOVE"


def _next_id() -> str:
    """Generate unique amendment ID: amend_YYYY-MM-DD_HHMMSS_xxxx.

    Time-sortable and collision-proof across processes — the old date+counter
    scheme reset its counter per process, so two nightly-job invocations on
    one date could both mint amend_<date>_001 and a review CLI keyed on
    amendment_id would act on the wrong record.
    """
    return (
        f"amend_{date.today().isoformat()}_"
        f"{datetime.now().strftime('%H%M%S')}_{uuid4().hex[:4]}"
    )


def _clip(text: str, cap: int) -> str:
    """One-line truncation for free-text fields.

    Trigger/evidence/rationale carry model-written prose (outcome reasons can
    run 500+ chars); uncapped, a record with a few recurrences crosses the
    bridge's 4,000-char chunking threshold and the stored drawer becomes
    unparseable by every amendment reader. old_text/new_text are never
    clipped — the applier matches them verbatim.
    """
    flat = " ".join(str(text).split())
    return flat if len(flat) <= cap else flat[: cap - 1] + "…"


def _infer_action(old_text: str) -> str:
    """Infer amendment action from old_text presence."""
    if not old_text:
        return AmendmentAction.ADD
    return AmendmentAction.MODIFY


def _assess_risk(target_layer: str, target_file: str) -> str:
    """Assess risk level based on target layer and file criticality.

    HIGH  → plan skill core prompts (piper, orchestrator-dependent)
    MEDIUM → other skill prompts
    LOW   → preferences, config (isolated, easily reversible)
    """
    if target_layer == "MEMPALACE_PREF" or target_layer == "CONFIG":
        return "LOW"
    basename = target_file.replace("\\", "/").split("/")[-1].lower()
    if basename in ("piper.md", "orchestrate.py"):
        return "HIGH"
    return "MEDIUM"


def generate_amendment(
    learning: str,
    evidence: List[str],
    target_layer: str,
    target_file: str,
    proposed_text: Optional[str] = None,
    old_text: Optional[str] = None,
    changes: Optional[List[Dict[str, str]]] = None,
    domain: Optional[str] = None,
) -> Dict[str, Any]:
    """Generate a structured amendment record.

    Returns amendment dict ready for mempalace storage.
    Status is PENDING on success, INVALID if validation fails.
    """
    errors = []

    if not evidence:
        errors.append("Amendment requires evidence (non-empty evidence list)")
    if not changes and not proposed_text:
        errors.append("Amendment requires either proposed_text or explicit changes")

    if errors:
        return {
            "amendment_id": _next_id(),
            "proposed_date": date.today().isoformat(),
            "target_layer": target_layer,
            "target_file": target_file,
            "trigger": learning,
            "evidence": evidence,
            "changes": [],
            "errors": errors,
            "status": "INVALID",
        }

    # Build changes list
    amendment_changes: List[Dict[str, str]] = []
    if changes:
        amendment_changes = [
            {
                "action": c.get("action", _infer_action(c.get("old_text", ""))),
                "old_text": c.get("old_text", ""),
                "new_text": c.get("new_text", ""),
                "rationale": _clip(c.get("rationale", learning), 240),
            }
            for c in changes
        ]
    elif proposed_text is not None:
        action = _infer_action(old_text or "")
        amendment_changes.append(
            {
                "action": action,
                "old_text": old_text or "",
                "new_text": proposed_text,
                "rationale": _clip(learning, 240),
            }
        )

    record = {
        "amendment_id": _next_id(),
        "proposed_date": date.today().isoformat(),
        "target_layer": target_layer,
        "target_file": target_file,
        "trigger": _clip(learning, 240),
        "evidence": [_clip(ev, 200) for ev in evidence[:5]],
        "changes": amendment_changes,
        "risk": _assess_risk(target_layer, target_file),
        "status": "PENDING",
    }
    if domain:
        # Ties the amendment to the outcome-ledger domain so efficacy can be
        # measured (mismatch rate in this domain before vs after apply).
        record["domain"] = domain
    return record


def draft_change(  # noqa: C901 - linear draft -> parse -> validate -> security guard
    learning: str, evidence, target_file: str, *, runner=None
) -> Optional[Dict[str, str]]:
    """(#23) Model-draft a real, anchored old->new diff for ``target_file``.

    Replaces the boilerplate template block with a concrete, verbatim-anchored
    edit the model authors from the actual file content. Returns a validated
    change dict, or None (=> caller falls back to the template guidance) when: the
    diff model is not enabled (PI_SELFIMPROVE_DIFF_MODEL unset), the target is not
    a readable file, the model fails, or the draft is invalid/unsafe.

    DRAFT-ONLY: the amendment stays PENDING and is written only after human
    approval through the #22-hardened apply gate — which independently re-checks
    the verbatim anchor and refuses any touch of the immutable security frame.
    """
    spec = os.environ.get(_DIFF_MODEL_ENV, "").strip()
    if not spec:
        return None
    try:
        content = Path(target_file).read_text(encoding="utf-8")
    except OSError:
        return None
    ev = "\n".join(f"- {e}" for e in (evidence or [])[:5])
    prompt = (
        f"RECURRING FAILURE:\n{(learning or '').strip()[:400]}\n\n"
        + (f"EVIDENCE:\n{ev}\n\n" if ev else "")
        + f'FILE ({target_file}):\n"""\n{content[:8000]}\n"""\n\n'
        + 'Return one JSON object with action/old_text/new_text/rationale.'
    )
    try:
        text = _load_pi_json_call()(prompt, model_spec=spec, system=_DIFF_SYSTEM,
                                    runner=runner)
    except Exception:  # noqa: BLE001 - drafting must never break the loop
        return None
    if not text:
        return None
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return None
    try:
        obj = json.loads(match.group(0))
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(obj, dict):
        return None
    action = str(obj.get("action", "")).strip().upper()
    old_text = str(obj.get("old_text", "") or "")
    new_text = str(obj.get("new_text", "") or "")
    if action not in ("ADD", "MODIFY") or not new_text:
        return None
    if action == "MODIFY" and (not old_text or old_text not in content):
        return None  # the anchor must be present verbatim in the file
    change = {
        "action": action,
        "old_text": old_text,
        "new_text": new_text,
        "rationale": str(obj.get("rationale", "") or learning),
    }
    # Security authority: never even PROPOSE a diff that touches the immutable frame.
    if _touches_security_block(content, change):
        return None
    return change
