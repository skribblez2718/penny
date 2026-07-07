"""LEARN primitive — record prediction vs outcome to the ledger (agent: carren)."""

from .. import contracts
from .spec import PrimitiveSpec

LEARN = PrimitiveSpec(
    contracts.LEARN,
    "carren",
    contracts.CONTRACTS[contracts.LEARN],
    "Record prediction vs outcome to the outcome ledger (inside the agent).",
)
