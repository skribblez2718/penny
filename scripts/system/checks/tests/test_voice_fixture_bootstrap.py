"""Bootstrap checkpoints only: no downstream app, engine, socket, or credentials."""

from __future__ import annotations

import builtins
from collections.abc import Callable, Mapping, Sequence
import hashlib
import importlib.util
from io import StringIO
import json
import os
from pathlib import Path
import runpy
import shutil
import stat
import sys
from types import ModuleType, SimpleNamespace

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[4]
FIXTURE = PROJECT_ROOT / "apps/orchestration/tests/fixtures/voice-private-fake-app.py"


class BootstrapComplete(Exception):
    """Stop at the first application import, before any application can execute."""


class ControlFilesStub(ModuleType):
    """Only the two bootstrap exports; no downstream package is loaded."""

    def __init__(self, canonical_script: Path) -> None:
        super().__init__("api.services.voice_control_files")
        self.CANONICAL_SCRIPT = canonical_script

    @staticmethod
    def hash_file(path: str) -> str:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def isolate_imports(
    monkeypatch: pytest.MonkeyPatch, checkpoint: Callable[[str], ModuleType]
) -> None:
    original_import = builtins.__import__

    def guarded_import(
        name: str,
        globals: Mapping[str, object] | None = None,
        locals: Mapping[str, object] | None = None,
        fromlist: Sequence[str] = (),
        level: int = 0,
    ) -> ModuleType:
        if name.partition(".")[0] in {"api", "fastapi", "numpy", "soundfile"}:
            return checkpoint(name)
        return original_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", guarded_import)


def expected_environment(root: Path) -> dict[str, str]:
    return {
        "VOICE_STUDIO_FAKE": "1",
        "VOICE_STUDIO_DB": str(root / "test.sqlite"),
        "VOICE_STUDIO_DATA": str(root / "data"),
        "VOICE_STUDIO_AUDIO_SCRATCH": str(root / "audio"),
        "VOICE_STUDIO_CONTROL_CONFIG": str(root / "control.json"),
    }


@pytest.mark.parametrize("loader", ["importlib", "runpy"])
def test_module_loading_is_inert(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    loader: str,
) -> None:
    def reject_import(name: str) -> ModuleType:
        pytest.fail(f"module loading attempted application import: {name}")

    isolate_imports(monkeypatch, reject_import)
    monkeypatch.chdir(tmp_path)
    # Valid CLI inputs expose accidental execution rather than just an argv error.
    monkeypatch.setattr(sys, "argv", [str(FIXTURE), str(tmp_path), "slow"])
    for name in expected_environment(tmp_path):
        monkeypatch.setenv(name, "synthetic-caller-value")
    before = dict(os.environ)

    if loader == "importlib":
        spec = importlib.util.spec_from_file_location("voice_fixture", FIXTURE)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        main = getattr(module, "main", None)
    else:
        main = runpy.run_path(str(FIXTURE))["main"]

    assert callable(main)
    changed_keys = {
        key for key in before.keys() | os.environ.keys() if before.get(key) != os.environ.get(key)
    }
    assert changed_keys == set()
    assert list(tmp_path.iterdir()) == []
    assert capsys.readouterr() == ("", "")


def load_fixture_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("voice_fixture", FIXTURE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("expires", [False, True])
def test_retained_work_waits_for_release_or_reports_inactivity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, expires: bool
) -> None:
    module = load_fixture_module()
    ticks = iter([0.0, 9.0 if expires else 1.0])
    sleeps: list[float] = []

    def release_after_sleep(seconds: float) -> None:
        assert (tmp_path / "retained").exists()
        sleeps.append(seconds)
        (tmp_path / "release-compute").touch()

    # Patch only this fixture's clock, not pytest's or other modules' time source.
    monkeypatch.setattr(
        module,
        "time",
        SimpleNamespace(monotonic=lambda: next(ticks), sleep=release_after_sleep),
    )
    if expires:
        with pytest.raises(RuntimeError, match="isolated fake release inactivity"):
            module._wait_for_release(tmp_path)
        assert sleeps == []
        assert not (tmp_path / "release-compute").exists()
    else:
        module._wait_for_release(tmp_path)
        assert sleeps == [0.01]
    assert (tmp_path / "retained").exists()


@pytest.mark.parametrize("lines", ["ignored\n stop \nremaining\n", ""])
def test_stop_wait_preserves_stop_frame_and_eof(
    monkeypatch: pytest.MonkeyPatch, lines: str
) -> None:
    module = load_fixture_module()
    stdin = StringIO(lines)
    monkeypatch.setattr(sys, "stdin", stdin)
    module._wait_for_stop()
    assert stdin.read() == ("remaining\n" if lines else "")


@pytest.mark.parametrize("node_available", [True, False])
def test_main_prepares_inputs_before_dependent_imports(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    node_available: bool,
) -> None:
    source = tmp_path / "source"
    (source / "api/services").mkdir(parents=True)
    source_files = [source / "api/z.py", source / "api/services/a.py"]
    for path in source_files:
        path.write_text("# synthetic source only\n", encoding="utf-8")
    canonical_script = source / "canonical.js"
    canonical_script.write_text("// synthetic canonicalizer\n", encoding="utf-8")
    node, python = tmp_path / "node", tmp_path / "python"
    node.write_bytes(b"synthetic node; never executed")
    python.write_bytes(b"synthetic python; never executed")
    root = tmp_path / "runtime"
    root.mkdir()
    control_files = ControlFilesStub(canonical_script)
    checkpoints: list[str] = []

    def pin(path: Path) -> dict[str, str]:
        return {"path": str(path.resolve()), "sha256": control_files.hash_file(str(path))}

    def checkpoint(name: str) -> ModuleType:
        assert {key: os.environ.get(key) for key in expected_environment(root)} == (
            expected_environment(root)
        )
        checkpoints.append(name)
        if name == "api.services.voice_control_files":
            assert list(root.iterdir()) == []
            return control_files
        assert name == "fastapi.testclient", f"unexpected dependent import: {name}"
        assert node_available, "application imported despite missing canonicalizer"
        for model in ("design", "base"):
            assert (root / model / "weights.safetensors").read_text() == "NOT REAL MODEL WEIGHTS"
            assert (root / model / "config.json").read_text() == "{}"
        config_path = root / "control.json"
        assert stat.S_IMODE(config_path.stat().st_mode) == 0o600
        assert json.loads(config_path.read_text()) == {
            "schema_version": 1,
            "backend_binding_id": "fixture-service",
            "observation_path": str(root / "observation.json"),
            "socket_path": str(root / "voice.sock"),
            "lock_path": str(root / "voice.lock"),
            "canonicalizer": pin(node),
            "source_files": [pin(path) for path in sorted(source_files)] + [pin(canonical_script)],
            "runtime_files": [pin(python), pin(node)],
            "model_files": [
                pin(root / model / filename)
                for model in ("design", "base")
                for filename in ("config.json", "weights.safetensors")
            ],
            "voice_design_root": str(root / "design"),
            "base_root": str(root / "base"),
            "lease_idle_ms": 10000,
            "refresh_ms": 100,
        }
        raise BootstrapComplete

    def which(command: str) -> str | None:
        assert command == "node"
        return str(node) if node_available else None

    isolate_imports(monkeypatch, checkpoint)
    monkeypatch.chdir(source)
    monkeypatch.setattr(shutil, "which", which)
    monkeypatch.setattr(sys, "executable", str(python))
    monkeypatch.setattr(sys, "argv", [str(FIXTURE), str(root)])
    for name in expected_environment(root):
        monkeypatch.setenv(name, "synthetic-caller-value")

    if node_available:
        with pytest.raises(BootstrapComplete):
            runpy.run_path(str(FIXTURE), run_name="__main__")
        assert checkpoints == ["api.services.voice_control_files", "fastapi.testclient"]
    else:
        with pytest.raises(RuntimeError, match="installed Node canonicalizer required"):
            runpy.run_path(str(FIXTURE), run_name="__main__")
        assert checkpoints == ["api.services.voice_control_files"]
        assert not (root / "control.json").exists()
    assert capsys.readouterr() == ("", "")
