from pathlib import Path

import pytest

import checks.check_skill_structure as structure
from checks.check_skill_structure import check_skill


def write_package(
    root: Path,
    *,
    disabled: bool = True,
    retired_release_status: bool = False,
) -> Path:
    package = root / "fixture-skill"
    (package / "assets" / "prompts").mkdir(parents=True)
    (package / "resources").mkdir()
    (package / "README.md").write_text("# Fixture skill\n", encoding="utf-8")
    (package / "assets" / "prompts" / "echo-run.md").write_text("# Mission\n", encoding="utf-8")
    (package / "resources" / "flow.html").write_text("<!doctype html>\n", encoding="utf-8")
    metadata = ["    engine: orchestration"]
    if retired_release_status:
        metadata.append("    release_status: candidate")
    (package / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                "name: fixture-skill",
                "description: Fixture workflow. Use when fixture validation is required. Do not use for direct work.",
                f"disable-model-invocation: {'true' if disabled else 'false'}",
                "metadata:",
                "  penny:",
                *metadata,
                "---",
                "",
                "## When to Use",
                "",
                "- Fixture tasks.",
                "",
                "## When Not to Use",
                "",
                "- Direct tasks.",
                "",
                "## Invocation",
                "",
                '`skill({ skill_name: "fixture-skill", goal: "..." })`',
            ]
        ),
        encoding="utf-8",
    )
    return package


def test_unified_package_accepts_manifest_without_lifecycle_metadata(tmp_path: Path) -> None:
    assert check_skill(write_package(tmp_path)) == []


def test_structure_rejects_retired_release_status_metadata(tmp_path: Path) -> None:
    issues = check_skill(write_package(tmp_path, retired_release_status=True))
    assert any(
        "must not declare retired metadata.penny.release_status" in message for _, message in issues
    )


def test_model_disable_flag_is_independent_of_structure_validity(tmp_path: Path) -> None:
    visible = write_package(tmp_path / "visible", disabled=False)
    hidden = write_package(tmp_path / "hidden", disabled=True)
    assert check_skill(visible) == []
    assert check_skill(hidden) == []


def test_native_ignore_accepts_comment_only_when_no_package_is_disabled(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(structure, "SKILLS_DIR", tmp_path)
    (tmp_path / ".ignore").write_text(
        "# Keep the safe native-discovery mirror present.\n", encoding="utf-8"
    )
    assert structure.check_native_model_ignore(set()) == []


def test_native_ignore_matches_explicit_model_disablement(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(structure, "SKILLS_DIR", tmp_path)
    (tmp_path / ".ignore").write_text("hidden-skill/\n", encoding="utf-8")
    assert structure.check_native_model_ignore({"hidden-skill"}) == []
    issues = structure.check_native_model_ignore(set())
    assert any("explicitly model-disabled" in message for _, message in issues)
