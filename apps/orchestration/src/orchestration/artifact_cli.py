"""Generic command-line owner for immutable workflow artifact persistence.

``put`` accepts one bounded, strict metadata object as an argument, reads the exact
artifact bytes from stdin, persists them through :class:`ArtifactStore`, verifies
the resulting reference, and writes only canonical ``ArtifactRef`` JSON to stdout.
Artifact-root selection remains the store's responsibility: ``PENNY_ARTIFACT_ROOT``
first, then the platform/XDG state default.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Final

from .artifacts import (
    ArtifactError,
    ArtifactRef,
    ArtifactStore,
    ArtifactValidationError,
    OutputArtifactMetadata,
    canonical_json,
)

MAX_METADATA_BYTES: Final = 64 * 1024


class ArtifactCliInputError(ArtifactValidationError):
    """The CLI metadata transport is malformed, oversized, or non-canonical."""


def parse_output_artifact_metadata(value: object) -> OutputArtifactMetadata:
    """Parse the exact action-supplied metadata contract and reject drift."""
    try:
        return OutputArtifactMetadata.from_dict(value)
    except ArtifactValidationError as exc:
        raise ArtifactCliInputError(str(exc)) from exc


def _object_without_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ArtifactCliInputError(f"metadata contains duplicate field: {key}")
        result[key] = value
    return result


def parse_metadata_json(raw: str) -> OutputArtifactMetadata:
    """Parse bounded JSON while rejecting duplicate keys at every object level."""
    encoded = raw.encode("utf-8")
    if len(encoded) > MAX_METADATA_BYTES:
        raise ArtifactCliInputError(
            f"output artifact metadata exceeds {MAX_METADATA_BYTES} UTF-8 bytes"
        )
    try:
        value = json.loads(raw, object_pairs_hook=_object_without_duplicate_keys)
    except ArtifactCliInputError:
        raise
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise ArtifactCliInputError("output artifact metadata is not valid JSON") from exc
    return parse_output_artifact_metadata(value)


def put_output_artifact(
    metadata: OutputArtifactMetadata,
    content: bytes,
    *,
    store: ArtifactStore | None = None,
) -> ArtifactRef:
    """Persist exact bytes and independently verify the returned canonical ref."""
    artifact_store = store or ArtifactStore()
    ref = artifact_store.put(
        content,
        run_id=metadata.run_id,
        phase=metadata.phase,
        branch_id=metadata.branch_id,
        kind=metadata.kind,
        operation_id=metadata.operation_id,
        version=metadata.version,
        producer=metadata.producer,
        consumer_scope=metadata.consumer_scope,
        media_type=metadata.media_type,
        parent_ref=metadata.parent_ref,
        upstream_refs=metadata.upstream_refs,
    )
    artifact_store.validate(
        ref,
        expected_run_id=metadata.run_id,
        expected_phase=metadata.phase,
        expected_branch_id=metadata.branch_id,
        expected_producer=metadata.producer,
    )
    return ref


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m orchestration.artifact_cli")
    subcommands = parser.add_subparsers(dest="command", required=True)
    put = subcommands.add_parser("put", help="persist exact stdin bytes")
    put.add_argument("--metadata-json", required=True)
    return parser


def _emit_error(exc: BaseException) -> None:
    # Error output is deliberately content-free: no stdin bytes or excerpts.
    payload = {
        "error": type(exc).__name__,
        "message": str(exc),
    }
    sys.stderr.buffer.write(canonical_json(payload) + b"\n")


def main(argv: list[str] | None = None) -> int:
    """Run the artifact CLI; successful stdout is exactly one canonical ref."""
    args = _parser().parse_args(argv)
    if args.command != "put":  # pragma: no cover - argparse enforces this branch
        raise AssertionError("unsupported artifact command")
    try:
        metadata = parse_metadata_json(args.metadata_json)
        content = sys.stdin.buffer.read()
        ref = put_output_artifact(metadata, content)
    except (ArtifactError, OSError, ValueError) as exc:
        _emit_error(exc)
        return 1
    except Exception as exc:  # fail closed without leaking input on unexpected faults
        _emit_error(RuntimeError(f"unexpected artifact persistence failure: {type(exc).__name__}"))
        return 1

    sys.stdout.buffer.write(canonical_json(ref.to_dict()) + b"\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
