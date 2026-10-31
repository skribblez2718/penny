"""Bounded tests for the raw SCA guest output protocol."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import stat
import struct
import sys
from pathlib import Path
from types import ModuleType

import pytest

SOURCE = Path(__file__).resolve().parents[1] / "output_protocol.py"
SPEC = importlib.util.spec_from_file_location("output_protocol", SOURCE)
assert SPEC and SPEC.loader
protocol = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = protocol
SPEC.loader.exec_module(protocol)


def module() -> ModuleType:
    return protocol


def zero_disk(path: Path, size: int = 2 * 1024 * 1024) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.ftruncate(descriptor, size)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def job_digest() -> str:
    return hashlib.sha256(b"job").hexdigest()


def test_round_trip_multiple_outputs(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    disk = tmp_path / "output.raw"
    zero_disk(disk)
    outputs = [
        protocol.OutputPayload(
            name="result.json",
            media_type="application/json",
            schema_id="penny.sca-source-query-result.v1",
            content=b'{"complete":true}\n',
        ),
        protocol.OutputPayload(
            name="evidence.txt",
            media_type="text/plain",
            schema_id=None,
            content=b"bounded evidence\n",
        ),
    ]
    descriptors = protocol.write_envelope(
        disk,
        job_sha256=job_digest(),
        status="succeeded",
        error_code=None,
        outputs=outputs,
    )
    assert len(descriptors) == 2
    assert all(item.offset % protocol.ALIGNMENT == 0 for item in descriptors)
    result = protocol.read_envelope(
        disk,
        expected_job_sha256=job_digest(),
        max_output_bytes=1024,
        max_result_items=2,
    )
    assert result.status == "succeeded"
    assert result.error_code is None
    assert [item[0].name for item in result.outputs] == ["result.json", "evidence.txt"]
    assert [item[1] for item in result.outputs] == [output.content for output in outputs]
    assert stat.S_IMODE(disk.stat().st_mode) == 0o600


def test_failure_envelope_has_no_outputs(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    disk = tmp_path / "output.raw"
    zero_disk(disk)
    protocol.write_envelope(
        disk,
        job_sha256=job_digest(),
        status="failed",
        error_code="guest_job_failed",
        outputs=[],
    )
    result = protocol.read_envelope(
        disk,
        expected_job_sha256=job_digest(),
        max_output_bytes=1024,
        max_result_items=1,
    )
    assert result.status == "failed"
    assert result.error_code == "guest_job_failed"
    assert result.outputs == ()


def tamper_fixture(tmp_path: Path) -> tuple[Path, bytearray, object, int]:
    tmp_path.chmod(0o700)
    disk = tmp_path / "output.raw"
    zero_disk(disk)
    protocol.write_envelope(
        disk,
        job_sha256=job_digest(),
        status="succeeded",
        error_code=None,
        outputs=[
            protocol.OutputPayload(
                name="result.json",
                media_type="application/json",
                schema_id="penny.test.v1",
                content=b"{}",
            )
        ],
    )
    data = bytearray(disk.read_bytes())
    manifest_length = struct.unpack(">Q", data[len(protocol.MAGIC) : len(protocol.MAGIC) + 8])[0]
    start = len(protocol.MAGIC) + 8
    return disk, data, json.loads(data[start : start + manifest_length]), start


def replace_manifest(data: bytearray, start: int, manifest: object, *, canonical: bool) -> None:
    encoded = (
        json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        if canonical
        else json.dumps(manifest, indent=1).encode()
    )
    data[len(protocol.MAGIC) : start] = struct.pack(">Q", len(encoded))
    data[start : protocol.HEADER_BYTES] = encoded + bytes(
        protocol.HEADER_BYTES - start - len(encoded)
    )


def assert_rejected(disk: Path, data: bytearray) -> None:
    disk.write_bytes(data)
    with pytest.raises(protocol.OutputProtocolError):
        protocol.read_envelope(
            disk,
            expected_job_sha256=job_digest(),
            max_output_bytes=1024,
            max_result_items=2,
        )


@pytest.mark.parametrize("mutation", ["magic", "payload", "padding", "noncanonical"])
def test_raw_tampering_fails_closed(tmp_path: Path, mutation: str) -> None:
    disk, data, manifest, start = tamper_fixture(tmp_path)
    if mutation == "magic":
        data[0] ^= 1
    elif mutation == "payload":
        data[protocol.HEADER_BYTES] ^= 1
    elif mutation == "padding":
        data[protocol.HEADER_BYTES - 1] = 1
    else:
        replace_manifest(data, start, manifest, canonical=False)
    assert_rejected(disk, data)


@pytest.mark.parametrize(
    "mutation", ["job", "overlap", "range", "duplicate", "output_name", "extra_field"]
)
def test_manifest_tampering_fails_closed(tmp_path: Path, mutation: str) -> None:
    disk, data, manifest, start = tamper_fixture(tmp_path)
    assert isinstance(manifest, dict)
    if mutation == "job":
        manifest["job_sha256"] = "0" * 64
    elif mutation == "overlap":
        manifest["outputs"].append(dict(manifest["outputs"][0], name="second"))
    elif mutation == "range":
        manifest["outputs"][0]["offset"] = len(data)
    elif mutation == "duplicate":
        manifest["outputs"].append(dict(manifest["outputs"][0]))
    elif mutation == "output_name":
        manifest["outputs"][0]["name"] = "../escape"
    else:
        manifest["unexpected"] = True
    replace_manifest(data, start, manifest, canonical=True)
    assert_rejected(disk, data)


def test_writer_rejects_bounds_and_unsafe_metadata(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    disk = tmp_path / "output.raw"
    zero_disk(disk, protocol.HEADER_BYTES)
    for unsafe_name in ("bad\nname", "../escape", "/absolute", "nested/name"):
        with pytest.raises(protocol.OutputProtocolError):
            protocol.write_envelope(
                disk,
                job_sha256=job_digest(),
                status="succeeded",
                error_code=None,
                outputs=[
                    protocol.OutputPayload(
                        name=unsafe_name,
                        media_type="text/plain",
                        schema_id=None,
                        content=b"x",
                    )
                ],
            )
    with pytest.raises(protocol.OutputProtocolError):
        protocol.write_envelope(
            disk,
            job_sha256=job_digest(),
            status="succeeded",
            error_code=None,
            outputs=[
                protocol.OutputPayload(
                    name="large",
                    media_type="application/octet-stream",
                    schema_id=None,
                    content=b"x" * protocol.ALIGNMENT,
                )
            ],
        )


def test_reader_rejects_permissions_and_wrong_job(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    disk = tmp_path / "output.raw"
    zero_disk(disk)
    protocol.write_envelope(
        disk,
        job_sha256=job_digest(),
        status="succeeded",
        error_code=None,
        outputs=[
            protocol.OutputPayload(
                name="result",
                media_type="text/plain",
                schema_id=None,
                content=b"ok",
            )
        ],
    )
    with pytest.raises(protocol.OutputProtocolError):
        protocol.read_envelope(
            disk,
            expected_job_sha256="0" * 64,
            max_output_bytes=1024,
            max_result_items=1,
        )
    disk.chmod(0o644)
    with pytest.raises(protocol.OutputProtocolError):
        protocol.read_envelope(
            disk,
            expected_job_sha256=job_digest(),
            max_output_bytes=1024,
            max_result_items=1,
        )
