from pathlib import Path
import sys

import pytest

import checks.check_skill_structure as structure
from checks.check_skill_structure import check_skill


def write_package(
    root: Path,
    *,
    disabled: bool | None = True,
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
    frontmatter = [
        "---",
        "name: fixture-skill",
        "description: Fixture workflow. Use when fixture validation is required. Do not use for direct work.",
    ]
    if disabled is not None:
        frontmatter.append(f"disable-model-invocation: {'true' if disabled else 'false'}")
    frontmatter.extend(
        [
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
    )
    (package / "SKILL.md").write_text("\n".join(frontmatter), encoding="utf-8")
    return package


def test_unified_package_accepts_manifest_without_lifecycle_metadata(tmp_path: Path) -> None:
    assert check_skill(write_package(tmp_path)) == []


def test_structure_rejects_retired_release_status_metadata(tmp_path: Path) -> None:
    issues = check_skill(write_package(tmp_path, retired_release_status=True))
    assert any(
        "must not declare retired metadata.penny.release_status" in message for _, message in issues
    )


def test_model_disable_flag_requires_omission_for_visible_packages(tmp_path: Path) -> None:
    visible = write_package(tmp_path / "visible", disabled=None)
    hidden = write_package(tmp_path / "hidden", disabled=True)
    invalid_visible = write_package(tmp_path / "invalid-visible", disabled=False)
    assert check_skill(visible) == []
    assert check_skill(hidden) == []
    assert any(
        "must omit 'disable-model-invocation'" in message
        for _, message in check_skill(invalid_visible)
    )


@pytest.mark.parametrize("disabled", [None, True])
def test_full_structure_validation_accepts_both_visibility_classes_without_extra_files(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    disabled: bool | None,
) -> None:
    write_package(tmp_path, disabled=disabled)
    assert {entry.name for entry in tmp_path.iterdir()} == {"fixture-skill"}
    monkeypatch.setattr(structure, "SKILLS_DIR", tmp_path)
    monkeypatch.setattr(sys, "argv", ["check_skill_structure.py"])
    with pytest.raises(SystemExit) as exited:
        structure.main()
    assert exited.value.code == 0
    assert "All 1 unified skill package(s) passed structural validation." in capsys.readouterr().out
