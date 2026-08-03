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
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .roster import roster_changed, roster_hash

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
    VerifyEdge(
        "code",
        "skribble",
        "skribble",
        "tdd: verdict backed by captured test/lint/type command output (oracle)",
    ),
    VerifyEdge(
        "jsa",
        "synthia",
        "vera",
        "claimed-evidence gate + per-finding cross-source agreement + reverify_model cross-model hook",
    ),
    VerifyEdge(
        "sca",
        "synthia",
        "vera",
        "agreement grounded in unfabricatable sandbox exit codes + annie(deep-dive) findings are cross-model + reverify_model hook",
    ),
    VerifyEdge(
        "imagegen",
        "synthia",
        "vera",
        "carren second critic (different model) + deterministic PIL decode/dimensions floor",
    ),
    # -- verifier already runs a different model than the actor (CROSS_MODEL) --------------------
    VerifyEdge(
        "learn",
        "skribble",
        "vera",
        "math recomputation (mechanical) — and author->verify is already cross-model",
    ),
)


#: The fleet these exceptions were last reviewed against — the EVENT trigger that
#: complements ``review_by``'s calendar trigger. See ``roster.py``.
#:
#: HONESTY NOTE: a BASELINE, not a record of fresh reviews. The exceptions below were
#: not re-measured when this was introduced (2026-07-31); the value is forward-looking.
#:
#: RE-BASELINED 2026-08-01 (opus,sonnet -> sol,terra: the fleet moved to OpenAI
#: gpt-5.6). The tripwire fired correctly and flagged all 4 same-model exceptions for
#: re-measurement; that re-measurement was DELIBERATELY DEFERRED and this constant
#: advanced anyway, by explicit operator decision, to keep the suite green. The prd
#: exception's "MEASURED 2026-07-30" rationale below therefore describes the OLD
#: (opus,sonnet) fleet and has NOT been reproduced on sol/terra. No exception here has
#: been validated against the current fleet.
BASELINE_ROSTER = "4e55bff3547d"  # models: sol, terra — re-baselined 2026-08-01 (UNMEASURED)


@dataclass(frozen=True)
class IndependenceException:
    """A registered, review-dated acceptance of a same-model bare-judgement verify edge."""

    skill: str
    rationale: str
    review_by: str  # YYYY-MM-DD — re-evaluate (ablate to cross-model + measure) at/before this date
    # The fleet this acceptance was last reviewed against. Note this is a DIFFERENT
    # signal from ``stale_exceptions``: that catches an edge which stopped being
    # same-model (the debt was repaid); this catches the fleet gaining or swapping a
    # MODEL, which changes whether a second opinion is worth paying for at all.
    roster_at_review: str = BASELINE_ROSTER


# Same-model edges we ACCEPT for now — each is the inventory for the T8 ablation pass. Repay by
# adopting jsa's `reverify_model` cross-model hook on the verify state and measuring same- vs
# cross-model catch rate. Every entry here MUST correspond to a VERIFY_EDGE that currently
# classifies SAME_MODEL (the test reports any that have gone stale).
SAME_MODEL_EXCEPTIONS: dict[str, IndependenceException] = {
    e.skill: e
    for e in (
        IndependenceException(
            "prd",
            "synthia generates the spec and vera validates it, both on sonnet by default. The "
            "cross-model hook EXISTS (PrdPlaybook.model_for_state: constraints['validate_model'] -> "
            "PRD_VERA/PRD_DEFAULT env -> agent default) but is OPT-IN, so the default path is still "
            "same-model judgement and this edge correctly stays SAME_MODEL. MEASURED 2026-07-30 "
            "against the labelled defect corpus (tests/prd_defect_corpus.py, 12 cases incl. 2 seen "
            "in real runs): deterministic code already decides 6/12 (50%) — schema violations, "
            "duplicate ids, matrix omissions/unknowns, uncheckable requirements — and a second "
            "model adds NOTHING to those. The judgement residual is the other 50%. DECISION: do "
            "NOT make cross-model the default yet. Several residual defects (unsourced threshold, "
            "unmeasurable criterion, unrefined goal stub) are MECHANIZABLE — moving them into the "
            "rules floor is cheaper, deterministic, and does not tax every run, whereas a second "
            "model costs latency on every run and is still unmeasured on the residual. Next "
            "repayment step: shrink the residual in code, then measure same- vs cross-model on "
            "whatever genuinely remains.",
            "2026-11-15",
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
            "THE SAME MODEL as synthia's synthesis (model names deliberately not repeated here — "
            "classify() resolves them live, so naming them only rots; it was opus/sonnet, now "
            "sol/terra). It is evidence-based (each claim must trace to a captured source), which "
            "partly mitigates, and carren adds a cross-model report critique whenever "
            "critique_passes >= 1 — so a DEFAULT quick/standard run has a same-model final gate with "
            "no cross-model critique at all. The cross-model "
            "hook now EXISTS (ResearchPlaybook.model_for_state: constraints['validate_model'] -> "
            "RESEARCH_VERA/RESEARCH_DEFAULT env -> agent default, added 2026-07-31, mirroring prd) but "
            "is OPT-IN, so the DEFAULT path is still same-model judgement and this edge correctly "
            "stays SAME_MODEL. MEASURED 2026-07-31 against the labelled grounding corpus "
            "(tests/research_grounding_corpus.py, 10 defect cases + 1 clean control; artifact at "
            ".penny/ablation/research_grounding/latest.json): the deterministic floor "
            "(research.grounding_floor — uncited claims, dangling citations, citations to "
            "content-less sources) already decides 4/10 (40%) with ZERO model spend and zero false "
            "positives on clean work. The JUDGEMENT RESIDUAL is the other 6/10 (60%): claims that ARE "
            "cited to a real source with real content, where only a reader can tell the source does "
            "not support them (scope overgeneralization, causal-from-correlational, temporal "
            "overreach, stitched conjunctions, figure-absent, source-silent). DECISION: do NOT make "
            "cross-model the default yet — it costs a full verifier pass on every run and is still "
            "UNMEASURED on the residual, which is the only slice it can affect. Next repayment steps: "
            "(a) consider promoting grounding_floor to a pre-gate ahead of vera so the 40% never "
            "reaches a model at all, (b) measure same- vs cross-model catch rate on the residual with "
            "live models. CAVEAT: the corpus is synthetic — research runs were unminable until "
            "ctx.verify_gaps began being populated; re-measure once the ledger supplies observed "
            "defects.",
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


def classify(edge: VerifyEdge, model_of: Callable[[str], str] = agent_model) -> str:
    """CROSS_MODEL / INDEPENDENT_CHECK / SAME_MODEL for one edge (see module docstring)."""
    if model_of(edge.actor) != model_of(edge.verifier):
        return CROSS_MODEL
    return INDEPENDENT_CHECK if edge.independent_check else SAME_MODEL


def check_independence(model_of: Callable[[str], str] = agent_model) -> list[str]:
    """Skills whose primary verify is SAME_MODEL bare-judgement AND is not a registered exception.

    Empty list == the invariant holds. A non-empty list is a fail-loud violation: either make the
    verify cross-model / evidence-backed, or register the edge in SAME_MODEL_EXCEPTIONS."""
    return [
        edge.skill
        for edge in VERIFY_EDGES
        if classify(edge, model_of) == SAME_MODEL and edge.skill not in SAME_MODEL_EXCEPTIONS
    ]


def stale_exceptions(model_of: Callable[[str], str] = agent_model) -> list[str]:
    """Registered exceptions whose edge no longer classifies SAME_MODEL — the debt was repaid (or
    the edge was removed) but the acceptance lingers. The test flags these so the ledger can't rot.
    """
    by_skill = {e.skill: e for e in VERIFY_EDGES}
    stale = []
    for skill in SAME_MODEL_EXCEPTIONS:
        edge = by_skill.get(skill)
        if edge is None or classify(edge, model_of) != SAME_MODEL:
            stale.append(skill)
    return stale


def exceptions_needing_roster_review() -> list[str]:
    """Exceptions accepted against a DIFFERENT fleet than the one running now.

    The event-driven half of expiry. An acceptance of the form "a same-model judge is
    good enough here" is a bet about the models; when the fleet changes the bet has to
    be re-placed, whatever the calendar says. Empty list == the fleet is unchanged
    since every exception was last reviewed.
    """
    return [
        skill
        for skill, exc in SAME_MODEL_EXCEPTIONS.items()
        if roster_changed(exc.roster_at_review)
    ]


def current_roster() -> str:
    """The fleet's current digest — what to record when an exception is re-reviewed."""
    return roster_hash()
