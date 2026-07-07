"""Target layer classifier for self-improvement amendments.

Classifies a proposed learning (pattern + evidence) into:
  - DOMAIN_GUIDANCE  → amend a skill prompt (.pi/skills/*/assets/prompts/*.md)
  - MEMPALACE_PREF   → store as user preference (penny/preferences room)
  - CONFIG           → change .env or config file
  - REJECTED_UNIVERSAL → would modify SYSTEM.md, log only (no automation)

Uses keyword heuristics. Fast, deterministic, no LLM.
"""

from enum import Enum
from typing import List, Optional


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


def classify_target(learning_description: str, evidence: Optional[List[str]]) -> TargetLayer:
    """Classify a learning into its correct target layer.

    Priority:
      1. If any universal keyword present → REJECTED_UNIVERSAL
      2. Else if preference keyword present → MEMPALACE_PREF
      3. Else if config keyword present → CONFIG
      4. Default → DOMAIN_GUIDANCE (most common case)
    """
    if not learning_description:
        learning_description = ""
    text = learning_description.lower()

    # Universal ALWAYS wins — protect SYSTEM.md from accidental targeting
    if _score(text, _UNIVERSAL_KEYWORDS) > 0:
        return TargetLayer.REJECTED_UNIVERSAL

    # Preferences second — user-specific patterns
    if _score(text, _PREFERENCE_KEYWORDS) > 0:
        return TargetLayer.MEMPALACE_PREF

    # Config third — operational changes
    if _score(text, _CONFIG_KEYWORDS) > 0:
        return TargetLayer.CONFIG

    # Default: domain-specific guidance
    return TargetLayer.DOMAIN_GUIDANCE
