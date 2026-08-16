from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

GENERATOR = Path(__file__).parents[2] / "generate_docx.py"


@pytest.fixture(scope="session")
def wordgen() -> ModuleType:
    spec = importlib.util.spec_from_file_location("penny_word_generate_docx", GENERATOR)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module
