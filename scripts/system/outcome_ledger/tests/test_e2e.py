"""End-to-end: create → evaluate → query → summarize lifecycle."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from outcome_ledger import (  # noqa: E402
    OutcomeRecord,
    write_record,
    read_recent,
    update_evaluation,
    list_pending_evaluations,
    summarize_by_domain,
    generate_decision_id,
)


class TestOutcomeLedgerLifecycle:
    """Full lifecycle with realistic mock backend."""

    def setup_store(self):
        """Return (store, writer, reader, deleter) for a fresh backend."""
        store: list = []

        def writer(payload):
            drawer_id = f"drawer_{len(store)}"
            store.append({
                "wing": payload.get("wing"),
                "room": payload.get("room"),
                "content": payload.get("content"),
                "drawer_id": drawer_id,
            })
            return {"success": True, "drawer_id": drawer_id}

        def reader(query, wing, room, limit):
            results = []
            for entry in reversed(store):  # newest first
                text = entry.get("content", "")
                if query == "outcome ledger recent" or query == "outcome ledger pending":
                    results.append({"text": text, **entry})
                elif query in text:
                    results.append({"text": text, **entry})
                if len(results) >= limit:
                    break
            return results

        def deleter(decision_id):
            # Find drawer_id by decision_id substring
            nonlocal store
            to_remove = [e["drawer_id"] for e in store if decision_id in e["content"]]
            store = [e for e in store if e["drawer_id"] not in to_remove]
            return len(to_remove) > 0

        return store, writer, reader, deleter

    def test_full_lifecycle_match(self):
        store, writer, reader, deleter = self.setup_store()
        session_id = "e2e_full_match"

        # 1. Create decision record
        rec = OutcomeRecord(
            decision_id=generate_decision_id(session_id, 1),
            session_id=session_id,
            action_taken="Refactored auth module",
            expected_outcome="All tests pass",
            confidence_at_action="POSSIBLE",
            domain="coding",
        )
        result = write_record(rec, writer=writer)
        assert result["success"] is True

        # 2. Verify pending
        pending = list_pending_evaluations(reader=reader)
        assert len(pending) == 1
        assert pending[0].decision_id == rec.decision_id

        # 3. Evaluate (user says it matched)
        ok = update_evaluation(
            decision_id=rec.decision_id,
            actual_outcome="All 267 tests passed",
            delta_score="MATCH",
            user_feedback="Approved",
            reader=reader,
            writer=writer,
            deleter=deleter,
        )
        assert ok is True

        # 4. No pending records now
        pending_after = list_pending_evaluations(reader=reader)
        assert len(pending_after) == 0

        # 5. Read and verify
        records = read_recent(reader=reader, limit=5)
        assert len(records) == 1
        assert records[0].actual_outcome == "All 267 tests passed"
        assert records[0].delta_score == "MATCH"

    def test_full_lifecycle_mismatch(self):
        store, writer, reader, deleter = self.setup_store()
        session_id = "e2e_mismatch"

        rec = OutcomeRecord(
            decision_id=generate_decision_id(session_id, 1),
            session_id=session_id,
            action_taken="Deleted old data files",
            expected_outcome="Clean workspace",
            confidence_at_action="POSSIBLE",
            domain="coding",
        )
        write_record(rec, writer=writer)

        update_evaluation(
            decision_id=rec.decision_id,
            actual_outcome="Deleted production data by accident",
            delta_score="MISMATCH",
            user_feedback="Rolled back",
            reader=reader,
            writer=writer,
            deleter=deleter,
        )

        records = read_recent(reader=reader, limit=5)
        assert records[0].delta_score == "MISMATCH"

        # Summary
        summary = summarize_by_domain(records)
        assert summary["coding"]["MISMATCH"] == 1

    def test_multiple_domain_summary(self):
        store, writer, reader, deleter = self.setup_store()

        domains_actions = [
            ("coding", "Refactored auth", "MATCH"),
            ("coding", "Fixed bug", "PARTIAL"),
            ("planning", "Created roadmap", "MATCH"),
            ("research", "Investigated library", "MISMATCH"),
        ]

        for i, (domain, action, delta) in enumerate(domains_actions):
            rec = OutcomeRecord(
                decision_id=f"multi_{i}",
                session_id="multi",
                action_taken=action,
                expected_outcome="OK",
                actual_outcome="Done",
                delta_score=delta,
                confidence_at_action="PROBABLE",
                domain=domain,
            )
            write_record(rec, writer=writer)

        records = read_recent(reader=reader, limit=10)
        summary = summarize_by_domain(records)

        assert summary["coding"]["MATCH"] == 1
        assert summary["coding"]["PARTIAL"] == 1
        assert summary["planning"]["MATCH"] == 1
        assert summary["research"]["MISMATCH"] == 1
