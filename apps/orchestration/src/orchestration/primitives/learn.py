"""LEARN primitive — record what the run learned (agent: carren)."""

from .. import contracts
from .spec import PrimitiveSpec

LEARN = PrimitiveSpec(
    contracts.LEARN,
    "carren",
    contracts.CONTRACTS[contracts.LEARN],
    "Record what was learned from this run (inside the agent).",
)
