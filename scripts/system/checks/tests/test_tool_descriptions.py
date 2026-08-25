from pathlib import Path

from checks.check_tool_descriptions import find_invisible_guidance


def test_accepts_provider_visible_descriptions(tmp_path: Path) -> None:
    extension = tmp_path / "visible" / "index.ts"
    extension.parent.mkdir()
    extension.write_text(
        'pi.registerTool({ name: "x", description: "What. Use when relevant. Do not use otherwise." });\n',
        encoding="utf-8",
    )

    assert find_invisible_guidance(tmp_path) == []


def test_rejects_prompt_guidelines_in_runtime_source(tmp_path: Path) -> None:
    extension = tmp_path / "hidden" / "index.ts"
    extension.parent.mkdir()
    extension.write_text(
        'pi.registerTool({ name: "x", description: "What", promptGuidelines: ["Use x"] });\n',
        encoding="utf-8",
    )

    issues = find_invisible_guidance(tmp_path)
    assert len(issues) == 1
    assert "promptGuidelines is invisible" in issues[0]


def test_ignores_test_fixtures_and_dependencies(tmp_path: Path) -> None:
    for relative in ("sample/tests/tool.test.ts", "sample/node_modules/package/index.ts"):
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("promptGuidelines: []\n", encoding="utf-8")

    assert find_invisible_guidance(tmp_path) == []
