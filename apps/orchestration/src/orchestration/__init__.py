"""orchestration — the shared FSM execution engine for Penny skills.

This package provides the one durable, observable, self-recovering runtime that
every skill's ``orchestrate.py`` delegates to (in ~5 lines). It owns the FSM
protocol (start/step/status), the durable SQLite checkpointer keyed by
``run_id`` (which retires the legacy state-on-argv + /tmp transport and
transition-replay state-forcing), self-recovery, and best-effort
observability emission.

Public API: the FSM protocol (``BasePlaybook``/``start``/``step``/``status``), the
typed seam (``Confidence``/``Directives``/contracts + the ``ParallelSpec`` fan-out
and gate hooks), the durable checkpointer, self-recovery, and observability
emission. See ``docs/agents/orchestration/overview.md``.
"""

__version__ = "0.1.0"

from .checkpointer import (  # noqa: E402
    STATUS_AWAITING_USER,
    STATUS_COMPLETE,
    STATUS_ERROR,
    STATUS_RUNNING,
    CheckpointRecord,
    Checkpointer,
)
from .contracts import (  # noqa: E402
    CONTRACTS,
    VERDICT_FAIL,
    VERDICT_PASS,
    VERDICTS,
    Confidence,
    Directives,
    validate_summary,
    validate_summary_contract,
    weakest_confidence,
)
from .context import RunContext  # noqa: E402
from .engine import BasePlaybook  # noqa: E402
from .loans import LOANS, Loan, list_loans, loan_enabled  # noqa: E402
from .obs_client import ObsClient  # noqa: E402
from .playbooks import PLAYBOOKS, ReferenceCycle, get_playbook  # noqa: E402
from .primitives import (
    ACT,
    FRAME,
    LEARN,
    OBSERVE,
    PLAN,
    PRIMITIVES,
    VERIFY,
    PrimitiveSpec,
)  # noqa: E402
from .primitives.spec import (  # noqa: E402
    ParallelSpec,
    contract_from_json,
    parallel_spec_from_dict,
)
from .recall import recall_lessons  # noqa: E402
from .recovery import recover_pending  # noqa: E402

__all__ = [
    "__version__",
    # contracts
    "Confidence",
    "Directives",
    "validate_summary",
    "validate_summary_contract",
    "weakest_confidence",
    "CONTRACTS",
    "VERDICT_PASS",
    "VERDICT_FAIL",
    "VERDICTS",
    # context
    "RunContext",
    # engine + playbooks
    "BasePlaybook",
    "ReferenceCycle",
    "ParallelSpec",
    "contract_from_json",
    "parallel_spec_from_dict",
    # loans (Ablate hooks) + recall (F2)
    "Loan",
    "LOANS",
    "loan_enabled",
    "list_loans",
    "recall_lessons",
    "PLAYBOOKS",
    "get_playbook",
    "recover_pending",
    # primitives
    "PrimitiveSpec",
    "PRIMITIVES",
    "OBSERVE",
    "FRAME",
    "PLAN",
    "ACT",
    "VERIFY",
    "LEARN",
    # observability
    "ObsClient",
    # checkpointer
    "Checkpointer",
    "CheckpointRecord",
    "STATUS_RUNNING",
    "STATUS_AWAITING_USER",
    "STATUS_COMPLETE",
    "STATUS_ERROR",
]
