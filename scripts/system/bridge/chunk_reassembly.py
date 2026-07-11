"""Chunk reassembly for MemPalace drawers — the read-side inverse of chunking.

``memory_bridge.tool_add_drawer`` (via ``_chunk_text``) splits content over the
chunk threshold into NON-overlapping sibling chunks that share a ``drawer_key``
metadata field and are ordered by ``chunk_index`` — a clean ``content[i:i+size]``
split, so concatenating a drawer's chunks in ``chunk_index`` order EXACTLY
restores the original content.

Any reader that wants a drawer's WHOLE content (rather than a single fragment)
must regroup those chunks. This module is the single source of truth for that
regrouping, kept dependency-free so it can be unit-tested in isolation and
reused by any consumer.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional


def reassemble_rows(
    ids: Optional[List[str]],
    documents: Optional[List[str]],
    metadatas: Optional[List[dict]],
) -> List[Dict[str, Any]]:
    """Collapse raw chunk rows into whole logical drawers, order-preserving.

    Groups rows by ``drawer_key`` (in first-appearance order), orders each group
    by ``chunk_index``, and concatenates the documents so the caller sees one
    logical drawer carrying its FULL content. A row without a ``drawer_key`` is
    its own group (unchunked or pre-metadata drawers are therefore safe and
    unchanged).

    Each returned drawer carries:
      * ``id``       — the group's lowest-``chunk_index`` row id. This is the
                       canonical drawer id ``tool_add_drawer`` returns and
                       ``tool_delete_drawer`` resolves to every sibling, so
                       deletes stay whole-drawer correct.
      * ``content``  — the reassembled full content ("" when documents omitted).
      * ``metadata`` — the drawer-level metadata (from the lowest-``chunk_index``
                       row; drawer-level fields are identical across siblings).

    ``documents`` may be empty (e.g. a metadata-only listing); content is then
    "" and grouping still works from ids + metadatas alone.
    """
    ids = ids or []
    documents = documents or []
    metadatas = metadatas or []

    order: List[str] = []
    groups: Dict[str, List[tuple]] = {}
    for i, row_id in enumerate(ids):
        meta = (metadatas[i] if i < len(metadatas) else None) or {}
        doc = documents[i] if i < len(documents) else ""
        key = meta.get("drawer_key") or row_id  # unkeyed row => its own group
        try:
            idx = int(meta.get("chunk_index", 0))
        except (TypeError, ValueError):
            idx = 0
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append((idx, row_id, doc, meta))

    out: List[Dict[str, Any]] = []
    for key in order:
        rows = sorted(groups[key], key=lambda r: r[0])
        content = "".join((r[2] or "") for r in rows)
        out.append({"id": rows[0][1], "content": content, "metadata": rows[0][3] or {}})
    return out
