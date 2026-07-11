"""Tests for run_prompt_efficacy.probe_provider credential precedence.

Precedence is subscription-first: a stored credential in Pi's auth.json
(OAuth/subscription or key) is the PRIMARY check; an ``*_API_KEY`` environment
variable is the BACKUP. This mirrors how Penny authenticates — subscription by
default, rarely an API-key env var.
"""

import json

import run_prompt_efficacy as rpe


def _auth_dir(tmp_path, providers):
    """Create an agent dir with an auth.json holding OAuth-shaped entries."""
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir()
    entries = {p: {"type": "oauth", "refresh": "x", "access": "y", "expires": 0} for p in providers}
    (agent_dir / "auth.json").write_text(json.dumps(entries), encoding="utf-8")
    return agent_dir


def test_subscription_is_primary(tmp_path, monkeypatch):
    """auth.json entry alone (no env key) -> runnable."""
    agent_dir = _auth_dir(tmp_path, ["anthropic"])
    monkeypatch.setattr(rpe, "pi_agent_dir", lambda: agent_dir)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert rpe.probe_provider("anthropic") is None


def test_api_key_is_backup(tmp_path, monkeypatch):
    """No auth.json entry but an API-key env var -> runnable via the backup."""
    agent_dir = _auth_dir(tmp_path, [])  # empty auth.json
    monkeypatch.setattr(rpe, "pi_agent_dir", lambda: agent_dir)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    assert rpe.probe_provider("anthropic") is None


def test_neither_credential_skips_with_reason(tmp_path, monkeypatch):
    """No auth.json entry and no env key -> skip with an explanatory reason."""
    agent_dir = _auth_dir(tmp_path, [])
    monkeypatch.setattr(rpe, "pi_agent_dir", lambda: agent_dir)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    reason = rpe.probe_provider("anthropic")
    assert reason is not None
    assert "auth.json" in reason and "ANTHROPIC_API_KEY" in reason


def test_subscription_wins_when_both_present(tmp_path, monkeypatch):
    """Both present -> runnable; subscription is checked first, env is redundant."""
    agent_dir = _auth_dir(tmp_path, ["anthropic"])
    monkeypatch.setattr(rpe, "pi_agent_dir", lambda: agent_dir)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    assert rpe.probe_provider("anthropic") is None


def test_unknown_provider_assumed_runnable(tmp_path, monkeypatch):
    """A provider with no known key-env mapping and no auth entry stays runnable
    (unchanged behavior — the probe never invents a skip for unmapped providers)."""
    agent_dir = _auth_dir(tmp_path, [])
    monkeypatch.setattr(rpe, "pi_agent_dir", lambda: agent_dir)
    assert rpe.probe_provider("some-local-thing") is None
