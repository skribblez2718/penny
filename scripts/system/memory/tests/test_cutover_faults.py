from __future__ import annotations

import errno
import json
import stat
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from memory.accepted_write_journal import (
    AmbiguousWriteError,
    AcceptedWriteJournal,
    HubOperationAdapter,
    JournalError,
    JournaledWriter,
    stable_operation_id,
)
from memory.admin_client import MemoryAdminClient
from memory.canary_cutover import (
    CanaryWriteCoordinator,
    CutoverState,
    TransitionRecord,
    _atomic_replace_state,
)
from memory.cutover_config import CutoverConfig, OperationSpec, load_cutover_config
from memory.replay_reconcile import reconcile_accepted_writes, replay_accepted_writes
from memory.tests.fake_hub import FakeHub

TOKEN = "synthetic-owner-token"
CUTOVER_TEMPLATE = Path(__file__).resolve().parents[3] / "setup/mempalace-cutover.config.json.in"


def _write_json(path: Path, value: object, mode: int = 0o600) -> Path:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")
    path.chmod(mode)
    return path


def _hub_config(root: Path, endpoint: str, palace_id: str) -> Path:
    roots: dict[str, str] = {}
    for name in ("palace", "archive", "runtime", "logs", "home", "config", "cache", "state"):
        directory = root / name
        directory.mkdir(mode=0o700, parents=True)
        directory.chmod(0o700)
        roots[name] = str(directory)
    palace = Path(roots["palace"])
    roots["kg"] = str(palace / "knowledge_graph.sqlite3")
    roots["logstream"] = str(palace / "logstream.sqlite3")
    token = root / "token"
    token.write_text(TOKEN, encoding="utf-8")
    token.chmod(0o600)
    return _write_json(
        root / "hub.json",
        {
            "schema_version": 1,
            "endpoint": endpoint,
            "palace_id": palace_id,
            "backend": "chroma",
            "python_executable": str(Path(sys.executable).absolute()),
            "token_file": str(token),
            "data_roots": roots,
            "health_timeout_seconds": 1,
            "stop_timeout_seconds": 1,
        },
    )


def build_cutover_config(root: Path, source: FakeHub, candidate: FakeHub) -> CutoverConfig:
    fixtures = _write_json(
        root / "shadow-fixtures.json",
        {
            "schema_version": 1,
            "document_type": "memory-shadow-fixtures",
            "read_tools": ["fixture_search"],
            "fixtures": [
                {
                    "fixture_id": "fixture-1",
                    "tool": "fixture_search",
                    "arguments": {"query": "synthetic"},
                    "extraction": {
                        "items_path": ["results"],
                        "id_field": "id",
                        "content_field": "content",
                    },
                    "tolerances": {
                        "max_rank_displacement": 1,
                        "candidate_latency_ms_max": 1000,
                        "candidate_over_source_ms_max": 1000,
                    },
                }
            ],
        },
    )
    source_config = _hub_config(root / "source", source.endpoint, "source-palace")
    candidate_config = _hub_config(root / "candidate", candidate.endpoint, "candidate-palace")
    config_path = _write_json(
        root / "cutover.json",
        {
            "schema_version": 1,
            "cutover_id": "synthetic-cutover",
            "source_config": str(source_config),
            "candidate_config": str(candidate_config),
            "state_path": str(root / "cutover-state.json"),
            "journal_path": str(root / "accepted-writes.jsonl"),
            "approval_ledger_path": str(root / "approval-ledger.jsonl"),
            "control_lock_path": str(root / "cutover-control.lock"),
            "shadow_fixtures_path": str(fixtures),
            "canary_client_ids": ["client-a"],
            "approved_client_ids": ["client-a", "client-b"],
            "no_fallback": True,
            "post_ack_read_required": True,
            "operation_specs": {
                "drawer": {
                    "write_tool": "fixture_write",
                    "operation_id_argument": "operation_id",
                    "resulting_ids_path": ["resulting_ids"],
                    "resulting_ids_mode": "list",
                    "read_tool": "fixture_read",
                    "read_ids_argument": "ids",
                    "read_ids_argument_mode": "list",
                    "read_items_path": ["records"],
                    "read_items_mode": "list",
                    "read_item_id_field": "id",
                    "read_projection_fields": ["id", "content"],
                }
            },
        },
    )
    return load_cutover_config(config_path)


def test_shipped_cutover_template_loads_with_actual_scalar_root_single_shape(
    tmp_path: Path,
) -> None:
    with FakeHub() as source, FakeHub() as candidate:
        source_config = _hub_config(tmp_path / "source", source.endpoint, "source-palace")
        candidate_config = _hub_config(
            tmp_path / "candidate", candidate.endpoint, "candidate-palace"
        )
        fixtures = _write_json(
            tmp_path / "shadow.json",
            {
                "schema_version": 1,
                "document_type": "memory-shadow-fixtures",
                "read_tools": ["fixture_search"],
                "fixtures": [],
            },
        )
        replacements = {
            "@CUTOVER_ID@": "template-cutover",
            "@SOURCE_HUB_CONFIG@": str(source_config),
            "@CANDIDATE_HUB_CONFIG@": str(candidate_config),
            "@STATE_PATH@": str(tmp_path / "state.json"),
            "@JOURNAL_PATH@": str(tmp_path / "journal.jsonl"),
            "@APPROVAL_LEDGER_PATH@": str(tmp_path / "approval.jsonl"),
            "@CONTROL_LOCK_PATH@": str(tmp_path / "control.lock"),
            "@SHADOW_FIXTURES_PATH@": str(fixtures),
            "@CANARY_CLIENT_ID@": "client-canary",
            "@PRIMARY_CLIENT_ID@": "client-primary",
        }
        rendered = CUTOVER_TEMPLATE.read_text(encoding="utf-8")
        for placeholder, value in replacements.items():
            rendered = rendered.replace(placeholder, value)
        assert "@" not in rendered
        config_path = tmp_path / "cutover.json"
        config_path.write_text(rendered, encoding="utf-8")
        config_path.chmod(0o600)

        config = load_cutover_config(config_path)

        spec = config.operation_specs["drawer"]
        assert spec.resulting_ids_mode == "scalar"
        assert spec.read_ids_argument_mode == "scalar"
        assert spec.read_items_path == ()
        assert spec.read_items_mode == "single"


def test_scalar_upstream_write_and_single_root_read_projection() -> None:
    calls: list[tuple[str, dict[str, object]]] = []

    class Client:
        def call_tool(self, tool: str, arguments: dict[str, object]) -> SimpleNamespace:
            calls.append((tool, arguments))
            if tool == "mempalace_add_drawer":
                return SimpleNamespace(payload={"drawer_id": "drawer-1"})
            if tool == "mempalace_get_drawer":
                return SimpleNamespace(
                    payload={
                        "drawer_id": "drawer-1",
                        "content": "exact",
                        "wing": "penny",
                        "room": "canary",
                    }
                )
            raise AssertionError(tool)

    spec = OperationSpec(
        plane="drawer",
        write_tool="mempalace_add_drawer",
        operation_id_argument="source_file",
        resulting_ids_path=("drawer_id",),
        resulting_ids_mode="scalar",
        read_tool="mempalace_get_drawer",
        read_ids_argument="drawer_id",
        read_ids_argument_mode="scalar",
        read_items_path=(),
        read_items_mode="single",
        read_item_id_field="drawer_id",
        read_projection_fields=("drawer_id", "content", "wing", "room"),
    )
    adapter = HubOperationAdapter(Client(), {"drawer": spec}, "candidate")  # type: ignore[arg-type]

    ids = adapter.write("drawer", {"wing": "penny", "room": "canary", "content": "exact"}, "op-1")
    verification = adapter.read_after_write("drawer", ids)

    assert ids == ("drawer-1",)
    assert verification.resulting_ids == ids
    assert calls == [
        (
            "mempalace_add_drawer",
            {"wing": "penny", "room": "canary", "content": "exact", "source_file": "op-1"},
        ),
        ("mempalace_get_drawer", {"drawer_id": "drawer-1"}),
    ]


def _adapter(
    hub: FakeHub, config: CutoverConfig, role: str, timeout: float = 0.5
) -> HubOperationAdapter:
    client = MemoryAdminClient(
        endpoint=hub.endpoint,
        bearer_token=TOKEN,
        timeout_seconds=timeout,
    )
    return HubOperationAdapter(client, config.operation_specs, role)


def test_journal_disk_pressure_refuses_remote_write_before_dispatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with FakeHub() as source, FakeHub() as candidate:
        config = build_cutover_config(tmp_path, source, candidate)
        journal = AcceptedWriteJournal(config.journal_path)
        adapter = _adapter(candidate, config, "candidate")
        writer = JournaledWriter(journal, adapter, fault_gate_passed=True)

        def disk_full(*_args: object, **_kwargs: object) -> int:
            raise OSError(errno.ENOSPC, "synthetic journal disk pressure")

        monkeypatch.setattr("memory.accepted_write_journal.os.write", disk_full)
        with pytest.raises(OSError, match="synthetic journal disk pressure"):
            writer.execute(
                operation_id="op-disk-pressure",
                plane="drawer",
                payload={"content": "must not reach candidate"},
            )

        assert candidate.state.records == {}
        assert config.journal_path.exists()
        assert config.journal_path.stat().st_size == 0


@pytest.mark.parametrize("fault", ["timeout-after-apply", "disconnect-after-apply"])
def test_ambiguous_object_before_journal_ack_requires_explicit_recovery(
    tmp_path: Path, fault: str
) -> None:
    with FakeHub() as source, FakeHub() as candidate:
        config = build_cutover_config(tmp_path, source, candidate)
        journal = AcceptedWriteJournal(config.journal_path)
        candidate.state.fault = fault
        writer = JournaledWriter(
            journal,
            _adapter(candidate, config, "candidate", timeout=0.02),
            fault_gate_passed=True,
        )
        operation_id = stable_operation_id(config.cutover_id, "client-a", "write-1")

        with pytest.raises(AmbiguousWriteError):
            writer.execute(
                operation_id=operation_id,
                plane="drawer",
                payload={"content": "accepted payload"},
            )

        _events, operations = journal.snapshot()
        assert operations[operation_id].stage == "prepared"
        assert len(candidate.state.records) == 1

        recovered = writer.execute(
            operation_id=operation_id,
            plane="drawer",
            payload={"content": "accepted payload"},
            recover_pending=True,
        )
        duplicate = writer.execute(
            operation_id=operation_id,
            plane="drawer",
            payload={"content": "accepted payload"},
        )

        assert recovered.read_after_write_sha256
        assert duplicate.duplicate is True
        assert len(candidate.state.records) == 1
        assert stat.S_IMODE(config.journal_path.stat().st_mode) == 0o600
        records = [json.loads(line) for line in config.journal_path.read_text().splitlines()]
        assert [record["event"] for record in records] == [
            "prepared",
            "remote-ack",
            "accepted",
        ]
        assert [record["event_sequence"] for record in records] == [1, 2, 3]
        assert records[-1]["remote_ack"] is True
        assert records[-1]["read_after_write"] is True
        assert records[-1]["resulting_ids"] == list(recovered.resulting_ids)

        with pytest.raises(JournalError, match="divergent"):
            writer.execute(
                operation_id=operation_id,
                plane="drawer",
                payload={"content": "different payload"},
            )


def test_canary_write_admits_only_bounded_clients_with_no_source_fallback(
    tmp_path: Path,
) -> None:
    with FakeHub() as source, FakeHub() as candidate:
        config = build_cutover_config(tmp_path, source, candidate)
        timestamp = "2026-08-15T12:00:00Z"
        transitions = (
            ("qualify", "draft", "qualified"),
            ("drain", "qualified", "drained"),
            ("final-delta", "drained", "delta_reconciled"),
            ("start-canary", "delta_reconciled", "canary"),
        )
        history = tuple(
            TransitionRecord(
                sequence=index,
                transition=transition,
                from_state=from_state,
                to_state=to_state,
                evidence_sha256="0" * 64,
                approval_consumption_sha256="1" * 64,
                applied_at=timestamp,
            )
            for index, (transition, from_state, to_state) in enumerate(transitions, start=1)
        )
        _atomic_replace_state(
            config.state_path,
            CutoverState(
                cutover_id=config.cutover_id,
                config_sha256=config.config_sha256,
                state="canary",
                authority_role="candidate",
                admitted_client_ids=config.canary_client_ids,
                blocked_client_ids=("client-b",),
                fallback_allowed=False,
                post_ack_read_required=True,
                fault_gate_passed=True,
                history=history,
                updated_at=timestamp,
            ),
        )
        coordinator = CanaryWriteCoordinator(config, _adapter(candidate, config, "candidate"))

        with pytest.raises(ValueError, match="not admitted"):
            coordinator.write(
                client_id="client-b",
                operation_key="blocked-write",
                plane="drawer",
                payload={"content": "must not write"},
            )
        accepted = coordinator.write(
            client_id="client-a",
            operation_key="canary-write",
            plane="drawer",
            payload={"content": "candidate only"},
        )

        assert accepted.resulting_ids
        assert source.state.write_calls == 0
        assert candidate.state.write_calls == 1


def test_exact_replay_is_idempotent_and_reconciles_without_duplicate_objects(
    tmp_path: Path,
) -> None:
    with FakeHub() as source, FakeHub() as candidate:
        config = build_cutover_config(tmp_path, source, candidate)
        source_journal = AcceptedWriteJournal(config.journal_path)
        operation_id = stable_operation_id(config.cutover_id, "client-a", "write-1")
        JournaledWriter(
            source_journal,
            _adapter(candidate, config, "candidate"),
            fault_gate_passed=True,
        ).execute(
            operation_id=operation_id,
            plane="drawer",
            payload={"content": "replay me exactly"},
        )
        replay_journal = AcceptedWriteJournal(tmp_path / "replay.jsonl")

        first = replay_accepted_writes(
            source_journal,
            replay_journal,
            _adapter(source, config, "source"),
            tmp_path / "replay-1.json",
            fault_gate_passed=True,
        )
        second = replay_accepted_writes(
            source_journal,
            replay_journal,
            _adapter(source, config, "source"),
            tmp_path / "replay-2.json",
            fault_gate_passed=True,
        )
        reconciliation = reconcile_accepted_writes(
            replay_journal,
            _adapter(source, config, "source"),
            tmp_path / "reconciliation.json",
        )

        assert first["exact"] is True
        assert second["exact"] is True
        assert second["duplicate_count"] == 1
        assert source.state.write_calls == 1
        assert len(source.state.records) == 1
        assert reconciliation["exact"] is True
        assert reconciliation["pending_count"] == 0


def test_replay_content_mismatch_is_a_no_go_receipt(tmp_path: Path) -> None:
    with FakeHub() as source, FakeHub() as candidate:
        config = build_cutover_config(tmp_path, source, candidate)
        source_journal = AcceptedWriteJournal(config.journal_path)
        operation_id = stable_operation_id(config.cutover_id, "client-a", "write-1")
        JournaledWriter(
            source_journal,
            _adapter(candidate, config, "candidate"),
            fault_gate_passed=True,
        ).execute(
            operation_id=operation_id,
            plane="drawer",
            payload={"content": "exact content"},
        )
        source.state.content_suffix = "-mismatch"

        receipt = replay_accepted_writes(
            source_journal,
            AcceptedWriteJournal(tmp_path / "mismatch-replay.jsonl"),
            _adapter(source, config, "source"),
            tmp_path / "mismatch-replay.json",
            fault_gate_passed=True,
        )

        assert receipt["exact"] is False
        assert receipt["replayed_count"] == 0
        assert receipt["failures"] == [
            {"operation_id": operation_id, "reason": "ReplayMismatchError"}
        ]
        assert receipt["package_downgrade"] is False
