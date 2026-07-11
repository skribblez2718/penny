"""Framework-detection helpers for the code playbook.

Pure, side-effect-free detectors extracted verbatim from the legacy code
skill (``.pi/skills/code/scripts/orchestrate.py``). They inspect a project
directory for server / AI / web-UI / multi-server signals and drive the
injection of server-startup and single-command-dev verification tiers.

The three public entry points (``apply_server_detection``,
``build_resource_context``, ``build_multi_server_block``) operate on the
orchestration engine's ``RunContext`` (``ctx``) rather than the legacy
``CodeSession``: they read/write the code playbook's domain state under
``ctx.extras["code"]``. The resource-file paths they emit still point at
``.pi/skills/code/resources/*`` — those resource files stay in the skill dir.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

# Map of framework names to the dep tokens that signal their presence.
# Used by ``_detect_server_framework`` to decide whether a project is a
# server. Keep this list aligned with what the integration-test guidance
# in resources/server-startup-tests.md covers.
_PYTHON_SERVER_DEPS: dict[str, list[str]] = {
    "fastapi": ["fastapi", "starlette"],
    "flask": ["flask"],
    "django": ["django"],
    "starlette": ["starlette"],
    "litestar": ["litestar"],
}

_TS_SERVER_DEPS: dict[str, list[str]] = {
    "express": ["express"],
    "fastify": ["fastify"],
    "next": ["next"],
    "koa": ["koa"],
    "hapi": ["@hapi/hapi", "hapi"],
    "nestjs": ["@nestjs/core", "@nestjs/common"],
}


def _detect_server_framework(project_root: str) -> dict:  # noqa: C901
    """Inspect the project to detect whether it is a server project.

    Returns a dict describing the server (or ``{"is_server": False}`` if
    none is detected). The orchestrator uses this to inject server-
    startup verification requirements into the ideal state and the
    plan/implement/verify task prompts.

    The check is intentionally shallow: we look for known server
    frameworks in the dependency manifest (pyproject.toml, package.json)
    AND for entry-point files that look like servers (e.g. ``app =
    FastAPI(...)`` or ``app = Flask(__name__)``). Any single hit is
    enough to mark the project as a server.

    Detection fields:
        is_server      -- True if any server signal was found
        language       -- "python" or "typescript" (best guess)
        framework      -- canonical framework name (e.g. "fastapi")
        entry_points   -- absolute paths to suspect entry-point files
        evidence       -- human-readable summary of what triggered the
                          detection (used for logging / debugging)
    """
    if not project_root:
        return {"is_server": False}

    root = Path(project_root)
    if not root.is_dir():
        return {"is_server": False}

    # Detect language from project files (was _detect_language, now inlined)
    detected_language = "python"  # default
    if (root / "pyproject.toml").exists() or (root / "setup.py").exists():
        detected_language = "python"
    elif (root / "tsconfig.json").exists() or (root / "package.json").exists():
        detected_language = "typescript"
    detected_framework: str | None = None
    entry_points: list[str] = []
    evidence: list[str] = []

    # --- Python: inspect pyproject.toml --------------------------------
    pyproject = root / "pyproject.toml"
    if pyproject.is_file():
        try:
            content = pyproject.read_text(encoding="utf-8").lower()
        except OSError:
            content = ""
        for framework, tokens in _PYTHON_SERVER_DEPS.items():
            if any(tok in content for tok in tokens):
                detected_framework = framework
                detected_language = "python"
                evidence.append(f"{framework} found in pyproject.toml")
                break

    # --- TypeScript: inspect package.json ------------------------------
    pkg_json = root / "package.json"
    if detected_framework is None and pkg_json.is_file():
        try:
            import json as _json

            with pkg_json.open(encoding="utf-8") as f:
                pkg = _json.load(f)
            all_deps: dict = {}
            all_deps.update(pkg.get("dependencies", {}))
            all_deps.update(pkg.get("devDependencies", {}))
            for framework, tokens in _TS_SERVER_DEPS.items():
                if any(tok in all_deps for tok in tokens):
                    detected_framework = framework
                    detected_language = "typescript"
                    evidence.append(f"{framework} found in package.json")
                    break
        except (OSError, ValueError):
            pass

    # --- Fallback: scan source files for framework imports -------------
    # If no manifest hit, look for direct framework imports inside .py
    # and .ts/.js files. This catches projects that pin deps elsewhere
    # (e.g. requirements.txt) or that the user wrote without a manifest.
    if detected_framework is None:
        scan_exts: dict[str, list[tuple[str, str]]] = {
            ".py": [
                ("fastapi", "fastapi"),
                ("flask", "flask"),
                ("django", "django"),
                ("starlette", "starlette"),
            ],
            ".ts": [
                ("express", "express"),
                ("fastify", "fastify"),
                ("next", "next"),
                ("koa", "koa"),
            ],
            ".js": [
                ("express", "express"),
                ("fastify", "fastify"),
                ("next", "next"),
                ("koa", "koa"),
            ],
        }
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix not in scan_exts:
                continue
            # Skip obvious noise — node_modules, venvs, caches, etc.
            parts_lower = {p.lower() for p in path.parts}
            if parts_lower & {
                "node_modules",
                ".venv",
                "venv",
                "__pycache__",
                ".pytest_cache",
                ".mypy_cache",
                ".ruff_cache",
                "dist",
                "build",
            }:
                continue
            try:
                content = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for framework, token in scan_exts[path.suffix]:
                # Look for `from fastapi import ...` or `import fastapi`
                # in Python, and `from "express"` / `require("express")`
                # in JS/TS.
                if path.suffix == ".py":
                    if (
                        f"import {token}" in content
                        or f"from {token} " in content
                        or f"from {token}\n" in content
                    ):
                        detected_framework = framework
                        detected_language = "python" if path.suffix == ".py" else "typescript"
                        evidence.append(f"{framework} import found in {path.relative_to(root)}")
                        break
                else:
                    if (
                        f"from '{token}'" in content
                        or f'from "{token}"' in content
                        or f"require('{token}')" in content
                        or f'require("{token}")' in content
                    ):
                        detected_framework = framework
                        detected_language = "typescript"
                        evidence.append(f"{framework} import found in {path.relative_to(root)}")
                        break
            if detected_framework is not None:
                break

    # --- Identify entry-point files ------------------------------------
    # A reasonable entry point is any non-test source file that creates
    # the framework's app object (e.g. ``app = FastAPI(...)`` for
    # FastAPI, ``app = Flask(__name__)`` for Flask) or that lives in a
    # top-level directory named ``backend``, ``server``, ``api``, or
    # ``src``.
    if detected_framework is not None:
        candidate_names = {
            "fastapi": ["main.py", "app.py", "server.py", "api.py"],
            "flask": ["main.py", "app.py", "server.py", "wsgi.py"],
            "django": ["manage.py", "wsgi.py", "asgi.py"],
            "starlette": ["main.py", "app.py"],
            "litestar": ["main.py", "app.py"],
            "express": ["server.js", "server.ts", "app.js", "app.ts", "index.js", "index.ts"],
            "fastify": ["server.js", "server.ts", "app.js", "app.ts"],
            "next": ["next.config.js", "next.config.ts"],
            "koa": ["server.js", "server.ts", "app.js", "app.ts"],
            "hapi": ["server.js", "app.js"],
            "nestjs": ["main.ts", "main.js"],
        }
        names_to_check = candidate_names.get(detected_framework, [])

        # 1) Files in a backend/server/api/src directory
        for sub in ("backend", "server", "api", "src", "app"):
            sub_path = root / sub
            if not sub_path.is_dir():
                continue
            for path in sub_path.rglob("*"):
                if (
                    path.is_file()
                    and path.suffix in {".py", ".ts", ".js"}
                    and not any(
                        p in path.parts for p in ("tests", "test", "__tests__", "__pycache__")
                    )
                    and path.name in names_to_check
                ):
                    entry_points.append(str(path.resolve()))

        # 2) Top-level files with the candidate names
        for name in names_to_check:
            path = root / name
            if path.is_file():
                entry_points.append(str(path.resolve()))

    if detected_framework is None:
        return {"is_server": False}

    return {
        "is_server": True,
        "language": detected_language,
        "framework": detected_framework,
        "entry_points": sorted(set(entry_points)),
        "evidence": " | ".join(evidence) if evidence else "(no evidence captured)",
    }


# Map of AI framework dep tokens used by _detect_ai_framework.
_AI_DEPS: dict[str, list[str]] = {
    "huggingface": ["transformers", "huggingface", "accelerate", "peft"],
    "openai": ["openai"],
    "anthropic": ["anthropic"],
    "langchain": ["langchain", "langgraph"],
    "llamacpp": ["llama-cpp-python", "llama_cpp"],
    "ollama": ["ollama"],
    "torch": ["torch"],  # PyTorch is a strong AI signal when combined with other clues
}

_WEB_UI_DEPS: dict[str, list[str]] = {
    "react": ["react"],
    "vue": ["vue"],
    "svelte": ["svelte"],
    "nextjs": ["next"],
    "htmx": ["htmx"],
    "gradio": ["gradio"],
    "dash": ["dash"],
}


def _detect_ai_framework(project_root: str) -> dict:  # noqa: C901
    """Detect whether a project integrates an AI/ML model.

    Inspects pyproject.toml / requirements.txt for known AI framework
    imports. Returns a dict with the same shape as
    ``_detect_server_framework`` so the orchestrator can inject
    AI-specific guidance (generation params, streaming, prompt design)
    into the plan/implement phases.
    """
    if not project_root:
        return {"is_ai": False}
    root = Path(project_root)
    if not root.is_dir():
        return {"is_ai": False}

    found: list[str] = []

    for manifest_name in ("pyproject.toml", "requirements.txt", "Pipfile"):
        manifest = root / manifest_name
        if not manifest.is_file():
            continue
        try:
            content = manifest.read_text(encoding="utf-8").lower()
        except OSError:
            continue
        for framework, tokens in _AI_DEPS.items():
            if framework in found:
                continue
            if any(tok in content for tok in tokens):
                found.append(framework)

    # Also scan source files for direct import statements
    for pattern in ("**/*.py", "**/*.ts", "**/*.tsx"):
        for src in root.glob(pattern):
            if "__pycache__" in str(src) or "node_modules" in str(src):
                continue
            try:
                content = src.read_text(encoding="utf-8").lower()
            except OSError:
                continue
            for framework, tokens in _AI_DEPS.items():
                if framework in found:
                    continue
                for tok in tokens:
                    if f"import {tok}" in content or f"from {tok}" in content:
                        found.append(framework)
                        break
            if len(found) >= len(_AI_DEPS):
                break

    if not found:
        return {"is_ai": False}
    return {
        "is_ai": True,
        "frameworks": found,
        "evidence": f"Found AI frameworks: {', '.join(sorted(found))}",
    }


def _detect_web_ui_framework(project_root: str) -> dict:  # noqa: C901
    """Detect whether a project includes a web frontend UI.

    Same detection pattern as ``_detect_server_framework`` but looks for
    frontend frameworks. Returns ``is_web_ui`` + detected frameworks.
    """
    if not project_root:
        return {"is_web_ui": False}
    root = Path(project_root)
    if not root.is_dir():
        return {"is_web_ui": False}

    # Check frontend-specific config files first (strong signals)
    for config_file in ("package.json", "tsconfig.json"):
        config = root / config_file
        if config.is_file():
            try:
                content = config.read_text(encoding="utf-8").lower()
            except OSError:
                continue
            if "react" in content:
                return {
                    "is_web_ui": True,
                    "frameworks": ["react"],
                    "evidence": f"react in {config_file}",
                }
            if "vue" in content:
                return {
                    "is_web_ui": True,
                    "frameworks": ["vue"],
                    "evidence": f"vue in {config_file}",
                }
            if "next" in content:
                return {
                    "is_web_ui": True,
                    "frameworks": ["nextjs"],
                    "evidence": f"next in {config_file}",
                }
            # Lit is matched precisely (not a bare 'lit' substring, which would
            # collide with names like eslint / @lit-labs internals unrelated to UI).
            if '"lit"' in content or "lit-element" in content or "lit-html" in content:
                return {
                    "is_web_ui": True,
                    "frameworks": ["lit"],
                    "evidence": f"lit in {config_file}",
                }
            if "tailwindcss" in content:
                return {
                    "is_web_ui": True,
                    "frameworks": ["tailwind"],
                    "evidence": f"tailwindcss in {config_file}",
                }

    # Check python manifests for UI frameworks
    for manifest_name in ("pyproject.toml", "requirements.txt"):
        manifest = root / manifest_name
        if not manifest.is_file():
            continue
        try:
            content = manifest.read_text(encoding="utf-8").lower()
        except OSError:
            continue
        found = []
        for framework, tokens in _WEB_UI_DEPS.items():
            if any(tok in content for tok in tokens):
                found.append(framework)
        if found:
            return {
                "is_web_ui": True,
                "frameworks": found,
                "evidence": f"UI frameworks in {manifest_name}: {', '.join(found)}",
            }

    # Scan JS/TS source for Lit imports (when no dependency manifest lists it).
    # Tokens are matched precisely to avoid a bare 'lit' substring collision.
    _lit_import_tokens = (
        'from "lit"',
        "from 'lit'",
        'from "lit/',
        "from 'lit/",
        "lit-element",
        "lit-html",
    )
    for pattern in ("**/*.ts", "**/*.js", "**/*.mjs", "**/*.tsx", "**/*.jsx"):
        for src in root.glob(pattern):
            if "node_modules" in str(src) or "__pycache__" in str(src):
                continue
            try:
                content = src.read_text(encoding="utf-8").lower()
            except OSError:
                continue
            if any(tok in content for tok in _lit_import_tokens):
                return {
                    "is_web_ui": True,
                    "frameworks": ["lit"],
                    "evidence": f"lit import in {src.name}",
                }

    return {"is_web_ui": False}


# Known dev-server / build-server frameworks in package.json. Their
# presence (under scripts.dev or scripts.start) is a strong signal
# that a subdirectory hosts a long-running dev server.
_JS_DEV_SERVER_DEPS: dict[str, list[str]] = {
    "vite": ["vite"],
    "webpack": ["webpack", "webpack-dev-server"],
    "next": ["next"],
    "nuxt": ["nuxt"],
    "remix": ["@remix-run/dev", "remix"],
    "astro": ["astro"],
    "sveltekit": ["@sveltejs/kit"],
    "parcel": ["parcel"],
    "rollup": ["rollup", "vite"],
    "esbuild": ["esbuild"],
    "expo": ["expo"],  # mobile dev server
    "react-native": ["react-native"],
}

# Subdirectories commonly used to hold a frontend app, in priority order.
_FRONTEND_DIR_CANDIDATES = (
    "frontend",
    "web",
    "client",
    "ui",
    "app",
    "apps/web",
    "apps/client",
    "packages/web",
    "packages/frontend",
)


def _detect_multi_server(project_root: str) -> dict:  # noqa: C901
    """Detect whether the project requires multiple long-running processes.

    A project is multi-server if it has:
      (a) a Python server framework (fastapi/flask/django/starlette/
          litestar) at the root AND a frontend dev server in a subdir
          (frontend/, web/, client/, etc.), OR
      (b) two server frameworks at the root (e.g. Python backend + Node
          API), OR
      (c) an explicit multi-process manager present (Makefile with a
          'dev' target that references ≥ 2 services, or Procfile with
          ≥ 2 entries).

    This drives injection of resources/project-structure.md, which
    enforces the single-command startup rule. The detector is
    intentionally conservative: a single-server project is never
    misclassified as multi-server, and a multi-server project is only
    flagged when at least two distinct long-running processes are
    present.

    Returns:
        {
            "is_multi_server": bool,
            "services": [
                {"name": str, "kind": str, "command": str, "evidence": str}
            ],
            "evidence": str,
        }
    """
    if not project_root:
        return {"is_multi_server": False}
    root = Path(project_root)
    if not root.is_dir():
        return {"is_multi_server": False}

    services: list[dict] = []

    # --- (a) Python server at the root ---------------------------------
    py_server = _detect_server_framework(project_root)
    if py_server.get("is_server"):
        framework = py_server.get("framework", "server")
        # Pick a sensible default command
        if framework in ("fastapi", "starlette", "litestar"):
            default_cmd = "uvicorn app.main:app --reload"
        elif framework == "flask":
            default_cmd = "flask --app app.main run --reload"
        elif framework == "django":
            default_cmd = "python manage.py runserver"
        else:
            default_cmd = f"<run {framework} server>"
        services.append(
            {
                "name": "backend",
                "kind": f"python-{framework}",
                "command": default_cmd,
                "evidence": py_server.get("evidence", ""),
            }
        )

    # --- (a) Node server at the root (rare but possible) ---------------
    # Reuse the python-detector's manifest logic: look for server deps
    # in a top-level package.json (not under a frontend/ subdir).
    pkg = root / "package.json"
    if pkg.is_file():
        try:
            with pkg.open(encoding="utf-8") as f:
                pkg_data = json.load(f)
        except (OSError, ValueError):
            pkg_data = {}
        all_deps: dict = {}
        all_deps.update(pkg_data.get("dependencies", {}))
        all_deps.update(pkg_data.get("devDependencies", {}))
        for framework, tokens in _TS_SERVER_DEPS.items():
            if any(tok in all_deps for tok in tokens):
                # Skip if this package.json also has a "dev" script that
                # looks like a dev server (those are detected below).
                scripts = pkg_data.get("scripts", {}) or {}
                has_dev_server = any(
                    _script_looks_like_dev_server(script) for script in scripts.values()
                )
                if not has_dev_server:
                    services.append(
                        {
                            "name": framework,
                            "kind": f"node-{framework}",
                            "command": scripts.get("dev")
                            or scripts.get("start")
                            or f"<run {framework}>",
                            "evidence": f"{framework} in root package.json",
                        }
                    )
                break

    # --- (a) Frontend dev server in a subdir ----------------------------
    for sub in _FRONTEND_DIR_CANDIDATES:
        sub_path = root / sub
        if not sub_path.is_dir():
            continue
        sub_pkg = sub_path / "package.json"
        if not sub_pkg.is_file():
            continue
        try:
            with sub_pkg.open(encoding="utf-8") as f:
                sub_pkg_data = json.load(f)
        except (OSError, ValueError):
            continue
        sub_deps: dict = {}
        sub_deps.update(sub_pkg_data.get("dependencies", {}))
        sub_deps.update(sub_pkg_data.get("devDependencies", {}))
        sub_scripts = sub_pkg_data.get("scripts", {}) or {}
        for framework, tokens in _JS_DEV_SERVER_DEPS.items():
            if any(tok in sub_deps for tok in tokens):
                dev_script = sub_scripts.get("dev") or sub_scripts.get("start") or ""
                services.append(
                    {
                        "name": sub,
                        "kind": f"{framework}-dev-server",
                        "command": dev_script or f"<run {framework}>",
                        "evidence": f"{framework} in {sub}/package.json",
                    }
                )
                break
        # Only one frontend subdir counts (don't double-count monorepos)
        if services and services[-1]["name"] == sub:
            break

    # --- (c) Explicit multi-process manager present --------------------
    has_explicit_manager = False
    # Makefile with a 'dev' target that mentions ≥ 2 service names
    makefile = root / "Makefile"
    if makefile.is_file():
        try:
            content = makefile.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            content = ""
        if re.search(r"^dev\s*:", content, re.MULTILINE):
            # Cheap heuristic: if the file mentions two or more of
            # (backend, frontend, server, worker, web, api) it counts.
            names = ("backend", "frontend", "server", "worker", "web", "api", "client")
            hits = sum(1 for n in names if re.search(rf"\b{n}\b", content, re.IGNORECASE))
            if hits >= 2:
                has_explicit_manager = True
    # Procfile with ≥ 2 process types
    procfile = root / "Procfile"
    if procfile.is_file():
        try:
            proc_content = procfile.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            proc_content = ""
        proc_lines = [
            ln
            for ln in proc_content.splitlines()
            if ln.strip() and not ln.strip().startswith("#") and ":" in ln
        ]
        if len(proc_lines) >= 2:
            has_explicit_manager = True
    # scripts/dev.sh that backgrounds ≥ 2 services
    dev_script_path = root / "scripts" / "dev.sh"
    if dev_script_path.is_file():
        try:
            dev_content = dev_script_path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            dev_content = ""
        # Count `start_*` invocations — a strong signal of multi-process.
        if len(re.findall(r"^start_\w+\s*\(\s*\)", dev_content, re.MULTILINE)) >= 2:
            has_explicit_manager = True

    # --- Decision -------------------------------------------------------
    # Multi-server = at least 2 detected services, OR 1 service plus
    # an explicit multi-process manager.
    is_multi = len(services) >= 2 or (len(services) >= 1 and has_explicit_manager)
    if not is_multi:
        return {"is_multi_server": False}

    if has_explicit_manager and len(services) < 2:
        services.append(
            {
                "name": "(manager)",
                "kind": "multi-process-manager",
                "command": "see Makefile / Procfile / scripts/dev.sh",
                "evidence": "explicit multi-process manager detected",
            }
        )

    return {
        "is_multi_server": True,
        "services": services,
        "evidence": " | ".join(s["evidence"] for s in services) or "multi-server heuristic",
    }


def _script_looks_like_dev_server(script_body: str) -> bool:
    """Cheap heuristic: does this npm script look like it starts a long-running
    dev server (as opposed to a one-shot build/test/lint command)?"""
    if not script_body:
        return False
    body = script_body.lower()
    indicators = (
        "vite",
        "webpack",
        "next dev",
        "nuxt",
        "remix",
        "astro dev",
        "svelte-kit dev",
        "expo start",
        "react-native start",
        "parcel",
        "rollup -w",
        "esbuild --watch",
        "nodemon",
    )
    return any(tok in body for tok in indicators)


# ============================================================
# Public entry points (operate on the engine's RunContext)
# ============================================================
#
# The code playbook stores its domain state under ``ctx.extras["code"]``,
# a dict with keys: ``ideal_state`` (dict), ``language`` (str),
# ``server_info`` (dict), ``multi_server_info`` (dict).


def apply_server_detection(ctx) -> None:
    """Detect a server framework in the project and update ``ctx.extras["code"]``.

    Port of the legacy ``_apply_server_detection``. Called after the ideal
    state is built. Populates ``code["server_info"]`` and flips
    ``code["ideal_state"]["verification"]["server_startup"]`` to True if a
    server framework is found. Multi-server detection runs unconditionally
    and populates ``code["multi_server_info"]`` + the ``multi_server`` flag.
    """
    if not ctx.project_root:
        # No project root known (e.g. very early in a session) — skip.
        return
    code = ctx.extras.setdefault("code", {})
    info = _detect_server_framework(ctx.project_root)
    code["server_info"] = info
    if info.get("is_server"):
        # Auto-enable the server-startup verification tier. Both Penny
        # (during PRD synthesis) and Synthia (during fixup) can override
        # this in the ideal_state, but the orchestrator will re-assert
        # it after detection to ensure it is never silently dropped.
        verification = code.setdefault("ideal_state", {}).setdefault("verification", {})
        verification["server_startup"] = True
        verification.setdefault("server_framework", info.get("framework"))
        verification.setdefault("server_entry_points", info.get("entry_points", []))
        verification.setdefault("server_evidence", info.get("evidence", ""))

    # Multi-server detection runs unconditionally — even non-server
    # projects can be multi-server (a Python CLI + a worker, two
    # backends, etc.). The detector decides. Result populates
    # code["multi_server_info"] and flips the multi_server flag in
    # ideal_state.verification so the plan/implement phases know.
    ms_info = _detect_multi_server(ctx.project_root)
    code["multi_server_info"] = ms_info
    if ms_info.get("is_multi_server"):
        verification = code.setdefault("ideal_state", {}).setdefault("verification", {})
        verification["multi_server"] = True
        verification.setdefault("multi_server_services", ms_info.get("services", []))
        verification.setdefault("multi_server_evidence", ms_info.get("evidence", ""))


def build_resource_context(ctx) -> str:
    """Return a string of resource-file paths to inject into agent tasks.

    Adapts the legacy ``_build_resource_context``: reads ``server_info`` /
    ``multi_server_info`` from ``ctx.extras["code"]`` (instead of the legacy
    ``session``), then returns a newline-separated list of resource paths the
    agent should read before starting work.
    """
    code = ctx.extras.get("code", {})
    resources: list[str] = []

    # Security checklist is always mandatory
    resources.append("resources/security-checklist.md")

    # Resilience patterns are always applicable
    resources.append("resources/resilience.md")

    # Server detection — inject server-startup tests resource
    if code.get("server_info", {}).get("is_server"):
        resources.append("resources/server-startup-tests.md")

    # Multi-server detection — inject the project-structure rule so the
    # implement/plan agents know to set up a single-command dev script.
    if code.get("multi_server_info", {}).get("is_multi_server"):
        resources.append("resources/project-structure.md")

    # AI detection — inject AI application checklist
    project_root = ctx.project_root or str(Path.cwd())
    ai_info = _detect_ai_framework(project_root)
    if ai_info.get("is_ai"):
        resources.append("resources/ai-application.md")

    # Web UI detection — inject UI checklist
    webui_info = _detect_web_ui_framework(project_root)
    if webui_info.get("is_web_ui"):
        resources.append("resources/web-ui.md")

    if not resources:
        return ""
    return (
        "MANDATORY: Before writing any code, read the following project-specific "
        "resources (use the read tool):\n" + "\n".join(f"  - {r}" for r in resources)
    )


def build_multi_server_block(ctx) -> str:
    """Return an inject-able task block enforcing the single-command dev rule.

    Adapts the legacy ``_build_multi_server_block``: fires only when
    ``ctx.extras["code"]["multi_server_info"]`` reports multi-server. The
    block tells the agent exactly which services were detected and which
    deliverables are required (Makefile, scripts/dev.sh, etc.).
    """
    info = ctx.extras.get("code", {}).get("multi_server_info", {})
    if not info.get("is_multi_server"):
        return ""

    services = info.get("services", [])
    if not services:
        return ""

    svc_lines = "\n".join(
        f"   - {s.get('name', '?')}: kind={s.get('kind', '?')}  command=`{s.get('command', '?')}`  evidence: {s.get('evidence', '?')}"
        for s in services
    )
    return (
        "\n\nMULTI-SERVER SINGLE-COMMAND STARTUP (MANDATORY):\n"
        "This project ships more than one long-running process. Per the rule in "
        ".pi/skills/code/resources/project-structure.md, the project MUST be "
        "set up so every server can be started with a single command. The "
        "implement phase MUST produce ALL of the following deliverables — "
        "the verify phase will fail if any are missing:\n"
        "\n"
        f"Detected services:\n{svc_lines}\n"
        "\n"
        "Required deliverables (in priority order):\n"
        "  1. `scripts/dev.sh` — executable bash script that starts every "
        "service in the background, traps SIGINT and SIGTERM, and tears down "
        "every child PID on exit. Must wait for the backend to respond to "
        "`/api/health` (or equivalent) before tailing logs. Per-service logs go "
        "to `$LOG_DIR/<service>.log`. Must support a `--check` mode that exits "
        "0 if all services are healthy, 1 otherwise.\n"
        "  2. `scripts/test.sh` — runs all test suites (backend unit + "
        "integration + frontend vitest + tsc), exits non-zero on any failure.\n"
        "  3. `Makefile` — thin wrappers: `make dev`, `make check`, `make test`, "
        "`make install`, `make stop`, `make clean`. The `dev` target invokes "
        "`scripts/dev.sh`; the README documents `./scripts/dev.sh` as the "
        "no-make fallback.\n"
        "  4. `.gitignore` — add `.run-logs/` (the dev script's log dir) and "
        "any `*.pid` files it creates.\n"
        "  5. `README.md` — replace any 'open two terminals' instructions with "
        "`make dev` (or `./scripts/dev.sh`). Document the make targets.\n"
        "\n"
        "The dev script MUST:\n"
        "  - Track every child PID in an array; do NOT rely on process groups "
        "(signaling your own PGID re-fires your own trap).\n"
        "  - Trap SIGINT and SIGTERM; on either, kill each tracked PID, "
        "sleep 0.7s, then SIGKILL any survivors.\n"
        "  - Health-probe each service after start with a deadline; fail the "
        "script (with the last log lines) if any service doesn't respond in "
        "time. This is the only reliable way to surface 'port already in use' "
        "or 'dependency not installed' early.\n"
        "  - Forward logs to per-service files (not stdout) and tail them in a "
        "background `tail -F` so the user sees activity.\n"
        "  - Use `set -euo pipefail` and fail fast on any error.\n"
        "\n"
        "The verify phase will run `scripts/dev.sh --check` and assert exit 0, "
        "then send SIGTERM and assert both ports are free within 5s. If either "
        "fails, the project is incomplete.\n"
    )
