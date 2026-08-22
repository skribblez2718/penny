import shutil
from pathlib import Path

import pytest

from checks.check_skill_structure import check_skill

PROJECT_ROOT = Path(__file__).resolve().parents[4]
SOURCE_SKILL = PROJECT_ROOT / ".pi" / "skills" / "knowledge-base"


def copied_skill(tmp_path: Path) -> Path:
    target = tmp_path / "knowledge-base"
    shutil.copytree(SOURCE_SKILL, target)
    return target


def errors(skill: Path) -> list[str]:
    return [message for severity, message in check_skill(skill) if severity == "ERROR"]


def test_knowledge_base_skill_exact_contract_passes() -> None:
    assert errors(SOURCE_SKILL) == []


@pytest.mark.parametrize(
    "mutation",
    [
        "drop_parent_delivery",
        "reorder_invocations",
        "change_invocation_field_order",
        "reorder_actions",
        "reorder_penny_fields",
        "remove_order_failure_table",
    ],
)
def test_knowledge_base_skill_exact_contract_rejects_drift(tmp_path: Path, mutation: str) -> None:
    skill = copied_skill(tmp_path)
    skill_md = skill / "SKILL.md"
    content = skill_md.read_text(encoding="utf-8")

    if mutation == "drop_parent_delivery":
        content = (
            "\n".join(
                line
                for line in content.splitlines()
                if 'answer_delivery: "parent_tool_result"' not in line
            )
            + "\n"
        )
    elif mutation == "reorder_invocations":
        init = 'knowledge_base({schema_version: 1, action: "init"'
        ingest = 'knowledge_base({schema_version: 1, action: "ingest"'
        lines = content.splitlines()
        init_index = next(index for index, line in enumerate(lines) if line.startswith(init))
        ingest_index = next(index for index, line in enumerate(lines) if line.startswith(ingest))
        lines[init_index], lines[ingest_index] = lines[ingest_index], lines[init_index]
        content = "\n".join(lines) + "\n"
    elif mutation == "change_invocation_field_order":
        content = content.replace(
            'knowledge_base({schema_version: 1, action: "status", kb_profile_id: "kbp_demo", run_id: "run_1"})',
            'knowledge_base({action: "status", schema_version: 1, kb_profile_id: "kbp_demo", run_id: "run_1"})',
        )
    elif mutation == "reorder_actions":
        content = content.replace(
            "      - init\n      - ingest\n", "      - ingest\n      - init\n"
        )
    elif mutation == "reorder_penny_fields":
        content = content.replace(
            "    entrypoint: pi-tool\n    tool: knowledge_base\n",
            "    tool: knowledge_base\n    entrypoint: pi-tool\n",
        )
    elif mutation == "remove_order_failure_table":
        readme = skill / "README.md"
        readme.write_text(
            readme.read_text(encoding="utf-8").replace(
                "## Order rules and prevented failure modes",
                "## Workflow ordering",
            ),
            encoding="utf-8",
        )

    skill_md.write_text(content, encoding="utf-8")
    assert errors(skill), f"mutation {mutation!r} unexpectedly passed"
