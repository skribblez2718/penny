"""LOAN registry — tagged KNOWLEDGE-CONSTRAINT scaffolding with Ablate hooks.

Any mechanism that exists because the current model is weak is a LOAN: it must
be tagged, toggleable, and scheduled for re-measurement. Setting a loan's
``PENNY_ABLATE_<LOAN_ID>`` environment variable to ``1`` disables it for a
scaffold-on versus scaffold-off run.

Unknown loan IDs fail loud, preventing unregistered constraint debt from being
wired to the shared engine.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from .roster import roster_changed, roster_hash

# Fleet baseline for the two retained engine loans. This is a change tripwire,
# not evidence that either mechanism was freshly measured on this fleet.
BASELINE_ROSTER = "4e55bff3547d"


@dataclass(frozen=True)
class Loan:
    """One tagged piece of KNOWLEDGE-CONSTRAINT scaffolding."""

    loan_id: str
    description: str
    rationale: str
    added: str
    review_by: str
    roster_at_review: str = BASELINE_ROSTER

    @property
    def toggle_env(self) -> str:
        """Environment switch that disables this mechanism for an ablation."""
        return f"PENNY_ABLATE_{self.loan_id.upper()}"

    @property
    def fleet_changed(self) -> bool:
        """Whether the configured fleet changed since the loan's review baseline."""
        return roster_changed(self.roster_at_review)


LOANS: dict[str, Loan] = {
    loan.loan_id: loan
    for loan in (
        Loan(
            loan_id="summary_schema_restatement",
            description=(
                "Restates each state's SUMMARY contract as a typed schema appended "
                "to the agent task (engine._summary_contract_directive)."
            ),
            rationale=(
                "Some models drop a structured-output contract buried mid-prompt "
                "and invent their own keys."
            ),
            added="2026-07-08",
            review_by="2026-10-01",
        ),
        Loan(
            loan_id="malformed_summary_retry",
            description=(
                "Bounded re-issue of a step whose agent emitted a malformed or "
                "missing SUMMARY (engine.step and engine._step_parallel)."
            ),
            rationale=(
                "Current models occasionally break the single-line SUMMARY JSON "
                "format; the repair retry must be re-measured on model upgrades."
            ),
            added="2026-07-14",
            review_by="2026-10-01",
        ),
    )
}


def loan_enabled(loan_id: str) -> bool:
    """Return whether a registered loan is enabled; unknown IDs raise ``KeyError``."""
    loan = LOANS[loan_id]
    return os.environ.get(loan.toggle_env, "") != "1"


def list_loans() -> list[Loan]:
    """Return the retained loan inventory."""
    return list(LOANS.values())


def loans_needing_review() -> list[Loan]:
    """Return loans whose fleet-change review tripwire has fired."""
    return [loan for loan in LOANS.values() if loan.fleet_changed]


def current_roster() -> str:
    """Return the current fleet digest for a completed loan review."""
    return roster_hash()
