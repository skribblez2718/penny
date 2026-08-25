from pathlib import Path

from checks.check_skill_structure import (
    DESCRIPTION_HARD_LIMIT,
    DESCRIPTION_PREFERRED_LIMIT,
    check_skill,
)


def write_skill(root: Path, description: str) -> Path:
    skill = root / "fixture"
    (skill / "assets" / "prompts").mkdir(parents=True)
    (skill / "resources").mkdir()
    (skill / "README.md").write_text("# Fixture\n", encoding="utf-8")
    (skill / "assets" / "prompts" / "echo-run.md").write_text("# Mission\n", encoding="utf-8")
    (skill / "resources" / "flow.html").write_text("<!doctype html>\n", encoding="utf-8")
    (skill / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                "name: fixture",
                f'description: "{description}"',
                "metadata:",
                "  penny:",
                "    engine: orchestration",
                "---",
                "",
                "## When to Use",
                "",
                "- Relevant tasks.",
                "",
                "## When Not to Use",
                "",
                "- Direct tasks.",
                "",
                "## Invocation",
                "",
                '`skill({ skill_name: "fixture", goal: "..." })`',
            ]
        ),
        encoding="utf-8",
    )
    return skill


def routing_description(padding: int = 0) -> str:
    return (
        "Fixture workflow. Use when structured fixture work is required. "
        "Do not use for direct work. " + "x" * padding
    )


def test_skill_description_accepts_preferred_length(tmp_path: Path) -> None:
    issues = check_skill(write_skill(tmp_path, routing_description()))
    assert not [issue for issue in issues if "description" in issue[1]]


def test_skill_description_warns_above_preferred_target(tmp_path: Path) -> None:
    issues = check_skill(write_skill(tmp_path, routing_description(DESCRIPTION_PREFERRED_LIMIT)))
    assert any(severity == "WARN" and "preferred" in message for severity, message in issues)


def test_skill_description_rejects_hard_limit(tmp_path: Path) -> None:
    issues = check_skill(write_skill(tmp_path, routing_description(DESCRIPTION_HARD_LIMIT)))
    assert any(severity == "ERROR" and "hard limit" in message for severity, message in issues)
