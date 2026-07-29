"""Absolute path resolution for agent-facing text.

WHY THIS EXISTS
---------------
An agent subprocess is spawned with ``cwd = project_root`` — the TARGET repo a skill
is operating on (``.pi/extensions/skill/index.ts`` passes ``projectRoot`` as the agent
cwd; ``agent-runner.ts`` spawns with ``cwd: cwd ?? defaultCwd``). For ``code`` /
``sca`` / ``jsa`` / ``learn`` / ``manim`` runs that directory is NOT this repo.

So any repo-relative path written into a task message — ``resources/rubric.md``,
``.pi/skills/code/resources/security-checklist.md``, ``docs/agents/secure-coding/…`` —
resolves against the wrong tree. It does not raise: the agent simply cannot read the
file and proceeds WITHOUT the guidance, which is how a *mandatory* security checklist
can silently fail to load on every foreign-repo run.

Every path handed to an agent must therefore be ABSOLUTE. There are two roots:

* :func:`skill_root`  — the skill's own directory (``resources/``, ``scripts/``).
  Authoritative source is ``constraints["skill_dir"]``, injected for every run by the
  skill driver, which is the only component that knows ``skill.path`` for certain.
* :func:`penny_root` — Penny's own repo (``docs/``, top-level ``scripts/``). This is
  ``$PROJECT_ROOT``, deliberately distinct from the per-run target ``project_root``.

Both are best-effort and never raise: a resolution failure yields ``""`` and the
caller omits the reference rather than emitting a broken relative path.
"""

from __future__ import annotations

import os
from pathlib import Path

from .context import RunContext

_PENNY_MARKERS = (".pi", "apps/orchestration")


def penny_root() -> str:
    """Absolute path to Penny's own repo root, or ``""``.

    ``$PROJECT_ROOT`` (.env) wins — it is the Penny-global anchor, the same constant
    the checkpointer and outcome ledger use. Never the per-run target ``project_root``.
    Falls back to walking up from this module to a directory carrying Penny's markers.
    """
    env = os.environ.get("PROJECT_ROOT", "").strip()
    if env and Path(env).is_dir():
        return str(Path(env).resolve())
    try:
        for parent in Path(__file__).resolve().parents:
            if all((parent / m).exists() for m in _PENNY_MARKERS):
                return str(parent)
    except Exception:  # noqa: BLE001 — best-effort resolution
        return ""
    return ""


def skill_root(ctx: RunContext | None, skill_name: str) -> str:
    """Absolute path to ``.pi/skills/<skill_name>``, or ``""``.

    Precedence: the driver-injected (or caller-supplied) ``constraints["skill_dir"]``,
    then a walk-up from this module. The constraint is authoritative because the TS
    driver resolves the skill by path; the walk-up is the offline/test fallback.
    """
    if ctx is not None:
        supplied = str((getattr(ctx, "constraints", None) or {}).get("skill_dir", "")).strip()
        if supplied and Path(supplied).is_dir():
            return str(Path(supplied).resolve())
    root = penny_root()
    if root:
        cand = Path(root) / ".pi" / "skills" / skill_name
        if cand.is_dir():
            return str(cand)
    try:
        for parent in Path(__file__).resolve().parents:
            cand = parent / ".pi" / "skills" / skill_name
            if cand.is_dir():
                return str(cand)
    except Exception:  # noqa: BLE001 — best-effort resolution
        return ""
    return ""


def skill_file(ctx: RunContext | None, skill_name: str, *parts: str) -> str:
    """Absolute path to a file inside a skill dir (e.g. ``resources/rubric.md``), or ``""``.

    Returns ``""`` when the skill root cannot be resolved, so a caller can omit a
    reference instead of emitting a path the agent will fail to read.
    """
    root = skill_root(ctx, skill_name)
    return str(Path(root).joinpath(*parts)) if root else ""


def penny_file(*parts: str) -> str:
    """Absolute path to a file inside Penny's repo (e.g. ``docs/agents/...``), or ``""``."""
    root = penny_root()
    return str(Path(root).joinpath(*parts)) if root else ""
