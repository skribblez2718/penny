"""Shared pytest fixtures for the orchestration test suite."""

import os

import pytest


@pytest.fixture(autouse=True)
def _clear_skill_model_routing_env(monkeypatch):
    """Keep playbook tests hermetic against the operator's ``.env``.

    The jsa/sca skills support env-driven per-agent model routing
    (``JSA_<AGENT>`` / ``JSA_DEFAULT`` / ``SCA_*`` = ``provider/model``), read by
    ``model_for_state``. A developer's ambient ``.env`` (e.g.
    ``JSA_DEFAULT=ollama/glm``) would otherwise flip ``model_for_state`` and break
    tests that assert the *code's* default (no model override). Clear those keys
    before every test; tests that exercise routing set them explicitly via
    ``monkeypatch.setenv`` (which applies after this autouse fixture).

    The same hazard applies to the model-JUDGMENT and loan-ablation switches. With
    ``PI_STALL_MODEL`` / ``PI_STRATEGY_MODEL`` / ``PI_GATE_INTENT_MODEL`` set, the loop
    guards and gate parser stop comparing strings and SPAWN A LIVE MODEL mid-test —
    slow, flaky, and it inverts the very behaviour the guard tests assert.
    ``PI_MODEL_TIER`` rescales budgets, and ``PENNY_ABLATE_*`` disables tagged loans.
    All are cleared so the suite tests the CODE's defaults; tests that exercise them
    set them explicitly via ``monkeypatch.setenv``.

    ``PENNY_UNCERTAINTY_RETRY`` belongs here for a sharper reason than the rest: it
    changes WHEN the HITL seam fires for every skill (an UNCERTAIN step gets one
    bounded compute retry before reaching a human), so with it ambient in the
    environment, every "UNCERTAIN escalates" test in the suite asserts the wrong thing.
    Measured: 10 such tests across 5 skills fail with it set. Clearing it keeps the
    suite testing the DEFAULT (dormant) configuration; the enabled path is covered
    generically by ``test_uncertainty_retry.py``, which sets it explicitly.

    """
    _PREFIXES = ("JSA_", "SCA_", "PENNY_ABLATE_")
    _EXACT = {
        "PI_STALL_MODEL",
        "PI_STRATEGY_MODEL",
        "PI_GATE_INTENT_MODEL",
        "PI_CODE_DETECT_MODEL",
        "PI_MODEL_TIER",
        "PENNY_UNCERTAINTY_RETRY",
    }
    for key in list(os.environ):
        if key.startswith(_PREFIXES) or key in _EXACT:
            monkeypatch.delenv(key, raising=False)
