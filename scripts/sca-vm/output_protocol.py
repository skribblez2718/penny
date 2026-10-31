#!/usr/bin/env python3
"""Bounded raw-block result protocol for the standalone SCA guest."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import struct
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Mapping, Sequence, TypeGuard

MAGIC = b"PENNYO01"
HEADER_BYTES = 64 * 1024
ALIGNMENT = 4096
MAX_OUTPUT_DISK_BYTES = 384 * 1024 * 1024
MAX_OUTPUTS = 16
MAX_NAME_BYTES = 128
MAX_MEDIA_TYPE_BYTES = 256
MAX_SCHEMA_ID_BYTES = 128
DIGEST_LENGTH = 64
OUTPUT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class OutputProtocolError(ValueError):
    """The raw output envelope failed its closed protocol contract."""


@dataclass(frozen=True)
class OutputPayload:
    """One named immutable output supplied to the guest-side writer."""

    name: str
    media_type: str
    schema_id: str | None
    content: bytes


@dataclass(frozen=True)
class OutputDescriptor:
    """One validated output location in the raw device."""

    name: str
    media_type: str
    schema_id: str | None
    offset: int
    byte_length: int
    sha256: str


@dataclass(frozen=True)
class OutputEnvelope:
    """Validated manifest plus exact output bytes."""

    job_sha256: str
    status: Literal["succeeded", "failed"]
    error_code: str | None
    outputs: tuple[tuple[OutputDescriptor, bytes], ...]


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _is_sha256(value: object) -> TypeGuard[str]:
    return (
        isinstance(value, str)
        and len(value) == DIGEST_LENGTH
        and all(character in "0123456789abcdef" for character in value)
    )


def _utf8_length(value: str) -> int:
    return len(value.encode("utf-8"))


def _validate_token(value: str, label: str, maximum: int) -> None:
    if (
        not value
        or _utf8_length(value) > maximum
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)
    ):
        raise OutputProtocolError(f"invalid {label}")


def _validate_output_name(value: str) -> None:
    if not OUTPUT_NAME.fullmatch(value):
        raise OutputProtocolError("invalid output name")


def _align(value: int) -> int:
    return (value + ALIGNMENT - 1) // ALIGNMENT * ALIGNMENT


def _canonical_json(value: Mapping[str, object]) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _exact_keys(value: Mapping[str, object], expected: set[str], label: str) -> None:
    if set(value) != expected:
        raise OutputProtocolError(f"invalid {label} fields")


def _record(value: object, label: str) -> Mapping[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise OutputProtocolError(f"invalid {label}")
    return value


def _integer(value: object, label: str, minimum: int, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum or value > maximum:
        raise OutputProtocolError(f"invalid {label}")
    return value


def _string(value: object, label: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise OutputProtocolError(f"invalid {label}")
    _validate_token(value, label, maximum)
    return value


def _regular_output_file(path: Path, *, writable: bool) -> tuple[int, int]:
    flags = os.O_CLOEXEC | os.O_NOFOLLOW | (os.O_RDWR if writable else os.O_RDONLY)
    descriptor = os.open(path, flags)
    try:
        details = os.fstat(descriptor)
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_nlink != 1
            or details.st_size < HEADER_BYTES
            or details.st_size > MAX_OUTPUT_DISK_BYTES
            or details.st_size % 512 != 0
            or details.st_mode & 0o077
            or (hasattr(os, "geteuid") and details.st_uid != os.geteuid())
        ):
            raise OutputProtocolError("invalid output disk")
        return descriptor, details.st_size
    except BaseException:
        os.close(descriptor)
        raise


def _open_device(path: Path, *, writable: bool) -> tuple[int, int]:
    flags = os.O_CLOEXEC | os.O_NOFOLLOW | (os.O_RDWR if writable else os.O_RDONLY)
    descriptor = os.open(path, flags)
    try:
        details = os.fstat(descriptor)
        if stat.S_ISREG(details.st_mode):
            os.close(descriptor)
            return _regular_output_file(path, writable=writable)
        if not stat.S_ISBLK(details.st_mode):
            raise OutputProtocolError("output destination is not a regular file or block device")
        size = os.lseek(descriptor, 0, os.SEEK_END)
        os.lseek(descriptor, 0, os.SEEK_SET)
        if size < HEADER_BYTES or size > MAX_OUTPUT_DISK_BYTES or size % 512 != 0:
            raise OutputProtocolError("invalid output device size")
        return descriptor, size
    except BaseException:
        os.close(descriptor)
        raise


def _write_all(descriptor: int, content: bytes, offset: int) -> None:
    written = 0
    while written < len(content):
        count = os.pwrite(descriptor, content[written:], offset + written)
        if count <= 0:
            raise OutputProtocolError("output write did not advance")
        written += count


def _read_exact(descriptor: int, byte_length: int, offset: int) -> bytes:
    chunks: list[bytes] = []
    remaining = byte_length
    cursor = offset
    while remaining:
        chunk = os.pread(descriptor, min(1024 * 1024, remaining), cursor)
        if not chunk:
            raise OutputProtocolError("output read ended early")
        chunks.append(chunk)
        cursor += len(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _validate_status(status: Literal["succeeded", "failed"], error_code: str | None) -> None:
    if status not in ("succeeded", "failed"):
        raise OutputProtocolError("invalid output status")
    if (status == "succeeded") != (error_code is None):
        raise OutputProtocolError("status and error code disagree")
    if error_code is not None:
        _validate_token(error_code, "error code", 128)


def _plan_outputs(outputs: Sequence[OutputPayload]) -> tuple[tuple[OutputDescriptor, ...], int]:
    names: set[str] = set()
    cursor = HEADER_BYTES
    descriptors: list[OutputDescriptor] = []
    for payload in outputs:
        _validate_token(payload.name, "output name", MAX_NAME_BYTES)
        _validate_output_name(payload.name)
        _validate_token(payload.media_type, "media type", MAX_MEDIA_TYPE_BYTES)
        if payload.schema_id is not None:
            _validate_token(payload.schema_id, "schema ID", MAX_SCHEMA_ID_BYTES)
        if payload.name in names or not payload.content:
            raise OutputProtocolError("duplicate or empty output")
        names.add(payload.name)
        cursor = _align(cursor)
        descriptors.append(
            OutputDescriptor(
                name=payload.name,
                media_type=payload.media_type,
                schema_id=payload.schema_id,
                offset=cursor,
                byte_length=len(payload.content),
                sha256=_sha256(payload.content),
            )
        )
        cursor += len(payload.content)
    return tuple(descriptors), cursor


def _header_bytes(
    job_sha256: str,
    status: Literal["succeeded", "failed"],
    error_code: str | None,
    descriptors: Sequence[OutputDescriptor],
) -> bytes:
    manifest: dict[str, object] = {
        "error_code": error_code,
        "job_sha256": job_sha256,
        "outputs": [
            {
                "byte_length": output.byte_length,
                "media_type": output.media_type,
                "name": output.name,
                "offset": output.offset,
                "schema_id": output.schema_id,
                "sha256": output.sha256,
            }
            for output in descriptors
        ],
        "schema_id": "penny.sca-vm-output.v1",
        "schema_version": 1,
        "status": status,
    }
    encoded = _canonical_json(manifest)
    if len(encoded) > HEADER_BYTES - len(MAGIC) - 8:
        raise OutputProtocolError("output manifest exceeds header")
    header = MAGIC + struct.pack(">Q", len(encoded)) + encoded
    return header + bytes(HEADER_BYTES - len(header))


def write_envelope(
    destination: Path,
    *,
    job_sha256: str,
    status: Literal["succeeded", "failed"],
    error_code: str | None,
    outputs: Sequence[OutputPayload],
) -> tuple[OutputDescriptor, ...]:
    """Write one complete envelope to an owner-private file or a guest block device."""

    if not _is_sha256(job_sha256):
        raise OutputProtocolError("invalid job SHA256")
    _validate_status(status, error_code)
    if len(outputs) > MAX_OUTPUTS or (status == "succeeded" and not outputs):
        raise OutputProtocolError("invalid output count")
    descriptors, final_offset = _plan_outputs(outputs)
    descriptor, disk_size = _open_device(destination, writable=True)
    try:
        if final_offset > disk_size:
            raise OutputProtocolError("outputs exceed output device")
        _write_all(descriptor, _header_bytes(job_sha256, status, error_code, descriptors), 0)
        for payload, output in zip(outputs, descriptors, strict=True):
            _write_all(descriptor, payload.content, output.offset)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return descriptors


def _manifest_from_header(header: bytes) -> Mapping[str, object]:
    if header[: len(MAGIC)] != MAGIC:
        raise OutputProtocolError("output magic missing")
    manifest_length = struct.unpack(">Q", header[len(MAGIC) : len(MAGIC) + 8])[0]
    if not 1 <= manifest_length <= HEADER_BYTES - len(MAGIC) - 8:
        raise OutputProtocolError("invalid output manifest length")
    manifest_end = len(MAGIC) + 8 + manifest_length
    manifest_bytes = header[len(MAGIC) + 8 : manifest_end]
    if any(header[manifest_end:]):
        raise OutputProtocolError("nonzero output header padding")
    try:
        value: object = json.loads(manifest_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise OutputProtocolError("invalid output manifest JSON") from exc
    manifest = _record(value, "output manifest")
    _exact_keys(
        manifest,
        {"error_code", "job_sha256", "outputs", "schema_id", "schema_version", "status"},
        "output manifest",
    )
    if _canonical_json(manifest) != manifest_bytes:
        raise OutputProtocolError("output manifest is not canonical JSON")
    return manifest


def _manifest_status(
    manifest: Mapping[str, object], expected_job_sha256: str
) -> tuple[Literal["succeeded", "failed"], str | None]:
    if (
        manifest["schema_id"] != "penny.sca-vm-output.v1"
        or manifest["schema_version"] != 1
        or manifest["job_sha256"] != expected_job_sha256
    ):
        raise OutputProtocolError("output manifest identity mismatch")
    status_value = manifest["status"]
    if status_value not in ("succeeded", "failed"):
        raise OutputProtocolError("invalid output status")
    status: Literal["succeeded", "failed"] = status_value
    error_value = manifest["error_code"]
    if error_value is not None and not isinstance(error_value, str):
        raise OutputProtocolError("invalid output error code")
    _validate_status(status, error_value)
    return status, error_value


def _manifest_outputs(
    manifest: Mapping[str, object],
    status: Literal["succeeded", "failed"],
    max_result_items: int,
) -> tuple[Mapping[str, object], ...]:
    raw_outputs = manifest["outputs"]
    if not isinstance(raw_outputs, list) or len(raw_outputs) > max_result_items:
        raise OutputProtocolError("output count exceeds limit")
    if status == "succeeded" and not raw_outputs:
        raise OutputProtocolError("successful output is empty")
    return tuple(_record(output, f"output {index}") for index, output in enumerate(raw_outputs))


def _decode_manifest(
    header: bytes, expected_job_sha256: str, max_result_items: int
) -> tuple[Literal["succeeded", "failed"], str | None, tuple[Mapping[str, object], ...]]:
    manifest = _manifest_from_header(header)
    status, error_code = _manifest_status(manifest, expected_job_sha256)
    return status, error_code, _manifest_outputs(manifest, status, max_result_items)


def _output_descriptor(
    output: Mapping[str, object], index: int, disk_size: int, max_output_bytes: int
) -> OutputDescriptor:
    _exact_keys(
        output,
        {"byte_length", "media_type", "name", "offset", "schema_id", "sha256"},
        f"output {index}",
    )
    schema_value = output["schema_id"]
    if schema_value is not None and not isinstance(schema_value, str):
        raise OutputProtocolError("invalid schema ID")
    if schema_value is not None:
        _validate_token(schema_value, "schema ID", MAX_SCHEMA_ID_BYTES)
    digest_value = output["sha256"]
    if not _is_sha256(digest_value):
        raise OutputProtocolError("invalid output SHA256")
    name = _string(output["name"], "output name", MAX_NAME_BYTES)
    _validate_output_name(name)
    return OutputDescriptor(
        name=name,
        media_type=_string(output["media_type"], "media type", MAX_MEDIA_TYPE_BYTES),
        schema_id=schema_value,
        offset=_integer(output["offset"], "output offset", HEADER_BYTES, disk_size),
        byte_length=_integer(output["byte_length"], "output byte length", 1, max_output_bytes),
        sha256=digest_value,
    )


def _assert_new_range(
    output: OutputDescriptor,
    names: set[str],
    ranges: list[tuple[int, int]],
    disk_size: int,
) -> None:
    if (
        output.name in names
        or output.offset % ALIGNMENT != 0
        or output.offset + output.byte_length > disk_size
    ):
        raise OutputProtocolError("invalid output range")
    current_range = (output.offset, output.offset + output.byte_length)
    if any(current_range[0] < end and start < current_range[1] for start, end in ranges):
        raise OutputProtocolError("overlapping output ranges")
    names.add(output.name)
    ranges.append(current_range)


def read_envelope(
    source: Path,
    *,
    expected_job_sha256: str,
    max_output_bytes: int,
    max_result_items: int,
) -> OutputEnvelope:
    """Read and validate one complete host-side output envelope."""

    if not _is_sha256(expected_job_sha256):
        raise OutputProtocolError("invalid expected job SHA256")
    if not 1 <= max_output_bytes <= MAX_OUTPUT_DISK_BYTES:
        raise OutputProtocolError("invalid output byte limit")
    if not 1 <= max_result_items <= MAX_OUTPUTS:
        raise OutputProtocolError("invalid output item limit")

    descriptor, disk_size = _regular_output_file(source, writable=False)
    try:
        status, error_value, output_values = _decode_manifest(
            _read_exact(descriptor, HEADER_BYTES, 0), expected_job_sha256, max_result_items
        )
        results: list[tuple[OutputDescriptor, bytes]] = []
        names: set[str] = set()
        ranges: list[tuple[int, int]] = []
        total_bytes = 0
        for index, output_value in enumerate(output_values):
            output = _output_descriptor(output_value, index, disk_size, max_output_bytes)
            _assert_new_range(output, names, ranges, disk_size)
            total_bytes += output.byte_length
            if total_bytes > max_output_bytes:
                raise OutputProtocolError("aggregate output exceeds limit")
            content = _read_exact(descriptor, output.byte_length, output.offset)
            if _sha256(content) != output.sha256:
                raise OutputProtocolError("output digest mismatch")
            results.append((output, content))
    finally:
        os.close(descriptor)
    return OutputEnvelope(
        job_sha256=expected_job_sha256,
        status=status,
        error_code=error_value,
        outputs=tuple(results),
    )


def _write_cli(args: argparse.Namespace) -> int:
    source = Path(args.payload)
    content = source.read_bytes()
    write_envelope(
        Path(args.destination),
        job_sha256=args.job_sha256,
        status="succeeded",
        error_code=None,
        outputs=[
            OutputPayload(
                name=args.name,
                media_type=args.media_type,
                schema_id=args.schema_id,
                content=content,
            )
        ],
    )
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    subparsers = result.add_subparsers(dest="command", required=True)
    write = subparsers.add_parser("write", help="write one successful payload")
    write.add_argument("--destination", required=True)
    write.add_argument("--job-sha256", required=True)
    write.add_argument("--name", required=True)
    write.add_argument("--media-type", required=True)
    write.add_argument("--schema-id")
    write.add_argument("--payload", required=True)
    return result


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "write":
            return _write_cli(args)
        raise OutputProtocolError("unsupported command")
    except (OSError, OutputProtocolError):
        print("SCA VM output protocol failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
