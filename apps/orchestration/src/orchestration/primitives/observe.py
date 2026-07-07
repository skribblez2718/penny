"""OBSERVE primitive — gather evidence, surface unknowns (agent: echo)."""

from .. import contracts
from .spec import PrimitiveSpec

OBSERVE = PrimitiveSpec(
    contracts.OBSERVE,
    "echo",
    contracts.CONTRACTS[contracts.OBSERVE],
    "Gather evidence; surface unknowns. Always emit confidence.",
)
