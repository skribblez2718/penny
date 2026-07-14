#!/usr/bin/env python3
"""Detector arms for the code_detection ablation.

- ``heuristic_detector`` wraps the existing hand-coded ``_detect_server_framework``
  (the scaffold under test).
- ``model_detector_factory`` builds a detector that shells to headless pi and asks
  the model to read the project files and report the same fields as JSON. The pi
  invocation mirrors the proven pattern in
  ``scripts/system/evals/prompt_efficacy_judge.py`` (``runner`` injectable for tests,
  so no live model call happens under unit test).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

# Fields the ablation grades.
FIELDS: List[str] = ["is_server", "language", "framework"]


# ── heuristic arm ───────────────────────────────────────────────────────────


def heuristic_detector(root: Path) -> Dict[str, Any]:
    """The current hand-coded, table-based detector (the scaffold under test)."""
    from orchestration.playbooks.code_detection import _detect_server_framework

    result = _detect_server_framework(str(root))
    return {
        "is_server": bool(result.get("is_server")),
        "language": result.get("language"),
        "framework": result.get("framework"),
    }


# ── model arm ─────────────────────────────────────────────────────────────────

DETECT_SYSTEM = (
    "You are a build-system detector. Given a project's files, decide whether it is a "
    "runnable web/HTTP server and, if so, which server framework and language. Judge only "
    "from the files shown. A CLI, library, or plain script is NOT a server. Output EXACTLY "
    "one JSON object and nothing else: "
    '{"is_server": true|false, "language": "python"|"typescript"|null, '
    '"framework": "<lowercase name>"|null}.'
)

_MANIFESTS = ("pyproject.toml", "package.json", "requirements.txt", "setup.py", "go.mod")
_SRC_SUFFIXES = {".py", ".ts", ".js", ".tsx", ".jsx", ".mjs"}
_SKIP_DIRS = {"node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".git"}
_MAX_FILES = 12
_MAX_BYTES = 4000

HERMETIC_FLAGS = [
    "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
    "--no-themes", "--no-context-files", "--no-tools",
]


def _read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8", errors="ignore")[:_MAX_BYTES]
    except OSError:
        return ""


def _collect_files(root: Path) -> List[Tuple[str, str]]:
    """Manifests first, then a bounded sample of source files."""
    out: List[Tuple[str, str]] = []
    for name in _MANIFESTS:
        p = root / name
        if p.is_file():
            out.append((name, _read(p)))
    for p in sorted(root.rglob("*")):
        if len(out) >= _MAX_FILES:
            break
        if not p.is_file() or p.suffix not in _SRC_SUFFIXES:
            continue
        if _SKIP_DIRS & {part.lower() for part in p.parts}:
            continue
        out.append((str(p.relative_to(root)), _read(p)))
    return out


def build_detect_prompt(root: Path) -> str:
    files = _collect_files(root)
    if not files:
        return "PROJECT FILES: (none found)"
    blocks = [f"----- {name} -----\n{content}" for name, content in files]
    return "PROJECT FILES:\n\n" + "\n\n".join(blocks)


def _last_assistant_text(stdout: str) -> Optional[str]:
    """Extract the last assistant text from a ``pi --mode json`` stream."""
    last: Optional[str] = None
    for line in (stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") != "message_end":
            continue
        message = event.get("message", event)
        if message.get("role") != "assistant" or message.get("stopReason") == "error":
            continue
        last = "".join(
            b.get("text", "")
            for b in message.get("content", [])
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return last


def _extract_json(text: str) -> Optional[Dict[str, Any]]:
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text or "", re.DOTALL)
    candidates = [fence.group(1)] if fence else []
    start = (text or "").find("{")
    if start != -1:
        candidates.append(text[start:])
    for cand in candidates:
        try:
            obj = json.loads(cand)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(obj, dict):
            return obj
    return None


def model_detector_factory(
    model: str = "anthropic/claude-haiku-4-5",
    *,
    timeout_s: int = 120,
    runner: Optional[Callable] = None,
) -> Callable[[Path], Dict[str, Any]]:
    """Build a detector that asks a model to read the project and report JSON.

    ``runner`` defaults to ``subprocess.run`` and is injected in tests so no live
    model call happens under unit test.
    """
    provider, model_id = model.split("/", 1)
    run = runner or subprocess.run
    hermetic_cwd = tempfile.mkdtemp(prefix="ablate-cd-")

    def detect(root: Path) -> Dict[str, Any]:
        prompt = build_detect_prompt(root)
        cmd = [
            "pi", "--mode", "json", "-p", *HERMETIC_FLAGS,
            "--provider", provider, "--model", model_id,
            "--thinking", "low", "--system-prompt", DETECT_SYSTEM, prompt,
        ]
        env = dict(os.environ)
        env["PI_SKIP_VERSION_CHECK"] = "1"
        proc = run(
            cmd, cwd=hermetic_cwd, env=env, stdin=subprocess.DEVNULL,
            capture_output=True, text=True, timeout=timeout_s,
        )
        text = _last_assistant_text(getattr(proc, "stdout", "") or "")
        if text is None:
            raise RuntimeError("no assistant message (or stopReason=error)")
        obj = _extract_json(text)
        if obj is None:
            raise RuntimeError(f"unparseable detection JSON: {text[:120]!r}")
        return {
            "is_server": bool(obj.get("is_server")),
            "language": obj.get("language") or None,
            "framework": obj.get("framework") or None,
        }

    return detect
