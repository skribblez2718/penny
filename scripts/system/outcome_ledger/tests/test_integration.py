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
)


class TestLedgerWriteReadRoundtrip:
    """Write + read roundtrip via in-memory mock backend."""

    def _make_writer(self, store):
        """Return a writer that appends to store list."""

        def writer(payload):
            store.append(payload)
            return {"success": True, "drawer_id": f"drawer_{len(store)}"}

        return writer

    def _make_reader(self, store):
        """Return a reader that searches store by substring match."""

        def reader(query, wing, room, limit):
            results = []
            for entry in store:
                text = entry.get("content", "")
                # Match: all recent entries, or substring search, or pending query
                if query in ("outcome ledger recent", "outcome ledger pending") or query in text:
                    results.append({"text": text, "wing": wing, "room": room})
                if len(results) >= limit:
                    break
            return results

        return reader

    def test_write_and_read(self):
        store = []
        writer = self._make_writer(store)
        reader = self._make_reader(store)

        rec = OutcomeRecord(
            decision_id="d_integ_001",
            session_id="sess-001",
            action_taken="Created plan",
            expected_outcome="Plan approved",
            confidence_at_action="PROBABLE",
            domain="planning",
        )

        result = write_record(rec, writer=writer)
        assert result["success"] is True

        records = read_recent(reader=reader)
        assert len(records) == 1
        assert records[0].decision_id == "d_integ_001"
        assert records[0].domain == "planning"

    def test_read_filter_by_query(self):
        store = []
        writer = self._make_writer(store)

        # Write two records
        write_record(
            OutcomeRecord(
                decision_id="coding_001",
                session_id="s1",
                action_taken="Refactor auth",
                expected_outcome="Tests pass",
                domain="coding",
            ),
            writer=writer,
        )
        write_record(
            OutcomeRecord(
                decision_id="planning_001",
                session_id="s2",
                action_taken="Create roadmap",
                expected_outcome="Roadmap approved",
                domain="planning",
            ),
            writer=writer,
        )

        reader = self._make_reader(store)
        coding_records = read_recent(query="coding_001", reader=reader, limit=5)
        assert len(coding_records) == 1
        assert coding_records[0].decision_id == "coding_001"

    def test_update_evaluation(self):
        store = []
        writer = self._make_writer(store)

        # Write initial record
        write_record(
            OutcomeRecord(
                decision_id="eval_001",
                session_id="s1",
                action_taken="Did thing",
                expected_outcome="It works",
                domain="coding",
            ),
            writer=writer,
        )

        reader = self._make_reader(store)

        deleted_ids = []

        def deleter(decision_id):
            deleted_ids.append(decision_id)
            # Remove from store
            store[:] = [e for e in store if decision_id not in e["content"]]
            return True

        ok = update_evaluation(
            decision_id="eval_001",
            actual_outcome="It partially worked",
            delta_score="PARTIAL",
            user_feedback="Needs retry",
            reader=reader,
            writer=writer,
            deleter=deleter,
        )
        assert ok is True

        updated = read_recent(query="eval_001", reader=reader, limit=5)
        assert len(updated) == 1
        assert updated[0].actual_outcome == "It partially worked"
        assert updated[0].delta_score == "PARTIAL"
        assert updated[0].user_feedback == "Needs retry"

    def test_pending_evaluations_list(self):
        store = []
        writer = self._make_writer(store)

        # Pending record
        write_record(
            OutcomeRecord(
                decision_id="pending_1",
                session_id="s1",
                action_taken="Action A",
                expected_outcome="Outcome A",
            ),
            writer=writer,
        )
        # Evaluated record
        write_record(
            OutcomeRecord(
                decision_id="evaluated_1",
                session_id="s2",
                action_taken="Action B",
                expected_outcome="Outcome B",
                actual_outcome="It worked",
                delta_score="MATCH",
            ),
            writer=writer,
        )

        reader = self._make_reader(store)
        pending = list_pending_evaluations(reader=reader)
        assert len(pending) == 1
        assert pending[0].decision_id == "pending_1"

    def test_summarize_by_domain(self):
        records = [
            OutcomeRecord(
                "d1", "s", "A", "E", actual_outcome="Done", delta_score="MATCH", domain="coding"
            ),
            OutcomeRecord(
                "d2", "s", "A", "E", actual_outcome="Fail", delta_score="MISMATCH", domain="coding"
            ),
            OutcomeRecord("d3", "s", "A", "E", domain="coding"),  # pending
            OutcomeRecord(
                "d4", "s", "A", "E", actual_outcome="Done", delta_score="MATCH", domain="planning"
            ),
        ]
        summary = summarize_by_domain(records)
        assert summary["coding"]["MATCH"] == 1
        assert summary["coding"]["MISMATCH"] == 1
        assert summary["coding"]["pending"] == 1
        assert summary["planning"]["MATCH"] == 1
        assert summary["planning"]["MISMATCH"] == 0
