from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from orchestration.artifact_cli import MAX_METADATA_BYTES
from orchestration.artifacts import ArtifactRef, ArtifactStore, canonical_json


def _metadata(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "schema_version": 1,
        "run_id": "run-cli-1",
        "phase": "observing",
        "branch_id": None,
        "kind": "agent-output",
        "operation_id": "observe-output-v1",
        "version": 1,
        "producer": "agent:echo",
        "consumer_scope": ["state:synthesizing"],
        "media_type": "application/octet-stream",
        "parent_ref": None,
        "upstream_refs": [],
    }
    value.update(overrides)
    return value


def _run_put(
    metadata: dict[str, object],
    content: bytes,
    *,
    artifact_root: Path | None = None,
    xdg_state_home: Path | None = None,
) -> subprocess.CompletedProcess[bytes]:
    env = dict(os.environ)
    if artifact_root is not None:
        env["PENNY_ARTIFACT_ROOT"] = str(artifact_root)
    else:
        env.pop("PENNY_ARTIFACT_ROOT", None)
    if xdg_state_home is not None:
        env["XDG_STATE_HOME"] = str(xdg_state_home)
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "orchestration.artifact_cli",
            "put",
            "--metadata-json",
            json.dumps(metadata, ensure_ascii=False, separators=(",", ":")),
        ],
        input=content,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        check=False,
    )


def _stdout_ref(result: subprocess.CompletedProcess[bytes]) -> ArtifactRef:
    assert result.returncode == 0, result.stderr.decode("utf-8", errors="replace")
    assert result.stderr == b""
    parsed: Any = json.loads(result.stdout)
    ref = ArtifactRef.from_dict(parsed)
    assert result.stdout == canonical_json(ref.to_dict()) + b"\n"
    return ref


def test_put_persists_exact_stdin_bytes_and_prints_only_canonical_ref(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    content = b'prefix\x00\xff\r\nmultibyte:\xe2\x98\x83\nSUMMARY:{"ok":true}\n'

    result = _run_put(_metadata(), content, artifact_root=root)
    ref = _stdout_ref(result)

    store = ArtifactStore(root)
    assert store.read_bytes(ref, expected_run_id="run-cli-1") == content
    assert ref.byte_length == len(content)
    assert ref.operation_id == "observe-output-v1"
    assert ref.version == 1


def test_put_uses_xdg_default_when_explicit_root_is_absent(tmp_path: Path) -> None:
    xdg_state_home = tmp_path / "state"
    result = _run_put(_metadata(run_id="run-xdg"), b"exact", xdg_state_home=xdg_state_home)
    ref = _stdout_ref(result)

    expected_root = xdg_state_home / "penny" / "artifacts"
    store = ArtifactStore(expected_root)
    assert store.read_bytes(ref, expected_run_id="run-xdg") == b"exact"


def test_put_is_idempotent_and_divergent_retry_fails_without_stdout(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    metadata = _metadata()

    first = _run_put(metadata, b"same bytes", artifact_root=root)
    second = _run_put(metadata, b"same bytes", artifact_root=root)
    assert _stdout_ref(first) == _stdout_ref(second)

    divergent = _run_put(metadata, b"different bytes", artifact_root=root)
    assert divergent.returncode == 1
    assert divergent.stdout == b""
    error = json.loads(divergent.stderr)
    assert error["error"] == "ArtifactDivergenceError"
    assert b"different bytes" not in divergent.stderr


def test_put_rejects_missing_unknown_duplicate_and_oversized_metadata(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    cases = []

    missing = _metadata()
    missing.pop("operation_id")
    cases.append(json.dumps(missing, separators=(",", ":")))

    unknown = _metadata(unexpected=True)
    cases.append(json.dumps(unknown, separators=(",", ":")))

    duplicate = json.dumps(_metadata(), separators=(",", ":"))[:-1] + ',"run_id":"other"}'
    cases.append(duplicate)

    oversized = json.dumps(_metadata(operation_id="x" * MAX_METADATA_BYTES), separators=(",", ":"))
    cases.append(oversized)

    for raw in cases:
        env = {**os.environ, "PENNY_ARTIFACT_ROOT": str(root)}
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "orchestration.artifact_cli",
                "put",
                "--metadata-json",
                raw,
            ],
            input=b"private output must never appear in errors",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            check=False,
        )
        assert result.returncode == 1
        assert result.stdout == b""
        assert b"private output" not in result.stderr
        assert json.loads(result.stderr)["error"] in {
            "ArtifactCliInputError",
            "ArtifactValidationError",
        }
