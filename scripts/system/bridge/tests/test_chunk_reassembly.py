"""Unit tests for chunk_reassembly.reassemble_rows (pure — no palace, no I/O)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from chunk_reassembly import reassemble_rows  # noqa: E402

_CHUNK_SIZE = 2000  # mirrors memory_bridge._CHUNK_SIZE


def _chunk(text, size=_CHUNK_SIZE):
    """Clean, non-overlapping split identical to memory_bridge._chunk_text."""
    return [text[i : i + size] for i in range(0, len(text), size)]


def _rows(content, drawer_key, extra_meta=None):
    """Build (ids, documents, metadatas) exactly as the bridge stores a drawer."""
    chunks = _chunk(content)
    base = {"wing": "penny", "room": "r", "filed_at": "2026-07-09T00:00:00"}
    base.update(extra_meta or {})
    ids = [drawer_key] if len(chunks) == 1 else [f"{drawer_key}_{i}" for i in range(len(chunks))]
    metas = [{**base, "drawer_key": drawer_key, "chunk_index": i} for i in range(len(chunks))]
    return ids, chunks, metas


def test_reassembles_chunked_drawer_to_full_content():
    content = "X" * 5000  # forces 3 chunks
    ids, docs, metas = _rows(content, "dk")
    assert len(ids) >= 3
    out = reassemble_rows(ids, docs, metas)
    assert len(out) == 1
    assert out[0]["content"] == content  # exact restore
    assert out[0]["id"] == "dk_0"  # chunk-0 id -> delete resolves all siblings
    assert out[0]["metadata"]["room"] == "r"


def test_reassembles_out_of_order_rows():
    content = "AB" * 1500  # 2 chunks
    ids, docs, metas = _rows(content, "dk")
    out = reassemble_rows(list(reversed(ids)), list(reversed(docs)), list(reversed(metas)))
    assert len(out) == 1 and out[0]["content"] == content
    assert out[0]["id"] == "dk_0"  # lowest chunk_index wins, not wire order


def test_unchunked_drawer_passthrough():
    ids, docs, metas = _rows("small", "dk")
    assert len(ids) == 1
    out = reassemble_rows(ids, docs, metas)
    assert out == [{"id": "dk", "content": "small", "metadata": metas[0]}]


def test_multiple_drawers_preserve_first_appearance_order():
    i1, d1, m1 = _rows("one", "k1")
    i2, d2, m2 = _rows("Y" * 5000, "k2")  # chunked in the middle
    i3, d3, m3 = _rows("three", "k3")
    out = reassemble_rows(i1 + i2 + i3, d1 + d2 + d3, m1 + m2 + m3)
    assert [o["id"] for o in out] == ["k1", "k2_0", "k3"]
    assert [o["content"] for o in out] == ["one", "Y" * 5000, "three"]


def test_rows_without_drawer_key_are_solo_groups():
    # legacy / pre-metadata rows: no drawer_key -> each id is its own drawer
    out = reassemble_rows(["a", "b"], ["c1", "c2"], [{}, None])
    assert [o["id"] for o in out] == ["a", "b"]
    assert [o["content"] for o in out] == ["c1", "c2"]


def test_metadata_only_listing_has_empty_content():
    # include_content=False path: documents omitted -> grouping still works
    ids, _docs, metas = _rows("Z" * 5000, "dk")
    out = reassemble_rows(ids, [], metas)
    assert len(out) == 1 and out[0]["content"] == ""
    assert out[0]["id"] == "dk_0"


def test_empty_and_none_inputs():
    assert reassemble_rows([], [], []) == []
    assert reassemble_rows(None, None, None) == []
