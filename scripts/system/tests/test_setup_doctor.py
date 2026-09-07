from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from memory.hub_config import load_hub_config
from memory.tests.test_hub_service import (
    _free_port,
    _launch,
    _make_config,
    _terminate,
    _wait_healthy,
    _write_fixture_server,
    _write_launcher,
)

PROJECT_ROOT = Path(__file__).parents[3]
DOCTOR = PROJECT_ROOT / "scripts" / "setup" / "doctor.mjs"
STATE_CLI = PROJECT_ROOT / "apps" / "orchestration" / "dist" / "state-cli.js"
OBSERVABILITY_SERVER = PROJECT_ROOT / "apps" / "observability" / "dist" / "server.js"


def _last_json(stdout: str) -> dict[str, object]:
    lines = [line for line in stdout.splitlines() if line.strip().startswith("{")]
    assert lines, stdout
    value = json.loads(lines[-1])
    assert isinstance(value, dict)
    return value


def _doctor_environment(state_root: Path, *, state_mode: str, allow_fresh: bool) -> dict[str, str]:
    environment = os.environ.copy()
    environment.update(
        {
            "PENNY_STATE_ROOT": str(state_root),
            "PENNY_MEMORY_MODE": "disabled",
            "PENNY_SETUP_MEMORY_MODE": "disabled",
            "PENNY_SETUP_STATE_MODE": state_mode,
            "PENNY_SETUP_ALLOW_FRESH_INIT": "1" if allow_fresh else "0",
            "PENNY_SETUP_DOCTOR_COMPONENT": "all",
            "PI_OBSERVABILITY_ENABLED": "true",
        }
    )
    environment.pop("PENNY_SETUP_MEMORY_HUB_CONFIG", None)
    return environment


@pytest.mark.integration
def test_doctor_reports_action_required_without_creating_missing_state(tmp_path: Path) -> None:
    if not STATE_CLI.exists() or not OBSERVABILITY_SERVER.exists():
        pytest.skip("build orchestration and observability before setup doctor integration tests")
    state_root = tmp_path / "missing-state"

    completed = subprocess.run(
        ["node", str(DOCTOR)],
        cwd=PROJECT_ROOT,
        env=_doctor_environment(state_root, state_mode="existing", allow_fresh=False),
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )

    assert completed.returncode == 1
    result = _last_json(completed.stdout)
    assert result["status"] == "action_required"
    assert not state_root.exists()


@pytest.mark.integration
@pytest.mark.skipif(os.name != "posix", reason="synthetic hub fixture uses POSIX signals")
def test_memory_doctor_requires_supervised_authenticated_hub(tmp_path: Path) -> None:
    fixture = tmp_path / "synthetic_hub.py"
    launcher = tmp_path / "launcher.py"
    _write_fixture_server(fixture)
    _write_launcher(launcher)
    palace = tmp_path / "palace"
    palace.mkdir(mode=0o700)
    config_path = _make_config(
        tmp_path / "owner",
        palace,
        palace_id="penny",
        port=_free_port(),
    )
    config = load_hub_config(config_path)
    process = _launch(config_path, launcher, fixture)
    try:
        _wait_healthy(config, process)
        environment = os.environ.copy()
        environment.update(
            {
                "PENNY_SETUP_MEMORY_MODE": "hub",
                "PENNY_SETUP_STATE_MODE": "existing",
                "PENNY_SETUP_MEMORY_HUB_CONFIG": str(config_path),
                "PENNY_SETUP_ALLOW_FRESH_INIT": "0",
                "PENNY_SETUP_DOCTOR_COMPONENT": "memory",
                "PENNY_MEMORY_MODE": "hub",
                "PENNY_MEMORY_WRITE_MODE": "disabled",
                "PENNY_MEMORY_MCP_ENDPOINT": f"{config.endpoint}/mcp",
                "PENNY_MEMORY_PALACE_ID": config.palace_id,
                "PENNY_MEMORY_DATA_ROOT_ID": "synthetic-data",
                "PENNY_MEMORY_PRINCIPAL_ID": "penny-primary",
                "PENNY_MEMORY_TRUST_MODE": "isolated",
                "PENNY_MEMORY_ISOLATION_BOUNDARY_ID": "synthetic-boundary",
                "PENNY_MEMORY_OWNER_ID": "operator",
                "PENNY_MEMORY_BACKUP_POLICY_REF": "backup-v1",
                "PENNY_MEMORY_MIGRATION_POLICY_REF": "migration-v1",
                "PENNY_MEMORY_RETENTION_POLICY_REF": "retention-v1",
                "PENNY_MEMORY_UNINSTALL_DISPOSITION": "preserve",
                "PENNY_MEMORY_MCP_TOKEN_FILE": str(config.token_file),
            }
        )
        environment.pop("PENNY_MEMORY_MCP_TOKEN_ENV", None)

        completed = subprocess.run(
            ["node", str(DOCTOR)],
            cwd=PROJECT_ROOT,
            env=environment,
            text=True,
            capture_output=True,
            check=False,
            timeout=30,
        )

        assert completed.returncode == 0, completed.stderr
        result = _last_json(completed.stdout)
        assert result["status"] == "ready"
        components = {
            item["component"]: item["status"]
            for item in result["components"]
            if isinstance(item, dict)
        }
        assert components["memory"] == "ready"
        assert components["memory_writes"] == "disabled_policy"

        environment.update(
            {
                "PENNY_STATE_ROOT": str(tmp_path / "core-state"),
                "PENNY_SETUP_STATE_MODE": "fresh",
                "PENNY_SETUP_ALLOW_FRESH_INIT": "1",
                "PENNY_SETUP_DOCTOR_COMPONENT": "all",
                "PI_OBSERVABILITY_ENABLED": "true",
            }
        )
        full_core = subprocess.run(
            ["node", str(DOCTOR)],
            cwd=PROJECT_ROOT,
            env=environment,
            text=True,
            capture_output=True,
            check=False,
            timeout=60,
        )
        assert full_core.returncode == 0, f"{full_core.stderr}\n{full_core.stdout}"
        full_result = _last_json(full_core.stdout)
        assert full_result["status"] == "ready"
        full_components = {
            item["component"]: item["status"]
            for item in full_result["components"]
            if isinstance(item, dict)
        }
        assert full_components["memory"] == "ready"
        assert full_components["canonical_state"] == "ready"
        assert full_components["observability"] == "ready"
        assert full_components["extensions"] == "ready"

        wrong_token = tmp_path / "wrong-token"
        wrong_token.write_text("wrong-synthetic-token-at-least-32-bytes\n", encoding="utf-8")
        wrong_token.chmod(0o600)
        environment["PENNY_MEMORY_MCP_TOKEN_FILE"] = str(wrong_token)
        environment["PENNY_SETUP_DOCTOR_COMPONENT"] = "memory"
        environment["PENNY_SETUP_STATE_MODE"] = "existing"
        environment["PENNY_SETUP_ALLOW_FRESH_INIT"] = "0"
        rejected = subprocess.run(
            ["node", str(DOCTOR)],
            cwd=PROJECT_ROOT,
            env=environment,
            text=True,
            capture_output=True,
            check=False,
            timeout=30,
        )
        assert rejected.returncode == 1
        rejected_result = _last_json(rejected.stdout)
        assert rejected_result["status"] == "action_required"
    finally:
        _terminate(process)


@pytest.mark.integration
def test_doctor_explicit_fresh_state_reaches_provider_free_ready(tmp_path: Path) -> None:
    if not STATE_CLI.exists() or not OBSERVABILITY_SERVER.exists():
        pytest.skip("build orchestration and observability before setup doctor integration tests")
    state_root = tmp_path / "fresh-state"

    completed = subprocess.run(
        ["node", str(DOCTOR)],
        cwd=PROJECT_ROOT,
        env=_doctor_environment(state_root, state_mode="fresh", allow_fresh=True),
        text=True,
        capture_output=True,
        check=False,
        timeout=60,
    )

    assert completed.returncode == 0, completed.stderr
    result = _last_json(completed.stdout)
    assert result["status"] == "ready"
    components = {
        item["component"]: item["status"] for item in result["components"] if isinstance(item, dict)
    }
    assert components["canonical_state"] == "ready"
    assert components["checkpoints"] == "ready"
    assert components["artifacts"] == "ready"
    assert components["receipt_authority"] == "ready"
    assert components["observability"] == "ready"
    assert components["extensions"] == "ready"
    assert state_root.exists()
