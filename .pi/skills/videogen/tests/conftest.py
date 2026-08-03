"""Shared, side-effect-free fixtures for the videogen helper test suite."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest


@pytest.fixture(scope="session")
def videogen_tests_root() -> Path:
    return Path(__file__).resolve().parent


@pytest.fixture(scope="session")
def videogen_scripts_dir(videogen_tests_root: Path) -> Path:
    return videogen_tests_root.parent / "scripts"


@pytest.fixture(scope="session")
def qa_fixtures_dir(videogen_tests_root: Path) -> Path:
    return videogen_tests_root / "fixtures" / "qa"


@pytest.fixture
def load_qa_fixture(qa_fixtures_dir: Path):
    def load(name: str) -> dict[str, Any]:
        value = json.loads((qa_fixtures_dir / name).read_text(encoding="utf-8"))
        assert isinstance(value, dict)
        return value

    return load
