"""The six operational primitives (name, default agent, SUMMARY contract, hint).

Each PrimitiveSpec is a reusable engine descriptor a playbook may bind to its own
states in-process (via PRIMITIVE_BY_STATE). They are engine objects only — never
`.pi/skills/` entries; the reference-cycle test fixture is their end-to-end consumer.
"""

from .spec import PrimitiveSpec
from .observe import OBSERVE
from .frame import FRAME
from .plan import PLAN
from .act import ACT
from .verify import VERIFY
from .learn import LEARN

PRIMITIVES: dict[str, PrimitiveSpec] = {
    p.name: p for p in (OBSERVE, FRAME, PLAN, ACT, VERIFY, LEARN)
}

__all__ = ["PrimitiveSpec", "OBSERVE", "FRAME", "PLAN", "ACT", "VERIFY", "LEARN", "PRIMITIVES"]
