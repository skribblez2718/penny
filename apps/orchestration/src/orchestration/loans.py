"""LOAN registry — tagged KNOWLEDGE-CONSTRAINT scaffolding with Ablate hooks.

Doctrine (docs/agents/architecture/atomic-loop-components.md, assembly invariant
6; bitter-lesson.md "What is NOT protected"): any mechanism that exists because
the CURRENT model is weak is a LOAN — permitted only when tagged, toggleable,
and scheduled for re-measurement at the next model upgrade. This module is the
engine's loan ledger plus its Ablate hook (atom G2): every entry names the
mechanism, the model weakness it compensates for, the date the loan was taken,
and the review date by which it must be re-ablated. Setting the loan's toggle
env var (``PENNY_ABLATE_<LOAN_ID>=1``) turns the mechanism OFF for a
scaffold-ON vs scaffold-OFF ablation run.

Deliberately fail-loud: querying an unregistered ``loan_id`` raises ``KeyError``
— wiring a mechanism to a toggle without tagging it here is impossible, so
constraint-debt cannot accrue invisibly (compliance rule 5).

The recurring Bitter-Lesson pass consumes :func:`list_loans` to inventory,
ablate, and dispose (delete / re-tag) each loan; see the LOAN lifecycle in the
doctrine docs.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from .roster import roster_changed, roster_hash

#: The fleet these loans were last reviewed against — the EVENT trigger that
#: complements ``review_by``'s calendar trigger (see ``roster.py`` for why a date is
#: the weaker of the two).
#:
#: HONESTY NOTE: every loan below predates this mechanism (added 2026-07-31). This
#: constant is a BASELINE, not a record of a fresh review — the loans were not
#: re-measured when it was introduced. Its value is forward-looking: from now on, a
#: declared fleet change flags them all for re-ablation. A loan re-reviewed
#: individually should record its own roster and drop back to the default only when
#: the two agree.
#:
#: RE-BASELINED 2026-08-01 (opus,sonnet -> sol,terra: the fleet moved to OpenAI
#: gpt-5.6). The tripwire fired correctly and flagged all 8 loans for re-ablation;
#: the re-ablation was DELIBERATELY DEFERRED and this constant advanced anyway, by
#: explicit operator decision, to keep the suite green. NONE of the loans below have
#: been measured on the current fleet — treat every `review_by` date here as the only
#: remaining trigger, and do not read a matching roster as evidence of a real review.
BASELINE_ROSTER = "4e55bff3547d"  # models: sol, terra — re-baselined 2026-08-01 (UNMEASURED)


@dataclass(frozen=True)
class Loan:
    """One tagged piece of KNOWLEDGE-CONSTRAINT scaffolding."""

    loan_id: str  # snake_case id; the toggle env is PENNY_ABLATE_<LOAN_ID upper>
    description: str  # what the mechanism does and where it lives
    rationale: str  # the model weakness this compensates for (why it was borrowed)
    added: str  # YYYY-MM-DD the loan was taken
    review_by: str  # YYYY-MM-DD expiry review (re-ablate at/before this date)
    # The fleet this loan was last reviewed against. A loan exists because the CURRENT
    # models are weak in some way, so the honest trigger to re-measure it is the models
    # changing — not a date passing.
    roster_at_review: str = BASELINE_ROSTER

    @property
    def toggle_env(self) -> str:
        """The Ablate hook: setting this env var to '1' disables the mechanism."""
        return f"PENNY_ABLATE_{self.loan_id.upper()}"

    @property
    def fleet_changed(self) -> bool:
        """True when the fleet has changed since this loan was last reviewed — i.e.
        the moment its justification is most likely to have evaporated."""
        return roster_changed(self.roster_at_review)


LOANS: dict[str, Loan] = {
    loan.loan_id: loan
    for loan in (
        Loan(
            loan_id="summary_schema_restatement",
            description=(
                "Restates each state's SUMMARY contract as an explicit typed schema "
                "appended LAST to the agent task (engine._summary_contract_directive)."
            ),
            rationale=(
                "Weaker (non-Claude) models drop a structured-output contract buried "
                "mid-prompt and invent their own keys (validated 2026-07-08)."
            ),
            added="2026-07-08",
            review_by="2026-10-01",
        ),
        Loan(
            loan_id="malformed_summary_retry",
            description=(
                "Bounded re-issue of a step whose agent emitted a malformed or missing "
                "SUMMARY (engine.step / engine._step_parallel format-repair retries). "
                "Transport failures (non-zero exitCode) are plumbing and retry "
                "unconditionally; only the format-repair retry is the loan."
            ),
            rationale=(
                "Current models occasionally break the single-line SUMMARY JSON format; "
                "an output-format repair layer compensates for a dissolving weakness "
                "(anti-pattern table: ablate each model upgrade)."
            ),
            added="2026-07-14",
            review_by="2026-10-01",
        ),
        Loan(
            loan_id="plan_default_explore_topology",
            description=(
                "The plan skill's legacy fixed 3-branch exploration fan-out "
                "(entrypoints / tests / config) used as a fallback when piper's "
                "scoping step emits no valid runtime topology "
                "(playbooks/plan.py PLAN_EXPLORE_DEFAULT / PARALLEL_BY_STATE)."
            ),
            rationale=(
                "Current models occasionally fail to emit a valid JSON exploration "
                "topology; the legacy 3-focus split keeps runs unblocked. Ablated, "
                "an invalid scoping output escalates to the user instead of silently "
                "using the default (arrangement 4 should be the model's output)."
            ),
            added="2026-07-14",
            review_by="2026-10-01",
        ),
        Loan(
            loan_id="learn_default_ingest_topology",
            description=(
                "The learn skill's fixed 3-branch ingest fan-out "
                "(content / conventions / assessment) used as the FALLBACK when "
                "the model-emitted scoping step returns no valid ingest topology "
                "(playbooks/learn.py LEARN_INGEST_DEFAULT / PARALLEL_BY_STATE)."
            ),
            rationale=(
                "Ingest topology is now model-emitted by the `scoping` state; this "
                "legacy 3-focus split is only the fallback when scoping emits "
                "nothing. Ablated, an empty scoping output escalates to the user "
                "instead of using the default — the model's topology (arrangement "
                "4) is authoritative. Delete when models reliably scope ingest."
            ),
            added="2026-07-14",
            review_by="2026-10-01",
        ),
        Loan(
            loan_id="imagegen_preset_keyword_router",
            description=(
                "The imagegen skill's keyword heuristic (route_preset / "
                "_ROUTE_KEYWORDS) that scans the goal text to pick one of the 4 "
                "render presets (blog-flux-steampunk / learning-qwen / hero-flux / "
                "general-flux)."
            ),
            rationale=(
                "Preset selection picks the generation MODEL/workflow, so it is "
                "resolved before any agent runs (no pre-routing Decide step yet). A "
                "caller constraints.preset always wins; this keyword router is only "
                "the fallback. Ablated, an unspecified preset falls to general-flux "
                "instead of keyword routing. Repay by having a framing agent declare "
                "the preset (model-owned routing)."
            ),
            added="2026-07-14",
            review_by="2026-10-01",
        ),
        Loan(
            loan_id="jsa_poc_artifact_capture",
            description=(
                "The jsa `poc_capture` TOOL_STATE (playbooks/jsa.py _run_poc_capture) that, for each "
                "claimed-verified finding, code-checks the evidence dir for a decodable browser "
                "screenshot and DEMOTES to 'unconfirmed' any finding lacking one (T7d B-light)."
            ),
            rationale=(
                "Capture-in-place hardening of jsa's SOLE autonomous gate (GATE_STATES={intake}, no "
                "human backstop) on its highest gaming-incentive output: current models can assert a "
                "browser PoC they did not run, and the engine cannot tell an asserted free-string "
                "transcript from a fabrication. A PARTIAL oracle (a screenshot proves a browser ran, "
                "not that the exploit fired; hardens the replayable subset). Repay by a stronger "
                "executed-marker harness (T7c Architecture A) or delete once an asserted transcript is "
                "trustworthy. Ablate (PENNY_ABLATE_JSA_POC_ARTIFACT_CAPTURE=1) to measure asserted-only "
                "vs artifact-checked catch rate (T8)."
            ),
            added="2026-07-14",
            review_by="2026-10-01",
        ),
        Loan(
            loan_id="prd_revision_budget",
            description=(
                "The prd skill's default revision budget of 5 validating->generating "
                "iterations (playbooks/prd.py initial_transition), applied via "
                "tier_budget(5, ceiling=8) so the operating point scales with "
                "PI_MODEL_TIER while the ceiling stays a hard safety max."
            ),
            rationale=(
                "The base 5 is a hand-guessed operating point inherited from the legacy "
                "orchestrator, tuned to a weaker generator that needed more revision "
                "rounds to reach a schema-valid, measurable spec. A caller "
                "constraints.max_iterations always wins. Ablated, the engine's generic "
                "default (3) stands instead of the prd-specific bump, so an ablation run "
                "measures whether the extra rounds still buy anything. Repay by deriving "
                "the budget from observed convergence in the outcome ledger."
            ),
            added="2026-07-28",
            review_by="2026-10-01",
        ),
        Loan(
            loan_id="code_iteration_budget",
            description=(
                "The code skill's default implement<->verify iteration budget of 3 "
                "(playbooks/code.py initial_transition), applied via "
                "tier_budget(3, ceiling=6) so the operating point scales with "
                "PI_MODEL_TIER while the ceiling stays a hard safety max."
            ),
            rationale=(
                "The base 3 is the engine's generic hand-guessed default, previously "
                "frozen as BOTH operating point and ceiling — so falling compute cost "
                "never converted into more verified search (Bitter-Lesson audit BL-6). "
                "A caller constraints.max_iterations always wins. Ablated, the engine's "
                "generic default (3) stands, so an ablation run measures whether the "
                "extra rounds buy anything. Repay by deriving the budget from observed "
                "convergence in the outcome ledger rather than a tier multiplier."
            ),
            added="2026-08-02",
            review_by="2026-11-01",
        ),
        Loan(
            loan_id="failure_mode_keywords",
            description=(
                "Keyword table classifying verifier-gap text into categorical failure "
                "modes for the outcome ledger (outcome_writer._FAILURE_MODE_KEYWORDS). "
                "PARTIALLY REPAID 2026-07-31: demoted to the FALLBACK. When "
                "PI_FAILURE_MODE_MODEL is set a model reads the gap text and picks from "
                "the same FAILURE_MODES vocabulary; the table decides only when no model "
                "is configured or the call fails."
            ),
            rationale=(
                "Substitutes a hand-built keyword classifier for model judgment over the "
                "gap text — it cannot see paraphrase, negation, or any failure mode nobody "
                "enumerated, so it only degrades as models improve. Ablated it falls back "
                "to the uncategorized bucket the compression loop already handles. FULL "
                "repayment = delete the table once PI_FAILURE_MODE_MODEL is the measured "
                "default; keep it until then so an unconfigured deployment still classifies."
            ),
            added="2026-07-14",
            review_by="2026-10-01",
        ),
    )
}


def loan_enabled(loan_id: str) -> bool:
    """Ablate hook: True when the loan's mechanism should run.

    Unknown ids fail loud (``KeyError``) — every toggle-gated mechanism must be
    tagged in :data:`LOANS` first.
    """
    loan = LOANS[loan_id]
    return os.environ.get(loan.toggle_env, "") != "1"


def list_loans() -> list[Loan]:
    """The loan inventory, for the recurring Bitter-Lesson pass."""
    return list(LOANS.values())


def loans_needing_review() -> list[Loan]:
    """Loans whose justification may have evaporated because the FLEET changed.

    This is the event-driven half of loan expiry, complementing ``review_by``'s
    calendar half: a scaffold borrowed against a weakness of the old models earns
    re-ablation the moment the models change, whether that is a week or a year later.
    Empty list == the fleet is unchanged since every loan was last reviewed.
    """
    return [loan for loan in LOANS.values() if loan.fleet_changed]


def current_roster() -> str:
    """The fleet's current digest — what to record when a loan is re-reviewed."""
    return roster_hash()
