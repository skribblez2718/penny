"""Headless-pi harness helpers for the trajectory runner.

Relocated here (verbatim, minus dead branches) when the eval producers that
originally hosted them were removed; the trajectory runner is now their only
consumer. Behavior is unchanged.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.request import urlopen

OLLAMA_PROBE_URL = "http://127.0.0.1:11434/api/version"
PROVIDER_KEY_ENV = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "minimax": "MINIMAX_API_KEY",
    "zai": "ZAI_API_KEY",
    "kimi": "KIMI_API_KEY",
    "groq": "GROQ_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}

VERDICT_RE = re.compile(r"verdict\s*[:\-]\s*(pass|fail)", re.IGNORECASE)


def pi_agent_dir() -> Path:
    """The pi config dir headless runs read (PI_CODING_AGENT_DIR or ~/.pi/agent)."""
    override = os.environ.get("PI_CODING_AGENT_DIR")
    return Path(override) if override else Path.home() / ".pi" / "agent"


def contaminating_global_prompts() -> List[Path]:
    """Global prompt files that would contaminate a hermetic headless run.

    Runs pass an explicit --system-prompt, so a global ~/.pi/agent/SYSTEM.md
    cannot silently replace it. Only a global APPEND_SYSTEM.md still
    contaminates: it is appended to EVERY run regardless of --system-prompt.
    """
    agent_dir = pi_agent_dir()
    return [agent_dir / name for name in ("APPEND_SYSTEM.md",) if (agent_dir / name).exists()]


def parse_model_spec(spec: str) -> Tuple[str, str]:
    """'provider/model' → (provider, model); bare model defaults to ollama."""
    if "/" in spec:
        provider, model = spec.split("/", 1)
        return provider.strip(), model.strip()
    return "ollama", spec.strip()


def parse_assistant_stream(stdout: str, cell: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Return the last assistant message from a --mode json stream; sum usage."""
    last_assistant: Optional[Dict[str, Any]] = None
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") != "message_end":
            continue
        message = event.get("message", event)
        if message.get("role") != "assistant":
            continue
        last_assistant = message
        usage = message.get("usage") or {}
        cell["tokens_in"] += int(usage.get("input") or 0)
        cell["tokens_out"] += int(usage.get("output") or 0) + int(usage.get("reasoning") or 0)
    return last_assistant


def parse_verdict(text: str) -> Optional[str]:
    # Take the LAST verdict, not the first: a chatty (weak) judge may emit a
    # preliminary "verdict: pass" before its real "VERDICT: FAIL" line, and
    # scoring the first would silently inflate the false-pass safety metric.
    matches = VERDICT_RE.findall(text)
    if matches:
        return matches[-1].upper()
    return None


def _auth_json_has_provider(provider: str) -> bool:
    """True when Pi's ``auth.json`` holds a stored credential for ``provider``."""
    auth_path = pi_agent_dir() / "auth.json"
    try:
        auth = json.loads(auth_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return isinstance(auth, dict) and provider in auth


def probe_provider(provider: str) -> Optional[str]:
    """Return a skip reason when the provider can't serve runs, else None.

    Credential precedence mirrors how Penny actually authenticates: a stored
    subscription/OAuth credential in Pi's ``auth.json`` is the PRIMARY check,
    and an ``*_API_KEY`` environment variable is the BACKUP.
    """
    if provider == "ollama":
        try:
            with urlopen(OLLAMA_PROBE_URL, timeout=3):
                return None
        except Exception as exc:  # noqa: BLE001 — any failure means unreachable
            return f"ollama daemon unreachable at 127.0.0.1:11434 ({type(exc).__name__})"

    if _auth_json_has_provider(provider):
        return None

    key_env = PROVIDER_KEY_ENV.get(provider)
    if key_env and os.environ.get(key_env):
        return None

    if key_env:
        return f"no stored {provider} credential in auth.json and {key_env} not set"
    return None
