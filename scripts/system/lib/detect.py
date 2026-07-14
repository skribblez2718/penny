"""Shared model-detect primitive (Bitter-Lesson #8).

One place for the headless-pi call that every model-participation site was
hand-rolling (prompt_efficacy_judge, capture, compression_loop, target_classifier,
amendment_generator), plus a generic ``detect(artifact, question) ->
{answer, evidence, confidence}`` classifier the skill ontology-kills
(#9/#13/#15/#16) build on instead of hand-coded keyword tables.

Detection is a CAPABILITY the model does for free from the artifact itself. The
caller supplies a soft label menu (so downstream labels stay stable) and keeps a
cheap heuristic fallback for when the model is off / unavailable — the doctrine's
default+fallback. Everything here is injected-runner testable and NEVER raises.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Sequence, Tuple

_HERMETIC = [
    "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
    "--no-themes", "--no-context-files", "--no-tools",
]
_CONFIDENCE = ("CERTAIN", "PROBABLE", "POSSIBLE", "UNCERTAIN")


def _split_spec(spec: str) -> Tuple[str, str]:
    """'provider/model' -> ('provider', 'model'); a bare 'model' -> ('', 'model')."""
    if "/" in spec and not spec.startswith("/") and not spec.endswith("/"):
        provider, model_id = spec.split("/", 1)
        return provider, model_id
    return "", spec


def pi_json_call(  # noqa: C901 - linear build-cmd -> spawn -> stream-parse
    prompt: str,
    *,
    model_spec: str,
    system: str,
    runner: Optional[Callable] = None,
    timeout_s: int = 45,
    cwd: Optional[str] = None,
) -> Optional[str]:
    """One headless-pi JSON call; returns the last assistant text, or None on ANY
    failure (spawn / timeout / non-zero exit / error stop / empty).

    The single canonical caller. ``runner`` defaults to ``subprocess.run`` and is
    injected in tests so no live model call ever happens under unit test.
    """
    provider, model_id = _split_spec(model_spec)
    cmd = ["pi", "--mode", "json", "-p", *_HERMETIC]
    if provider:
        cmd += ["--provider", provider]
    cmd += ["--model", model_id, "--thinking", "low", "--system-prompt", system, prompt]
    env = dict(os.environ)
    env["PI_SKIP_VERSION_CHECK"] = "1"
    run = runner or subprocess.run
    try:
        proc = run(
            cmd, cwd=cwd or str(Path.cwd()), env=env, stdin=subprocess.DEVNULL,
            capture_output=True, text=True, timeout=timeout_s,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if getattr(proc, "returncode", 0) not in (0, None):
        return None
    last: Optional[str] = None
    for line in (getattr(proc, "stdout", "") or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        if event.get("type") != "message_end":
            continue
        message = event.get("message", event)
        if message.get("role") != "assistant":
            continue
        if message.get("stopReason") == "error":
            return None
        last = "".join(
            b.get("text", "") for b in message.get("content", [])
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return last


def extract_json(text: Optional[str]) -> Optional[Any]:
    """First parseable JSON object in ``text`` (greedy brace span), else None."""
    if not text:
        return None
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except (json.JSONDecodeError, ValueError):
        return None


_DETECT_SYSTEM = (
    "You inspect an ARTIFACT and answer one QUESTION about it, grounded ONLY in "
    "evidence from the artifact itself. Reply with EXACTLY one JSON object and "
    "nothing else: "
    '{"answer": <value>, "evidence": ["<short quote or fact from the artifact>"], '
    '"confidence": "CERTAIN" | "PROBABLE" | "POSSIBLE" | "UNCERTAIN"}. '
    "When a MENU of allowed answers is given, answer with exactly one menu value "
    '(use "other" if none fit). If the artifact does not support an answer, say so '
    "with low confidence."
)


def detect(
    artifact: str,
    question: str,
    *,
    model_spec: str,
    labels: Optional[Sequence[str]] = None,
    runner: Optional[Callable] = None,
    timeout_s: int = 45,
    max_artifact_chars: int = 8000,
) -> Dict[str, Any]:
    """Detect an answer about ``artifact`` with a model (#8).

    Returns ``{"ok", "answer", "evidence", "confidence"}``. ``ok`` is False (and
    ``answer`` None) on ANY failure so the caller can fall back to a heuristic.
    When ``labels`` is given the model is offered that soft menu (plus "other").
    Never raises.
    """
    fail = {"ok": False, "answer": None, "evidence": [], "confidence": "UNCERTAIN"}
    if not model_spec:
        return fail
    menu = ""
    if labels:
        menu = "\n\nALLOWED ANSWERS (choose exactly one): " + ", ".join(labels) + ', or "other".'
    prompt = (
        f"QUESTION:\n{question.strip()}{menu}\n\n"
        f'ARTIFACT:\n"""\n{(artifact or "")[:max_artifact_chars]}\n"""\n\n'
        'Return {"answer","evidence","confidence"}.'
    )
    try:
        text = pi_json_call(
            prompt, model_spec=model_spec, system=_DETECT_SYSTEM,
            runner=runner, timeout_s=timeout_s,
        )
    except Exception:  # noqa: BLE001 - detection must never raise
        return fail
    obj = extract_json(text)
    if not isinstance(obj, dict) or "answer" not in obj:
        return fail
    conf = str(obj.get("confidence", "")).strip().upper()
    if conf not in _CONFIDENCE:
        conf = "PROBABLE"
    evidence = [str(e) for e in (obj.get("evidence") or []) if str(e).strip()][:5]
    return {"ok": True, "answer": obj.get("answer"), "evidence": evidence, "confidence": conf}
