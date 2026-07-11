"""Action classes + reversibility — the machine-checkable taxonomy autonomy needs.

"Almost autonomous" can't be a global switch: trustworthy at renaming a variable
is not trustworthy at a schema migration. Every action Penny might take alone is
classified into a (domain, operation) pair with a **reversibility** tag. The gate
(gate.py) never lets an irreversible or destructive action run unattended, no
matter how much trust the domain has earned — that hard rule is the permanent
human floor.

Reversibility is a property of the ACTION, not a vibe:
  reversible    — undoable with no lasting cost (edit a file, draft text, read)
  irreversible  — undoable only with effort / external coordination (deploy,
                  publish, send an email, git push, merge)
  destructive   — data loss on failure (delete, drop, wipe, overwrite, rm -rf)

The taxonomy is deliberately small and keyword-driven; when in doubt it errs
toward the LESS reversible class (safety over autonomy).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Tuple

REVERSIBLE = "reversible"
IRREVERSIBLE = "irreversible"
DESTRUCTIVE = "destructive"

# Domains mirror the outcome ledger's `domain` field so per-class trust can be
# computed from real outcomes (coding/research/planning/communication/...).


@dataclass(frozen=True)
class ActionClass:
    domain: str
    operation: str
    reversibility: str

    @property
    def key(self) -> str:
        return f"{self.domain}.{self.operation}"


# Ordered most-severe first: the first matching rule wins, so a "delete the
# deployed database" matches destructive before anything softer. Each rule:
# (reversibility, operation, domain, keyword-patterns).
_RULES: Tuple[Tuple[str, str, str, Tuple[str, ...]], ...] = (
    # ── destructive: data loss on failure ────────────────────────────────────
    (
        DESTRUCTIVE,
        "delete",
        "other",
        (
            "delete",
            "drop table",
            "drop database",
            "rm -rf",
            "wipe",
            "erase",
            "truncate",
            "destroy",
            "purge",
            "format ",
            "factory reset",
        ),
    ),
    (
        DESTRUCTIVE,
        "overwrite",
        "other",
        ("overwrite", "force push", "push --force", "git reset --hard"),
    ),
    # ── irreversible: undoable only with effort / external coordination ───────
    (
        IRREVERSIBLE,
        "deploy",
        "other",
        ("deploy", "release", "publish", "ship to prod", "production", "go live", "rollout"),
    ),
    (
        IRREVERSIBLE,
        "send",
        "communication",
        (
            "send email",
            "send the email",
            "send message",
            "post to",
            "tweet",
            "notify the",
            "email the",
            "message the",
        ),
    ),
    (
        IRREVERSIBLE,
        "merge",
        "coding",
        ("git push", "merge to main", "merge the pr", "merge into", "tag a release"),
    ),
    (IRREVERSIBLE, "payment", "other", ("pay ", "charge ", "purchase", "transfer funds", "refund")),
    (
        IRREVERSIBLE,
        "grant",
        "other",
        ("grant access", "revoke access", "change permissions", "rotate credentials"),
    ),
    # ── reversible: undoable with no lasting cost ─────────────────────────────
    (
        REVERSIBLE,
        "edit",
        "coding",
        (
            "edit",
            "refactor",
            "rename",
            "implement",
            "fix",
            "add a test",
            "write code",
            "change the code",
        ),
    ),
    (
        REVERSIBLE,
        "summarize",
        "research",
        ("summarize", "research", "investigate", "analyze", "review", "find out"),
    ),
    (
        REVERSIBLE,
        "decompose",
        "planning",
        ("plan", "design", "decompose", "outline", "draft a plan"),
    ),
    (REVERSIBLE, "draft", "communication", ("draft", "write a note", "compose", "rewrite")),
    (REVERSIBLE, "config", "other", ("set config", "update config", "change setting", "toggle")),
)

# When nothing matches, default to the safe side: unknown actions ASK.
_DEFAULT = ActionClass(domain="other", operation="unknown", reversibility=IRREVERSIBLE)


def classify(action_text: str) -> ActionClass:
    """Map a free-text action description to its ActionClass. Most-severe rule wins;
    unknown → irreversible (ask), never silently reversible."""
    text = (action_text or "").lower()
    for reversibility, operation, domain, patterns in _RULES:
        if any(_matches(p, text) for p in patterns):
            return ActionClass(domain=domain, operation=operation, reversibility=reversibility)
    return _DEFAULT


def _matches(pattern: str, text: str) -> bool:
    # Multi-word patterns match as substrings; single tokens match on word
    # boundaries so "delete" doesn't fire on "deleted the confusion" false-alarms
    # while "drop table" still matches literally.
    if " " in pattern:
        return pattern in text
    return re.search(rf"\b{re.escape(pattern)}\b", text) is not None


def is_reversible(action_text: str) -> bool:
    return classify(action_text).reversibility == REVERSIBLE


def always_ask(action_text: str) -> bool:
    """True when the action must ALWAYS ask a human (irreversible/destructive),
    regardless of earned trust — the hard rule the gate enforces first."""
    return classify(action_text).reversibility in (IRREVERSIBLE, DESTRUCTIVE)


def known_domains() -> List[str]:
    return sorted({domain for _, _, domain, _ in _RULES} | {"other"})
