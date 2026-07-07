"""Generate structured amendment JSON from classified learnings.

Builds amendment records for storage in mempalace (penny/system_amendments).
Handles ID generation, risk scoring, action inference, and validation.
"""

from datetime import date, datetime
from typing import List, Dict, Any, Optional
from uuid import uuid4


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
