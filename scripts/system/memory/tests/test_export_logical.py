from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from memory.common import ValidationError
from memory.export_logical import export_logical_records
from memory.manifest_core import load_logical_records


class FakeClient:
    def __init__(self, drawers: list[dict[str, Any]], *, changing_total: bool = False) -> None:
        self.drawers = drawers
        self.changing_total = changing_total
        self.list_calls = 0

    def call_tool(self, tool: str, arguments: dict[str, object]) -> SimpleNamespace:
        if tool == "mempalace_list_drawers":
            self.list_calls += 1
            offset = int(arguments["offset"])
            limit = int(arguments["limit"])
            page = [
                {
                    "drawer_id": item["drawer_id"],
                    "wing": item["wing"],
                    "room": item["room"],
                    "metadata": item["metadata"],
                    "content_preview": item["content"][:10],
                }
                for item in self.drawers[offset : offset + limit]
            ]
            total = len(self.drawers) + (1 if self.changing_total and self.list_calls > 1 else 0)
            return SimpleNamespace(
                payload={
                    "drawers": page,
                    "total": total,
                    "count": len(page),
                    "offset": offset,
                    "limit": limit,
                }
            )
        if tool == "mempalace_get_drawer":
            drawer_id = arguments["drawer_id"]
            return SimpleNamespace(
                payload=next(item for item in self.drawers if item["drawer_id"] == drawer_id)
            )
        if tool == "mempalace_kg_stats":
            return SimpleNamespace(payload={"triples": 0})
        raise AssertionError(f"unexpected tool: {tool}")


def _palace(root: Path) -> Path:
    palace = root / "copied-palace"
    archive = palace / "archive" / "penny--diary"
    sidecar = palace / "00000000-0000-0000-0000-000000000001"
    archive.mkdir(parents=True)
    sidecar.mkdir()
    (archive / "2026-08.jsonl").write_text('{"entry":"one"}\n', encoding="utf-8")
    (sidecar / "header.bin").write_bytes(b"durable-index")
    # Runtime files created merely by opening the copied palace are excluded.
    (palace / "knowledge_graph.sqlite3").write_bytes(b"runtime")
    (palace / ".collection_type_fixed").write_bytes(b"")
    (palace / "replica.json").write_text("{}", encoding="utf-8")
    return palace


def _drawers() -> list[dict[str, Any]]:
    return [
        {
            "drawer_id": "drawer-1",
            "content": "exact diary content",
            "wing": "penny",
            "room": "diary",
            "metadata": {
                "type": "diary_entry",
                "chunk_index": 0,
                "source_file": "private/source.jsonl",
            },
        },
        {
            "drawer_id": "drawer-2",
            "content": "exact second chunk",
            "wing": "penny",
            "room": "diary",
            "metadata": {
                "type": "diary_entry",
                "chunk_index": 1,
                "source_file": "private/source.jsonl",
            },
        },
    ]


def test_exports_exact_drawers_groups_diary_archive_and_durable_sidecars(tmp_path: Path) -> None:
    output = tmp_path / "logical.json"
    counts = export_logical_records(FakeClient(_drawers()), _palace(tmp_path), output, workers=2)

    assert counts == {
        "archive": 1,
        "chunk_group": 1,
        "diary": 2,
        "drawer": 2,
        "sidecar": 1,
    }
    assert output.stat().st_mode & 0o077 == 0
    records = json.loads(output.read_text(encoding="utf-8"))["records"]
    assert (
        next(item for item in records if item["record_class"] == "drawer")["value"]["content"]
        == "exact diary content"
    )
    sidecars = [item for item in records if item["record_class"] == "sidecar"]
    assert sidecars[0]["value"]["path"].endswith("/header.bin")
    assert all("knowledge_graph.sqlite3" not in str(item) for item in sidecars)
    assert len(load_logical_records(output)) == 7


def test_refuses_overwrite_and_invalid_worker_bound(tmp_path: Path) -> None:
    palace = _palace(tmp_path)
    output = tmp_path / "logical.json"
    output.write_text("sentinel", encoding="utf-8")
    with pytest.raises(ValidationError, match="already exists"):
        export_logical_records(FakeClient(_drawers()), palace, output)
    output.unlink()
    with pytest.raises(ValidationError, match="workers"):
        export_logical_records(FakeClient(_drawers()), palace, output, workers=0)
