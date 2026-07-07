"""FRAME primitive — turn goal + evidence into success_criteria (agent: annie)."""

from .. import contracts
from .spec import PrimitiveSpec

FRAME = PrimitiveSpec(
    contracts.FRAME,
    "annie",
    contracts.CONTRACTS[contracts.FRAME],
    "Define success_criteria (= the verification criteria). Always emit confidence.",
)
