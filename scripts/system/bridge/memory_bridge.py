#!/usr/bin/env python3
"""Legacy MemPalace bridge for tests and copied/offline compatibility only.

Production extensions and administration must use the supervised HTTP hub.
Importing or executing this module requires an explicit compatibility flag,
an absolute copied/offline target, and a validated drain/no-hub/no-peer receipt.
There is no configured-path or live-palace default.

All 23 historical tools remain available for gated recovery compatibility:
- Palace (read): status, list_wings, list_rooms, get_taxonomy, search, smart_search, check_duplicate, get_aaak_spec, list_drawers
- Palace (write): add_drawer, delete_drawer, delete_drawers_by_room
- Knowledge Graph: kg_query, kg_add, kg_invalidate, kg_timeline, kg_stats
- Navigation: traverse, find_tunnels, graph_stats
- Agent Diary: diary_write, diary_read

Required environment:
    PENNY_MEMORY_BRIDGE_OFFLINE_COMPAT=1
    PENNY_MEMORY_OFFLINE_TARGET=/absolute/path/to/copied-palace
    PENNY_MEMORY_OFFLINE_RECEIPT=/absolute/path/to/offline-receipt.json
"""

import sys
import os
import json
import hashlib
import errno
import fcntl
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from scripts.system.memory.hnsw import HNSW_TUNING
from scripts.system.memory.offline_access import authorize_offline_target

if os.environ.get("PENNY_MEMORY_BRIDGE_OFFLINE_COMPAT") != "1":
    raise RuntimeError(
        "memory_bridge is offline/test compatibility only; "
        "set PENNY_MEMORY_BRIDGE_OFFLINE_COMPAT=1 with an explicit copy and receipt"
    )
_offline_target_raw = os.environ.get("PENNY_MEMORY_OFFLINE_TARGET", "")
_offline_receipt_raw = os.environ.get("PENNY_MEMORY_OFFLINE_RECEIPT", "")
if not _offline_target_raw or not _offline_receipt_raw:
    raise RuntimeError("memory_bridge requires explicit offline target and receipt paths")
_OFFLINE_AUTHORIZATION = authorize_offline_target(
    Path(_offline_target_raw), Path(_offline_receipt_raw)
)
os.environ["MEMPALACE_PALACE_PATH"] = str(_OFFLINE_AUTHORIZATION.target)
os.environ.pop("MEMPAL_PALACE_PATH", None)
os.environ.pop("MEMPALACE_PATH", None)

# Raw peers are imported only after the copied/offline runtime guard succeeds.
try:
    from mempalace.config import MempalaceConfig
    from mempalace.palace_graph import traverse, find_tunnels, graph_stats
    from mempalace.knowledge_graph import KnowledgeGraph
    import chromadb

    # Smart retriever import — prefer project copy over site-packages
    # (site-packages copy can be overwritten by pip upgrade)
    # Use sys.prefix (reliable for .venv/bin/python) instead of VIRTUAL_ENV
    # because spawned subprocesses don't inherit VIRTUAL_ENV from the parent.
    _project_root = Path(sys.prefix).parent
    _project_smart_retriever = (
        _project_root / ".pi" / "extensions" / "memory" / "smart_retriever.py"
    )
    if _project_smart_retriever.exists():
        sys.path.insert(0, str(_project_smart_retriever.parent))
    try:
        from smart_retriever import SmartRetriever

        SMART_RETRIEVER_AVAILABLE = True
    except ImportError:
        SMART_RETRIEVER_AVAILABLE = False
except ImportError as e:
    print(
        json.dumps({"error": f"MemPalace import failed: {e}", "hint": "Run: pip install mempalace"})
    )
    sys.exit(1)


def _apply_palace_path_env_compat() -> None:
    """Reassert the one receipt-authorized target; aliases cannot redirect it."""

    authorized = str(_OFFLINE_AUTHORIZATION.target)
    for name in ("MEMPALACE_PALACE_PATH", "MEMPAL_PALACE_PATH", "MEMPALACE_PATH"):
        supplied = os.environ.get(name)
        if supplied and Path(supplied).resolve(strict=False) != _OFFLINE_AUTHORIZATION.target:
            raise RuntimeError(f"{name} cannot redirect the authorized offline target")
    os.environ["MEMPALACE_PALACE_PATH"] = authorized


_apply_palace_path_env_compat()
_config = MempalaceConfig()
# Do not leak the compatibility target into child processes, where the generic
# offline guard would correctly interpret a configured path as live. The
# process-local config above remains permanently bound to the authorized copy.
os.environ.pop("MEMPALACE_PALACE_PATH", None)

# HNSW tuning applied at COLLECTION CREATION time. Load-bearing — do not drop.
#
# Why this exists
# ---------------
# The bridge is spawned as a fresh short-lived process for EVERY memory call.
# ChromaDB only persists its write-ahead log (the `embeddings_queue` table) into
# the HNSW vector index once `sync_threshold` operations accumulate. Its own
# SqlEmbeddingsQueue docstring explicitly says it is suitable only when producer
# and consumer live in the SAME process, because notification is in-process.
# Penny instead spawns a fresh short-lived process for every memory call.
#
# At the stock threshold of 1000, metadata-only recall UPDATEs and ADDs accumulate
# into a large replay backlog while HNSW persistence lags. Historical production
# corpora prove the immediate trigger is UPDATE+ADD replay, NOT deletes:
#     Aug 1 wedge: 83 UPDATE + 38 ADD, zero DELETE, byte-exact HNSW files
#     Aug 2 wedge: 167 UPDATE + 52 ADD, zero DELETE, byte-exact HNSW files
# Replaying the full byte-identical Aug 2 corpus crashed 2/2; truncating it at
# earlier operation boundaries survived. The NULL-pointer dereference is inside
# chromadb_rust_bindings (upstream bug, unfixed as of 1.5.9 — latest release).
# It kills BOTH reads and writes, wedging the palace because the replay that
# would advance the vector segment is itself what crashes.
#
# Measured on this palace (identical bytes, repeated trials):
#     WAL backlog    0 records -> 0/8 crashes
#     WAL backlog  142 records -> 0/5 crashes
#     WAL backlog  162 records -> 4/4 crashes
#     WAL backlog  218 records -> 5/5 crashes
#
# Keeping the backlog bounded well under that cliff is what prevents the crash.
#
# MUST be set at creation: ChromaDB accepts `collection.modify(metadata=...)`
# for these keys and even persists them to `collection_metadata`, but the Rust
# core does NOT honor them afterwards — verified: a healthy collection modified
# after the fact still never compacted. Applying this to an existing collection
# therefore requires a rebuild (see scripts/system/bridge/repair_palace.py).
# The knowledge graph is initialized LAZILY, on first KG-tool use — never at import.
#
# Why: KnowledgeGraph() opens a SQLite DB at mempalace's DEFAULT_KG_PATH
# (~/.mempalace/knowledge_graph.sqlite3) and runs CREATE TABLE IF NOT EXISTS, which
# SQLite needs WRITE access even to open. That path is HOME-based and is NOT the
# project palace_path, so it can be unavailable independently of the drawer store
# (e.g. a sandboxed agent under `--ro-bind / /` with a read-only HOME).
#
# Constructing it at import made every one of the 23 bridge tools die before dispatch:
# a KG-only fault took down plain drawer reads/writes, diary_write, and search too.
# Observed impact: 337 bridge deaths across 38 sessions (2026-08-02/03), dropping 136
# write calls (71 kg_add, 37 diary_write, 28 add_drawer) that had nothing to do with
# the KG. Lazy init confines a KG fault to the five KG tools, which already return
# {"error": ...} from their own try/except.
#
# _kg stays None on failure so a transient fault retries on the next call rather than
# poisoning the process.
_kg = None


def _get_kg() -> KnowledgeGraph:
    """Return the process-wide KnowledgeGraph, constructing it on first use.

    Raises:
        Exception: whatever KnowledgeGraph() raises (typically
            sqlite3.OperationalError when the KG path is unwritable). Callers are
            the five KG tools, each of which already wraps this in try/except and
            converts it to an {"error": ...} response for that tool alone.
    """
    global _kg
    if _kg is None:
        _kg = KnowledgeGraph()
    return _kg


# Chunk reassembly (read-side inverse of _chunk_text) — regroup sibling chunks
# into whole logical drawers so readers never see fragments. Sibling-module
# import: works when run as a script (its dir is sys.path[0]) and when imported
# by a consumer that put the bridge dir on sys.path; the fallback guarantees it
# either way.
try:
    from chunk_reassembly import reassemble_rows
except ImportError:  # pragma: no cover - import-context robustness
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from chunk_reassembly import reassemble_rows


# ==================== CROSS-PROCESS PALACE LOCK ====================
#
# Why this exists
# ---------------
# ChromaDB's PersistentClient is SINGLE-PROCESS. Its metadata segment is SQLite
# and is safely serialized by SQLite's own locking, but its vector segment is
# four raw files (data_level0.bin, length.bin, link_lists.bin, header.bin) with
# NO cross-process locking whatsoever. Two processes flushing the HNSW segment
# at the same time interleave their writes and tear the index.
#
# Penny's architecture guarantees that concurrency: the bridge is spawned as a
# fresh process for EVERY memory call, `subagent` runs up to 25 agents at once,
# `skill` runs up to 3 skills at once, and the tiered-memory archiver fires from
# cron with no coordination with live sessions.
#
# Measured on this palace (identical workload, 8 workers x 90 adds, only the
# concurrency changed):
#     8 workers CONCURRENT  -> 2/8 SIGSEGV, data_level0.bin size wrong,
#                             link_lists.bin +772 trailing bytes,
#                             121 of 720 rows landed (~83% silently LOST),
#                             palace then segfaulted on every subsequent read
#     8 workers SEQUENTIAL  -> 0/8 crashes, all files byte-exact,
#                             675 of 675 rows landed, palace healthy
#
# The torn-write fingerprint (trailing bytes in link_lists.bin) is what wedged
# the production palace on 2026-08-11. The damage is subtle enough to pass every
# consistency check — labels, tombstones, neighbour ranges, levels and vector
# norms all validate — but it leaves a corrupt region in the graph, and any
# later insert or query whose traversal reaches it dereferences garbage and
# dies with SIGSEGV. Because that crash happens during WAL replay, the vector
# segment can never advance, so the palace stays wedged permanently.
#
# There is no upstream fix to upgrade into: chromadb 1.5.9 is still the latest
# release on PyPI. Serializing writers is the only durable remedy.
#
# The lock is taken here, in the Python bridge, rather than in the TypeScript
# extension, so that EVERY consumer is covered by construction: the extension's
# per-call spawns, the archiver importing tool_* directly, and the maintenance
# and repair scripts.
_LOCK_FILENAME = ".palace.lock"
_LOCK_TIMEOUT_S = float(os.environ.get("MEMPALACE_LOCK_TIMEOUT", "120"))
_lock_fd = None
_lock_depth = 0


def _open_lock_file(path: str):
    """Open (creating if needed) the palace lock file. None if unavailable."""
    fd = None
    try:
        os.makedirs(path, exist_ok=True)
        return os.open(os.path.join(path, _LOCK_FILENAME), os.O_RDWR | os.O_CREAT, 0o644)
    except Exception:
        if fd is not None:
            try:
                os.close(fd)
            except Exception:
                pass
        return None


def _flock_until(fd: int, timeout: float) -> bool:
    """Poll for an exclusive flock until acquired or the timeout expires."""
    deadline = time.monotonic() + timeout
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError as exc:
            if exc.errno not in (errno.EACCES, errno.EAGAIN):
                return False
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.05)


@contextmanager
def palace_lock(palace_path: str = None, timeout: float = None):
    """Hold an exclusive cross-process lock on the palace for the whole block.

    Serializes every process that touches the ChromaDB store, which is what
    keeps concurrent writers from tearing the HNSW segment (see the block
    comment above for the measurements that motivate this).

    Reentrant within a process: nested acquisitions bump a depth counter rather
    than calling flock() on a second file descriptor, which would deadlock
    against ourselves (flock locks are per open-file-description).

    Fails CLOSED if the lock file cannot be opened or the timeout expires.
    Running a memory operation unlocked would recreate the torn-index condition
    this lock exists to prevent; availability must never outrank store integrity.

    Args:
        palace_path: Palace directory. Defaults to the configured palace.
        timeout: Seconds to wait for the lock. Defaults to MEMPALACE_LOCK_TIMEOUT
            (120s).

    Yields:
        bool: Always True; yielded only while the lock is held.

    Raises:
        RuntimeError: lock file could not be opened.
        TimeoutError: another process held the lock past the deadline.
    """
    global _lock_fd, _lock_depth

    if _lock_depth > 0:  # already held by this process — reentrant
        _lock_depth += 1
        try:
            yield True
        finally:
            _lock_depth -= 1
        return

    path = palace_path or _config.palace_path
    timeout = _LOCK_TIMEOUT_S if timeout is None else timeout

    fd = _open_lock_file(path)
    if fd is None:
        raise RuntimeError(f"Cannot open palace lock file under {path}")

    acquired = _flock_until(fd, timeout)
    if not acquired:
        os.close(fd)
        raise TimeoutError(f"Timed out after {timeout}s waiting for palace lock at {path}")

    _lock_fd, _lock_depth = fd, 1
    try:
        yield True
    finally:
        _lock_depth -= 1
        if _lock_depth == 0:
            _lock_fd = None
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except Exception:
                pass
        try:
            os.close(fd)
        except Exception:
            pass


def _fix_blob_seq_ids(palace_path: str):
    """Fix ChromaDB BLOB seq_ids → INTEGER before creating PersistentClient.

    ChromaDB's Rust compactor expects INTEGER seq_id columns, but older
    versions stored them as 8-byte big-endian BLOBs. Without this fix,
    PersistentClient() crashes with:
      "mismatched types; Rust type u64 (as SQL type INTEGER) is not
       compatible with SQL type BLOB"
    """
    import sqlite3

    db_path = os.path.join(palace_path, "chroma.sqlite3")
    if not os.path.isfile(db_path):
        return
    try:
        with sqlite3.connect(db_path) as conn:
            for table in ("embeddings", "max_seq_id"):
                try:
                    rows = conn.execute(
                        f"SELECT rowid, seq_id FROM {table} WHERE typeof(seq_id) = 'blob'"
                    ).fetchall()
                except sqlite3.OperationalError:
                    continue
                if not rows:
                    continue
                updates = [(int.from_bytes(blob, byteorder="big"), rowid) for rowid, blob in rows]
                conn.executemany(f"UPDATE {table} SET seq_id = ? WHERE rowid = ?", updates)
                conn.commit()
    except Exception:
        pass


def _get_collection(create: bool = False):
    """Get ChromaDB collection.

    On the create path the collection is given HNSW_TUNING so its write-ahead
    log stays bounded. See the HNSW_TUNING comment for why that is load-bearing.
    """
    try:
        _fix_blob_seq_ids(_config.palace_path)
        client = chromadb.PersistentClient(path=_config.palace_path)
        # Always use 'mempalace_drawers' to match searcher.py
        collection_name = "mempalace_drawers"
        if create:
            return client.get_or_create_collection(collection_name, metadata=dict(HNSW_TUNING))
        return client.get_collection(collection_name)
    except Exception:
        return None


def _no_palace() -> dict:
    """Return error when palace doesn't exist."""
    return {
        "error": "No palace found",
        "palace_path": _config.palace_path,
        "hint": "Run: mempalace init <dir> && mempalace mine <dir>",
    }


def _canonical_wing(wing: str) -> str:
    """Collapse known duplicate wing spellings to their canonical form.

    Penny's own memories live under the 'penny' wing, but a legacy 'wing_penny'
    spelling accreted 178 drawers (incl. 63 diary entries) that the default
    readers could not see. Canonicalizing at write time (and reading both
    spellings until the one-time migration merges them) closes the split.
    """
    if not wing:
        return wing
    if wing.lower() in ("wing_penny", "penny"):
        return "penny"
    return wing


def _diary_wings(agent_name: str) -> list:
    """Return every wing spelling a given agent's diary may live under."""
    raw = f"wing_{agent_name.lower().replace(' ', '_')}"
    return sorted({_canonical_wing(raw), raw})


# ==================== PALACE READ TOOLS ====================


def tool_status(params: dict) -> dict:
    """Get palace overview with drawer counts."""
    col = _get_collection()
    if not col:
        return _no_palace()

    count = col.count()
    wings = {}
    rooms = {}

    try:
        all_meta = col.get(include=["metadatas"])["metadatas"]
        for m in all_meta:
            w = m.get("wing", "unknown")
            r = m.get("room", "unknown")
            wings[w] = wings.get(w, 0) + 1
            rooms[r] = rooms.get(r, 0) + 1
    except Exception as e:
        wings["_error"] = f"Metadata scan failed: {e}"

    return {
        "success": True,
        "total_drawers": count,
        "wings": wings,
        "rooms": rooms,
        "palace_path": str(_config.palace_path),
    }


def tool_list_wings(params: dict) -> dict:
    """List all wings with drawer counts."""
    col = _get_collection()
    if not col:
        return _no_palace()

    wings = {}
    try:
        all_meta = col.get(include=["metadatas"])["metadatas"]
        for m in all_meta:
            w = m.get("wing", "unknown")
            wings[w] = wings.get(w, 0) + 1
    except Exception as e:
        wings["_error"] = f"Metadata scan failed: {e}"

    return {"success": True, "wings": wings}


def tool_list_rooms(params: dict) -> dict:
    """List rooms within a wing (or all rooms)."""
    col = _get_collection()
    if not col:
        return _no_palace()

    wing = _canonical_wing(params.get("wing")) if params.get("wing") else None
    rooms = {}

    try:
        kwargs = {"include": ["metadatas"]}
        if wing:
            kwargs["where"] = {"wing": wing}
        all_meta = col.get(**kwargs)["metadatas"]
        for m in all_meta:
            r = m.get("room", "unknown")
            rooms[r] = rooms.get(r, 0) + 1
    except Exception:
        pass

    return {"success": True, "wing": wing or "all", "rooms": rooms}


def tool_get_taxonomy(params: dict) -> dict:
    """Get full taxonomy: wing -> room -> count."""
    col = _get_collection()
    if not col:
        return _no_palace()

    taxonomy = {}
    try:
        all_meta = col.get(include=["metadatas"])["metadatas"]
        for m in all_meta:
            w = m.get("wing", "unknown")
            r = m.get("room", "unknown")
            if w not in taxonomy:
                taxonomy[w] = {}
            taxonomy[w][r] = taxonomy[w].get(r, 0) + 1
    except Exception:
        pass

    return {"success": True, "taxonomy": taxonomy}


def _bump_recall(ids: list) -> None:
    """Record a recall: increment recall_count and stamp last_recalled_at.

    This is the store's ONLY usage signal — it feeds the archiver's
    recall-modulated TTL (a reused drawer lives longer) and search ranking.
    Only genuine model-initiated recall should call this (``track_recall``);
    the system's own churning background queries must NOT, or a drawer would
    have its TTL renewed every session and never expire. Best-effort — never
    raises.
    """
    ids = [i for i in (ids or []) if i]
    if not ids:
        return
    try:
        col = _get_collection()
        if not col:
            return
        existing = col.get(ids=ids, include=["metadatas"])
        now_iso = datetime.now().isoformat()
        upd_ids, upd_metas = [], []
        for i, did in enumerate(existing.get("ids", [])):
            meta = dict(existing["metadatas"][i] or {})
            meta["recall_count"] = int(meta.get("recall_count", 0) or 0) + 1
            meta["last_recalled_at"] = now_iso
            upd_ids.append(did)
            upd_metas.append(meta)
        if upd_ids:
            col.update(ids=upd_ids, metadatas=upd_metas)
    except Exception:
        pass


def _wing_room_where(wing, room) -> dict:
    """Build the chroma where-clause for optional wing/room filters.

    Canonicalizes the wing so reads match what writes stored — post-migration
    the store only contains 'penny', but callers (and the extension's own
    parameter docs) may still pass 'wing_penny'; without this, that filter
    silently matches nothing.
    """
    wing = _canonical_wing(wing) if wing else wing
    if wing and room:
        return {"$and": [{"wing": wing}, {"room": room}]}
    if wing:
        return {"wing": wing}
    if room:
        return {"room": room}
    return {}


def _query_hits(raw: dict) -> list:
    """Flatten a chroma query result into id-carrying hit dicts."""
    ids = (raw.get("ids") or [[]])[0]
    docs = (raw.get("documents") or [[]])[0]
    metas = (raw.get("metadatas") or [[]])[0]
    dists = (raw.get("distances") or [[]])[0]
    hits = []
    for i, doc_id in enumerate(ids):
        meta = metas[i] if i < len(metas) and metas[i] else {}
        dist = dists[i] if i < len(dists) else None
        hits.append(
            {
                "id": doc_id,
                "text": docs[i] if i < len(docs) else "",
                "wing": meta.get("wing", ""),
                "room": meta.get("room", ""),
                "source_file": meta.get("source_file", ""),
                # Same L2->similarity mapping the smart retriever uses.
                "similarity": (round(1.0 / (1.0 + dist), 4) if dist is not None else None),
            }
        )
    return hits


def tool_search(params: dict) -> dict:
    """Semantic search with optional wing/room filter.

    Queries the collection directly (not mempalace.search_memories) because the
    library's hits carry no drawer ids — which silently made ``track_recall`` a
    no-op forever: the old guard checked ``isinstance(results, list)`` against a
    dict, and even unwrapped hits had no ``id`` for ``_bump_recall`` to use.
    Recall tracking is the store's only usage signal; it must actually fire on
    model-initiated search. Result shape stays wheel-compatible
    ({query, filters, results}) with ``id`` added to each hit.
    """
    query = params.get("query", "")
    limit = int(params.get("limit", 5))
    wing = params.get("wing")
    room = params.get("room")
    track_recall = bool(params.get("track_recall", False))

    if not query:
        return {"error": "Query is required"}

    col = _get_collection()
    if not col:
        return _no_palace()

    try:
        kwargs: dict = {
            "query_texts": [query],
            "n_results": limit,
            "include": ["documents", "metadatas", "distances"],
        }
        where = _wing_room_where(wing, room)
        if where:
            kwargs["where"] = where
        hits = _query_hits(col.query(**kwargs))
        if track_recall:
            _bump_recall([h["id"] for h in hits])
        return {
            "success": True,
            "results": {
                "query": query,
                "filters": {"wing": wing, "room": room},
                "results": hits,
            },
        }
    except Exception as e:
        return {"error": str(e)}


def tool_smart_search(params: dict) -> dict:
    """
    Context-aware memory search that minimizes context usage.

    Features:
    - Semantic vector search over ALL rooms (the embedding is the router; no
      keyword room-routing or regex entity extraction — Bitter-Lesson #12)
    - Optional explicit wing/room metadata filters, honored as-is
    - Returns summaries (truncated) not full content
    - Filters by minimum similarity threshold (default 0.25, uses 1/(1+L2dist) mapping)
    - Lower default limit (3 vs 5)

    Use this instead of search() for context-efficient retrieval.
    """
    if not SMART_RETRIEVER_AVAILABLE:
        return {
            "error": "Smart retriever not available",
            "hint": "Check smart_retriever.py is in Python path",
        }

    query = params.get("query", "")
    context = params.get("context")
    wing = _canonical_wing(params.get("wing")) if params.get("wing") else None
    room = params.get("room")
    limit = int(params.get("limit", 3))  # Lower default
    include_full = params.get("include_full", False)
    min_similarity = params.get("min_similarity", 0.25)  # L2-similarity scale [0,1]
    track_recall = bool(params.get("track_recall", False))

    if not query:
        return {"error": "Query is required"}

    try:
        retriever = SmartRetriever(
            {
                "palace_path": str(_config.palace_path),
                "kg_path": str(Path.home() / ".mempalace" / "knowledge_graph.sqlite3"),
                "default_limit": limit,
                "min_similarity": min_similarity,
            }
        )

        results = retriever.smart_search(
            query=query,
            context=context,
            wing=wing,
            room=room,
            limit=limit,
            include_full=include_full,
        )

        # Convert to expected format
        formatted_results = []
        for hit in results.get("results", []):
            formatted_results.append(
                {
                    "text": hit.get("full_content") if include_full else hit["summary"],
                    "summary": hit["summary"],
                    "wing": hit["wing"],
                    "room": hit["room"],
                    "source_file": hit["source_file"],
                    "similarity": hit["similarity"],
                    "id": hit.get("id"),
                }
            )

        if track_recall:
            _bump_recall([r.get("id") for r in formatted_results])

        return {
            "success": True,
            "query": query,
            "results": formatted_results,
            "context_analysis": results.get("context_analysis", {}),
            "filter_stats": {
                "total_before_threshold": results.get("total_before_threshold", 0),
                "total_after_threshold": results.get("total_after_threshold", 0),
                "min_similarity": min_similarity,
            },
        }
    except Exception as e:
        import traceback

        return {"error": str(e), "traceback": traceback.format_exc()}


def tool_check_duplicate(params: dict) -> dict:
    """Check for duplicate content before filing."""
    col = _get_collection()
    if not col:
        return _no_palace()

    content = params.get("content", "")
    threshold = params.get("threshold", 0.9)

    if not content:
        return {"error": "Content is required"}

    try:
        results = col.query(
            query_texts=[content],
            n_results=5,
            include=["metadatas", "documents", "distances"],
        )
        duplicates = []

        if results["ids"] and results["ids"][0]:
            for i, drawer_id in enumerate(results["ids"][0]):
                dist = results["distances"][0][i]
                similarity = round(1.0 / (1.0 + dist), 3)
                if similarity >= threshold:
                    meta = results["metadatas"][0][i]
                    doc = results["documents"][0][i]
                    duplicates.append(
                        {
                            "id": drawer_id,
                            "wing": meta.get("wing", "?"),
                            "room": meta.get("room", "?"),
                            "similarity": similarity,
                            "content": doc[:200] + "..." if len(doc) > 200 else doc,
                        }
                    )

        return {
            "success": True,
            "is_duplicate": len(duplicates) > 0,
            "matches": duplicates,
        }
    except Exception as e:
        return {"error": str(e)}


def tool_get_aaak_spec(params: dict) -> dict:
    """Return the AAAK dialect specification."""
    aaak_spec = """AAAK is a compressed memory dialect that MemPalace uses for efficient storage.
It is designed to be readable by both humans and LLMs without decoding.

FORMAT:
  ENTITIES: 3-letter uppercase codes. ALC=Alice, JOR=Jordan, RIL=Riley, MAX=Max, BEN=Ben.
  EMOTIONS: *action markers* before/during text. *warm*=joy, *fierce*=determined, *raw*=vulnerable, *bloom*=tenderness.
  STRUCTURE: Pipe-separated fields. FAM: family | PROJ: projects | ⚠: warnings/reminders.
  DATES: ISO format (2026-03-31). COUNTS: Nx = N mentions (e.g., 570x).
  IMPORTANCE: ★ to ★★★★★ (1-5 scale).
  HALLS: hall_facts, hall_events, hall_discoveries, hall_preferences, hall_advice.
  WINGS: wing_user, wing_agent, wing_team, wing_code, wing_myproject, wing_hardware, wing_ue5, wing_ai_research.
  ROOMS: Hyphenated slugs representing named ideas (e.g., chromedb-setup, gpu-pricing).

EXAMPLE:
  FAM: ALC→♡JOR | 2D(kids): RIL(18,sports) MAX(11,chess+swimming) | BEN(contributor)

Read AAAK naturally — expand codes mentally, treat *markers* as emotional context.
When WRITING AAAK: use entity codes, mark emotions, keep structure tight."""

    palace_protocol = """IMPORTANT — MemPalace Memory Protocol:
1. ON WAKE-UP: Call mempalace_status to load palace overview + AAAK spec.
2. BEFORE RESPONDING about any person, project, or past event: call mempalace_kg_query or mempalace_search FIRST. Never guess — verify.
3. IF UNSURE about a fact (name, gender, age, relationship): say "let me check" and query the palace. Wrong is worse than slow.
4. AFTER EACH SESSION: call mempalace_diary_write to record what happened, what you learned, what matters.
5. WHEN FACTS CHANGE: call mempalace_kg_invalidate on the old fact, mempalace_kg_add for the new one.

This protocol ensures the AI KNOWS before it speaks. Storage is not memory — but storage + this protocol = memory."""

    return {
        "success": True,
        "aaak_spec": aaak_spec,
        "palace_protocol": palace_protocol,
    }


# ==================== PALACE WRITE TOOLS ====================


def tool_list_drawers(params: dict) -> dict:
    """List drawer IDs and metadata, filtered by wing and/or room.

    Returns the lifecycle metadata (filed_at, type, recall_count,
    last_recalled_at) the tiered-memory archiver needs to make age/usage
    decisions. Supports ``offset`` so callers can paginate the whole store
    instead of silently truncating at the first page.
    """
    col = _get_collection()
    if not col:
        return _no_palace()

    wing = params.get("wing")
    room = params.get("room")
    limit = min(int(params.get("limit", 1000)), 10000)
    offset = max(int(params.get("offset", 0)), 0)
    include_content = bool(params.get("include_content", False))

    where = _wing_room_where(wing, room)

    try:
        # Fetch ALL matching rows, then reassemble sibling chunks into whole
        # logical drawers BEFORE applying offset/limit. This is deliberate:
        # chunk siblings are not guaranteed contiguous in a get(), so a
        # row-level limit/offset (the old behavior) could split a chunked drawer
        # across a page boundary and hand callers a partial fragment. Collapsing
        # over the full filtered set makes offset/limit operate on LOGICAL
        # drawers and guarantees each drawer's content is complete. The store is
        # bounded (callers already page at 10000), so fetching the filtered set
        # is no heavier than the previous single 10000-row page.
        include = ["metadatas", "documents"] if include_content else ["metadatas"]
        kwargs: dict = {"include": include}
        if where:
            kwargs["where"] = where
        results = col.get(**kwargs)

        logical = reassemble_rows(
            results.get("ids") or [],
            results.get("documents") or [],
            results.get("metadatas") or [],
        )
        drawers = []
        for d in logical[offset : offset + limit]:
            meta = d.get("metadata") or {}
            drawer = {
                "id": d["id"],
                "wing": meta.get("wing", ""),
                "room": meta.get("room", ""),
                "source_file": meta.get("source_file", ""),
                "filed_at": meta.get("filed_at", ""),
                "type": meta.get("type", ""),
                "recall_count": meta.get("recall_count", 0),
                "last_recalled_at": meta.get("last_recalled_at", ""),
                "expires_at": meta.get("expires_at", ""),
            }
            if include_content:
                drawer["content"] = d.get("content", "")
            drawers.append(drawer)

        return {"success": True, "drawers": drawers, "count": len(drawers)}
    except Exception as e:
        return {"error": str(e)}


def tool_delete_drawers_by_room(params: dict) -> dict:
    """Bulk delete all drawers in a specific wing/room combination. Irreversible."""
    wing = _canonical_wing(params.get("wing", ""))
    room = params.get("room")

    if not wing or not room:
        return {"error": "Both wing and room are required for bulk delete"}

    col = _get_collection()
    if not col:
        return _no_palace()

    try:
        results = col.get(where={"$and": [{"wing": wing}, {"room": room}]}, include=[])
        ids = results["ids"]
        deleted_count = 0
        if ids:
            try:
                col.delete(ids=ids)
                deleted_count = len(ids)
            except Exception as delete_err:
                # Partial delete possible — count what survived
                remaining = col.get(where={"$and": [{"wing": wing}, {"room": room}]}, include=[])
                deleted_count = len(ids) - len(remaining["ids"])
                return {
                    "success": False,
                    "error": f"Partial delete: {delete_err}",
                    "deleted_count": deleted_count,
                    "total_attempted": len(ids),
                    "wing": wing,
                    "room": room,
                }

        return {
            "success": True,
            "deleted_count": deleted_count,
            "wing": wing,
            "room": room,
        }
    except Exception as e:
        return {"error": str(e)}


# Write-time content limits. The 384-dim MiniLM encoder truncates at ~256
# tokens, so a single huge document only gets its head embedded. Split large
# content into sibling chunks (sharing a drawer_key) and reject raw dumps.
_MAX_DRAWER_CHARS = 200_000
_CHUNK_THRESHOLD = 4_000
_CHUNK_SIZE = 2_000


def _chunk_text(content: str, size: int = _CHUNK_SIZE) -> list:
    return [content[i : i + size] for i in range(0, len(content), size)]


def tool_add_drawer(params: dict) -> dict:
    """File verbatim content into the palace.

    Stamps lifecycle metadata (``type``/``tier``/``session_id``/``recall_count``/
    ``last_recalled_at``/``expires_at``) so the archiver's decay and the recall
    telemetry can operate, canonicalizes the wing, and chunks oversized content
    so the encoder sees representative text for the whole document.
    """
    col = _get_collection(create=True)
    if not col:
        return _no_palace()

    wing = _canonical_wing(params.get("wing", "wing_general"))
    room = params.get("room", "general")
    content = params.get("content", "")
    source_file = params.get("source_file", "")
    added_by = params.get("added_by", "penny")
    drawer_type = params.get("type", "")
    tier = params.get("tier", "")
    session_id = params.get("session_id", "")
    expires_at = params.get("expires_at", "")

    if not content:
        return {"error": "Content is required"}
    if len(content) > _MAX_DRAWER_CHARS:
        return {
            "error": (
                f"Content too large ({len(content)} chars > {_MAX_DRAWER_CHARS}). "
                "Store a summary plus a source_file pointer, not a raw dump."
            )
        }

    # Duplicate guard on the whole document (before any chunking). System
    # rewrites of an existing drawer (e.g. a status flip, which is
    # delete-then-re-add of near-identical JSON) pass skip_duplicate_check —
    # otherwise the guard can reject the re-add AFTER the delete and lose the
    # record. Model-initiated adds must never set it.
    if not params.get("skip_duplicate_check"):
        dup = tool_check_duplicate({"content": content, "threshold": 0.9})
        if dup.get("is_duplicate"):
            return {
                "success": False,
                "reason": "duplicate",
                "matches": dup["matches"],
            }

    now_iso = datetime.now().isoformat()
    chunks = _chunk_text(content) if len(content) > _CHUNK_THRESHOLD else [content]
    base_hash = hashlib.md5((content[:100] + now_iso).encode()).hexdigest()[:16]
    drawer_key = f"drawer_{wing}_{room}_{base_hash}"

    def _meta(chunk_index: int) -> dict:
        m = {
            "wing": wing,
            "room": room,
            "source_file": source_file,
            "chunk_index": chunk_index,
            "drawer_key": drawer_key,
            "added_by": added_by,
            "filed_at": now_iso,
            "type": drawer_type,
            "tier": tier,
            "session_id": session_id,
            "expires_at": expires_at,
            "recall_count": 0,
            "last_recalled_at": "",
        }
        # Drop empty-string values to keep metadata lean; readers use .get(...).
        return {k: v for k, v in m.items() if v != ""}

    ids = [drawer_key] if len(chunks) == 1 else [f"{drawer_key}_{i}" for i in range(len(chunks))]

    try:
        col.add(
            ids=ids,
            documents=chunks,
            metadatas=[_meta(i) for i in range(len(chunks))],
        )
        return {
            "success": True,
            "drawer_id": ids[0],
            "drawer_key": drawer_key,
            "wing": wing,
            "room": room,
            "chunks": len(chunks),
        }
    except Exception as e:
        return {"error": str(e)}


def tool_delete_drawer(params: dict) -> dict:
    """Delete a drawer by ID — including sibling chunks of the same document.

    Chunked adds return ``drawer_id = {drawer_key}_0``; deleting only that id
    would leave chunks 1..n orphaned and still surfacing in search with no id
    the caller holds to remove them. Siblings are found via the shared
    ``drawer_key`` metadata stamped at write time.
    """
    col = _get_collection()
    if not col:
        return _no_palace()

    drawer_id = params.get("drawer_id")
    if not drawer_id:
        return {"error": "drawer_id is required"}

    try:
        existing = col.get(ids=[drawer_id], include=["metadatas"])
        if not existing["ids"]:
            return {"success": False, "error": f"Drawer not found: {drawer_id}"}

        ids_to_delete = [drawer_id]
        metas = existing.get("metadatas") or [{}]
        drawer_key = (metas[0] or {}).get("drawer_key", "")
        if drawer_key:
            siblings = col.get(where={"drawer_key": drawer_key}, include=[])
            ids_to_delete = sorted(set(siblings["ids"]) | {drawer_id})

        col.delete(ids=ids_to_delete)
        return {
            "success": True,
            "drawer_id": drawer_id,
            "deleted_ids": ids_to_delete,
            "chunks_deleted": len(ids_to_delete),
        }
    except Exception as e:
        return {"error": str(e)}


# ==================== KNOWLEDGE GRAPH TOOLS ====================


def tool_kg_query(params: dict) -> dict:
    """Query knowledge graph for entity relationships."""
    entity = params.get("entity")
    if not entity:
        return {"error": "entity is required"}

    as_of = params.get("as_of")
    direction = params.get("direction", "both")

    try:
        results = _get_kg().query_entity(entity, as_of=as_of, direction=direction)
        return {
            "success": True,
            "entity": entity,
            "as_of": as_of,
            "facts": results,
            "count": len(results),
        }
    except Exception as e:
        return {"error": str(e)}


def tool_kg_add(params: dict) -> dict:
    """Add a fact to the knowledge graph."""
    subject = params.get("subject")
    predicate = params.get("predicate")
    obj = params.get("object")

    if not all([subject, predicate, obj]):
        return {"error": "subject, predicate, and object are required"}

    valid_from = params.get("valid_from")
    source_closet = params.get("source_closet")

    try:
        triple_id = _get_kg().add_triple(
            subject, predicate, obj, valid_from=valid_from, source_closet=source_closet
        )
        return {
            "success": True,
            "triple_id": triple_id,
            "fact": f"{subject} → {predicate} → {obj}",
        }
    except Exception as e:
        return {"error": str(e)}


def tool_kg_invalidate(params: dict) -> dict:
    """Mark a fact as no longer true."""
    subject = params.get("subject")
    predicate = params.get("predicate")
    obj = params.get("object")

    if not all([subject, predicate, obj]):
        return {"error": "subject, predicate, and object are required"}

    ended = params.get("ended")

    try:
        _get_kg().invalidate(subject, predicate, obj, ended=ended)
        return {
            "success": True,
            "fact": f"{subject} → {predicate} → {obj}",
            "ended": ended or "today",
        }
    except Exception as e:
        return {"error": str(e)}


def tool_kg_timeline(params: dict) -> dict:
    """Get chronological timeline of facts."""
    entity = params.get("entity")

    try:
        results = _get_kg().timeline(entity)
        return {
            "success": True,
            "entity": entity or "all",
            "timeline": results,
            "count": len(results),
        }
    except Exception as e:
        return {"error": str(e)}


def tool_kg_stats(params: dict) -> dict:
    """Knowledge graph statistics."""
    try:
        stats = _get_kg().stats()
        return {"success": True, "stats": stats}
    except Exception as e:
        return {"error": str(e)}


# ==================== NAVIGATION TOOLS ====================


def tool_traverse(params: dict) -> dict:
    """Walk the palace graph from a room."""
    col = _get_collection()
    if not col:
        return _no_palace()

    start_room = params.get("start_room")
    if not start_room:
        return {"error": "start_room is required"}

    max_hops = params.get("max_hops", 2)

    try:
        result = traverse(start_room, col=col, max_hops=max_hops)
        return {"success": True, "result": result}
    except Exception as e:
        return {"error": str(e)}


def tool_find_tunnels(params: dict) -> dict:
    """Find rooms that bridge two wings."""
    col = _get_collection()
    if not col:
        return _no_palace()

    wing_a = params.get("wing_a")
    wing_b = params.get("wing_b")

    try:
        result = find_tunnels(wing_a, wing_b, col=col)
        return {"success": True, "tunnels": result}
    except Exception as e:
        return {"error": str(e)}


def tool_graph_stats(params: dict) -> dict:
    """Palace graph overview."""
    col = _get_collection()
    if not col:
        return _no_palace()

    try:
        stats = graph_stats(col=col)
        return {"success": True, "stats": stats}
    except Exception as e:
        return {"error": str(e)}


# ==================== AGENT DIARY TOOLS ====================


def tool_diary_write(params: dict) -> dict:
    """Write an agent diary entry."""
    col = _get_collection(create=True)
    if not col:
        return _no_palace()

    agent_name = params.get("agent_name")
    entry = params.get("entry")

    if not agent_name or not entry:
        return {"error": "agent_name and entry are required"}

    topic = params.get("topic", "general")
    session_id = params.get("session_id", "")
    wing = _canonical_wing(f"wing_{agent_name.lower().replace(' ', '_')}")
    room = "diary"

    # Dedup guard (parity with add_drawer) — the auto-diary writer can fire
    # repeatedly; avoid stacking near-identical entries.
    dup = tool_check_duplicate({"content": entry, "threshold": 0.9})
    if dup.get("is_duplicate"):
        return {"success": False, "reason": "duplicate", "matches": dup["matches"]}

    now = datetime.now()
    entry_id = f"diary_{wing}_{now.strftime('%Y%m%d_%H%M%S')}_{hashlib.md5(entry[:50].encode()).hexdigest()[:8]}"

    meta = {
        "wing": wing,
        "room": room,
        "hall": "hall_diary",
        "topic": topic,
        "type": "diary_entry",
        "tier": "episodic",
        "agent": agent_name,
        "filed_at": now.isoformat(),
        "date": now.strftime("%Y-%m-%d"),
        "recall_count": 0,
        "last_recalled_at": "",
    }
    if session_id:
        meta["session_id"] = session_id

    try:
        col.add(
            ids=[entry_id],
            documents=[entry],
            metadatas=[meta],
        )
        return {
            "success": True,
            "entry_id": entry_id,
            "agent": agent_name,
            "topic": topic,
            "timestamp": now.isoformat(),
        }
    except Exception as e:
        return {"error": str(e)}


def tool_diary_read(params: dict) -> dict:
    """Read agent diary entries."""
    col = _get_collection()
    if not col:
        return _no_palace()

    agent_name = params.get("agent_name")
    if not agent_name:
        return {"error": "agent_name is required"}

    last_n = params.get("last_n", 10)
    wings = _diary_wings(agent_name)

    try:
        wing_filter = {"wing": wings[0]} if len(wings) == 1 else {"wing": {"$in": wings}}
        results = col.get(
            where={"$and": [wing_filter, {"room": "diary"}]},
            include=["documents", "metadatas"],
        )

        if not results["ids"]:
            return {
                "success": True,
                "agent": agent_name,
                "entries": [],
                "message": "No diary entries yet.",
            }

        # Sort by timestamp
        entries = []
        for doc, meta in zip(results["documents"], results["metadatas"]):
            entries.append(
                {
                    "date": meta.get("date", ""),
                    "timestamp": meta.get("filed_at", ""),
                    "topic": meta.get("topic", ""),
                    "content": doc,
                }
            )

        entries.sort(key=lambda x: x["timestamp"], reverse=True)
        entries = entries[:last_n]

        return {
            "success": True,
            "agent": agent_name,
            "entries": entries,
            "total": len(results["ids"]),
            "showing": len(entries),
        }
    except Exception as e:
        return {"error": str(e)}


# ==================== DISPATCH ====================

TOOL_HANDLERS = {
    "status": tool_status,
    "list_wings": tool_list_wings,
    "list_rooms": tool_list_rooms,
    "get_taxonomy": tool_get_taxonomy,
    "search": tool_search,
    "smart_search": tool_smart_search,
    "check_duplicate": tool_check_duplicate,
    "get_aaak_spec": tool_get_aaak_spec,
    "list_drawers": tool_list_drawers,
    "delete_drawers_by_room": tool_delete_drawers_by_room,
    "add_drawer": tool_add_drawer,
    "delete_drawer": tool_delete_drawer,
    "kg_query": tool_kg_query,
    "kg_add": tool_kg_add,
    "kg_invalidate": tool_kg_invalidate,
    "kg_timeline": tool_kg_timeline,
    "kg_stats": tool_kg_stats,
    "traverse": tool_traverse,
    "find_tunnels": tool_find_tunnels,
    "graph_stats": tool_graph_stats,
    "diary_write": tool_diary_write,
    "diary_read": tool_diary_read,
}


def handle_request(request: dict) -> dict:
    """Handle a tool request."""
    tool_name = request.get("tool")
    params = request.get("params", {})

    if tool_name not in TOOL_HANDLERS:
        return {
            "success": False,
            "error": f"Unknown tool: {tool_name}. Available: {list(TOOL_HANDLERS.keys())}",
        }

    # Serialize the ENTIRE tool call, not just collection acquisition: ChromaDB
    # flushes the HNSW segment during add/delete/query, so the window that must
    # be exclusive is the whole operation.
    handler = TOOL_HANDLERS[tool_name]
    with palace_lock():
        result = handler(params)
    return result


def main():
    """Main entry point - reads JSON from stdin, writes JSON to stdout."""
    try:
        request = json.load(sys.stdin)
        result = handle_request(request)
        print(json.dumps(result))
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON: {e}"}))
    except Exception as e:
        print(json.dumps({"error": f"Error: {e}"}))


if __name__ == "__main__":
    main()
