"""Structural lookup regressions for the root-guidance extraction.

These checks preserve reachable source documents and upstream targets, not a particular
wording of natural-language triggers. Task applicability still needs a separate lookup
review; the AGENTS.md checker is not a semantic route resolver.
"""

from __future__ import annotations

import re
from itertools import pairwise
from pathlib import Path

import pytest

from checks.check_agents_links import ENTRY_RE, ROUTING_RE, tracked_files, validate_nested
from checks.check_markdown_links import document_errors

ROOT = Path(__file__).resolve().parents[4]

# The intended additions are explicit so these tests cover unstaged files without
# scanning ignored roots or changing the git index. This is a structural contract,
# not a semantic task router or proof of source-concept coverage.
CODING_GUIDES: dict[str, tuple[str, ...]] = {
    "": ("engineering-practice.md",),
    "design": ("modularity.md", "interfaces.md", "architecture.md"),
    "construction": ("readability.md", "routines-and-state.md", "errors-and-resources.md"),
    "testing": ("behavior.md", "diagnosis-and-performance.md"),
    "refactoring": (
        "safe-change.md",
        "smells.md",
        "local-transformations.md",
        "data-models.md",
        "conditions-and-calls.md",
        "generalization.md",
    ),
    "data-systems": (
        "authority-and-models.md",
        "storage-and-query.md",
        "replication-and-partitioning.md",
        "consistency-and-coordination.md",
        "evolution-and-repair.md",
        "processing-and-replay.md",
    ),
    "reliability": (
        "dependencies.md",
        "capacity-and-overload.md",
        "runtime-lifecycle.md",
        "observability-and-recovery.md",
    ),
}


def _coding_paths() -> set[str]:
    base = Path("docs/agents/coding")
    leaves = {str(base / group / name) for group, names in CODING_GUIDES.items() for name in names}
    return leaves | {str(base / group / "AGENTS.md") for group in CODING_GUIDES}


@pytest.mark.parametrize(
    "route",
    [
        ("AGENTS.md", "docs/agents/AGENTS.md", "docs/agents/pi-platform.md"),
        ("AGENTS.md", "docs/agents/AGENTS.md", "docs/agents/public-repository-boundary.md"),
        (
            "AGENTS.md",
            "docs/agents/AGENTS.md",
            "docs/agents/extensions/AGENTS.md",
            "docs/agents/extensions/extension-creation-procedure.md",
        ),
        (
            "AGENTS.md",
            "docs/agents/AGENTS.md",
            "docs/agents/coding/AGENTS.md",
            "docs/agents/coding/conventions.md",
        ),
        (
            "AGENTS.md",
            "docs/agents/AGENTS.md",
            "docs/agents/prompts/AGENTS.md",
            "docs/agents/prompts/cognitive-frame-standards.md",
        ),
        ("AGENTS.md", "docs/penny/AGENTS.md", "docs/penny/artifact-access.md"),
    ],
)
def test_source_documents_remain_reachable_through_direct_routes(route: tuple[str, ...]) -> None:
    for source, target in pairwise(route):
        source_path = ROOT / source
        entries = [
            entry
            for line in source_path.read_text(encoding="utf-8").splitlines()
            if (entry := ENTRY_RE.match(line))
            and (source_path.parent / entry.group("target")).resolve() == ROOT / target
        ]
        assert len(entries) == 1, f"Expected one route from {source} to {target}"
        assert ROUTING_RE.match(entries[0].group("desc")), f"Untyped route in {source}"
    assert (ROOT / route[-1]).is_file()


@pytest.mark.parametrize(
    "upstream_target",
    [
        "README.md",
        "docs/",
        "examples/",
        "docs/extensions.md",
        "examples/extensions/",
        "docs/themes.md",
        "docs/skills.md",
        "docs/prompt-templates.md",
        "docs/tui.md",
        "docs/keybindings.md",
        "docs/sdk.md",
        "docs/custom-provider.md",
        "docs/models.md",
        "docs/packages.md",
    ],
)
def test_upstream_lookup_targets_survive_relocation(upstream_target: str) -> None:
    text = (ROOT / "docs/agents/pi-platform.md").read_text(encoding="utf-8")
    assert upstream_target in re.findall(r"`([^`]+)`", text)


def test_agent_index_accepts_source_documents_alongside_feature_indexes() -> None:
    path = "docs/agents/AGENTS.md"
    text = (ROOT / path).read_text(encoding="utf-8")
    # Include the two expected additions even before staging; never scan private roots.
    tracked = set(tracked_files(ROOT)) | {
        "docs/agents/pi-platform.md",
        "docs/agents/public-repository-boundary.md",
    }
    assert validate_nested(path, text, tracked) == []

    # A passing real-document test needs an oracle: losing either new entry must fail.
    for target in ("pi-platform.md", "public-repository-boundary.md"):
        without_route = "\n".join(
            line
            for line in text.splitlines()
            if not ((entry := ENTRY_RE.match(line)) and entry.group("target") == target)
        )
        assert any(
            f"missing entry for direct child {target}" in error
            for error in validate_nested(path, without_route, tracked)
        )


@pytest.mark.parametrize("group", tuple(CODING_GUIDES))
def test_coding_indexes_cover_all_intended_children_before_staging(group: str) -> None:
    path = str(Path("docs/agents/coding") / group / "AGENTS.md")
    text = (ROOT / path).read_text(encoding="utf-8")
    intended = set(tracked_files(ROOT)) | _coding_paths()
    assert validate_nested(path, text, intended) == []

    # Removing an actual intended-child route must be detected, not merely leave
    # a passing positive fixture with an incomplete enumeration.
    for line in text.splitlines():
        entry = ENTRY_RE.match(line)
        if entry is None:
            continue
        target = entry.group("target")
        if str(Path(path).parent / target) not in _coding_paths():
            continue
        without_route = "\n".join(candidate for candidate in text.splitlines() if candidate != line)
        assert any(
            f"missing entry for direct child {target}" in error
            for error in validate_nested(path, without_route, intended)
        )


@pytest.mark.parametrize(
    "leaf", sorted(path for path in _coding_paths() if not path.endswith("/AGENTS.md"))
)
def test_intended_coding_guides_are_reachable_from_root(leaf: str) -> None:
    route = ["AGENTS.md", "docs/agents/AGENTS.md", "docs/agents/coding/AGENTS.md"]
    if Path(leaf).parent != Path("docs/agents/coding"):
        route.append(str(Path(leaf).parent / "AGENTS.md"))
    route.append(leaf)
    for source, target in pairwise(route):
        source_path = ROOT / source
        entries = [
            entry
            for line in source_path.read_text(encoding="utf-8").splitlines()
            if (entry := ENTRY_RE.match(line))
            and (source_path.parent / entry.group("target")).resolve() == ROOT / target
        ]
        assert len(entries) == 1, f"Expected one direct route from {source} to {target}"
        assert ROUTING_RE.match(entries[0].group("desc")), f"Untyped route in {source}"
    assert (ROOT / leaf).is_file()


@pytest.mark.parametrize(
    "path",
    sorted(
        _coding_paths()
        | {
            "docs/agents/coding/conventions.md",
            "docs/humans/coding/conventions.md",
        }
    ),
)
def test_intended_coding_document_links_resolve_before_staging(path: str) -> None:
    # Use the existing link/heading-anchor checker directly: its CLI intentionally
    # enumerates tracked paths only. No staged files or private discovery are needed.
    assert document_errors(ROOT, ROOT / path) == []
