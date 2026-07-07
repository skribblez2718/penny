"""Outcome Ledger write/read/operations with dependency-injected backend."""

from typing import Callable, Dict, List, Optional

from .schema import OutcomeRecord

Writer = Callable[[Dict[str, str]], Dict[str, str]]
Reader = Callable[[str, str, int], List[Dict[str, str]]]
Deleter = Callable[[str], bool]


def write_record(
    record: OutcomeRecord,
    wing: str = "penny",
    room: str = "outcomes",
    writer: Optional[Writer] = None,
) -> Dict[str, str]:
    """Write an outcome record to the ledger.

    Returns the backend result dict (typically {success: bool, drawer_id: str}).
    """
    record.validate()
    content = record.to_json()

    if writer is None:
        # Will be supplied by caller or default
        raise ValueError(
            "writer must be provided; use memory_add_drawer wrapper " "or inject a test mock"
        )

    result = writer({"wing": wing, "room": room, "content": content})
    return result


def read_recent(
    query: str = "outcome ledger recent",
    wing: str = "penny",
    room: str = "outcomes",
    limit: int = 5,
    reader: Optional[Reader] = None,
) -> List[OutcomeRecord]:
    """Read recent outcome records from the ledger."""
    if reader is None:
        raise ValueError(
            "reader must be provided; use memory_smart_search wrapper " "or inject a test mock"
        )

    results = reader(query, wing, room, limit)
    records: List[OutcomeRecord] = []
    for r in results:
        raw = r.get("text", "")
        if raw:
            try:
                records.append(OutcomeRecord.from_json(raw))
            except Exception:
                continue
    return records


def update_evaluation(
    decision_id: str,
    actual_outcome: str,
    delta_score: str,
    user_feedback: str = "",
    wing: str = "penny",
    room: str = "outcomes",
    reader: Optional[Reader] = None,
    writer: Optional[Writer] = None,
    deleter: Optional[Deleter] = None,
) -> bool:
    """Update an existing record with actual outcome and delta score.

    Reads the record, updates it, deletes old version, writes new version.
    """
    if reader is None or writer is None or deleter is None:
        raise ValueError("reader, writer, and deleter must be provided")

    records = read_recent(
        query=decision_id,
        wing=wing,
        room=room,
        limit=10,
        reader=reader,
    )

    for rec in records:
        if rec.decision_id == decision_id:
            rec.actual_outcome = actual_outcome
            rec.delta_score = delta_score  # type: ignore[assignment]
            rec.user_feedback = user_feedback

            # Delete old version
            # Note: actual deletion requires drawer_id; this is a simplified interface
            deleter(decision_id)

            write_record(rec, wing=wing, room=room, writer=writer)
            return True

    return False


def list_pending_evaluations(
    wing: str = "penny",
    room: str = "outcomes",
    reader: Optional[Reader] = None,
) -> List[OutcomeRecord]:
    """Return records that have not yet been evaluated (no actual_outcome)."""
    records = read_recent(
        query="outcome ledger pending",
        wing=wing,
        room=room,
        limit=50,
        reader=reader,
    )
    return [r for r in records if not r.is_evaluated()]


def summarize_by_domain(
    records: List[OutcomeRecord],
) -> Dict[str, Dict[str, int]]:
    """Aggregate outcome records by domain and delta_score.

    Returns {domain: {MATCH: n, PARTIAL: n, MISMATCH: n, pending: n}}
    """
    summary: Dict[str, Dict[str, int]] = {}
    for rec in records:
        domain = rec.domain or "uncategorized"
        if domain not in summary:
            summary[domain] = {"MATCH": 0, "PARTIAL": 0, "MISMATCH": 0, "pending": 0}

        if rec.is_evaluated():
            summary[domain][rec.delta_score] += 1
        else:
            summary[domain]["pending"] += 1

    return summary
