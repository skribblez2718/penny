"""Shared test fixtures for the observability backend.

Test isolation from the ambient project .env: ``observability/config.py`` loads
the Penny root ``.env`` at import, which may set ``PI_OBSERVABILITY_API_KEY``
and flip auth on. Integration tests that assume open access would then get 401.
Baseline every test to auth-disabled; tests that need auth on monkeypatch
``Config.API_KEY`` themselves (autouse runs first, so their override wins).
"""

import pytest

from observability.config import Config


@pytest.fixture(autouse=True)
def _neutralize_ambient_auth(monkeypatch):
    monkeypatch.delenv("PI_OBSERVABILITY_API_KEY", raising=False)
    monkeypatch.setattr(Config, "API_KEY", "", raising=False)
    yield
