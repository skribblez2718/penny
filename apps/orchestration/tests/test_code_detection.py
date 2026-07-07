"""Unit tests for the framework-detection helpers in the code playbook.

These port the pure-function tests from the legacy code skill
(``.pi/skills/code/tests/test_server_detection.py``) onto the orchestration
engine's ``code_detection`` module. Tests that referenced the legacy
``CodeSession``, the ``handle_*`` phase handlers, ``start()`` or the CLI are
NOT ported here — those are exercised elsewhere. The ``apply_server_detection``
/ ``build_*`` entry points are covered with fresh tests that drive a minimal
RunContext-shaped object (``types.SimpleNamespace`` with ``.project_root`` and
``.extras``).
"""

from __future__ import annotations

import json
import textwrap
import types
from pathlib import Path

from orchestration.playbooks import code_detection


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(content).lstrip(), encoding="utf-8")


def _ctx(tmp_path: Path):
    """Minimal RunContext-shaped stub for the public entry points."""
    return types.SimpleNamespace(
        project_root=str(tmp_path),
        goal="",
        extras={"code": {"ideal_state": {}}},
    )


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

    info = code_detection._detect_server_framework(str(tmp_path))
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

    info = code_detection._detect_server_framework(str(tmp_path))
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

    info = code_detection._detect_server_framework(str(tmp_path))
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

    info = code_detection._detect_server_framework(str(tmp_path))
    assert info["is_server"] is True
    assert info["framework"] == "django"


def test_detect_express_in_package_json(tmp_path: Path) -> None:
    """express in package.json triggers detection."""
    pkg = {
        "name": "web",
        "dependencies": {"express": "^4.18.0"},
    }
    (tmp_path / "package.json").write_text(json.dumps(pkg), encoding="utf-8")

    info = code_detection._detect_server_framework(str(tmp_path))
    assert info["is_server"] is True
    assert info["framework"] == "express"
    assert info["language"] == "typescript"


def test_detect_fastify_in_package_json(tmp_path: Path) -> None:
    pkg = {"name": "api", "dependencies": {"fastify": "^4.0.0"}}
    (tmp_path / "package.json").write_text(json.dumps(pkg), encoding="utf-8")

    info = code_detection._detect_server_framework(str(tmp_path))
    assert info["is_server"] is True
    assert info["framework"] == "fastify"


def test_detect_nestjs_in_package_json(tmp_path: Path) -> None:
    pkg = {
        "name": "api",
        "dependencies": {"@nestjs/core": "^10.0.0"},
    }
    (tmp_path / "package.json").write_text(json.dumps(pkg), encoding="utf-8")

    info = code_detection._detect_server_framework(str(tmp_path))
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

    info = code_detection._detect_server_framework(str(tmp_path))
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

    info = code_detection._detect_server_framework(str(tmp_path))
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

    info = code_detection._detect_server_framework(str(tmp_path))
    assert info["is_server"] is True
    assert any("backend" in ep and "main.py" in ep for ep in info["entry_points"])


def test_detect_handles_empty_project_root() -> None:
    """Empty project_root returns is_server=False without raising."""
    info = code_detection._detect_server_framework("")
    assert info["is_server"] is False


def test_detect_handles_nonexistent_project_root(tmp_path: Path) -> None:
    """Nonexistent project_root returns is_server=False without raising."""
    info = code_detection._detect_server_framework(str(tmp_path / "does-not-exist"))
    assert info["is_server"] is False


# ---------------------------------------------------------------------------
# _detect_multi_server
# ---------------------------------------------------------------------------


def test_detect_multi_server_python_backend_with_vite_frontend(tmp_path: Path) -> None:
    """Python FastAPI backend + a frontend/ dir with Vite = multi-server."""
    (tmp_path / "pyproject.toml").write_text('[project]\nname="x"\ndependencies=["fastapi"]\n')
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "package.json").write_text(
        json.dumps(
            {
                "name": "fe",
                "devDependencies": {"vite": "^5.0.0"},
                "scripts": {"dev": "vite"},
            }
        )
    )

    result = code_detection._detect_multi_server(str(tmp_path))
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

    result = code_detection._detect_multi_server(str(tmp_path))
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

    result = code_detection._detect_multi_server(str(tmp_path))
    assert result["is_multi_server"] is True


def test_detect_multi_server_empty_project_is_not_multi(tmp_path: Path) -> None:
    """A project with no server and no frontend is not multi-server."""
    result = code_detection._detect_multi_server(str(tmp_path))
    assert result["is_multi_server"] is False


# ---------------------------------------------------------------------------
# _script_looks_like_dev_server
# ---------------------------------------------------------------------------


def test_script_looks_like_dev_server_detects_dev_servers() -> None:
    assert code_detection._script_looks_like_dev_server("vite") is True
    assert code_detection._script_looks_like_dev_server("next dev") is True
    assert code_detection._script_looks_like_dev_server("nodemon server.js") is True


def test_script_looks_like_dev_server_rejects_one_shot() -> None:
    assert code_detection._script_looks_like_dev_server("") is False
    assert code_detection._script_looks_like_dev_server("tsc --noEmit") is False
    assert code_detection._script_looks_like_dev_server("eslint .") is False


# ---------------------------------------------------------------------------
# apply_server_detection (RunContext entry point)
# ---------------------------------------------------------------------------


def test_apply_server_detection_sets_flag(tmp_path: Path) -> None:
    """apply_server_detection flips verification.server_startup for servers."""
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

    ctx = _ctx(tmp_path)
    ctx.extras["code"]["ideal_state"] = {
        "goal": "Build API",
        "success_criteria": [],
        "verification": {"lint": True, "type_check": True, "unit_tests": True},
    }

    code_detection.apply_server_detection(ctx)

    code = ctx.extras["code"]
    assert code["server_info"].get("is_server") is True
    verification = code["ideal_state"]["verification"]
    assert verification["server_startup"] is True
    assert verification["server_framework"] == "fastapi"
    assert any("backend" in ep for ep in verification["server_entry_points"])


def test_apply_server_detection_noop_for_non_server(tmp_path: Path) -> None:
    """apply_server_detection leaves verification alone for non-servers."""
    _write(
        tmp_path / "pyproject.toml",
        """
        [project]
        dependencies = ["click", "rich"]
        """,
    )

    ctx = _ctx(tmp_path)
    ctx.extras["code"]["ideal_state"] = {
        "goal": "Build CLI",
        "success_criteria": [],
        "verification": {"lint": True, "type_check": True, "unit_tests": True},
    }

    code_detection.apply_server_detection(ctx)

    code = ctx.extras["code"]
    assert code["server_info"].get("is_server") is False
    assert code["ideal_state"]["verification"].get("server_startup", False) is False


def test_apply_server_detection_noop_without_project_root() -> None:
    """No project_root -> no code state is populated."""
    ctx = types.SimpleNamespace(project_root="", goal="", extras={"code": {"ideal_state": {}}})
    code_detection.apply_server_detection(ctx)
    assert "server_info" not in ctx.extras["code"]
    assert "multi_server_info" not in ctx.extras["code"]


# ---------------------------------------------------------------------------
# build_resource_context / build_multi_server_block (RunContext entry points)
# ---------------------------------------------------------------------------


def test_build_resource_context_injects_multi_server_resource(tmp_path: Path) -> None:
    """When multi-server is detected, build_resource_context includes
    resources/project-structure.md so the implement agent reads it."""
    (tmp_path / "pyproject.toml").write_text('[project]\ndependencies=["fastapi"]\n')
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "package.json").write_text(json.dumps({"devDependencies": {"vite": "^5.0.0"}}))

    ctx = _ctx(tmp_path)
    ctx.extras["code"]["ideal_state"] = {
        "goal": "x",
        "success_criteria": ["x"],
        "verification": {},
    }
    code_detection.apply_server_detection(ctx)
    assert ctx.extras["code"]["multi_server_info"]["is_multi_server"] is True

    resource_ctx = code_detection.build_resource_context(ctx)
    assert "resources/security-checklist.md" in resource_ctx
    assert "resources/server-startup-tests.md" in resource_ctx
    assert "resources/project-structure.md" in resource_ctx


def test_build_multi_server_block_lists_required_deliverables(tmp_path: Path) -> None:
    """The injected block must mention scripts/dev.sh, Makefile, README,
    and the SIGINT/SIGTERM traps so the implement agent knows what to ship."""
    ctx = _ctx(tmp_path)
    ctx.extras["code"]["multi_server_info"] = {
        "is_multi_server": True,
        "services": [
            {
                "name": "backend",
                "kind": "python-fastapi",
                "command": "uvicorn app:app",
                "evidence": "x",
            },
            {"name": "frontend", "kind": "vite-dev-server", "command": "vite", "evidence": "y"},
        ],
    }
    block = code_detection.build_multi_server_block(ctx)
    assert "scripts/dev.sh" in block
    assert "Makefile" in block
    assert "SIGINT" in block and "SIGTERM" in block
    assert "/api/health" in block
    assert "--check" in block
    assert "README.md" in block
    assert "backend" in block
    assert "frontend" in block


def test_build_multi_server_block_empty_when_not_multi(tmp_path: Path) -> None:
    """No block is emitted when the project is not multi-server."""
    ctx = _ctx(tmp_path)
    ctx.extras["code"]["multi_server_info"] = {"is_multi_server": False}
    assert code_detection.build_multi_server_block(ctx) == ""
