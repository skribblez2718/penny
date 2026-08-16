"""The model roster — which models the fleet actually runs on, as an EVENT TRIGGER.

Why this exists
---------------
Every acceptance of borrowed scaffolding in this codebase (``loans.py``) and every
accepted same-model verify edge (``independence.py``) carries a ``review_by`` date.
A calendar is the wrong trigger. The Bitter-Lesson doctrine says so explicitly:
re-audit *"periodically (target ~quarterly) **and** event-driven on a major model
upgrade — a stronger model is precisely when scaffolding becomes newly obsolete"*.

A date cannot know that. It fires when the earth has moved, not when the fleet has.
A scaffold that compensates for a model weakness should be re-measured the moment the
models change, whether that is a week or a year after it was taken — and should NOT
demand attention on a Tuesday in October merely because someone typed that date.

What is hashed, and why the SET
-------------------------------
The digest covers the sorted set of DISTINCT models across ``.pi/agents/*.md`` — not
the agent->model mapping. Re-pointing one agent at another model already in the fleet
is caught elsewhere and better: ``independence.classify`` resolves models LIVE per
edge, so a re-pointed verifier changes its classification immediately. What neither
ledger can currently see is the fleet gaining, losing, or swapping a MODEL — the
event the doctrine names as the moment to re-measure.

Known limitation (stated rather than papered over)
--------------------------------------------------
Agent frontmatter may name models by aliases rather than immutable versions. A
provider silently improving a model behind an unchanged alias will NOT move this
hash, and no amount of hashing local files can detect it. This trigger therefore
catches *declared* fleet changes only; a silent upgrade still relies on the periodic
pass. Recording the alias set is strictly better than a date, and strictly worse than
a version-pinned roster would be — pin versions in frontmatter and this gets sharper
for free.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

_AGENTS_DIR = Path(__file__).resolve().parents[4] / ".pi" / "agents"

_MODEL_RE = re.compile(r"(?m)^model:[ \t]*(\S+)[ \t]*$")


def model_roster(agents_dir: Path | str = _AGENTS_DIR) -> dict[str, str]:
    """``{agent_name: model}`` read LIVE from ``.pi/agents/*.md`` frontmatter.

    Agents whose file declares no ``model:`` are omitted rather than guessed \u2014 an
    unresolvable agent must never be silently folded into the fleet identity.
    """
    roster: dict[str, str] = {}
    directory = Path(agents_dir)
    if not directory.is_dir():
        return roster
    for path in sorted(directory.glob("*.md")):
        match = _MODEL_RE.search(path.read_text(encoding="utf-8"))
        if match:
            roster[path.stem] = match.group(1).strip()
    return roster


def distinct_models(agents_dir: Path | str = _AGENTS_DIR) -> tuple[str, ...]:
    """The sorted set of models the fleet runs on."""
    return tuple(sorted(set(model_roster(agents_dir).values())))


def roster_hash(agents_dir: Path | str = _AGENTS_DIR) -> str:
    """Short stable digest of the fleet's distinct models.

    Empty roster -> ``""`` (unknown), never a digest of nothing: a missing agents
    directory must read as "cannot tell", not as a fleet that happens to differ.
    """
    models = distinct_models(agents_dir)
    if not models:
        return ""
    return hashlib.sha256("|".join(models).encode("utf-8")).hexdigest()[:12]


def roster_changed(recorded: str, agents_dir: Path | str = _AGENTS_DIR) -> bool:
    """Has the fleet changed since ``recorded`` was captured?

    Unknown on either side (``""``) reads as NOT changed: an un-baselined entry or an
    unreadable agents dir should not spam every acceptance as needing review. The
    absence of a baseline is reported separately by the ledger checks.
    """
    current = roster_hash(agents_dir)
    if not recorded or not current:
        return False
    return recorded != current
