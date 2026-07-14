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


@dataclass(frozen=True)
class Loan:
    """One tagged piece of KNOWLEDGE-CONSTRAINT scaffolding."""

    loan_id: str  # snake_case id; the toggle env is PENNY_ABLATE_<LOAN_ID upper>
    description: str  # what the mechanism does and where it lives
    rationale: str  # the model weakness this compensates for (why it was borrowed)
    added: str  # YYYY-MM-DD the loan was taken
    review_by: str  # YYYY-MM-DD expiry review (re-ablate at/before this date)

    @property
    def toggle_env(self) -> str:
        """The Ablate hook: setting this env var to '1' disables the mechanism."""
        return f"PENNY_ABLATE_{self.loan_id.upper()}"


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
            loan_id="task_digest_cap",
            description=(
                "Truncates values embedded in agent task messages to a fixed character "
                "budget (engine.BasePlaybook._cap) so directives stay digests."
            ),
            rationale=(
                "Compact (atom E2) mechanism: the *need* for context economy is durable "
                "but this fixed-threshold mechanism is a loan tuned to current context "
                "handling; re-measure as models handle longer contexts natively."
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
            loan_id="failure_mode_keywords",
            description=(
                "Keyword table classifying verifier-gap text into categorical failure "
                "modes for the outcome ledger (outcome_writer._FAILURE_MODE_KEYWORDS)."
            ),
            rationale=(
                "Substitutes a hand-built keyword classifier for model judgment over the "
                "gap text; ablated it falls back to the uncategorized bucket the "
                "compression loop already handles."
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
