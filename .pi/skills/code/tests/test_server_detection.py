"""Unit tests for the server-framework auto-detection in the code skill.

These tests verify the ``_detect_server_framework`` helper used by the
orchestrator to decide whether a project is a server project. The
verdict drives the ``verification.server_startup`` flag in the ideal
state, which in turn triggers mandatory server-startup integration
tests in the implement and verify phases of the Ralph Wiggum Loop.
"""

from __future__ import annotations

import json
import sys
import textwrap
from pathlib import Path

# Make the orchestrator importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from orchestrate import (
    _apply_server_detection,
    _build_multi_server_block,
    _build_resource_context,
    _detect_multi_server,
    _detect_server_framework,
    CodeSession,
    handle_implement,
    start,
)


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(content).lstrip(), encoding="utf-8")


# ---------------------------------------------------------------------------
# _detect_server_framework
# ---------------------------------------------------------------------------


def test_detect_no_server(tmp_path: Path) -> None:
    """A project with no server deps returns is_server=False."""
    _write(
        tmp_path / "pyproject.toml",
        """
        [project]
        name = "cli-tool"
        dependencies = ["click>=8.0", "rich>=13.0"]
        """,
    )
    _write(
        tmp_path / "main.py",
        "import click\n\n@click.command()\ndef main():\n    pass\n",
    )

    info = _detect_server_framework(str(tmp_path))
    assert info["is_server"] is False


def test_detect_fastapi_in_pyproject(tmp_path: Path) -> None:
    """fastapi in pyproject.toml triggers detection."""
    _write(
        tmp_path / "pyproject.toml",
        """
        [project]
        name = "api"
        dependencies = ["fastapi>=0.115", "uvicorn[standard]"]
        """,
    )

    info = _detect_server_framework(str(tmp_path))
    assert info["is_server"] is True
    assert info["framework"] == "fastapi"
    assert info["language"] == "python"


def test_detect_flask_in_pyproject(tmp_path: Path) -> None:
    """flask in pyproject.toml triggers detection."""
    _write(
        tmp_path / "pyproject.toml",
        """
        [project]
        name = "web"
        dependencies = ["flask>=3.0"]
        """,
    )

    info = _detect_server_framework(str(tmp_path))
    assert info["is_server"] is True
    assert info["framework"] == "flask"


def test_detect_django_in_pyproject(tmp_path: Path) -> None:
    """django in pyproject.toml triggers detection."""
    _write(
        tmp_path / "pyproject.toml",
        """
        [project]
        dependencies = ["django>=5.0"]
        """,
    )

    info = _detect_server_framework(str(tmp_path))
    assert info["is_server"] is True
    assert info["framework"] == "django"


def test_detect_express_in_package_json(tmp_path: Path) -> None:
    """express in package.json triggers detection."""
    pkg = {
        "name": "web",
        "dependencies": {"express": "^4.18.0"},
    }
    (tmp_path / "package.json").write_text(json.dumps(pkg), encoding="utf-8")

    info = _detect_server_framework(str(tmp_path))
    assert info["is_server"] is True
    assert info["framework"] == "express"
    assert info["language"] == "typescript"


def test_detect_fastify_in_package_json(tmp_path: Path) -> None:
    pkg = {"name": "api", "dependencies": {"fastify": "^4.0.0"}}
    (tmp_path / "package.json").write_text(json.dumps(pkg), encoding="utf-8")

    info = _detect_server_framework(str(tmp_path))
    assert info["is_server"] is True
    assert info["framework"] == "fastify"


def test_detect_nestjs_in_package_json(tmp_path: Path) -> None:
    pkg = {
        "name": "api",
        "dependencies": {"@nestjs/core": "^10.0.0"},
    }
    (tmp_path / "package.json").write_text(json.dumps(pkg), encoding="utf-8")

    info = _detect_server_framework(str(tmp_path))
    assert info["is_server"] is True
    assert info["framework"] == "nestjs"


def test_detect_server_by_import_in_source(tmp_path: Path) -> None:
    """When pyproject doesn't list the framework, a direct import is enough."""
    # No pyproject.toml — but the source clearly imports fastapi
    _write(
        tmp_path / "backend" / "main.py",
        """
        from fastapi import FastAPI
        app = FastAPI()
        """,
    )

    info = _detect_server_framework(str(tmp_path))
    assert info["is_server"] is True
    assert info["framework"] == "fastapi"


def test_detect_skips_noise_directories(tmp_path: Path) -> None:
    """node_modules and .venv imports are not considered for detection."""
    _write(
        tmp_path / "node_modules" / "express" / "index.js",
        "module.exports = require('express');",
    )
    _write(
        tmp_path / "package.json",
        '{"name": "consumer", "dependencies": {"some-lib": "1.0"}}',
    )

    info = _detect_server_framework(str(tmp_path))
    assert info["is_server"] is False


def test_detect_identifies_entry_points(tmp_path: Path) -> None:
    """Entry points in backend/ or top-level are reported."""
    _write(
        tmp_path / "pyproject.toml",
        """
        [project]
        dependencies = ["fastapi"]
        """,
    )
    _write(
        tmp_path / "backend" / "main.py",
        """
        from fastapi import FastAPI
        app = FastAPI()
        """,
    )

    info = _detect_server_framework(str(tmp_path))
    assert info["is_server"] is True
    assert any("backend" in ep and "main.py" in ep for ep in info["entry_points"])


def test_detect_handles_empty_project_root() -> None:
    """Empty project_root returns is_server=False without raising."""
    info = _detect_server_framework("")
    assert info["is_server"] is False


def test_detect_handles_nonexistent_project_root(tmp_path: Path) -> None:
    """Nonexistent project_root returns is_server=False without raising."""
    info = _detect_server_framework(str(tmp_path / "does-not-exist"))
    assert info["is_server"] is False


# ---------------------------------------------------------------------------
# _apply_server_detection
# ---------------------------------------------------------------------------


def test_apply_server_detection_sets_flag(tmp_path: Path) -> None:
    """_apply_server_detection flips verification.server_startup for servers."""
    _write(
        tmp_path / "pyproject.toml",
        """
        [project]
        dependencies = ["fastapi"]
        """,
    )
    _write(
        tmp_path / "backend" / "main.py",
        "from fastapi import FastAPI\napp = FastAPI()\n",
    )

    session = CodeSession("test-1", "Build API")
    session.project_root = str(tmp_path)
    session.ideal_state = {
        "goal": "Build API",
        "success_criteria": [],
        "verification": {"lint": True, "type_check": True, "unit_tests": True},
    }

    _apply_server_detection(session)

    assert session.server_info.get("is_server") is True
    verification = session.ideal_state["verification"]
    assert verification["server_startup"] is True
    assert verification["server_framework"] == "fastapi"
    assert any("backend" in ep for ep in verification["server_entry_points"])


def test_apply_server_detection_noop_for_non_server(tmp_path: Path) -> None:
    """_apply_server_detection leaves verification alone for non-servers."""
    _write(
        tmp_path / "pyproject.toml",
        """
        [project]
        dependencies = ["click", "rich"]
        """,
    )

    session = CodeSession("test-1", "Build CLI")
    session.project_root = str(tmp_path)
    session.ideal_state = {
        "goal": "Build CLI",
        "success_criteria": [],
        "verification": {"lint": True, "type_check": True, "unit_tests": True},
    }

    _apply_server_detection(session)

    assert session.server_info.get("is_server") is False
    assert session.ideal_state["verification"].get("server_startup", False) is False


# ---------------------------------------------------------------------------
# start() integration
# ---------------------------------------------------------------------------


def test_start_with_server_project_enables_startup_verification(
    tmp_path: Path,
) -> None:
    """start() detects a server project and returns a verify command
    that mentions server-startup tests."""
    _write(
        tmp_path / "pyproject.toml",
        """
        [project]
        dependencies = ["fastapi"]
        """,
    )
    _write(
        tmp_path / "backend" / "main.py",
        "from fastapi import FastAPI\napp = FastAPI()\n",
    )
    _write(
        tmp_path / "main.py",
        "def main():\n    pass\n",
    )

    # Build IDEAL STATE and state_data as prd skill would produce
    ideal_state = {
        "goal": "Build a FastAPI service",
        "success_criteria": ["It works"],
        "deliverables": ["backend/main.py"],
        "language": "python",
        "verification": {"lint": True, "type_check": True, "unit_tests": True},
    }
    state_data = {"ideal_state": ideal_state, "goal": "Build a FastAPI service"}
    result = start(
        "test-server-startup",
        "Build a FastAPI service",
        state_data=state_data,
        project_root=str(tmp_path),
    )

    # The returned orchestrator_state should have server detection on
    state = result["orchestrator_state"]
    assert state["server_info"]["is_server"] is True
    assert state["server_info"]["framework"] == "fastapi"
    # The ideal_state should have server_startup verification enabled
    assert state["ideal_state"]["verification"]["server_startup"] is True
    assert state["ideal_state"]["verification"]["server_framework"] == "fastapi"


def test_start_with_non_server_project_skips_startup_verification(
    tmp_path: Path,
) -> None:
    _write(
        tmp_path / "pyproject.toml",
        """
        [project]
        dependencies = ["click", "rich"]
        """,
    )
    _write(tmp_path / "main.py", "import click\n\n@click.command()\ndef main(): pass\n")

    ideal_state = {
        "goal": "Build a CLI tool",
        "success_criteria": ["It works"],
        "language": "python",
        "verification": {"lint": True, "type_check": True, "unit_tests": True},
    }
    state_data = {"ideal_state": ideal_state, "goal": "Build a CLI tool"}
    result = start(
        "test-cli",
        "Build a CLI tool",
        state_data=state_data,
        project_root=str(tmp_path),
    )

    state = result["orchestrator_state"]
    assert state["server_info"]["is_server"] is False
    # The server_startup key is not added when the project isn't a server.
    assert (
        state["ideal_state"]["verification"].get("server_startup", False)
        is False
    )


# ---------------------------------------------------------------------------
# handle_verify
# ---------------------------------------------------------------------------


def test_handle_verify_includes_server_startup_for_servers(tmp_path: Path) -> None:
    """When the project is a server, handle_verify's task mentions the
    four-category checklist."""
    sys.path.insert(0, str(tmp_path))
    try:
        from orchestrate import handle_verify  # re-import under tmp_path
    finally:
        sys.path.pop(0)

    session = CodeSession("test-1", "API")
    session.language = "python"
    session.ideal_state = {
        "goal": "API",
        "success_criteria": ["x"],
        "verification": {
            "lint": True,
            "type_check": True,
            "unit_tests": True,
            "integration_tests": False,
            "e2e_tests": False,
            "server_startup": True,
            "server_framework": "fastapi",
            "server_entry_points": ["/tmp/x/backend/main.py"],
        },
    }

    result = handle_verify(session)

    # Verify commands include the server-startup tier
    assert "integration or server" in result["task"]
    # And the gap-check is in the task
    assert "SERVER-STARTUP VERIFICATION" in result["task"]
    assert "background thread" in result["task"]
    assert "sys.path" in result["task"].lower() or "PYTHONPATH" in result["task"]
    assert "CORS" in result["task"]


def test_handle_verify_omits_server_checks_for_non_servers(tmp_path: Path) -> None:
    """For non-server projects, no server-specific instructions leak in."""
    sys.path.insert(0, str(tmp_path))
    try:
        from orchestrate import handle_verify
    finally:
        sys.path.pop(0)

    session = CodeSession("test-1", "CLI")
    session.language = "python"
    session.ideal_state = {
        "goal": "CLI",
        "success_criteria": ["x"],
        "verification": {
            "lint": True,
            "type_check": True,
            "unit_tests": True,
            "integration_tests": False,
            "e2e_tests": False,
            "server_startup": False,
        },
    }

    result = handle_verify(session)
    assert "SERVER-STARTUP VERIFICATION" not in result["task"]


# ---------------------------------------------------------------------------
# handle_implement
# ---------------------------------------------------------------------------


def test_handle_implement_includes_server_test_requirements_for_servers(
    tmp_path: Path,
) -> None:
    """For server projects, handle_implement's task contains the four
    server-startup test categories."""
    sys.path.insert(0, str(tmp_path))
    try:
        from orchestrate import handle_implement
    finally:
        sys.path.pop(0)

    session = CodeSession("test-1", "API")
    session.language = "python"
    session.ideal_state = {
        "goal": "API",
        "success_criteria": ["x"],
        "verification": {
            "server_startup": True,
            "server_framework": "fastapi",
            "server_entry_points": ["/tmp/x/backend/main.py"],
        },
    }

    result = handle_implement(session)
    task = result["task"]
    # All four categories should be present
    assert "SERVER-STARTUP TEST REQUIREMENTS" in task
    assert "CATEGORY 1" not in task  # we used numbered bullets, not labels
    assert (
        "background thread" in task.lower() or "subprocess" in task.lower()
    )
    assert "subprocess" in task.lower()  # Category 2
    assert "CORS" in task  # Category 3
    assert "happy path" in task.lower()  # Category 4


# =====================================================================
# Multi-server detection (the single-command dev rule)
# =====================================================================


def test_detect_multi_server_python_backend_with_vite_frontend(tmp_path: Path) -> None:
    """Python FastAPI backend + a frontend/ dir with Vite = multi-server."""
    (tmp_path / "pyproject.toml").write_text('[project]\nname="x"\ndependencies=["fastapi"]\n')
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "package.json").write_text(
        json.dumps({
            "name": "fe",
            "devDependencies": {"vite": "^5.0.0"},
            "scripts": {"dev": "vite"},
        })
    )

    result = _detect_multi_server(str(tmp_path))
    assert result["is_multi_server"] is True
    names = [s["name"] for s in result["services"]]
    assert "backend" in names
    assert "frontend" in names
    backend = next(s for s in result["services"] if s["name"] == "backend")
    assert backend["kind"] == "python-fastapi"
    frontend_svc = next(s for s in result["services"] if s["name"] == "frontend")
    assert "vite" in frontend_svc["kind"]


def test_detect_multi_server_single_python_project_is_not_multi(tmp_path: Path) -> None:
    """A single FastAPI project with no frontend is NOT multi-server."""
    (tmp_path / "pyproject.toml").write_text('[project]\ndependencies=["fastapi"]\n')
    (tmp_path / "main.py").write_text("from fastapi import FastAPI\napp = FastAPI()\n")

    result = _detect_multi_server(str(tmp_path))
    assert result["is_multi_server"] is False


def test_detect_multi_server_makefile_with_multi_service_target(tmp_path: Path) -> None:
    """A Makefile with a 'dev' target mentioning backend + frontend
    upgrades a single-server project to multi-server (because the
    project is implicitly multi-process)."""
    (tmp_path / "pyproject.toml").write_text('[project]\ndependencies=["fastapi"]\n')
    (tmp_path / "main.py").write_text("from fastapi import FastAPI\napp = FastAPI()\n")
    (tmp_path / "Makefile").write_text(
        "dev:\n\t@echo starting backend\n\t@echo starting frontend\n"
    )

    result = _detect_multi_server(str(tmp_path))
    assert result["is_multi_server"] is True


def test_detect_multi_server_empty_project_is_not_multi(tmp_path: Path) -> None:
    """A project with no server and no frontend is not multi-server."""
    result = _detect_multi_server(str(tmp_path))
    assert result["is_multi_server"] is False


def test_detect_multi_server_injects_resource_into_context(tmp_path: Path) -> None:
    """When multi-server is detected, _build_resource_context includes
    resources/project-structure.md so the implement agent reads it."""
    # Build a multi-server project
    (tmp_path / "pyproject.toml").write_text('[project]\ndependencies=["fastapi"]\n')
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "package.json").write_text(
        json.dumps({"devDependencies": {"vite": "^5.0.0"}})
    )

    session = CodeSession("test-1", "x")
    session.project_root = str(tmp_path)
    session.server_info = {"is_server": True, "framework": "fastapi",
                           "entry_points": [], "evidence": "x"}
    # Force-detect by calling _apply_server_detection
    session.ideal_state = {
        "goal": "x",
        "success_criteria": ["x"],
        "verification": {},
    }
    _apply_server_detection(session)
    assert session.multi_server_info["is_multi_server"] is True

    ctx = _build_resource_context(session)
    assert "resources/project-structure.md" in ctx


def test_build_multi_server_block_lists_required_deliverables(tmp_path: Path) -> None:
    """The injected block must mention scripts/dev.sh, Makefile, README,
    and the SIGINT/SIGTERM traps so the implement agent knows what to ship."""
    session = CodeSession("test-1", "x")
    session.multi_server_info = {
        "is_multi_server": True,
        "services": [
            {"name": "backend", "kind": "python-fastapi",
             "command": "uvicorn app:app", "evidence": "x"},
            {"name": "frontend", "kind": "vite-dev-server",
             "command": "vite", "evidence": "y"},
        ],
    }
    block = _build_multi_server_block(session)
    assert "scripts/dev.sh" in block
    assert "Makefile" in block
    assert "SIGINT" in block and "SIGTERM" in block
    assert "/api/health" in block
    assert "--check" in block
    assert "README.md" in block
    assert "backend" in block
    assert "frontend" in block


def test_handle_implement_includes_multi_server_block_when_multi_server(
    tmp_path: Path,
) -> None:
    """When the ideal state has multi_server=True, handle_implement's
    task must include the multi-server deliverables block."""
    sys.path.insert(0, str(tmp_path))
    try:
        from orchestrate import handle_implement
    finally:
        sys.path.pop(0)

    session = CodeSession("test-ms", "fullstack app")
    session.language = "python"
    session.ideal_state = {
        "goal": "fullstack app",
        "success_criteria": ["x"],
        "verification": {
            "multi_server": True,
            "multi_server_services": [
                {"name": "backend", "kind": "python-fastapi", "command": "x", "evidence": "x"},
                {"name": "frontend", "kind": "vite", "command": "x", "evidence": "x"},
            ],
        },
    }
    session.server_info = {"is_server": True, "framework": "fastapi",
                           "entry_points": [], "evidence": "x"}
    # Even without running _apply_server_detection, the block fires if
    # the multi_server_info on the session is set:
    session.multi_server_info = {
        "is_multi_server": True,
        "services": session.ideal_state["verification"]["multi_server_services"],
    }

    result = handle_implement(session)
    task = result["task"]
    assert "MULTI-SERVER SINGLE-COMMAND STARTUP" in task
    assert "scripts/dev.sh" in task
    assert "Makefile" in task
