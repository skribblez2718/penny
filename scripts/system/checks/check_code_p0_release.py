#!/usr/bin/env python3
"""P0 code-skill release acceptance: manifest, eval ratchet, scope, preservation.

The checker is read-only outside explicitly supplied output captures. It never
updates the immutable baseline, edits findings, or mutates out-of-scope paths.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

ROOT = Path(__file__).resolve().parents[3]
CHECKS = Path(__file__).resolve().parent
VERIFICATION_MANIFEST = CHECKS / "code_p0_verification_manifest.json"
SCOPE_MANIFEST = CHECKS / "code_p0_scope_manifest.json"
DRIFT_MATRIX = CHECKS / "code_p0_contract_drift_matrix.json"


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def _sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    if path.is_symlink():
        digest.update(os.fsencode(os.readlink(path)))
        return digest.hexdigest()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def capture_source_identity(root: Path) -> dict[str, Any]:
    """Capture complete dirty/index/path/mode identity against one HEAD."""
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
        shell=False,
    ).stdout.strip()
    status_output = subprocess.run(
        ["git", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"],
        cwd=root,
        check=True,
        capture_output=True,
        shell=False,
    ).stdout
    records: list[dict[str, Any]] = []
    for raw in status_output.split(b"\0"):
        if not raw:
            continue
        relative = raw[3:].decode("utf-8", "surrogateescape")
        status_value = raw[:2].decode("ascii")
        path = root / relative
        exists = path.exists() or path.is_symlink()
        index = subprocess.run(
            ["git", "rev-parse", f":{relative}"],
            cwd=root,
            check=False,
            capture_output=True,
            text=True,
            shell=False,
        )
        records.append(
            {
                "path": relative,
                "index_status": status_value[0],
                "worktree_status": status_value[1],
                "exists": exists,
                "mode": format(stat.S_IMODE(path.lstat().st_mode), "04o") if exists else None,
                "sha256": _sha256_path(path) if exists and not path.is_dir() else None,
                "index_blob": index.stdout.strip() if index.returncode == 0 else None,
            }
        )
    records.sort(key=lambda item: item["path"])
    return {
        "head": head,
        "worktree_digest": hashlib.sha256(_canonical_json(records)).hexdigest(),
        "worktree_records": records,
    }


def _write_new_private_file(path: Path, content: bytes) -> None:
    """Publish a complete owner-only file without replacing an existing baseline."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.link(temporary, path, follow_symlinks=False)
    finally:
        temporary.unlink(missing_ok=True)


def _code_artifact_api() -> tuple[
    Callable[[Any], list[str]],
    Callable[[str, Any], dict[str, Any]],
    Callable[[Any, Mapping[str, Any]], list[str]],
]:
    source = ROOT / "apps" / "orchestration" / "src"
    if str(source) not in sys.path:
        sys.path.insert(0, str(source))
    from orchestration.code_artifacts import (
        selected_release_input_identity,
        validate_eval_baseline,
        validate_selected_release_input_binding,
    )

    return (
        validate_eval_baseline,
        selected_release_input_identity,
        validate_selected_release_input_binding,
    )


def _selected_release_inputs() -> dict[str, dict[str, Any]]:
    """Load the exact current selected manifest identities for capture/comparison."""
    _, identity, _ = _code_artifact_api()
    return {
        "scope_leak_manifest": identity(
            "scope_leak_manifest", json.loads(SCOPE_MANIFEST.read_text(encoding="utf-8"))
        ),
        "verification_manifest": identity(
            "verification_manifest",
            json.loads(VERIFICATION_MANIFEST.read_text(encoding="utf-8")),
        ),
        "contract_drift_matrix": identity(
            "contract_drift_matrix", json.loads(DRIFT_MATRIX.read_text(encoding="utf-8"))
        ),
    }


def verify_immutable_baseline(value: Mapping[str, Any]) -> list[str]:
    validate_eval_baseline, _, _ = _code_artifact_api()
    return validate_eval_baseline(value)


def compare_selected_release_inputs(baseline: Mapping[str, Any]) -> list[str]:
    """Reject changed IDs, schemas, versions, or content digests before any checks run."""
    selected = baseline.get("selected_inputs")
    if not isinstance(selected, dict):
        return ["eval baseline has no selected release input binding"]
    _, _, validate_binding = _code_artifact_api()
    payloads = {
        "scope_leak_manifest": json.loads(SCOPE_MANIFEST.read_text(encoding="utf-8")),
        "verification_manifest": json.loads(VERIFICATION_MANIFEST.read_text(encoding="utf-8")),
        "contract_drift_matrix": json.loads(DRIFT_MATRIX.read_text(encoding="utf-8")),
    }
    return validate_binding(selected, payloads)


def compare_full_evals(  # noqa: C901 - frozen per-eval release comparator
    baseline: Mapping[str, Any], candidate: Mapping[str, Any]
) -> list[str]:
    """Return every new/worsened/missing/skipped/errored/timed-out eval entry."""
    baseline_results = baseline.get("normalized_outcomes", {}).get("results", [])
    candidate_results = candidate.get("results", [])
    errors: list[str] = []
    candidate_names = [item.get("name") for item in candidate_results if isinstance(item, dict)]
    if len(candidate_names) != len(candidate_results) or any(
        not isinstance(name, str) or not name for name in candidate_names
    ):
        return ["candidate full-eval result identities are malformed"]
    if len(candidate_names) != len(set(candidate_names)):
        errors.append("candidate full-eval results contain duplicate identities")
    by_name = {item["name"]: item for item in candidate_results if isinstance(item, dict)}
    baseline_names = {item.get("name") for item in baseline_results if isinstance(item, dict)}
    ordinal = {"PASS": 0, "FAIL": 1, "ERROR": 2, "TIMEOUT": 3}
    for prior in baseline_results:
        if not isinstance(prior, dict) or not isinstance(prior.get("name"), str):
            continue
        name = prior["name"]
        current = by_name.get(name)
        if current is None:
            errors.append(f"{name}: candidate entry is missing")
            continue
        status = current.get("status")
        if status in {"SKIP", "ERROR", "TIMEOUT"}:
            errors.append(f"{name}: candidate status {status} is release-failing")
            continue
        prior_status = prior.get("status")
        if prior_status == "PASS" and status != "PASS":
            errors.append(f"{name}: baselined PASS became {status}")
            continue
        if prior_status != "PASS" and ordinal.get(str(status), 99) > ordinal.get(
            str(prior_status), 99
        ):
            errors.append(f"{name}: ordinal severity worsened {prior_status}->{status}")
            continue
        # A baselined PASS that remains PASS has not regressed under the frozen
        # contract, even when a time-varying metric (for example freshness age)
        # moves between captures. Numeric worsening applies only to unchanged
        # known non-passes; a transition to PASS is an allowed improvement.
        prior_value = prior.get("value")
        current_value = current.get("value")
        direction = prior.get("direction")
        if (
            prior_status != "PASS"
            and status != "PASS"
            and isinstance(prior_value, (int, float))
            and isinstance(current_value, (int, float))
        ):
            if direction == "up_good" and current_value < prior_value:
                errors.append(f"{name}: score decreased {prior_value}->{current_value}")
            if direction == "down_good" and current_value > prior_value:
                errors.append(
                    f"{name}: severity/failure count increased {prior_value}->{current_value}"
                )
    for name, current in by_name.items():
        if name in baseline_names:
            continue
        status = current.get("status")
        if status != "PASS":
            errors.append(f"{name}: new candidate eval has release-failing status {status}")
    return errors


def validate_verification_manifest(value: Any) -> list[str]:
    source = ROOT / "apps" / "orchestration" / "src"
    if str(source) not in sys.path:
        sys.path.insert(0, str(source))
    from orchestration.code_artifacts import validate_p0_verification_manifest

    return validate_p0_verification_manifest(value, criteria_count=11)


def _load_public_scanner() -> Any:
    spec = importlib.util.spec_from_file_location(
        "p0_public_boundary", CHECKS / "check_public_boundary.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load public-boundary scanner")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _load_orchestration_scope() -> Callable[[str | Path, str | Path], list[str]]:
    source = ROOT / "apps" / "orchestration" / "src"
    if str(source) not in sys.path:
        sys.path.insert(0, str(source))
    from orchestration.scope_preservation import compare_preservation_artifact

    return compare_preservation_artifact


def run_named_checks(manifest: Mapping[str, Any]) -> list[str]:
    failures: list[str] = []
    externally_satisfied = {"full-evals", "code-p0-release"}
    for name, argv in manifest["checks"].items():
        if name in externally_satisfied:
            print(f"CHECK {name} external=current release comparison")
            continue
        process = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True, shell=False)
        tail = (process.stdout + process.stderr)[-1200:].strip()
        print(f"CHECK {name} exit={process.returncode}\n{tail}")
        if process.returncode != 0:
            failures.append(f"check {name!r} failed with exit {process.returncode}")
    return failures


def _full_eval_argv() -> list[str]:
    manifest = json.loads(VERIFICATION_MANIFEST.read_text(encoding="utf-8"))
    argv = manifest.get("checks", {}).get("full-evals") if isinstance(manifest, dict) else None
    if (
        not isinstance(argv, list)
        or not argv
        or any(not isinstance(item, str) or not item for item in argv)
    ):
        raise ValueError("selected verification manifest has no valid full-evals command")
    return argv


def capture_full_evals() -> int:
    """Capture a complete candidate eval artifact without treating known failures as new."""
    argv = _full_eval_argv()
    process = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True, shell=False)
    if process.stderr:
        print(process.stderr, file=sys.stderr, end="")
    try:
        candidate = json.loads(process.stdout)
    except json.JSONDecodeError as exc:
        print(f"FAIL: full-eval candidate was not valid JSON: {exc}")
        return 1
    results = candidate.get("results") if isinstance(candidate, dict) else None
    if not isinstance(results, list) or not results:
        print("FAIL: full-eval candidate has no normalized result entries")
        return 1
    print(json.dumps(candidate, ensure_ascii=False, sort_keys=True))
    print(
        f"CAPTURED: {len(results)} full-eval entries; raw evaluator exit={process.returncode}",
        file=sys.stderr,
    )
    return 0


def capture_immutable_baseline(output_path: Path) -> int:
    """Capture a pre-edit baseline once, failing if eval execution mutates source identity."""
    output = output_path.resolve(strict=False)
    if output == ROOT or ROOT in output.parents:
        print("FAIL: immutable baseline output must be outside the project tree")
        return 1
    raw_output = output.with_suffix(output.suffix + ".raw.json")
    if output.exists() or output.is_symlink() or raw_output.exists() or raw_output.is_symlink():
        print("FAIL: immutable baseline and raw-output paths must not already exist")
        return 1
    try:
        before = capture_source_identity(ROOT)
        captured_at = datetime.now(timezone.utc).isoformat()
        argv = _full_eval_argv()
        process = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True, shell=False)
        after = capture_source_identity(ROOT)
        if before != after:
            print("FAIL: full-eval baseline command changed source/worktree identity")
            return 1
        candidate = json.loads(process.stdout)
        results = candidate.get("results") if isinstance(candidate, dict) else None
        if not isinstance(results, list) or not results:
            print("FAIL: full-eval baseline has no normalized result entries")
            return 1
        raw_bytes = _canonical_json(
            {
                "stdout": process.stdout,
                "stderr": process.stderr,
                "exit_status": process.returncode,
            }
        )
        unsigned = {
            "schema_version": 2,
            "immutable": True,
            "captured_at": captured_at,
            "command_argv": argv,
            "working_directory": str(ROOT),
            "source_identity": before,
            "selected_inputs": _selected_release_inputs(),
            "normalized_outcomes": {"results": results},
            "comparator": {"id": "p0-full-eval-v1", "frozen": True},
            "raw_output_ref": str(raw_output),
            "raw_output_digest": hashlib.sha256(raw_bytes).hexdigest(),
        }
        baseline = {**unsigned, "digest": hashlib.sha256(_canonical_json(unsigned)).hexdigest()}
        _write_new_private_file(raw_output, raw_bytes)
        try:
            errors = verify_immutable_baseline(baseline)
            if errors:
                print("FAIL: generated baseline is invalid: " + "; ".join(errors))
                raw_output.unlink(missing_ok=True)
                return 1
            _write_new_private_file(output, json.dumps(baseline, indent=2).encode("utf-8") + b"\n")
        except Exception:
            raw_output.unlink(missing_ok=True)
            raise
    except (OSError, ValueError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        print(f"FAIL: immutable baseline capture failed: {exc}")
        return 1
    print(
        f"CAPTURED: immutable baseline {output} with {len(results)} entries; "
        f"raw evaluator exit={process.returncode}"
    )
    return 0


def main() -> int:  # noqa: C901 - explicit selected-tier release accounting
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--candidate-evals", type=Path)
    parser.add_argument("--preservation-artifact", type=Path)
    parser.add_argument("--execute-checks", action="store_true")
    parser.add_argument("--capture-evals", action="store_true")
    parser.add_argument("--capture-baseline", type=Path)
    args = parser.parse_args()
    if args.capture_evals and args.capture_baseline:
        parser.error("--capture-evals and --capture-baseline are mutually exclusive")
    if args.capture_evals:
        return capture_full_evals()
    if args.capture_baseline:
        return capture_immutable_baseline(args.capture_baseline)

    manifest = json.loads(VERIFICATION_MANIFEST.read_text(encoding="utf-8"))
    scope = json.loads(SCOPE_MANIFEST.read_text(encoding="utf-8"))
    drift_matrix = json.loads(DRIFT_MATRIX.read_text(encoding="utf-8"))
    errors = validate_verification_manifest(manifest)
    if scope.get("schema_version") != 1 or not scope.get("manifest_id"):
        errors.append("scope/leak manifest is not the configured schema-v1 artifact")
    if drift_matrix.get("schema_version") != 1:
        errors.append("contract/drift matrix is not schema-v1")

    scanner = _load_public_scanner()
    selected_scope = scanner.load_manifest(SCOPE_MANIFEST)
    errors.extend(scanner.validate_fixtures(selected_scope))
    matches = scanner.scan_manifest(ROOT, selected_scope)
    unresolved = [match for match in matches if match.in_scope and not match.resolved_generic]
    errors.extend(
        f"public-boundary unresolved: {match.path}:{match.line}:{match.pattern_id}"
        for match in unresolved
    )
    for match in matches:
        if not match.in_scope:
            print(f"REPORT-ONLY {match.path}:{match.line}:{match.pattern_id}")

    baseline_path = args.baseline or (
        Path(os.environ["PENNY_P0_BASELINE"]) if os.environ.get("PENNY_P0_BASELINE") else None
    )
    candidate_path = args.candidate_evals or (
        Path(os.environ["PENNY_P0_CANDIDATE_EVALS"])
        if os.environ.get("PENNY_P0_CANDIDATE_EVALS")
        else None
    )
    preservation_path = args.preservation_artifact or (
        Path(os.environ["PENNY_P0_PRESERVATION"])
        if os.environ.get("PENNY_P0_PRESERVATION")
        else None
    )
    if baseline_path is None or candidate_path is None or preservation_path is None:
        errors.append("baseline, candidate eval, and preservation artifact paths are all required")
    else:
        try:
            baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
            candidate = json.loads(candidate_path.read_text(encoding="utf-8"))
            errors.extend(verify_immutable_baseline(baseline))
            errors.extend(compare_selected_release_inputs(baseline))
            errors.extend(compare_full_evals(baseline, candidate))
            errors.extend(_load_orchestration_scope()(ROOT, preservation_path))
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            errors.append(f"release evidence could not be validated: {exc}")
    if args.execute_checks:
        errors.extend(run_named_checks(manifest))

    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print("PASS: P0 release manifest, scope, baseline comparison, and preservation checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
