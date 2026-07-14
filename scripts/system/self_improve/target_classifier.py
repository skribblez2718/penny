"""Target layer classifier for self-improvement amendments.

Classifies a proposed learning (pattern + evidence) into:
  - DOMAIN_GUIDANCE  → amend a skill prompt (.pi/skills/*/assets/prompts/*.md)
  - MEMPALACE_PREF   → store as user preference (penny/preferences room)
  - CONFIG           → change .env or config file
  - REJECTED_UNIVERSAL → would modify SYSTEM.md, log only (no automation)

Model-first (#21): when PI_SELFIMPROVE_TARGET_MODEL is set, a model judges the
layer; otherwise (or on any failure) the keyword heuristic below is the fallback.
The human apply-gate remains the safety net; the model is told to fail safe toward
REJECTED_UNIVERSAL when a learning might touch an immutable rule.
"""

import json
import os
import re
import subprocess
from enum import Enum
from pathlib import Path
from typing import List, Optional

REPO_ROOT = Path(__file__).resolve().parents[3]

_TARGET_MODEL_ENV = "PI_SELFIMPROVE_TARGET_MODEL"
_TARGET_HERMETIC = [
    "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
    "--no-themes", "--no-context-files", "--no-tools",
]
_TARGET_SYSTEM = (
    "You route a proposed self-improvement LEARNING for a coding-agent system to "
    "the correct layer. Reply with EXACTLY one JSON object and nothing else: "
    '{"layer": "<LAYER>"}. Choose one:\n'
    "- DOMAIN_GUIDANCE: a skill/agent behavior lesson (how to do a kind of task "
    "better). This is the common case.\n"
    "- MEMPALACE_PREF: a USER preference or working style (concision, confirmation "
    "habits, workflow taste) — not a general capability lesson.\n"
    "- CONFIG: an operational/config value (a timeout, path, environment variable, "
    "or setting).\n"
    "- REJECTED_UNIVERSAL: would change an IMMUTABLE / universal rule — security "
    "directives, the instruction hierarchy, confidence-label semantics, core values "
    "(truth/safety/clarity), or SYSTEM.md itself. These are NEVER auto-amended. When "
    "you are UNSURE whether a learning touches this immutable layer, choose "
    "REJECTED_UNIVERSAL (fail safe)."
)


class TargetLayer(Enum):
    DOMAIN_GUIDANCE = "DOMAIN_GUIDANCE"
    MEMPALACE_PREF = "MEMPALACE_PREF"
    CONFIG = "CONFIG"
    REJECTED_UNIVERSAL = "REJECTED_UNIVERSAL"


# Universal-layer keywords — anything touching these belongs in REJECTED_UNIVERSAL
_UNIVERSAL_KEYWORDS = frozenset(
    [
        # Security directives
        "security directive",
        "system_directive",
        "system_boundary",
        "agent_boundary",
        "immutable",
        # Cognitive Frame sections
        "before responding",
        "before_responding",
        "instruction hierarchy",
        "instruction_hierarchy",
        "self-verification",
        "self_verification",
        "self verification",
        "canonical vocabulary",
        "canonical_vocabulary",
        "reasoning style",
        "reasoning_style",
        # Confidence levels
        "confidence level",
        "confidence_level",
        "CERTAIN",
        "PROBABLE",
        "POSSIBLE",
        "UNCERTAIN",
        "new confidence",
        # Core rules
        "truth",
        "safety",
        "clarity",
        "thoroughness",
        "never fabricate",
        "always verify",
        "mission rule",
        "output contract",
        "limitations",
        "restrictions",
        "boundaries",
        "options",
        "parameters",
        "choices",
        "guesses",
        "expectations",
        "defaults",
        "gaps",
        "questions",
        "uncertainties",
        "compromises",
        "costs",
        "sacrifices",
        "validation",
        "testing",
    ]
)

# Preference keywords — user-specific patterns → mempalace
_PREFERENCE_KEYWORDS = frozenset(
    [
        "user prefers",
        "user likes",
        "user wants",
        "user consistently",
        "user often",
        "user asked",
        "communication style",
        "concise",
        "verbose",
        "terse",
        "confirmation threshold",
        "ask before",
        "always confirm",
        "workflow preference",
        "work style",
    ]
)

# Config keywords — operational changes
_CONFIG_KEYWORDS = frozenset(
    [
        "timeout",
        "directory",
        "path",
        "environment variable",
        "config value",
        ".env",
        "setting",
        "increase timeout",
        "decrease timeout",
        "global path",
        "relative path",
    ]
)

# Domain-guidance keywords — skill/agent name + domain action
_DOMAIN_KEYWORDS = frozenset(
    [
        "piper",
        "echo",
        "carren",
        "tabitha",
        "plan skill",
        "exploration",
        "critique",
        "taskify",
        "coding",
        "testing",
        "refactor",
        "explore",
        "config file",
        "package manager",
        "CREST",
        "summary format",
        "output format",
        "skill prompt",
        "domain evaluation",
        "underestimates",
        "overestimates",
        "misses",
        "incorrectly assumes",
        "wrong package",
    ]
)


def _score(text_lower: str, keywords: frozenset) -> int:
    """Count how many keyword phrases appear in text."""
    return sum(1 for kw in keywords if kw in text_lower)


def _classify_by_keywords(
    learning_description: str, evidence: Optional[List[str]]
) -> TargetLayer:
    """Keyword-heuristic fallback (the pre-#21 classifier).

    Priority: universal → preference → config → default DOMAIN_GUIDANCE.
    """
    if not learning_description:
        learning_description = ""
    text = learning_description.lower()
    if _score(text, _UNIVERSAL_KEYWORDS) > 0:
        return TargetLayer.REJECTED_UNIVERSAL
    if _score(text, _PREFERENCE_KEYWORDS) > 0:
        return TargetLayer.MEMPALACE_PREF
    if _score(text, _CONFIG_KEYWORDS) > 0:
        return TargetLayer.CONFIG
    return TargetLayer.DOMAIN_GUIDANCE


def _pi_json_call(prompt, *, spec, system, runner=None, timeout_s=45):  # noqa: C901
    """One headless-pi JSON call; last assistant text or None on any failure."""
    if "/" in spec and not spec.startswith("/") and not spec.endswith("/"):
        provider, model_id = spec.split("/", 1)
    else:
        provider, model_id = "", spec
    cmd = ["pi", "--mode", "json", "-p", *_TARGET_HERMETIC]
    if provider:
        cmd += ["--provider", provider]
    cmd += ["--model", model_id, "--thinking", "low", "--system-prompt", system, prompt]
    env = dict(os.environ)
    env["PI_SKIP_VERSION_CHECK"] = "1"
    run = runner or subprocess.run
    try:
        proc = run(cmd, cwd=str(REPO_ROOT), env=env, stdin=subprocess.DEVNULL,
                   capture_output=True, text=True, timeout=timeout_s)
    except (subprocess.TimeoutExpired, OSError):
        return None
    if getattr(proc, "returncode", 0) not in (0, None):
        return None
    last = None
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


def _classify_via_model(learning_description, evidence, spec, *, runner=None):
    """Model judgment -> a TargetLayer, or None on any failure / bad label."""
    prompt = f"LEARNING:\n{(learning_description or '').strip()[:800]}"
    ev = "\n".join(f"- {e}" for e in (evidence or [])[:5])
    if ev:
        prompt += f"\n\nEVIDENCE:\n{ev}"
    prompt += '\n\nReturn one JSON object: {"layer": "<LAYER>"}.'
    text = _pi_json_call(prompt, spec=spec, system=_TARGET_SYSTEM, runner=runner)
    if not text:
        return None
    match = re.search(r"\{[^{}]*\}", text)
    if not match:
        return None
    try:
        obj = json.loads(match.group(0))
    except (json.JSONDecodeError, ValueError):
        return None
    try:
        return TargetLayer(str(obj.get("layer", "")).strip().upper())
    except ValueError:
        return None


def classify_target(
    learning_description: str, evidence: Optional[List[str]], *, runner=None
) -> TargetLayer:
    """Classify a learning into its target layer.

    #21 model-first: when PI_SELFIMPROVE_TARGET_MODEL is set, a model judges the
    layer (fail-safe toward REJECTED_UNIVERSAL for immutable-rule touches); falls
    back to the keyword heuristic on unset/failure. Never raises — the human
    apply-gate is the safety net.
    """
    spec = os.environ.get(_TARGET_MODEL_ENV, "").strip()
    if spec:
        try:
            layer = _classify_via_model(learning_description, evidence, spec, runner=runner)
        except Exception:  # noqa: BLE001 - classification must never break the loop
            layer = None
        if layer is not None:
            return layer
    return _classify_by_keywords(learning_description, evidence)
