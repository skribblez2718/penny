"""Invariant: every filesystem path a playbook hands an agent is ABSOLUTE.

WHY THIS EXISTS
---------------
An agent subprocess is spawned with ``cwd = project_root`` — the TARGET repo the skill
operates on (``skill/index.ts`` passes ``projectRoot`` as the agent cwd;
``agent-runner.ts`` spawns with ``cwd: cwd ?? defaultCwd``). For ``code`` / ``sca`` /
``jsa`` / ``learn`` / ``manim`` / ``prd`` runs, that is NOT this repo.

A repo-relative path in a task message therefore resolves against the wrong tree — and
it does not fail loudly. The agent simply cannot read the file and continues without
it. That is how ``code``'s **mandatory** ``resources/security-checklist.md`` silently
failed to load on every foreign-repo run (found 2026-07-28).

THE RULE: build agent-facing paths with ``orchestration.paths`` (``skill_file`` /
``penny_file`` / ``skill_root`` / ``penny_root``), never as a bare relative literal.

HOW THE CHECK WORKS
-------------------
Playbook sources are parsed with ``ast`` and every string constant is inspected.
Docstrings are exempt (prose about the codebase is fine). A path-looking literal is a
violation UNLESS it begins with ``/`` — which is exactly what a correctly-built
f-string fragment looks like: ``f"{skill_file(...)}/resources/x.md"`` yields the
constant ``"/resources/x.md"``, while the broken form yields ``"resources/x.md"``.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

_PLAYBOOKS = Path(__file__).resolve().parents[1] / "src" / "orchestration" / "playbooks"

# Markers that make a string literal "path-looking" for agent-facing purposes.
_PATH_MARKERS = (
    ".pi/skills/",
    "docs/agents/",
    "resources/",
    "scripts/",
)

# Literals that are legitimately relative because they are NOT agent-facing paths:
# they name a repo location in prose, or are path *components* joined by paths.py.
_ALLOW = {
    "resources/",  # bare component used in joins
    "scripts/",
}

# Explicit opt-out for a path that is deliberately relative to the TARGET repo — a
# deliverable the agent CREATES there (e.g. `scripts/dev.sh`), not a file it reads from
# this repo. Annotate the line (or the line above) with this marker. Requiring the
# annotation keeps the distinction intentional and reviewable instead of ambient.
_OPT_OUT = "agent-path: target-relative"


def _playbook_files() -> list[Path]:
    return sorted(p for p in _PLAYBOOKS.glob("*.py") if p.name != "__init__.py")


def _docstring_nodes(tree: ast.AST) -> set[int]:
    """id() of every Constant node that is a module/class/function docstring."""
    out: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                out.add(id(body[0].value))
    return out


def _violations(path: Path) -> list[str]:
    source = path.read_text(encoding="utf-8")
    lines = source.splitlines()
    tree = ast.parse(source)
    docstrings = _docstring_nodes(tree)
    bad: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        if id(node) in docstrings:
            continue
        text = node.value
        if text in _ALLOW:
            continue
        if not any(m in text for m in _PATH_MARKERS):
            continue
        # A correctly-built fragment follows an interpolated absolute root, so the
        # literal part starts with "/". A bare relative path does not.
        if text.lstrip().startswith("/"):
            continue
        # Declared target-repo-relative (a deliverable the agent creates there).
        window = lines[max(0, node.lineno - 2) : node.end_lineno or node.lineno]
        if any(_OPT_OUT in ln for ln in window):
            continue
        bad.append(f"{path.name}:{node.lineno}: {text[:110]!r}")
    return bad


@pytest.mark.parametrize("path", _playbook_files(), ids=lambda p: p.name)
def test_playbook_hands_agents_no_relative_paths(path):
    bad = _violations(path)
    assert not bad, (
        "Relative filesystem path(s) in playbook source. An agent's cwd is the TARGET "
        "repo, so these resolve into the wrong tree and are SILENTLY unreadable. Build "
        "them with orchestration.paths (skill_file / penny_file):\n  "
        + "\n  ".join(bad)
    )


def test_paths_helpers_return_absolute_or_empty():
    from orchestration.paths import penny_file, penny_root, skill_file, skill_root

    assert penny_root().startswith("/")
    assert skill_root(None, "prd").startswith("/")
    assert skill_file(None, "code", "resources", "security-checklist.md").startswith("/")
    assert penny_file("docs", "agents").startswith("/")
    # An unresolvable skill yields "" (caller omits the reference) — never a relative path.
    assert skill_root(None, "no-such-skill-xyz") == ""
    assert skill_file(None, "no-such-skill-xyz", "resources", "x.md") == ""


def test_constraint_supplied_skill_dir_wins(tmp_path):
    from orchestration.context import RunContext
    from orchestration.paths import skill_root

    real = tmp_path / "custom-skill"
    real.mkdir()
    ctx = RunContext(
        session_id="s", run_id="r", playbook="prd", constraints={"skill_dir": str(real)}
    )
    assert skill_root(ctx, "prd") == str(real)


def test_code_mandatory_resources_are_absolute_on_a_foreign_project_root():
    """The regression that motivated this file: code's MANDATORY security checklist."""
    from orchestration.context import RunContext
    from orchestration.playbooks import code_detection

    ctx = RunContext(
        session_id="s", run_id="r", playbook="code", project_root="/srv/some-other-repo"
    )
    ctx.extras["code"] = {"language": "python"}
    text = code_detection.build_resource_context(ctx)
    assert "security-checklist.md" in text
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("- "):
            assert stripped[2:].startswith("/"), f"non-absolute resource path: {stripped}"
