"""VERIFY primitive — judge artifacts vs criteria (agent: vera)."""

from .. import contracts
from .spec import PrimitiveSpec

VERIFY = PrimitiveSpec(
    contracts.VERIFY,
    "vera",
    contracts.CONTRACTS[contracts.VERIFY],
    "Judge artifacts vs success_criteria; verdict PASS/FAIL + gaps. "
    "Use a different model than ACT. Always emit confidence.",
)
