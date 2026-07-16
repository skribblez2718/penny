"""Cross-model verification independence — the invariant + its registered exceptions.

Doctrine (SYSTEM.md: "Independent checks for high-stakes work — ideally a different model or
agent than the one that produced it"; the atomic-loop VERIFY tier): a skill's VERIFY is a
STRONGER check when it does NOT run the same model that produced the work — correlated
single-model errors otherwise slip a false PASS through. ``jsa.model_for_state('reverify')``
already names this exact hazard ("the point of Rec 5 is an independent judge, so correlated
single-model errors don't slip a false PASS through") and exposes a ``reverify_model`` hook to
repair it.

This module is the ledger of every skill's PRIMARY actor->verify edge. It resolves each agent's
model LIVE from its ``.pi/agents/<agent>.md`` frontmatter (so the invariant self-corrects the
moment an agent is re-pointed at a different model — ratchet on the current fleet, never a frozen
snapshot), classifies each edge, and flags any edge where the verifier shares the actor's model
WITHOUT a model-independent check — unless that edge is a registered, review-dated EXCEPTION.

Classification per edge:
  * CROSS_MODEL        — verifier.model != actor.model. Independent by construction.
  * INDEPENDENT_CHECK  — same model, but the decisive PASS/FAIL signal is NOT the verifier's bare
                         judgement: an oracle (tests), an evidence gate (tool output / sandbox exit
                         codes / citation grounding), a deterministic rules floor, or a different-
                         family second critic on the SAME artifact. A confidently-wrong actor model
                         cannot fool the check by agreeing with itself.
  * SAME_MODEL         — same model AND the decisive signal is the verifier's bare judgement. This
                         is the dangerous case; it MUST be registered in SAME_MODEL_EXCEPTIONS with
                         a rationale + review_by, or the fail-loud test rejects it.

``check_independence`` is consumed by ``tests/test_independence.py``: a new skill that wires a
same-model verifier over a subjective judgement cannot ship silently, and a registered exception
that has since become cross-model (or gained a real independent check) is reported as STALE so the
ledger cannot rot. The registered exceptions are the inventory the T8 Bitter-Lesson ablation pass
consumes (repay by adopting jsa's ``reverify_model`` cross-model hook and measuring).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

_AGENTS_DIR = Path(__file__).resolve().parents[4] / ".pi" / "agents"

CROSS_MODEL = "CROSS_MODEL"
INDEPENDENT_CHECK = "INDEPENDENT_CHECK"
SAME_MODEL = "SAME_MODEL"


def agent_model(agent: str, agents_dir: Path | str = _AGENTS_DIR) -> str:
    """The model an agent runs on, read LIVE from ``.pi/agents/<agent>.md`` frontmatter.

    Fail-loud: a missing agent file or missing ``model:`` line raises — the invariant must never
    silently treat an unresolvable agent as 'independent'."""
    path = Path(agents_dir) / f"{agent}.md"
    text = path.read_text(encoding="utf-8")
    match = re.search(r"(?m)^model:[ \t]*(\S+)[ \t]*$", text)
    if not match:
        raise ValueError(f"no 'model:' frontmatter in {path}")
    return match.group(1).strip()


@dataclass(frozen=True)
class VerifyEdge:
    """One skill's primary producer -> verifier edge, plus any model-independent check on it."""

    skill: str
    actor: str  # agent producing the primary artifact under review
    verifier: str  # agent in the primary VERIFY role over that artifact
    independent_check: str  # "" if the verdict is the verifier's bare judgement; else its name


# The primary actor->verify edge of every gated skill. `independent_check` is non-empty ONLY when
# the decisive PASS/FAIL signal is model-independent (oracle / evidence / rules floor / cross-family
# second critic) — see the module docstring's classification rules.
VERIFY_EDGES: tuple[VerifyEdge, ...] = (
    # -- same-model, bare-judgement verify -> must be registered exceptions --------------------
    VerifyEdge("prd", "synthia", "vera", ""),
    VerifyEdge("rez", "synthia", "vera", ""),
    VerifyEdge("research", "synthia", "vera", ""),
    VerifyEdge("plan", "piper", "carren", ""),
    # -- same-model primary, but a real model-independent check makes the verdict unfoolable ----
    VerifyEdge("code", "skribble", "skribble", "tdd: verdict backed by captured test/lint/type command output (oracle)"),
    VerifyEdge("jsa", "synthia", "vera", "claimed-evidence gate + per-finding cross-source agreement + reverify_model cross-model hook"),
    VerifyEdge("sca", "synthia", "vera", "agreement grounded in unfabricatable sandbox exit codes + annie(deep-dive) findings are cross-model + reverify_model hook"),
    VerifyEdge("imagegen", "synthia", "vera", "carren second critic (different model) + deterministic PIL decode/dimensions floor"),
    # -- verifier already runs a different model than the actor (CROSS_MODEL) --------------------
    VerifyEdge("learn", "skribble", "vera", "math recomputation (mechanical) — and author->verify is already cross-model"),
)


@dataclass(frozen=True)
class IndependenceException:
    """A registered, review-dated acceptance of a same-model bare-judgement verify edge."""

    skill: str
    rationale: str
    review_by: str  # YYYY-MM-DD — re-evaluate (ablate to cross-model + measure) at/before this date


# Same-model edges we ACCEPT for now — each is the inventory for the T8 ablation pass. Repay by
# adopting jsa's `reverify_model` cross-model hook on the verify state and measuring same- vs
# cross-model catch rate. Every entry here MUST correspond to a VERIFY_EDGE that currently
# classifies SAME_MODEL (the test reports any that have gone stale).
SAME_MODEL_EXCEPTIONS: dict[str, IndependenceException] = {
    e.skill: e
    for e in (
        IndependenceException(
            "prd",
            "synthia generates the spec and vera validates it, both on sonnet. vera's structural "
            "checks are partly evidence-backed (the T4 validate_json IDEAL_STATE schema floor), but "
            "the prose-quality / coverage judgement remains the verifier's bare same-model call. No "
            "cross-model verify hook yet — repay via a model_for_state override on `validating`.",
            "2026-10-01",
        ),
        IndependenceException(
            "rez",
            "synthia tailors the resume and vera validates it, both on sonnet. The T4 source-"
            "provenance ASSIST feeds vera a deterministic fabrication-suspect list (partial), but the "
            "anti-fabrication verdict is still vera's same-model judgement. No cross-model verify hook.",
            "2026-10-01",
        ),
        IndependenceException(
            "research",
            "vera's `validating` citation-grounding gate is the final verify in ALL modes and runs "
            "sonnet over synthia's sonnet synthesis. It is evidence-based (each claim must trace to a "
            "captured source), which partly mitigates, and carren adds a cross-model report critique "
            "in DEEP mode only — but quick/standard modes have a same-model final gate and there is no "
            "cross-model reverify hook (adopt jsa's `reverify_model`).",
            "2026-10-01",
        ),
        IndependenceException(
            "plan",
            "piper drafts the plan and carren critiques it, both on opus — same model, different "
            "agents. The plan is a human-reviewed proposal (a person is the outer verifier), so the "
            "stakes of a correlated miss are lower, but the automated critique is still same-model. "
            "Repay via a cross-model critique option.",
            "2026-10-01",
        ),
    )
}


def classify(edge: VerifyEdge, model_of=agent_model) -> str:
    """CROSS_MODEL / INDEPENDENT_CHECK / SAME_MODEL for one edge (see module docstring)."""
    if model_of(edge.actor) != model_of(edge.verifier):
        return CROSS_MODEL
    return INDEPENDENT_CHECK if edge.independent_check else SAME_MODEL


def check_independence(model_of=agent_model) -> list[str]:
    """Skills whose primary verify is SAME_MODEL bare-judgement AND is not a registered exception.

    Empty list == the invariant holds. A non-empty list is a fail-loud violation: either make the
    verify cross-model / evidence-backed, or register the edge in SAME_MODEL_EXCEPTIONS."""
    return [
        edge.skill
        for edge in VERIFY_EDGES
        if classify(edge, model_of) == SAME_MODEL and edge.skill not in SAME_MODEL_EXCEPTIONS
    ]


def stale_exceptions(model_of=agent_model) -> list[str]:
    """Registered exceptions whose edge no longer classifies SAME_MODEL — the debt was repaid (or
    the edge was removed) but the acceptance lingers. The test flags these so the ledger can't rot."""
    by_skill = {e.skill: e for e in VERIFY_EDGES}
    stale = []
    for skill in SAME_MODEL_EXCEPTIONS:
        edge = by_skill.get(skill)
        if edge is None or classify(edge, model_of) != SAME_MODEL:
            stale.append(skill)
    return stale
