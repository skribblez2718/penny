"""Invariant: every repository path a playbook hands an agent is absolute.

Agent subprocesses run with the target repository as their working directory.
A relative path to Penny-owned guidance can therefore resolve against the wrong
tree without failing loud. Playbooks must build such paths with
``orchestration.paths``.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

_PLAYBOOKS = Path(__file__).resolve().parents[1] / "src" / "orchestration" / "playbooks"
_PATH_MARKERS = (".pi/skills/", "docs/agents/", "resources/", "scripts/")
_ALLOW = {"resources/", "scripts/"}
_OPT_OUT = "agent-path: target-relative"


def _playbook_files() -> list[Path]:
    return sorted(path for path in _PLAYBOOKS.glob("*.py") if path.name != "__init__.py")


def _docstring_nodes(tree: ast.AST) -> set[int]:
    """Return IDs of constants used as module, class, or function docstrings."""
    out: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(
            node,
            (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef),
        ):
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
        if id(node) in docstrings or node.value in _ALLOW:
            continue
        if not any(marker in node.value for marker in _PATH_MARKERS):
            continue
        if node.value.lstrip().startswith("/"):
            continue
        window = lines[max(0, node.lineno - 2) : node.end_lineno or node.lineno]
        if any(_OPT_OUT in line for line in window):
            continue
        bad.append(f"{path.name}:{node.lineno}: {node.value[:110]!r}")
    return bad


@pytest.mark.parametrize("path", _playbook_files(), ids=lambda path: path.name)
def test_playbook_hands_agents_no_relative_paths(path):
    bad = _violations(path)
    assert not bad, (
        "Relative filesystem path(s) in playbook source. Build Penny-owned paths "
        "with orchestration.paths:\n  " + "\n  ".join(bad)
    )


def test_paths_helpers_return_absolute_or_empty():
    from orchestration.paths import penny_file, penny_root, skill_file, skill_root

    assert penny_root().startswith("/")
    assert skill_root(None, "research").startswith("/")
    assert skill_file(None, "research", "resources", "flow.html").startswith("/")
    assert penny_file("docs", "agents").startswith("/")
    assert skill_root(None, "no-such-skill-xyz") == ""
    assert skill_file(None, "no-such-skill-xyz", "resources", "x.md") == ""


def test_constraint_supplied_skill_dir_wins(tmp_path):
    from orchestration.context import RunContext
    from orchestration.paths import skill_root

    supplied = tmp_path / "custom-skill"
    supplied.mkdir()
    ctx = RunContext(
        session_id="s",
        run_id="r",
        playbook="research",
        constraints={"skill_dir": str(supplied)},
    )
    assert skill_root(ctx, "research") == str(supplied)


def test_every_directive_states_the_absolute_skill_root(tmp_path):
    from orchestration.checkpointer import Checkpointer
    from orchestration.playbooks.research import ResearchPlaybook

    checkpointer = Checkpointer(db_path=tmp_path / "o.db")
    directive = ResearchPlaybook(checkpointer).start(
        session_id="s",
        run_id="r",
        goal="research a thing",
        project_root="/srv/some-other-repo",
    )
    task = directive["task_summary"]
    assert "Skill root (ABSOLUTE):" in task
    root_line = next(
        line for line in task.splitlines() if line.startswith("Skill root (ABSOLUTE):")
    )
    root = root_line.split(":", 1)[1].strip()
    assert root.startswith("/") and root.endswith("/.pi/skills/research")
    assert not root.startswith("/srv/some-other-repo")


def test_skill_root_line_is_empty_when_unresolvable():
    from orchestration.context import RunContext
    from orchestration.engine import BasePlaybook

    class _Unknown(BasePlaybook):
        NAME = "no-such-skill-xyz"

    ctx = RunContext(session_id="s", run_id="r", playbook="no-such-skill-xyz")
    assert _Unknown(None)._skill_root_line(ctx) == ""
