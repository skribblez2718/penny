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

import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Optional, Tuple, cast

REPO_ROOT = Path(__file__).resolve().parents[3]

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


# ---------------------------------------------------------------------------
# Optional model second-opinion on reversibility (veto-only, env-gated).
#
# The keyword taxonomy above is a conservative floor (unknown -> ask; errs toward
# the less-reversible class). Its residual blind spot is a keyword FALSE POSITIVE
# -- an action that matches a REVERSIBLE rule but is actually dangerous ("update
# config to shorten data retention", "toggle off the nightly backup"). This layer
# asks a model for a second opinion ONLY on keyword-reversible actions and
# combines by MOST-SEVERE: the model can only DOWNGRADE reversible ->
# (irreversible|destructive), forcing the gate to ASK. It can NEVER upgrade a
# non-reversible verdict, so the deny-by-default floor is preserved by
# construction (monotone). OFF unless PENNY_AUTONOMY_REVERSIBILITY_MODEL is set;
# any transport/parse failure keeps the keyword verdict, and a low-confidence
# answer is treated as a veto. Never raises. Mirrors the env-gated model +
# keyword-fallback pattern in self_improve/target_classifier.py,
# outcome_ledger/capture.py, and BasePlaybook.classify_gate_intent.
# ---------------------------------------------------------------------------

_REVERSIBILITY_MODEL_ENV = "PENNY_AUTONOMY_REVERSIBILITY_MODEL"
_REVERSIBILITY_TIMEOUT_S = 30
_SEVERITY = {REVERSIBLE: 0, IRREVERSIBLE: 1, DESTRUCTIVE: 2}

_REVERSIBILITY_SYSTEM = (
    "You are a strict safety classifier: is an ACTION reversible? "
    "'reversible' = undoing it has no lasting cost (edit a file, draft text, read, "
    "refactor). 'irreversible' = undoing needs effort or external coordination "
    "(deploy, publish, send a message/email, git push, merge, grant/revoke access, "
    "payment). 'destructive' = failure loses data (delete, drop, wipe, overwrite, "
    "truncate, force-push). When you are not sure, do NOT answer reversible. Reply "
    "with EXACTLY one JSON object and nothing else: "
    '{"reversibility": "reversible|irreversible|destructive", "confidence": "high|low"}. '
    'Use "low" whenever the action is ambiguous or you are unsure.'
)


def _load_pi_json_call() -> Callable[..., Optional[str]]:
    """Lazy-import the shared headless-pi caller (scripts/system/lib)."""
    lib = str(REPO_ROOT / "scripts" / "system" / "lib")
    if lib not in sys.path:
        sys.path.insert(0, lib)
    from detect import pi_json_call

    return cast(Callable[..., Optional[str]], pi_json_call)


def _reversibility_via_model(
    action_text: str, spec: str, *, runner: Optional[Callable] = None
) -> Optional[str]:
    """Ask a model for the action's reversibility. Returns an EFFECTIVE label
    (REVERSIBLE / IRREVERSIBLE / DESTRUCTIVE), or None on any failure / bad output
    (caller then keeps the keyword verdict). A low-confidence answer collapses to
    IRREVERSIBLE (a veto) -- it never returns reversible when the model is unsure."""
    prompt = f"ACTION:\n{(action_text or '').strip()[:800]}\n\nClassify its reversibility."
    text = _load_pi_json_call()(
        prompt,
        model_spec=spec,
        system=_REVERSIBILITY_SYSTEM,
        runner=runner,
        timeout_s=_REVERSIBILITY_TIMEOUT_S,
        cwd=str(REPO_ROOT),
    )
    if not text:
        return None
    match = re.search(r"\{[^{}]*\}", text)
    if not match:
        return None
    try:
        obj = json.loads(match.group(0))
    except (json.JSONDecodeError, ValueError):
        return None
    label = str(obj.get("reversibility", "")).strip().lower()
    if label not in (REVERSIBLE, IRREVERSIBLE, DESTRUCTIVE):
        return None  # unparseable label -> keyword fallback (no veto)
    confidence = str(obj.get("confidence", "")).strip().lower()
    if confidence != "high":
        return IRREVERSIBLE  # low-confidence on a reversible-keyword action -> veto
    return label


def model_veto_reversibility(
    action_text: str, base_reversibility: str, *, runner: Optional[Callable] = None
) -> str:
    """Veto-only model second opinion. Returns the MOST-SEVERE of the keyword
    verdict and the model's -- so it can only move a REVERSIBLE verdict toward ASK,
    never the reverse. Consulted ONLY when the keyword verdict is REVERSIBLE (the
    sole act-eligible case) and PENNY_AUTONOMY_REVERSIBILITY_MODEL is set;
    otherwise returns ``base_reversibility`` unchanged (byte-identical to the
    keyword-only gate). Fail-safe and never raises."""
    if base_reversibility != REVERSIBLE:
        return base_reversibility  # already ASK -- never spend a model call
    spec = os.environ.get(_REVERSIBILITY_MODEL_ENV, "").strip()
    if not spec:
        return base_reversibility  # feature OFF
    try:
        verdict = _reversibility_via_model(action_text, spec, runner=runner)
    except Exception:  # noqa: BLE001 -- the autonomy gate must never crash
        verdict = None
    if verdict is None:
        return base_reversibility  # infra/parse failure -> keyword fallback
    return verdict if _SEVERITY[verdict] > _SEVERITY[base_reversibility] else base_reversibility
