from pathlib import Path

import pytest

import checks.check_skill_structure as structure
from checks.check_skill_structure import check_skill


def write_package(
    root: Path,
    *,
    release_status: str = "candidate",
    disabled: bool = True,
) -> Path:
    package = root / "fixture-candidate"
    (package / "assets" / "prompts").mkdir(parents=True)
    (package / "resources").mkdir()
    (package / "README.md").write_text("# Fixture candidate\n", encoding="utf-8")
    (package / "assets" / "prompts" / "echo-run.md").write_text("# Mission\n", encoding="utf-8")
    (package / "resources" / "flow.html").write_text("<!doctype html>\n", encoding="utf-8")
    (package / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                "name: fixture-candidate",
                "description: Fixture candidate workflow. Use when fixture evaluation is required. Do not use for direct work.",
                f"disable-model-invocation: {'true' if disabled else 'false'}",
                "metadata:",
                "  penny:",
                "    engine: orchestration",
                f"    release_status: {release_status}",
                "---",
                "",
                "## When to Use",
                "",
                "- Candidate fixture tasks.",
                "",
                "## When Not to Use",
                "",
                "- Direct tasks.",
                "",
                "## Invocation",
                "",
                '`skill({ skill_name: "fixture-candidate", goal: "..." })`',
            ]
        ),
        encoding="utf-8",
    )
    return package


def test_unified_package_accepts_closed_candidate_manifest(tmp_path: Path) -> None:
    assert check_skill(write_package(tmp_path)) == []


def test_candidate_registry_namespace_rejects_production_status(tmp_path: Path) -> None:
    issues = check_skill(write_package(tmp_path, release_status="production"), "candidate")
    assert any(severity == "ERROR" and "release status" in message for severity, message in issues)


def test_model_visibility_is_independent_of_release_status(tmp_path: Path) -> None:
    visible_candidate = write_package(tmp_path / "visible-candidate", disabled=False)
    hidden_production = write_package(
        tmp_path / "hidden-production", release_status="production", disabled=True
    )
    assert check_skill(visible_candidate) == []
    assert check_skill(hidden_production) == []


def test_native_ignore_accepts_comment_only_when_no_package_is_disabled(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(structure, "SKILLS_DIR", tmp_path)
    (tmp_path / ".ignore").write_text(
        "# Keep the safe native-discovery mirror present.\n", encoding="utf-8"
    )
    assert structure.check_native_model_ignore(set()) == []


def test_native_ignore_matches_explicit_model_disablement_not_release_status(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(structure, "SKILLS_DIR", tmp_path)
    (tmp_path / ".ignore").write_text("production-hidden/\n", encoding="utf-8")
    assert structure.check_native_model_ignore({"production-hidden"}) == []
    issues = structure.check_native_model_ignore(set())
    assert any("explicitly model-disabled" in message for _, message in issues)


def configure_source_guard(monkeypatch: pytest.MonkeyPatch, root: Path) -> Path:
    active = root / "active"
    active.mkdir(parents=True)
    retired = root / ".pi" / structure.RETIRED_CANDIDATE_DIRNAME
    monkeypatch.setattr(structure, "PROJECT_ROOT", root)
    monkeypatch.setattr(structure, "RETIRED_CANDIDATE_ROOT", retired)
    monkeypatch.setattr(structure, "SOURCE_GUARD_ROOTS", [active])
    monkeypatch.setattr(structure, "CURRENT_RESEARCH_DOCS", [])
    monkeypatch.setattr(structure, "HISTORICAL_BINDING_TEST", root / "historical-binding.ts")
    return active


def test_source_guard_rejects_retired_directory(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    configure_source_guard(monkeypatch, tmp_path)
    structure.RETIRED_CANDIDATE_ROOT.mkdir(parents=True)
    issues = structure.check_single_skill_source_root()
    assert any("source root exists" in message for _, message in issues)


def test_source_guard_rejects_active_retired_path_bytes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    active = configure_source_guard(monkeypatch, tmp_path)
    token = f".pi/{structure.RETIRED_CANDIDATE_DIRNAME}"
    (active / "binding.ts").write_text(f'const path = "{token}/fixture";\n', encoding="utf-8")
    issues = structure.check_single_skill_source_root()
    assert any("active source introduces" in message for _, message in issues)


def test_source_guard_allows_marked_frozen_binding_test(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    active = configure_source_guard(monkeypatch, tmp_path)
    historical = active / "historical-binding.ts"
    monkeypatch.setattr(structure, "HISTORICAL_BINDING_TEST", historical)
    token = f".pi/{structure.RETIRED_CANDIDATE_DIRNAME}"
    historical.write_text(
        f'// {structure.HISTORICAL_ROOT_MARKER}\nconst path = "{token}/fixture";\n',
        encoding="utf-8",
    )
    assert structure.check_single_skill_source_root() == []
