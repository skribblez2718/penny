from checks.check_capability_registry import (
    DESCRIPTION_HARD_LIMIT,
    DESCRIPTION_PREFERRED_LIMIT,
    check_description,
)


def test_agent_description_accepts_semantic_routing_shape() -> None:
    errors, warnings = check_description(
        "fixture",
        {
            "description": (
                "Analyze supplied material. Use for comparisons and root-cause work. "
                "Do not use for discovering unknown external evidence."
            )
        },
    )

    assert errors == []
    assert warnings == []


def test_agent_description_requires_positive_and_negative_routes() -> None:
    errors, _warnings = check_description("fixture", {"description": "Analyze material."})

    assert any("positive routing clause" in error for error in errors)
    assert any("anti-case clause" in error for error in errors)


def test_agent_description_warns_above_preferred_target_but_allows_it() -> None:
    description = (
        "Analyze material. Use for comparisons. Do not use for discovery. "
        + "x" * DESCRIPTION_PREFERRED_LIMIT
    )
    errors, warnings = check_description("fixture", {"description": description})

    assert errors == []
    assert len(warnings) == 1
    assert "preferred target" in warnings[0]


def test_agent_description_rejects_hard_limit() -> None:
    description = (
        "Analyze material. Use for comparisons. Do not use for discovery. "
        + "x" * DESCRIPTION_HARD_LIMIT
    )
    errors, _warnings = check_description("fixture", {"description": description})

    assert any("hard limit" in error for error in errors)
