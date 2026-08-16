"""Creation-time HNSW settings shared by hub-era offline recovery tools."""

from __future__ import annotations

HNSW_TUNING: dict[str, int] = {
    "hnsw:sync_threshold": 64,
    "hnsw:batch_size": 32,
}
