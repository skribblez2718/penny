"""PLAN primitive — sequence the approach into ordered steps (agent: piper)."""

from .. import contracts
from .spec import PrimitiveSpec

PLAN = PrimitiveSpec(
    contracts.PLAN,
    "piper",
    contracts.CONTRACTS[contracts.PLAN],
    "Sequence steps, each with a done-when. Always emit confidence.",
)
