"""ACT primitive — produce or change the artifact (agent: skribble)."""

from .. import contracts
from .spec import PrimitiveSpec

ACT = PrimitiveSpec(
    contracts.ACT,
    "skribble",
    contracts.CONTRACTS[contracts.ACT],
    "Produce/change the artifact; record artifacts for idempotent re-run. Always emit confidence.",
)
