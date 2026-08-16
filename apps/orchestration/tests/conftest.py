"""Shared pytest fixtures for the orchestration test suite."""

import os

import pytest


@pytest.fixture(autouse=True)
def _clear_model_routing_env(monkeypatch, tmp_path):
    """Keep tests hermetic against operator model-routing and ablation settings.

    Research supports environment-driven model selection. Generic loop-judgment,
    capability-tier, uncertainty-retry, and loan-ablation switches can also alter
    control flow or spawn a live model. Tests set these variables explicitly when
    exercising those paths; ambient values are removed before every test.
    """
    prefixes = ("RESEARCH_", "PENNY_ABLATE_", "MEMPALACE_", "PENNY_MEMORY_")
    exact = {
        "PI_STALL_MODEL",
        "PI_STRATEGY_MODEL",
        "PI_GATE_INTENT_MODEL",
        "PI_MODEL_TIER",
        "PENNY_UNCERTAINTY_RETRY",
        "PI_MEMORY_BRIDGE",
        "PENNY_RECEIPT_HMAC_KEY",
        "PENNY_ARTIFACT_DISPATCH_MODE",
    }
    for key in list(os.environ):
        if key.startswith(prefixes) or key in exact:
            monkeypatch.delenv(key, raising=False)
    # Every test gets a private artifact plane and no ambient memory service.
    # Bare SUMMARYs remain available only through this explicitly test-named seam;
    # the production CLI does not set it and therefore requires protocol v2.
    monkeypatch.setenv("PENNY_ARTIFACT_ROOT", str((tmp_path / "artifacts").resolve()))
    monkeypatch.setenv("PENNY_RECEIPT_HMAC_KEY", "5a" * 32)
    monkeypatch.setenv("PENNY_ORCH_TEST_ALLOW_PROGRAMMATIC_RESULTS", "1")
