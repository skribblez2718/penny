"""Immutable full-eval comparator and selected release manifest tests."""

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3]
CHECKER = ROOT / "scripts/system/checks/check_code_p0_release.py"
MANIFEST = ROOT / "scripts/system/checks/code_p0_verification_manifest.json"


def _module():
    spec = importlib.util.spec_from_file_location("test_code_p0_release_module", CHECKER)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _baseline(results, tmp_path):
    raw_output = tmp_path / "baseline.raw.json"
    raw_output.write_bytes(b'{"exit_status":0,"stderr":"","stdout":"pass"}')
    raw_output.chmod(0o600)
    worktree_records = []
    worktree_canonical = json.dumps(
        worktree_records, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    value = {
        "schema_version": 2,
        "immutable": True,
        "captured_at": "2026-08-02T00:00:00+00:00",
        "command_argv": ["native-full-evals", "--json"],
        "working_directory": str(ROOT),
        "source_identity": {
            "head": "test-head",
            "worktree_digest": hashlib.sha256(worktree_canonical).hexdigest(),
            "worktree_records": worktree_records,
        },
        "selected_inputs": _module()._selected_release_inputs(),
        "normalized_outcomes": {"results": results},
        "comparator": {"id": "p0-full-eval-v1", "frozen": True},
        "raw_output_ref": str(raw_output),
        "raw_output_digest": hashlib.sha256(raw_output.read_bytes()).hexdigest(),
    }
    canonical = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    value["digest"] = hashlib.sha256(canonical).hexdigest()
    return value


def test_selected_release_manifest_maps_all_criteria_and_six_dimensions():
    manifest = json.loads(MANIFEST.read_text())
    assert manifest["version"] == 4
    assert _module().validate_verification_manifest(manifest) == []
    required_checks = {
        "skill-e2e",
        "questionnaire-e2e",
        "root-integration-failure-propagation",
        "python-format",
        "python-lint",
        "python-typecheck",
    }
    assert required_checks <= set(manifest["checks"])
    assert {"skill-e2e", "questionnaire-e2e"} <= set(manifest["criterion_map"]["criterion:7"])
    assert manifest["evidence_class_map"]["quality:harmful_duplication_avoidance"] == (
        "judgment-only"
    )
    assert manifest["evidence_class_map"]["quality:unnecessary_complexity_avoidance"] == (
        "judgment-only"
    )
    for path in ("contracts.py", "independence.py", "playbooks/code_detection.py"):
        assert any(argument.endswith(path) for argument in manifest["checks"]["python-format"])
        assert any(argument.endswith(path) for argument in manifest["checks"]["python-typecheck"])


def test_root_integration_aggregate_propagates_a_child_failure(tmp_path):
    root_package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    aggregate = root_package["scripts"]["test:integration"]
    marker = tmp_path / "second-child-ran"
    extension_root = tmp_path / ".pi" / "extensions"
    failing = extension_root / "a-failing"
    later = extension_root / "b-later"
    failing.mkdir(parents=True)
    later.mkdir(parents=True)
    (tmp_path / "package.json").write_text(
        json.dumps({"scripts": {"test:integration": aggregate}}), encoding="utf-8"
    )
    (failing / "package.json").write_text(
        json.dumps({"scripts": {"test:integration": "node -e 'process.exit(7)'"}}),
        encoding="utf-8",
    )
    (later / "package.json").write_text(
        json.dumps(
            {
                "scripts": {
                    "test:integration": (
                        "node -e \"require('node:fs').writeFileSync("
                        + repr(str(marker))
                        + ", 'ran')\""
                    )
                }
            }
        ),
        encoding="utf-8",
    )

    process = subprocess.run(
        ["bun", "run", "test:integration"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        shell=False,
        timeout=30,
    )

    assert process.returncode != 0, process.stdout + process.stderr
    assert not marker.exists(), "aggregate continued after a failing child"


def test_full_eval_allows_unchanged_known_failure_and_improvement(tmp_path):
    baseline = _baseline(
        [
            {"name": "pass", "status": "PASS", "value": 1.0, "direction": "up_good"},
            {
                "name": "passing-age",
                "status": "PASS",
                "value": 1.0,
                "direction": "down_good",
            },
            {"name": "known", "status": "FAIL", "value": 2.0, "direction": "down_good"},
        ],
        tmp_path,
    )
    candidate = {
        "results": [
            {"name": "pass", "status": "PASS", "value": 1.1, "direction": "up_good"},
            {
                "name": "passing-age",
                "status": "PASS",
                "value": 2.0,
                "direction": "down_good",
            },
            {"name": "known", "status": "FAIL", "value": 2.0, "direction": "down_good"},
        ]
    }
    assert _module().verify_immutable_baseline(baseline) == []
    assert _module().compare_full_evals(baseline, candidate) == []


def test_full_eval_rejects_new_worsened_missing_skipped_error_and_timeout(tmp_path):
    baseline = _baseline(
        [
            {"name": "lost-pass", "status": "PASS", "value": 1.0, "direction": "up_good"},
            {"name": "worse-count", "status": "FAIL", "value": 2.0, "direction": "down_good"},
            {"name": "missing", "status": "PASS", "value": None, "direction": ""},
            {"name": "skip", "status": "FAIL", "value": None, "direction": ""},
            {"name": "error", "status": "FAIL", "value": None, "direction": ""},
            {"name": "timeout", "status": "FAIL", "value": None, "direction": ""},
        ],
        tmp_path,
    )
    candidate = {
        "results": [
            {"name": "lost-pass", "status": "FAIL", "value": 1.0, "direction": "up_good"},
            {"name": "worse-count", "status": "FAIL", "value": 3.0, "direction": "down_good"},
            {"name": "skip", "status": "SKIP", "value": None, "direction": ""},
            {"name": "error", "status": "ERROR", "value": None, "direction": ""},
            {"name": "timeout", "status": "TIMEOUT", "value": None, "direction": ""},
            {"name": "new-failure", "status": "FAIL", "value": None, "direction": ""},
        ]
    }
    errors = _module().compare_full_evals(baseline, candidate)
    for name in (
        "lost-pass",
        "worse-count",
        "missing",
        "skip",
        "error",
        "timeout",
        "new-failure",
    ):
        assert any(name in error for error in errors)


def test_candidate_capture_keeps_stdout_machine_readable(monkeypatch, capsys):
    module = _module()
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(
            stdout=json.dumps({"results": [{"name": "eval", "status": "PASS"}]}),
            stderr="",
            returncode=0,
        ),
    )

    assert module.capture_full_evals() == 0
    captured = capsys.readouterr()
    assert json.loads(captured.out)["results"][0]["status"] == "PASS"
    assert "CAPTURED: 1 full-eval entries" in captured.err


def test_baseline_capture_rejects_output_inside_project_tree(capsys):
    assert _module().capture_immutable_baseline(ROOT / "forbidden-baseline.json") == 1
    assert "outside the project tree" in capsys.readouterr().out


def test_baseline_capture_writes_private_digest_bound_artifacts(tmp_path, monkeypatch):
    module = _module()
    records = [
        {
            "path": "dirty.txt",
            "index_status": " ",
            "worktree_status": "M",
            "exists": True,
            "mode": "0644",
            "sha256": "a" * 64,
            "index_blob": "b" * 40,
        }
    ]
    identity = {
        "head": "test-head",
        "worktree_digest": hashlib.sha256(
            json.dumps(records, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest(),
        "worktree_records": records,
    }
    monkeypatch.setattr(module, "capture_source_identity", lambda _root: identity)
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(
            stdout=json.dumps({"results": [{"name": "eval", "status": "PASS"}]}),
            stderr="diagnostic",
            returncode=0,
        ),
    )
    output = tmp_path / "baseline.json"

    assert module.capture_immutable_baseline(output) == 0
    baseline = json.loads(output.read_text())
    raw_output = Path(baseline["raw_output_ref"])
    assert module.verify_immutable_baseline(baseline) == []
    assert output.stat().st_mode & 0o077 == 0
    assert raw_output.stat().st_mode & 0o077 == 0
    assert baseline["raw_output_digest"] == hashlib.sha256(raw_output.read_bytes()).hexdigest()
    assert baseline["schema_version"] == 2
    assert baseline["selected_inputs"] == module._selected_release_inputs()


def test_release_rejects_selected_manifest_identity_version_or_digest_drift(tmp_path):
    module = _module()
    baseline = _baseline([{"name": "a", "status": "PASS"}], tmp_path)
    baseline["selected_inputs"]["verification_manifest"]["digest"] = "0" * 64
    unsigned = {key: value for key, value in baseline.items() if key != "digest"}
    baseline["digest"] = hashlib.sha256(
        json.dumps(unsigned, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()

    errors = module.compare_selected_release_inputs(baseline)
    assert errors == ["selected verification_manifest identity/version/digest changed"]


def test_release_cli_fails_closed_without_all_external_evidence_paths():
    env = {
        key: value
        for key, value in os.environ.items()
        if key
        not in {
            "PENNY_P0_BASELINE",
            "PENNY_P0_CANDIDATE_EVALS",
            "PENNY_P0_PRESERVATION",
        }
    }
    process = subprocess.run(
        [sys.executable, str(CHECKER)],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert process.returncode == 1
    assert "baseline, candidate eval, and preservation artifact paths are all required" in (
        process.stdout + process.stderr
    )


def test_baseline_digest_cannot_be_rebased_silently(tmp_path):
    baseline = _baseline([{"name": "a", "status": "PASS"}], tmp_path)
    baseline["normalized_outcomes"]["results"][0]["status"] = "FAIL"
    assert _module().verify_immutable_baseline(baseline) == [
        "eval baseline identity/digest changed"
    ]
