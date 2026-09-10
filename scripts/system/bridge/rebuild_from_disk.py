#!/usr/bin/env python3
"""Recover exact vectors into a new receipt-gated copied/offline palace.

Preview is intentionally inspection-only: it authorizes the copied target, runs
SQLite/FTS5 inspection on a private disposable diagnostic copy, and reads SQLite
rows in read-only mode.  It does not deserialize ``index_metadata.pickle``, open
ChromaDB, build an index, allocate recovery staging, rename, swap, or clean up.

Exact-vector apply requires two independent decisions:

* ``--apply`` authorizes a new preserved recovery attempt and copied-target swap.
* ``--trust-legacy-index-metadata`` explicitly trusts Chroma's executable pickle
  metadata for this attempt.  This is direct in-process deserialization.  It is
  **not** a sandbox or subprocess-isolation claim.

Every authorized attempt receives a private unique sibling directory.  The old
source, failed stage, failed swapped tree, and event records are retained; this
tool has no cleanup mode.  A reported backup path is advisory and is paired
with exact parent/original/parked identities for fail-closed reacquisition.
``open_authorized_recovery`` retains the validated filesystem descriptors after
delegating receipt semantics to ``authorize_offline_target``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import pickle
import sqlite3
import struct
import subprocess
import sys
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from scripts.system.bridge.fts5_integrity import (
    materialize_sqlite_family,
    probe_authorized_database,
    probe_database_directory,
    sqlite_budget_guard,
)
from scripts.system.bridge.recovery_safety import (
    FileIdentity,
    HeldDirectory,
    RecoveryBudget,
    RecoverySource,
    RecoverySwapError,
    SourceSnapshot,
    VerificationResult,
    account_staging_tree,
    allocate_recovery_attempt,
    assert_source_unchanged,
    copy_preserved_entries,
    hold_child_directory,
    hold_regular_file,
    open_authorized_recovery,
    recovery_attempt_binding,
    revalidate_source_binding,
    snapshot_source_tree,
    swap_staged_palace,
)
from scripts.system.memory.common import ValidationError, canonical_json_bytes
from scripts.system.memory.hnsw import HNSW_TUNING

COLLECTION = "mempalace_drawers"
BATCH = 500
VERIFY_TIMEOUT_SECONDS = 900
PROJECT_ROOT = Path(__file__).resolve().parents[3]
MAX_VECTOR_DIMENSIONS = 65_536
MAX_HNSW_ELEMENT_BYTES = 4 * MAX_VECTOR_DIMENSIONS + 1024 * 1024
MAX_LEGACY_METADATA_BYTES = 256 * 1024 * 1024
MAX_RECORD_ID_BYTES = 4_096

MetadataValue = str | int | float | bool
Vector = tuple[float, ...]


@dataclass(frozen=True)
class SafeRecoveryInspection:
    """SQLite-only recovery facts available without executable metadata."""

    documents: dict[str, str]
    metadata: dict[str, dict[str, MetadataValue]]
    pending_vectors: dict[str, Vector]
    pending_deletes: frozenset[str]


@dataclass(frozen=True)
class LegacyMetadataTrust:
    """Explicit trust decision bound to one source/receipt inspection identity."""

    target: Path
    source_id: str
    source_manifest_sha256: str
    receipt_sha256: str


@dataclass(frozen=True)
class RecoveryRecord:
    """One exact record to write and verify before and after swap."""

    record_id: str
    document: str
    metadata: dict[str, MetadataValue]
    embedding: Vector


@dataclass(frozen=True)
class RecoveryInput:
    """Exact source records and content-free counts for an authorized rebuild."""

    records: tuple[RecoveryRecord, ...]
    missing: tuple[str, ...]
    document_count: int
    index_vector_count: int
    pending_vector_count: int
    pending_delete_count: int
    vector_dimensions: int | None


@dataclass(frozen=True)
class HnswLayout:
    """Validated level-zero byte layout for one legacy HNSW segment."""

    current_count: int
    usable_count: int
    size_per_element: int
    label_offset: int
    data_offset: int
    dimensions: int


def _typed(row: sqlite3.Row) -> MetadataValue | None:
    """Return the populated typed column of an embedding_metadata row."""

    for key in ("string_value", "int_value", "float_value", "bool_value"):
        value: object = row[key]
        if value is None:
            continue
        if key == "bool_value":
            return bool(value)
        if isinstance(value, (str, int, float)) and not isinstance(value, bool):
            if isinstance(value, float) and not math.isfinite(value):
                raise ValidationError("SQLite metadata contains a non-finite float")
            return value
        raise ValidationError("SQLite metadata contains an unsupported typed value")
    return None


def _metadata_segment_id(connection: sqlite3.Connection) -> str:
    segment_row = connection.execute(
        "SELECT s.id FROM segments s JOIN collections c ON c.id = s.collection "
        "WHERE c.name = ? AND s.scope = 'METADATA'",
        (COLLECTION,),
    ).fetchone()
    if segment_row is None or not isinstance(segment_row[0], str):
        raise ValidationError("copied palace has no metadata segment for the recovery collection")
    return segment_row[0]


def _embedding_id_map(connection: sqlite3.Connection, segment_id: str) -> dict[int, str]:
    identities: dict[int, str] = {}
    for row in connection.execute(
        "SELECT id, embedding_id FROM embeddings WHERE segment_id = ?", (segment_id,)
    ):
        row_id, embedding_id = row["id"], row["embedding_id"]
        if not isinstance(row_id, int) or not isinstance(embedding_id, str):
            raise ValidationError("copied palace contains an invalid embedding identity")
        if len(embedding_id.encode("utf-8")) > MAX_RECORD_ID_BYTES:
            raise ValidationError("copied palace contains an oversized embedding identity")
        identities[row_id] = embedding_id
    return identities


def _read_metadata_rows(
    connection: sqlite3.Connection,
    rowid_to_id: Mapping[int, str],
) -> tuple[dict[str, str], dict[str, dict[str, MetadataValue]]]:
    documents: dict[str, str] = {}
    metadata: dict[str, dict[str, MetadataValue]] = {}
    for row in connection.execute("SELECT * FROM embedding_metadata"):
        row_id = row["id"]
        embedding_id = rowid_to_id.get(row_id) if isinstance(row_id, int) else None
        if embedding_id is None:
            continue
        key = row["key"]
        if not isinstance(key, str):
            raise ValidationError("copied palace contains a non-string metadata key")
        if key == "chroma:document":
            document = row["string_value"]
            if not isinstance(document, str):
                raise ValidationError("copied palace contains a non-string document")
            documents[embedding_id] = document
            continue
        value = _typed(row)
        if value is not None:
            metadata.setdefault(embedding_id, {})[key] = value
    return documents, metadata


def read_sqlite(
    database: Path,
    budget: RecoveryBudget | None = None,
) -> tuple[dict[str, str], dict[str, dict[str, MetadataValue]]]:
    """Return metadata from an already private descriptor-rooted SQLite copy."""

    operation_budget = budget if budget is not None else RecoveryBudget()
    operation_budget.checkpoint()
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        with sqlite_budget_guard(connection, operation_budget):
            segment_id = _metadata_segment_id(connection)
            return _read_metadata_rows(connection, _embedding_id_map(connection, segment_id))
    finally:
        connection.close()


def _decode_vector_blob(raw: object) -> Vector:
    if not isinstance(raw, bytes) or not raw or len(raw) % 4 != 0:
        raise ValidationError("pending vector is not a nonempty float32 byte sequence")
    dimensions = len(raw) // 4
    if dimensions > MAX_VECTOR_DIMENSIONS:
        raise ValidationError("pending vector exceeds the supported dimension bound")
    values = struct.unpack(f"<{dimensions}f", raw)
    if not all(math.isfinite(value) for value in values):
        raise ValidationError("pending vector contains a non-finite value")
    return tuple(values)


def read_pending(
    database: Path,
    budget: RecoveryBudget | None = None,
) -> tuple[dict[str, Vector], set[str]]:
    """Return latest pending vectors/deletes from a private SQLite copy.

    ChromaDB operation codes are 0 ADD, 1 UPDATE, 2 UPSERT, and 3 DELETE.
    Later rows take precedence.  A metadata-only UPDATE preserves the prior vector.
    """

    operation_budget = budget if budget is not None else RecoveryBudget()
    operation_budget.checkpoint()
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    try:
        vectors: dict[str, Vector] = {}
        deletes: set[str] = set()
        with sqlite_budget_guard(connection, operation_budget):
            rows = connection.execute(
                "SELECT operation, id, vector FROM embeddings_queue ORDER BY seq_id"
            )
            for operation, raw_id, raw_vector in rows:
                operation_budget.checkpoint()
                if not isinstance(operation, int) or operation not in {0, 1, 2, 3}:
                    raise ValidationError("embeddings_queue contains an unknown operation")
                if not isinstance(raw_id, str):
                    raise ValidationError("embeddings_queue contains a non-string record ID")
                if len(raw_id.encode("utf-8")) > MAX_RECORD_ID_BYTES:
                    raise ValidationError("embeddings_queue contains an oversized record ID")
                if operation in {0, 2}:
                    if raw_vector is None:
                        raise ValidationError("pending add/upsert is missing its exact vector")
                    vectors[raw_id] = _decode_vector_blob(raw_vector)
                    deletes.discard(raw_id)
                elif operation == 1 and raw_vector is not None:
                    vectors[raw_id] = _decode_vector_blob(raw_vector)
                elif operation == 3:
                    deletes.add(raw_id)
                    vectors.pop(raw_id, None)
        return vectors, deletes
    finally:
        connection.close()


def inspect_recovery_source(
    source: RecoverySource,
    snapshot: SourceSnapshot,
) -> SafeRecoveryInspection:
    """Collect preview-safe SQLite facts from one held diagnostic copy."""

    with materialize_sqlite_family(
        source.root,
        expected_snapshot=snapshot,
        account_as_input=True,
    ) as database:
        documents, metadata = read_sqlite(database, source.budget)
        pending_vectors, pending_deletes = read_pending(database, source.budget)
    assert_source_unchanged(source, snapshot)
    return SafeRecoveryInspection(
        documents=documents,
        metadata=metadata,
        pending_vectors=pending_vectors,
        pending_deletes=frozenset(pending_deletes),
    )


def _trusted_pickle(
    descriptor: int,
    identity: FileIdentity,
    budget: RecoveryBudget,
) -> object:
    """Deserialize one explicitly trusted, already-open exact legacy file."""

    if identity.size > MAX_LEGACY_METADATA_BYTES:
        raise ValidationError("trusted legacy index metadata exceeds the byte bound")
    budget.checkpoint()
    try:
        with os.fdopen(os.dup(descriptor), "rb") as handle:
            # Executable deserialization is authorized by the separate trust flag;
            # the descriptor identity is bound to the inspected source snapshot.
            value = pickle.load(handle)  # noqa: S301 - explicit break-glass trust
    except ValidationError:
        raise
    except Exception as exc:
        raise ValidationError("trusted legacy index metadata could not be decoded") from exc
    budget.checkpoint()
    return value


def _label_map(raw: object, *, maximum_entries: int) -> dict[int, str]:
    if not isinstance(raw, dict) or set(raw) < {"label_to_id"}:
        raise ValidationError("trusted legacy index metadata lacks label_to_id")
    candidate: object = raw["label_to_id"]
    if not isinstance(candidate, dict) or len(candidate) > maximum_entries:
        raise ValidationError("trusted legacy label map has an invalid size")
    labels: dict[int, str] = {}
    for label, record_id in candidate.items():
        if not isinstance(label, int) or label < 0 or label > 2**64 - 1:
            raise ValidationError("trusted legacy label map contains an invalid label")
        if not isinstance(record_id, str) or len(record_id.encode("utf-8")) > MAX_RECORD_ID_BYTES:
            raise ValidationError("trusted legacy label map contains an invalid record ID")
        labels[label] = record_id
    return labels


def _snapshot_identities(snapshot: SourceSnapshot) -> dict[str, FileIdentity]:
    return {
        member.relative_path: FileIdentity(
            member.device,
            member.inode,
            member.mode,
            member.size,
            member.modified_ns,
            member.changed_ns,
        )
        for member in snapshot.members
    }


def _segment_names(snapshot: SourceSnapshot) -> tuple[str, ...]:
    identities = _snapshot_identities(snapshot)
    return tuple(
        sorted(
            member.relative_path
            for member in snapshot.members
            if member.kind == "directory"
            and member.relative_path != "."
            and "/" not in member.relative_path
            and f"{member.relative_path}/header.bin" in identities
            and f"{member.relative_path}/data_level0.bin" in identities
        )
    )


def _hnsw_layout(
    segment: HeldDirectory,
    segment_name: str,
    identities: Mapping[str, FileIdentity],
) -> HnswLayout:
    header_identity = identities.get(f"{segment_name}/header.bin")
    data_identity = identities.get(f"{segment_name}/data_level0.bin")
    if header_identity is None or data_identity is None:
        raise ValidationError("HNSW segment is missing required regular files")
    with hold_regular_file(segment, "header.bin", header_identity) as descriptor:
        segment.budget.checkpoint()
        header = os.pread(descriptor, 4 + 6 * 8, 0)
    if len(header) < 4 + 6 * 8:
        raise ValidationError("HNSW header is truncated")
    _, _, current_count, size_per_element, label_offset, data_offset = struct.unpack_from(
        "<QQQQQQ", header, 4
    )
    if (
        size_per_element <= 0
        or size_per_element > MAX_HNSW_ELEMENT_BYTES
        or data_offset > label_offset
        or label_offset + 8 > size_per_element
        or (label_offset - data_offset) % 4 != 0
    ):
        raise ValidationError("HNSW header contains an invalid element layout")
    dimensions = (label_offset - data_offset) // 4
    if dimensions <= 0 or dimensions > MAX_VECTOR_DIMENSIONS:
        raise ValidationError("HNSW vector dimension is outside the supported bound")
    return HnswLayout(
        current_count=current_count,
        usable_count=min(current_count, data_identity.size // size_per_element),
        size_per_element=size_per_element,
        label_offset=label_offset,
        data_offset=data_offset,
        dimensions=dimensions,
    )


def _vector_from_element(element: bytes, layout: HnswLayout) -> Vector:
    vector = tuple(struct.unpack_from(f"<{layout.dimensions}f", element, layout.data_offset))
    if not all(math.isfinite(value) for value in vector):
        raise ValidationError("HNSW index contains a non-finite vector")
    return vector


def _read_level_zero_vectors(
    segment: HeldDirectory,
    data_identity: FileIdentity,
    layout: HnswLayout,
    labels: Mapping[int, str],
) -> dict[str, Vector]:
    vectors: dict[str, Vector] = {}
    try:
        with hold_regular_file(segment, "data_level0.bin", data_identity) as descriptor:
            for index in range(layout.usable_count):
                segment.budget.checkpoint()
                element = os.pread(
                    descriptor,
                    layout.size_per_element,
                    index * layout.size_per_element,
                )
                if len(element) != layout.size_per_element:
                    raise ValidationError("HNSW data changed or truncated during recovery")
                if struct.unpack_from("<I", element, 0)[0] & 0x10000:
                    continue
                label = struct.unpack_from("<Q", element, layout.label_offset)[0]
                record_id = labels.get(label)
                if record_id is not None:
                    vectors[record_id] = _vector_from_element(element, layout)
    except OSError as exc:
        raise ValidationError("cannot read HNSW vector bytes") from exc
    return vectors


def read_index_vectors(
    source: RecoverySource,
    snapshot: SourceSnapshot,
    trust: LegacyMetadataTrust,
) -> dict[str, Vector]:
    """Recover exact HNSW vectors only from snapshot-bound held descriptors."""

    if (
        source.target != trust.target
        or source.authorization.source_id != trust.source_id
        or snapshot.manifest_sha256 != trust.source_manifest_sha256
        or source.receipt_sha256 != trust.receipt_sha256
    ):
        raise ValidationError("legacy metadata trust is not bound to this source and receipt")
    assert_source_unchanged(source, snapshot)
    identities = _snapshot_identities(snapshot)
    segment_names = _segment_names(snapshot)
    if not segment_names:
        return {}
    segment_name = max(
        segment_names,
        key=lambda name: identities[f"{name}/data_level0.bin"].size,
    )
    segment_identity = identities[segment_name]
    with hold_child_directory(
        source.root,
        segment_name,
        segment_identity,
        namespace=f"legacy-segment:{segment_name}",
    ) as segment:
        layout = _hnsw_layout(segment, segment_name, identities)
        metadata_identity = identities.get(f"{segment_name}/index_metadata.pickle")
        data_identity = identities.get(f"{segment_name}/data_level0.bin")
        if metadata_identity is None or data_identity is None:
            raise ValidationError("HNSW segment lacks trusted metadata or level-zero data")
        with hold_regular_file(
            segment,
            "index_metadata.pickle",
            metadata_identity,
        ) as metadata_descriptor:
            labels = _label_map(
                _trusted_pickle(metadata_descriptor, metadata_identity, source.budget),
                maximum_entries=layout.usable_count,
            )
        vectors = _read_level_zero_vectors(segment, data_identity, layout, labels)
    assert_source_unchanged(source, snapshot)
    return vectors


def _validate_vector_dimensions(records: Sequence[RecoveryRecord]) -> int | None:
    dimensions = {len(record.embedding) for record in records}
    if not dimensions:
        return None
    if 0 in dimensions or len(dimensions) != 1:
        raise ValidationError("recovery vectors do not share one nonzero dimension")
    return next(iter(dimensions))


def collect_exact_recovery_input(
    inspection: SafeRecoveryInspection,
    index_vectors: Mapping[str, Vector],
) -> RecoveryInput:
    """Apply pending precedence and require one exact vector for every live document."""

    live_ids = set(inspection.documents) - set(inspection.pending_deletes)
    orphan_pending = set(inspection.pending_vectors) - set(inspection.documents)
    if orphan_pending:
        raise ValidationError("pending vectors contain IDs absent from SQLite metadata")
    vectors = dict(index_vectors)
    vectors.update(inspection.pending_vectors)
    records: list[RecoveryRecord] = []
    missing: list[str] = []
    for record_id in sorted(live_ids):
        vector = vectors.get(record_id)
        if vector is None:
            missing.append(record_id)
            continue
        records.append(
            RecoveryRecord(
                record_id=record_id,
                document=inspection.documents[record_id],
                metadata=dict(inspection.metadata.get(record_id, {})),
                embedding=tuple(vector),
            )
        )
    dimensions = _validate_vector_dimensions(records)
    return RecoveryInput(
        records=tuple(records),
        missing=tuple(missing),
        document_count=len(inspection.documents),
        index_vector_count=len(index_vectors),
        pending_vector_count=len(inspection.pending_vectors),
        pending_delete_count=len(inspection.pending_deletes),
        vector_dimensions=dimensions,
    )


def _record_digest(records: Iterable[RecoveryRecord]) -> str:
    digest = hashlib.sha256()
    for record in sorted(records, key=lambda item: item.record_id):
        metadata = canonical_json_bytes(record.metadata)
        vector = struct.pack(f"<{len(record.embedding)}f", *record.embedding)
        for value in (
            record.record_id.encode("utf-8"),
            record.document.encode("utf-8"),
            metadata,
            vector,
        ):
            digest.update(struct.pack("<Q", len(value)))
            digest.update(value)
    return digest.hexdigest()


def build(dest: HeldDirectory | Path, records: Sequence[RecoveryRecord]) -> None:
    """Write a fresh exact-vector palace into held private staging."""

    destination = dest.access_path if isinstance(dest, HeldDirectory) else dest
    budget = dest.budget if isinstance(dest, HeldDirectory) else RecoveryBudget()
    budget.checkpoint()
    if (
        (not isinstance(dest, HeldDirectory) and destination.is_symlink())
        or not destination.is_dir()
        or any(destination.iterdir())
    ):
        raise ValidationError("exact rebuild destination must be an empty held directory")
    import chromadb

    client = chromadb.PersistentClient(path=str(destination))
    if isinstance(dest, HeldDirectory):
        account_staging_tree(dest)
    collection = client.create_collection(COLLECTION, metadata=dict(HNSW_TUNING))
    if isinstance(dest, HeldDirectory):
        account_staging_tree(dest)
    for index in range(0, len(records), BATCH):
        budget.checkpoint()
        chunk = records[index : index + BATCH]
        embeddings: list[Sequence[float] | Sequence[int]] = [
            list(record.embedding) for record in chunk
        ]
        collection.add(
            ids=[record.record_id for record in chunk],
            embeddings=embeddings,
            documents=[record.document for record in chunk],
            metadatas=[record.metadata for record in chunk],
        )
        if isinstance(dest, HeldDirectory):
            account_staging_tree(dest)
    budget.checkpoint()


def _iterable_list(value: object, field: str) -> list[object]:
    if isinstance(value, (str, bytes, bytearray, Mapping)) or not isinstance(value, Iterable):
        raise ValidationError(f"rebuilt Chroma result has invalid {field}")
    return list(value)


def _metadata_value(value: object) -> MetadataValue:
    if isinstance(value, bool):
        return value
    if isinstance(value, (str, int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise ValidationError("rebuilt metadata contains a non-finite float")
        return value
    raise ValidationError("rebuilt metadata contains an unsupported value")


def _metadata_from_result(raw_metadata: object) -> dict[str, MetadataValue]:
    if raw_metadata is None:
        return {}
    if not isinstance(raw_metadata, Mapping):
        raise ValidationError("rebuilt collection returned invalid metadata")
    metadata: dict[str, MetadataValue] = {}
    for key, value in raw_metadata.items():
        if not isinstance(key, str):
            raise ValidationError("rebuilt collection returned a non-string metadata key")
        metadata[key] = _metadata_value(value)
    return metadata


def _embedding_from_result(raw_embedding: object) -> Vector:
    embedding: list[float] = []
    for value in _iterable_list(raw_embedding, "embedding"):
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise ValidationError("rebuilt collection returned a non-numeric vector")
        number = float(value)
        if not math.isfinite(number):
            raise ValidationError("rebuilt collection returned a non-finite vector")
        embedding.append(number)
    return tuple(embedding)


def _page_records(raw_page: object) -> tuple[RecoveryRecord, ...]:
    if not isinstance(raw_page, Mapping):
        raise ValidationError("rebuilt collection returned a non-object page")
    ids = _iterable_list(raw_page.get("ids"), "ids")
    documents = _iterable_list(raw_page.get("documents"), "documents")
    metadata_items = _iterable_list(raw_page.get("metadatas"), "metadatas")
    embeddings = _iterable_list(raw_page.get("embeddings"), "embeddings")
    if not (len(ids) == len(documents) == len(metadata_items) == len(embeddings)):
        raise ValidationError("rebuilt collection returned misaligned record fields")
    records: list[RecoveryRecord] = []
    for raw_id, raw_document, raw_metadata, raw_embedding in zip(
        ids, documents, metadata_items, embeddings
    ):
        if not isinstance(raw_id, str) or not isinstance(raw_document, str):
            raise ValidationError("rebuilt collection returned invalid ID/document data")
        records.append(
            RecoveryRecord(
                raw_id,
                raw_document,
                _metadata_from_result(raw_metadata),
                _embedding_from_result(raw_embedding),
            )
        )
    return tuple(records)


def _records_from_collection(
    palace: Path,
    budget: RecoveryBudget,
) -> tuple[RecoveryRecord, ...]:
    import chromadb

    budget.checkpoint()
    client = chromadb.PersistentClient(path=str(palace))
    collection = client.get_collection(COLLECTION)
    total: object = collection.count()
    budget.checkpoint()
    if not isinstance(total, int) or total < 0:
        raise ValidationError("rebuilt collection returned an invalid count")
    records: list[RecoveryRecord] = []
    for offset in range(0, total, BATCH):
        budget.checkpoint()
        raw_page: object = collection.get(
            limit=min(BATCH, total - offset),
            offset=offset,
            include=["embeddings", "documents", "metadatas"],
        )
        records.extend(_page_records(raw_page))
    if len(records) != total:
        raise ValidationError("rebuilt collection count does not match retrieved records")
    return tuple(records)


def _verify_hnsw_tuning(database: Path, budget: RecoveryBudget) -> None:
    budget.checkpoint()
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        with sqlite_budget_guard(connection, budget):
            stored = {
                str(key): int(value)
                for key, value in connection.execute(
                    "SELECT key, int_value FROM collection_metadata WHERE key LIKE 'hnsw:%'"
                )
            }
    missing = {key: value for key, value in HNSW_TUNING.items() if stored.get(key) != value}
    if missing:
        raise ValidationError("rebuilt collection did not preserve required HNSW tuning")


def _first_query_id(raw_result: object) -> str | None:
    if not isinstance(raw_result, Mapping):
        return None
    outer = _iterable_list(raw_result.get("ids"), "query ids")
    if not outer:
        return None
    inner = _iterable_list(outer[0], "query result ids")
    return inner[0] if inner and isinstance(inner[0], str) else None


def _verify_self_recall(
    palace: Path,
    records: Sequence[RecoveryRecord],
    budget: RecoveryBudget,
) -> None:
    import chromadb

    budget.checkpoint()
    collection = chromadb.PersistentClient(path=str(palace)).get_collection(COLLECTION)
    for record in records[:25]:
        budget.checkpoint()
        query_embeddings: list[Sequence[float] | Sequence[int]] = [list(record.embedding)]
        result: object = collection.query(
            query_embeddings=query_embeddings,
            n_results=1,
        )
        if _first_query_id(result) != record.record_id:
            raise ValidationError("rebuilt exact vector failed self-recall verification")


def _verify_exact_in_process(
    palace: HeldDirectory,
    *,
    expected_count: int,
    expected_digest: str,
) -> VerificationResult:
    path = palace.access_path
    records = _records_from_collection(path, palace.budget)
    if len(records) != expected_count:
        return VerificationResult(False, f"count {len(records)} != expected {expected_count}")
    if _record_digest(records) != expected_digest:
        return VerificationResult(False, "record IDs/documents/metadata/exact vectors differ")
    integrity = probe_database_directory(palace)
    if not integrity.ok:
        return VerificationResult(False, "rebuilt SQLite/FTS5 integrity failed")
    with materialize_sqlite_family(palace, account_as_input=False) as copied_database:
        _verify_hnsw_tuning(copied_database, palace.budget)
    _verify_self_recall(path, records, palace.budget)
    dimensions = _validate_vector_dimensions(records)
    return VerificationResult(
        True,
        f"exact records/integrity/self-recall verified count={len(records)} "
        f"dimensions={dimensions}",
    )


def verify(
    palace: HeldDirectory,
    records: Sequence[RecoveryRecord],
) -> VerificationResult:
    """Verify held staged bytes in a bounded credential-free child process."""

    budget = palace.budget
    path = palace.access_path
    reference = str(palace.descriptor)
    budget.checkpoint()
    expected_digest = _record_digest(records)
    try:
        completed = subprocess.run(
            [
                sys.executable,
                "-m",
                "scripts.system.bridge.rebuild_from_disk",
                "--internal-verify",
                reference,
                str(len(records)),
                expected_digest,
            ],
            capture_output=True,
            timeout=min(VERIFY_TIMEOUT_SECONDS, budget.remaining_seconds),
            check=False,
            cwd=PROJECT_ROOT,
            env={
                "ANONYMIZED_TELEMETRY": "False",
                "HOME": str(path.parent),
                "PYTHONHASHSEED": "0",
            },
            pass_fds=(palace.descriptor,),
        )
    except subprocess.TimeoutExpired:
        return VerificationResult(False, "verification timed out")
    budget.checkpoint()
    lines = (completed.stdout + completed.stderr).decode(errors="replace").strip().splitlines()
    tail = lines[-1] if lines else ""
    if completed.returncode != 0:
        return VerificationResult(False, f"verification rc={completed.returncode} {tail}")
    try:
        payload: object = json.loads(tail)
    except json.JSONDecodeError:
        return VerificationResult(False, "verification returned malformed output")
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        return VerificationResult(False, "verification did not confirm exact records")
    detail = payload.get("detail")
    return VerificationResult(
        True, detail if isinstance(detail, str) else "exact verification passed"
    )


def _chroma_entry_names(snapshot: SourceSnapshot) -> frozenset[str]:
    names: set[str] = {".palace.lock"}
    paths = {member.relative_path for member in snapshot.members}
    for member in snapshot.members:
        name = member.relative_path
        if "/" in name or name == ".":
            continue
        if name.startswith("chroma.sqlite3"):
            names.add(name)
        elif member.kind == "directory" and f"{name}/header.bin" in paths:
            names.add(name)
    return frozenset(names)


def _print_inspection(palace: Path, inspection: SafeRecoveryInspection) -> None:
    print(f"palace          : {palace}")
    print(f"documents       : {len(inspection.documents)}")
    print("vectors (index) : UNVERIFIED (requires trusted legacy executable metadata)")
    print(f"vectors (WAL)   : {len(inspection.pending_vectors)}")
    print(f"pending deletes : {len(inspection.pending_deletes)}")
    print("diagnostic copy : ephemeral private SQLite/FTS5 probe only")


def _legacy_trust(
    source: RecoverySource,
    snapshot: SourceSnapshot,
) -> LegacyMetadataTrust:
    return LegacyMetadataTrust(
        target=source.target,
        source_id=source.authorization.source_id,
        source_manifest_sha256=snapshot.manifest_sha256,
        receipt_sha256=source.receipt_sha256,
    )


def _internal_verify(argv: Sequence[str]) -> int:
    if len(argv) != 3:
        return 2
    raw_reference, raw_count, expected_digest = argv
    try:
        descriptor = int(raw_reference)
        expected_count = int(raw_count)
    except ValueError:
        return 2
    display_path = Path("/proc/self/fd") / raw_reference
    budget = RecoveryBudget()
    opened = os.fstat(descriptor)
    palace = HeldDirectory(
        descriptor,
        FileIdentity.from_stat(opened),
        display_path,
        budget,
        "verification-stage",
    )
    try:
        result = _verify_exact_in_process(
            palace,
            expected_count=expected_count,
            expected_digest=expected_digest,
        )
    except Exception as exc:  # native crashes are represented by the parent return code
        print(json.dumps({"ok": False, "detail": type(exc).__name__}))
        return 1
    print(json.dumps({"ok": result.ok, "detail": result.detail}))
    return 0 if result.ok else 1


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--offline-target", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--apply", action="store_true", help="build and swap inside the copy")
    parser.add_argument(
        "--trust-legacy-index-metadata",
        action="store_true",
        help=(
            "separately trust executable index_metadata.pickle for this exact copied source; "
            "this is not sandboxed or isolated"
        ),
    )
    return parser


def _collect_trusted_recovery(
    source: RecoverySource,
    source_snapshot: SourceSnapshot,
    inspection: SafeRecoveryInspection,
) -> RecoveryInput:
    revalidate_source_binding(source, source_snapshot)
    trust = _legacy_trust(source, source_snapshot)
    recovery = collect_exact_recovery_input(
        inspection,
        read_index_vectors(source, source_snapshot, trust),
    )
    print(f"vectors (index) : {recovery.index_vector_count} (explicitly trusted metadata)")
    print(f"recoverable     : {len(recovery.records)}")
    print(
        f"UNRECOVERABLE   : {len(recovery.missing)}"
        f"{' -> ' + str(list(recovery.missing[:5])) if recovery.missing else ''}"
    )
    return recovery


def _apply_exact_recovery(
    source: RecoverySource,
    source_snapshot: SourceSnapshot,
    recovery: RecoveryInput,
) -> int:
    revalidate_source_binding(source, source_snapshot)
    attempt = allocate_recovery_attempt(
        source,
        "exact-rebuild",
        source_snapshot,
        recovery_attempt_binding(source, source_snapshot),
    )
    print(f"\nattempt         : {attempt.root}")
    print(f"building        : {attempt.staging}")
    try:
        build(attempt.staging_handle, recovery.records)
        copy_preserved_entries(
            source,
            attempt,
            source_snapshot,
            excluded_names=_chroma_entry_names(source_snapshot),
        )
        account_staging_tree(attempt.staging_handle)
        staged_verification = verify(attempt.staging_handle, recovery.records)
        print(f"verify staged   : {staged_verification.detail}")
        if not staged_verification.ok:
            print("ABORT: exact staged verification failed; source and attempt are preserved.")
            return 1

        revalidate_source_binding(source, source_snapshot)
        swap_result = swap_staged_palace(
            source,
            attempt,
            source_snapshot,
            lambda swapped: verify(swapped, recovery.records),
        )
    except RecoverySwapError as exc:
        print(f"ABORT: {exc}; attempt evidence retained at {attempt.root}")
        return 1
    except (OSError, RuntimeError, ValidationError) as exc:
        print(
            f"ABORT: recovery attempt failed ({type(exc).__name__}); "
            f"source/attempt evidence retained at {attempt.root}"
        )
        return 1
    finally:
        attempt.close()

    backup = swap_result.backup
    print(f"verify swapped  : {swap_result.verification.detail}")
    print(
        f"OK: exact palace rebuilt ({len(recovery.records)} records). "
        f"Previous source backup advisory path: {backup.advisory_path}."
    )
    print("Exact backup identity evidence: " + json.dumps(backup.to_dict(), sort_keys=True))
    print(
        "Cleanup is a separate operator-authorized action; this tool deletes no attempt evidence."
    )
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    arguments = list(argv) if argv is not None else sys.argv[1:]
    if arguments[:1] == ["--internal-verify"]:
        return _internal_verify(arguments[1:])
    args = _parser().parse_args(arguments)

    with open_authorized_recovery(args.offline_target, args.receipt) as source:
        palace = source.target
        source_snapshot = snapshot_source_tree(source)
        integrity = probe_authorized_database(source, source_snapshot)
        if not integrity.repair_safe:
            print(
                "ABORT: temporary-copy integrity probe found unclassified SQLite corruption; "
                "refusing to rebuild from potentially damaged source rows."
            )
            return 1
        if integrity.corrupt_fts5_tables:
            print("classified FTS5 corruption detected; exact rebuild may proceed")

        inspection = inspect_recovery_source(source, source_snapshot)
        _print_inspection(palace, inspection)
        if not args.apply:
            assert_source_unchanged(source, source_snapshot)
            print(
                "\nPREVIEW — exact-vector recovery remains unverified; "
                "no recovery attempt allocated."
            )
            if args.trust_legacy_index_metadata:
                print("Trust flag recorded but not exercised; no pickle was deserialized.")
            return 0
        if not args.trust_legacy_index_metadata:
            print(
                "\nABORT: --apply does not trust executable legacy metadata. Re-run only after "
                "a separate decision with --trust-legacy-index-metadata."
            )
            return 1

        recovery = _collect_trusted_recovery(source, source_snapshot, inspection)
        if recovery.missing:
            print(
                "\nABORT: some live documents have no exact vector. Refusing record loss or "
                "an unapproved re-embedding substitute."
            )
            return 1
        if not recovery.records:
            print("\nABORT: refusing to replace the copied palace with an empty recovery.")
            return 1
        return _apply_exact_recovery(source, source_snapshot, recovery)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - bounded CLI error boundary
        print(f"rebuild ERROR: {type(exc).__name__}", file=sys.stderr)
        raise SystemExit(1)
