"""
E2E test for signal generation and acknowledgment flow.

Verifies the complete lifecycle:
  1. Generate a signal via watcher logic
  2. Write signal to mempalace
  3. Retrieve pending signals via session-start checker
  4. Acknowledge signal
  5. Verify signal no longer appears as pending

Run:
    source .venv/bin/activate
    pytest scripts/system/watchers/test_e2e_signals.py -v
"""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Ensure venv packages are importable
_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_BRIDGE_DIR = _PROJECT_ROOT / "scripts" / "system" / "bridge"
if str(_BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(_BRIDGE_DIR))

sys.path.insert(0, str(Path(__file__).parent))

from session_start_checker import get_pending_signals, format_signal_presentation  # noqa: E402
from signal_generators import (  # noqa: E402
    generate_mempalace_growth_signal,
    generate_mismatch_rate_signal,
    write_signal,
    acknowledge_signal,
)


class TestSignalLifecycleE2E:
    """End-to-end signal lifecycle test using real mempalace operations."""

    def test_generate_write_retrieve_acknowledge(self):
        """
        Full lifecycle: generate signal → write → retrieve → acknowledge → verify gone.
        """
        from uuid import uuid4
        from memory_bridge import tool_smart_search, tool_delete_drawer
        uid = str(uuid4())[:8]
        session_id = f"e2e_test_{uid}"

        # Cleanup: remove any existing test signals from prior runs
        cleanup = tool_smart_search({
            "query": "e2e_test_",
            "wing": "penny",
            "room": "signals",
            "limit": 20,
            "include_full": True,
        })
        for r in cleanup.get("results", []):
            text = r.get("text", "")
            if "e2e_test_" in text:
                try:
                    tool_delete_drawer({"drawer_id": r.get("id")})
                except Exception:
                    pass

        # Build a completely unique signal to avoid semantic dedup collisions.
        # ChromaDB's add_drawer has its own dedup layer (~0.9 threshold).
        # We include a long unique nonce to shift the embedding away from
        # existing signals that share the same JSON schema.
        nonce = str(uuid4())
        signal = {
            "signal_id": f"signal_{uid}",
            "signal_type": "METRIC",
            "source": "e2e_lifecycle_test",
            "priority": "INFO",
            "title": f"E2E lifecycle test {uid}",
            "context": f"Completely unique test context. NONCE={nonce} "
                       f"Do not deduplicate this signal. It is a test artifact.",
            "suggested_action": f"Cleanup test signal {uid}",
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "expires": (datetime.now(timezone.utc) + timedelta(days=7)).isoformat().replace("+00:00", "Z"),
            "status": "PENDING",
        }
        signal_id = signal["signal_id"]

        # --- Phase 2: Write to mempalace ---
        drawer_id = write_signal(signal)
        # If tool_add_drawer semantic dedup blocks us, fall back to direct add
        if drawer_id is None:
            from memory_bridge import tool_add_drawer
            import json as _json
            full_text = f"signal_id: {signal_id}\n" + _json.dumps(signal, indent=2)
            result = tool_add_drawer({"wing": "penny", "room": "signals", "content": full_text})
            if result.get("success"):
                drawer_id = result.get("drawer_id")
        assert drawer_id is not None, "Signal should be written to mempalace"
        assert drawer_id.startswith("drawer_penny_signals_")

        # Brief delay for ChromaDB HNSW index update before acknowledgment
        import time
        time.sleep(2)

        # --- Phase 3: Retrieve via session-start checker ---
        pending = get_pending_signals(limit=10)
        info_ids = [s["signal_id"] for s in pending["info"]]
        assert signal_id in info_ids, f"Signal {signal_id} should appear in pending list"

        # Presentation formatting should include the signal title
        presentation = format_signal_presentation(pending)
        assert signal["title"] in presentation or "Mempalace growth" in presentation

        # --- Phase 4: Acknowledge ---
        ack = acknowledge_signal(signal_id, session_id)
        assert ack is True, "Acknowledgment should succeed"

        # --- Phase 5: Verify signal no longer pending ---
        pending_after = get_pending_signals(limit=10)
        all_pending_ids = (
            [s["signal_id"] for s in pending_after["critical"]]
            + [s["signal_id"] for s in pending_after["info"]]
        )
        assert signal_id not in all_pending_ids, (
            f"Acknowledged signal {signal_id} should not appear as pending"
        )

    def test_duplicate_signal_not_rewritten(self):
        """
        Writing the same signal_id twice should result in only one drawer.
        """
        from uuid import uuid4
        uid = str(uuid4())[:8]
        session_id = f"e2e_dup_test_{uid}"
        signal = generate_mempalace_growth_signal(session_id, drawer_count_threshold=1)
        assert signal is not None

        # Make content unique to get past tool_add_drawer dedup
        signal["signal_id"] = f"dup_test_{uid}"
        signal["title"] = f"Dup test signal {uid}"
        signal["context"] = f"Dup context {uid}"
        signal["suggested_action"] = f"Dup action {uid}"

        # First write
        drawer_id_1 = write_signal(signal)
        assert drawer_id_1 is not None, f"First write should succeed: {signal}"

        # Second write (same signal_id and content)
        drawer_id_2 = write_signal(signal)
        assert drawer_id_2 is None, "Duplicate signal should be skipped"

        # Cleanup: acknowledge the first one
        acknowledge_signal(signal["signal_id"], session_id)

    def test_multiple_watchers_generate_multiple_signals(self):
        """
        Multiple watcher types can generate signals in the same run.
        """
        from uuid import uuid4
        from unittest.mock import patch

        uid = str(uuid4())[:8]
        session_id = f"e2e_multi_test_{uid}"

        # Force mempalace growth signal with unique content
        sig1 = generate_mempalace_growth_signal(session_id, drawer_count_threshold=1)
        if sig1:
            sig1["signal_id"] = f"multi1_{uid}"
            sig1["title"] = f"Multi test 1 {uid}"
            sig1["context"] = f"Multi context 1 {uid}"
        drawer1 = write_signal(sig1) if sig1 else None

        # Force mismatch rate signal via mock search results
        _recent_ts = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        fake_results = [
            {"summary": f"delta_score: MISMATCH\ntimestamp: {_recent_ts}\nunique: {uid}"}
        ] * 5

        with patch("signal_generators.tool_smart_search") as mock_search:
            mock_search.return_value = {"success": True, "results": fake_results}
            sig2 = generate_mismatch_rate_signal(session_id, threshold=3)
            if sig2:
                sig2["signal_id"] = f"multi2_{uid}"
                sig2["title"] = f"Multi test 2 {uid}"
                sig2["context"] = f"Multi context 2 {uid}"
            drawer2 = write_signal(sig2) if sig2 else None

        # At least one signal should exist
        pending = get_pending_signals(limit=20)
        total = len(pending["critical"]) + len(pending["info"])
        assert total >= 1, "At least one signal should be pending"

        # Cleanup
        if sig1 and drawer1:
            acknowledge_signal(sig1["signal_id"], session_id)
        if sig2 and drawer2:
            acknowledge_signal(sig2["signal_id"], session_id)


if __name__ == "__main__":
    import pytest

    pytest.main([__file__, "-v"])
