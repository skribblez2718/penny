from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path

PROJECT_ROOT = Path(__file__).parents[3]
MASTER_SETUP = PROJECT_ROOT / "scripts" / "setup" / "setup.sh"
BROWSER_SETUP = PROJECT_ROOT / "scripts" / "setup" / "init-external-tools.sh"
MEMORY_SETUP = PROJECT_ROOT / "scripts" / "setup" / "init-memory.sh"
CONFIG_CHECK = PROJECT_ROOT / "scripts" / "setup" / "check-config.mjs"
PREFLIGHT = PROJECT_ROOT / "scripts" / "setup" / "preflight.mjs"
MAKEFILE = PROJECT_ROOT / "Makefile"
NODE = shutil.which("node")


def _copy_setup_script(tmp_path: Path, source: Path) -> Path:
    setup_dir = tmp_path / "scripts" / "setup"
    setup_dir.mkdir(parents=True, exist_ok=True)
    target = setup_dir / source.name
    shutil.copy2(source, target)
    return target


def _write_executable(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)


def _last_json(stdout: str) -> dict[str, object]:
    lines = [line for line in stdout.splitlines() if line.strip()]
    assert lines
    value = json.loads(lines[-1])
    assert isinstance(value, dict)
    return value


def test_master_setup_delegates_to_explicit_make_graph_without_discovery(tmp_path: Path) -> None:
    script = _copy_setup_script(tmp_path, MASTER_SETUP)
    unexpected = script.parent / "init-unexpected.sh"
    marker = tmp_path / "unexpected-called"
    _write_executable(unexpected, f"#!/bin/sh\ntouch {shlex.quote(str(marker))}\n")

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    make_args = tmp_path / "make-args.json"
    fake_make = bin_dir / "make"
    _write_executable(
        fake_make,
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        f"open({str(make_args)!r}, 'w', encoding='utf-8').write(json.dumps(sys.argv[1:]))\n",
    )
    environment = os.environ.copy()
    environment["PATH"] = f"{bin_dir}:/usr/bin:/bin"

    completed = subprocess.run(
        ["bash", str(script), "STATE_MODE=existing"],
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0
    assert json.loads(make_args.read_text(encoding="utf-8")) == [
        "-C",
        str(tmp_path),
        "setup",
        "STATE_MODE=existing",
    ]
    assert not marker.exists()


def test_memory_setup_no_args_is_non_destructive_action_required(tmp_path: Path) -> None:
    script = _copy_setup_script(tmp_path, MEMORY_SETUP)

    completed = subprocess.run(
        ["bash", str(script)],
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 1
    assert "ACTION_REQUIRED" in completed.stderr
    assert not (tmp_path / ".mempalace").exists()


def test_memory_setup_delegates_only_to_supervised_hub_command(tmp_path: Path) -> None:
    script = _copy_setup_script(tmp_path, MEMORY_SETUP)
    python = tmp_path / ".venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    marker = tmp_path / "python-args.txt"
    _write_executable(
        python,
        "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > " + shlex.quote(str(marker)) + "\n",
    )
    config = tmp_path / "hub.json"
    config.write_text("{}", encoding="utf-8")

    completed = subprocess.run(
        ["bash", str(script), "status", "--config", str(config)],
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0
    assert marker.read_text(encoding="utf-8").splitlines() == [
        "-m",
        "scripts.system.memory.hub_service",
        "status",
        "--config",
        str(config),
    ]
    assert not (tmp_path / ".mempalace").exists()


def _hub_env() -> str:
    return "\n".join(
        [
            "PENNY_MEMORY_MODE=hub",
            "PENNY_MEMORY_WRITE_MODE=disabled",
            "PENNY_MEMORY_MCP_ENDPOINT=http://127.0.0.1:8766/mcp",
            "PENNY_MEMORY_PALACE_ID=penny",
            "PENNY_MEMORY_DATA_ROOT_ID=penny-data",
            "PENNY_MEMORY_PRINCIPAL_ID=penny-primary",
            "PENNY_MEMORY_TRUST_MODE=isolated",
            "PENNY_MEMORY_ISOLATION_BOUNDARY_ID=penny-local",
            "PENNY_MEMORY_OWNER_ID=operator",
            "PENNY_MEMORY_BACKUP_POLICY_REF=backup-v1",
            "PENNY_MEMORY_MIGRATION_POLICY_REF=migration-v1",
            "PENNY_MEMORY_RETENTION_POLICY_REF=retention-v1",
            "PENNY_MEMORY_UNINSTALL_DISPOSITION=preserve",
            "PENNY_MEMORY_MCP_TOKEN_ENV=PENNY_TEST_MEMORY_TOKEN",
            "",
        ]
    )


def test_config_check_defaults_to_hub_and_requires_private_config(tmp_path: Path) -> None:
    if NODE is None:
        raise AssertionError("Node is required by Penny setup tests")
    script = _copy_setup_script(tmp_path, CONFIG_CHECK)
    environment = os.environ.copy()
    environment["PENNY_SETUP_MEMORY_MODE"] = "hub"
    environment["PENNY_SETUP_STATE_MODE"] = "existing"
    environment.pop("PENNY_SETUP_MEMORY_HUB_CONFIG", None)
    environment.pop("PENNY_MEMORY_MODE", None)

    completed = subprocess.run(
        [NODE, str(script)],
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 1
    result = _last_json(completed.stdout)
    assert result["status"] == "action_required"
    assert result["memory_mode"] == "hub"
    assert result["error"] == {
        "code": "MEMORY_HUB_CONFIG_REQUIRED",
        "message": (
            "hub memory is enabled by default; supply MEMORY_HUB_CONFIG as an absolute "
            "caller-owned path"
        ),
    }


def test_config_check_accepts_aligned_hub_configuration(tmp_path: Path) -> None:
    if NODE is None:
        raise AssertionError("Node is required by Penny setup tests")
    script = _copy_setup_script(tmp_path, CONFIG_CHECK)
    (tmp_path / ".env").write_text(_hub_env(), encoding="utf-8")
    config = tmp_path / "hub.json"
    config.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "endpoint": "http://127.0.0.1:8766",
                "palace_id": "penny",
            }
        ),
        encoding="utf-8",
    )
    config.chmod(0o600)
    environment = {
        key: value for key, value in os.environ.items() if not key.startswith("PENNY_MEMORY_")
    }
    environment["PENNY_SETUP_MEMORY_MODE"] = "hub"
    environment["PENNY_SETUP_STATE_MODE"] = "existing"
    environment["PENNY_SETUP_MEMORY_HUB_CONFIG"] = str(config)
    environment["PENNY_TEST_MEMORY_TOKEN"] = "synthetic-test-token-at-least-32-bytes"

    completed = subprocess.run(
        [NODE, str(script)],
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert "synthetic-test-token-at-least-32-bytes" not in completed.stdout
    assert "synthetic-test-token-at-least-32-bytes" not in completed.stderr
    result = _last_json(completed.stdout)
    assert result["status"] == "ready"
    assert result["memory_mode"] == "hub"
    assert "environment" not in result


def test_config_check_rejects_runtime_setup_memory_mode_mismatch(tmp_path: Path) -> None:
    if NODE is None:
        raise AssertionError("Node is required by Penny setup tests")
    script = _copy_setup_script(tmp_path, CONFIG_CHECK)
    (tmp_path / ".env").write_text("PENNY_MEMORY_MODE=disabled\n", encoding="utf-8")
    environment = os.environ.copy()
    environment["PENNY_SETUP_MEMORY_MODE"] = "hub"
    environment["PENNY_SETUP_STATE_MODE"] = "existing"
    environment.pop("PENNY_MEMORY_MODE", None)

    completed = subprocess.run(
        [NODE, str(script)],
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 1
    assert _last_json(completed.stdout)["error"] == {
        "code": "MEMORY_MODE_MISMATCH",
        "message": (
            "setup memory mode must match PENNY_MEMORY_MODE in .env or the exported environment"
        ),
    }


def test_preflight_checks_supported_versions_without_installing(tmp_path: Path) -> None:
    if NODE is None:
        raise AssertionError("Node is required by Penny setup tests")
    script = _copy_setup_script(tmp_path, PREFLIGHT)
    (tmp_path / "package.json").write_text(
        json.dumps(
            {
                "devDependencies": {"@earendil-works/pi-coding-agent": "0.85.1"},
                "engines": {"node": ">=22.19.0"},
            }
        ),
        encoding="utf-8",
    )
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    versions = {
        "bun": "1.2.0",
        "pi": "0.85.1",
        "python3": "Python 3.12.1",
        "uv": "uv 0.8.0",
    }
    for name, version in versions.items():
        _write_executable(bin_dir / name, f"#!/bin/sh\nprintf '%s\\n' {shlex.quote(version)}\n")
    environment = os.environ.copy()
    environment["PATH"] = str(bin_dir)

    completed = subprocess.run(
        [NODE, str(script), "core"],
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    result = _last_json(completed.stdout)
    assert result["status"] == "ready"
    assert [item["component"] for item in result["checks"]] == [
        "node",
        "bun",
        "pi",
        "python",
        "uv",
    ]


def test_preflight_rejects_pi_sdk_version_skew(tmp_path: Path) -> None:
    if NODE is None:
        raise AssertionError("Node is required by Penny setup tests")
    script = _copy_setup_script(tmp_path, PREFLIGHT)
    (tmp_path / "package.json").write_text(
        json.dumps(
            {
                "devDependencies": {"@earendil-works/pi-coding-agent": "0.85.1"},
                "engines": {"node": ">=22.19.0"},
            }
        ),
        encoding="utf-8",
    )
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _write_executable(bin_dir / "bun", "#!/bin/sh\nprintf '1.3.0\\n'\n")
    _write_executable(bin_dir / "pi", "#!/bin/sh\nprintf '0.85.0\\n'\n")
    environment = os.environ.copy()
    environment["PATH"] = str(bin_dir)

    completed = subprocess.run(
        [NODE, str(script), "javascript"],
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 1
    result = _last_json(completed.stdout)
    assert result["status"] == "failed"
    assert result["error"] == {
        "code": "PREREQUISITE_INVALID",
        "message": "Pi 0.85.1 is required; found 0.85.0",
    }


def test_browser_setup_uses_only_repository_local_playwright(tmp_path: Path) -> None:
    script = _copy_setup_script(tmp_path, BROWSER_SETUP)
    playwright = tmp_path / "node_modules" / ".bin" / "playwright"
    playwright.parent.mkdir(parents=True)
    marker = tmp_path / "playwright-args.txt"
    _write_executable(
        playwright,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + shlex.quote(str(marker)) + "\n",
    )

    completed = subprocess.run(
        ["bash", str(script)],
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0
    assert marker.read_text(encoding="utf-8").splitlines() == ["install", "chromium"]
    source = BROWSER_SETUP.read_text(encoding="utf-8")
    assert "bunx playwright" not in source
    assert '"$PLAYWRIGHT_BIN" install chromium' in source
    assert "install-deps" in source


def test_make_setup_contract_is_explicit_frozen_and_parallel_safe() -> None:
    source = MAKEFILE.read_text(encoding="utf-8")
    setup_region = source.split("# ── Development", maxsplit=1)[0]

    assert '"$SCRIPT_DIR"/init-*.sh' not in MASTER_SETUP.read_text(encoding="utf-8")
    assert "bun install --frozen-lockfile" in setup_region
    assert "uv sync --frozen" in setup_region
    assert "--extra dev" not in setup_region
    assert "setup-browser: install-js" in setup_region
    assert (
        "setup-ready: preflight-js config-check $(SETUP_MEMORY_TARGET) build-observability"
        in setup_region
    )
    assert "SETUP_MEMORY_TARGET := install-py" in setup_region
    assert "build-observability: build-orchestration" in setup_region
    assert "PENNY_SETUP_ALLOW_FRESH_INIT=$(if $(filter fresh,$(STATE_MODE)),1,0)" in setup_region

    dry_run = subprocess.run(
        [
            "make",
            "-n",
            "-j4",
            "setup",
            "MEMORY_MODE=disabled",
            "STATE_MODE=existing",
        ],
        cwd=PROJECT_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert dry_run.returncode == 0, dry_run.stderr
    assert dry_run.stdout.count("bun install --frozen-lockfile --offline") == 1
    assert dry_run.stdout.count("init-orchestration.sh build") == 1
    assert dry_run.stdout.count("init-observability.sh") == 1
    assert dry_run.stdout.count("scripts/setup/doctor.mjs") == 1
    assert "uv sync" not in dry_run.stdout
    assert "PENNY_SETUP_ALLOW_FRESH_INIT=0" in dry_run.stdout

    hub_dry_run = subprocess.run(
        [
            "make",
            "-n",
            "-j4",
            "setup",
            "MEMORY_MODE=hub",
            "STATE_MODE=fresh",
            "MEMORY_HUB_CONFIG=/private/hub.json",
        ],
        cwd=PROJECT_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert hub_dry_run.returncode == 0, hub_dry_run.stderr
    assert hub_dry_run.stdout.count("uv sync --frozen --offline") == 1
    assert hub_dry_run.stdout.count("bun install --frozen-lockfile --offline") == 1
    assert "PENNY_SETUP_ALLOW_FRESH_INIT=1" in hub_dry_run.stdout


def test_websocket_runtime_peer_has_no_unused_direct_type_package() -> None:
    manifest = json.loads((PROJECT_ROOT / "package.json").read_text(encoding="utf-8"))
    assert manifest["devDependencies"]["ws"].startswith("^8.18")
    assert "@types/ws" not in manifest["devDependencies"]
    assert '"openai"' in (PROJECT_ROOT / "bun.lock").read_text(encoding="utf-8")
    assert '"ws": "^8.18.0"' in (PROJECT_ROOT / "bun.lock").read_text(encoding="utf-8")


def test_clean_target_preserves_memory_data() -> None:
    source = MAKEFILE.read_text(encoding="utf-8")
    clean = source.split("\nclean:\n", maxsplit=1)[1].split("\n\n", maxsplit=1)[0]
    assert ".mempalace" not in clean
    assert "memory data was preserved" in clean
