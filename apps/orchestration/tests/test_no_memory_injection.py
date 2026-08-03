"""Invariant: NOTHING retrieved from MemPalace is injected into an agent directive.

WHY THIS EXISTS
---------------
The engine used to run a "Recall (atom F2)" step at ``start()``: it searched a
MemPalace room and seeded the FIRST agent directive with whatever came back,
labelled "Lessons from prior runs (advisory…)".

The room it read held unreviewed stored proposals, not distilled lessons, and the
retrieval applied no status filter — so text the operator had never approved, and
text the operator had explicitly rejected, was rendered into agent prompts verbatim.
Stored text reached the model through a door with no gate on it at all.

THE RULE (operator-set, not negotiable by a future refactor):
  * An agent's context comes from ``.pi/agents/<agent>.md`` + skill orchestration.
  * A playbook directive carries THIS run's facts only.
  * Stored text influences the system exactly one way: a human approves it and the
    relevant file is edited. Never by being fed to a model as "context".

These tests are the ratchet. They are deliberately source-level as well as
behavioural, because the failure mode is *reintroduction* in a new playbook.
"""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest

from orchestration.context import RunContext

_SRC = Path(__file__).resolve().parents[1] / "src" / "orchestration"

# USAGE patterns of the removed mechanism. Matching on usage (not the bare token)
# lets context.py keep the token in its ``_RETIRED_KEYS`` declaration — which is the
# migration seam that must exist — while still catching any real reintroduction.
_FORBIDDEN = (
    "ctx.recall_lessons",
    "self.recall_lessons",
    "recall_lessons(",
    "recall_lessons =",
    "from .recall",
    "import recall",
    "Lessons from prior runs",
)


def _python_sources() -> list[Path]:
    return [p for p in _SRC.rglob("*.py") if "__pycache__" not in p.parts]


# ---------------------------------------------------------------------------
# the mechanism is gone
# ---------------------------------------------------------------------------


def test_recall_module_no_longer_exists():
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("orchestration.recall")


def test_orchestration_package_exports_no_recall_symbol():
    import orchestration

    assert not hasattr(orchestration, "recall_lessons")
    assert "recall_lessons" not in getattr(orchestration, "__all__", [])


def test_runcontext_models_no_retrieved_lessons_field():
    ctx = RunContext(session_id="s", run_id="r", playbook="p")
    assert not hasattr(ctx, "recall_lessons")
    assert "recall_lessons" not in ctx.to_dict()


@pytest.mark.parametrize("path", _python_sources(), ids=lambda p: p.name)
def test_no_source_file_reintroduces_memory_injection(path):
    text = path.read_text(encoding="utf-8")
    hits = [m for m in _FORBIDDEN if m in text]
    assert not hits, (
        f"{path.relative_to(_SRC)} reintroduces retrieved-memory injection {hits}. "
        "Agent directives carry this run's facts only; amendments reach the system "
        "by human-approved file edits, never by injection into a prompt."
    )


def test_context_mentions_the_retired_key_only_as_a_retired_key():
    # The one legitimate occurrence in the tree: the migration seam that drops the
    # key from legacy checkpoints. It must NOT be a live serialization key again.
    text = (_SRC / "context.py").read_text(encoding="utf-8")
    assert "_RETIRED_KEYS" in text and '"recall_lessons"' in text
    keys_block = text.split("_KEYS: tuple[str, ...] = (", 1)[1].split(")", 1)[0]
    assert "recall_lessons" not in keys_block, "retired key is back in _KEYS"


# ---------------------------------------------------------------------------
# migration safety: the retired key must not wedge in-flight runs
# ---------------------------------------------------------------------------


def test_legacy_checkpoint_carrying_the_retired_key_still_loads():
    # 92/104 checkpoints in the live DB were written with `recall_lessons`, 5 of them
    # still resumable. from_dict fails loud on unknown keys by design, so the retired
    # key must be explicitly dropped or those runs could never resume.
    legacy = {
        "session_id": "s",
        "run_id": "r",
        "playbook": "prd",
        "goal": "build a thing",
        "iteration": 2,
        "recall_lessons": ["a stale injected lesson", "another"],
    }
    ctx = RunContext.from_dict(legacy)
    assert ctx.run_id == "r" and ctx.goal == "build a thing" and ctx.iteration == 2
    assert not hasattr(ctx, "recall_lessons")  # dropped, not carried forward
    assert "recall_lessons" not in ctx.to_dict()  # and never re-persisted


def test_genuinely_unknown_keys_still_fail_loud():
    # Retiring a key must not weaken the schema-drift guard for everything else.
    with pytest.raises(ValueError, match="unknown keys"):
        RunContext.from_dict(
            {"session_id": "s", "run_id": "r", "playbook": "prd", "bogus_field": 1}
        )


# ---------------------------------------------------------------------------
# behavioural: a built directive contains no injected memory
# ---------------------------------------------------------------------------


def test_base_task_summary_contains_only_run_facts():
    from orchestration.engine import BasePlaybook
    from orchestration.primitives.spec import PrimitiveSpec

    spec = PrimitiveSpec("OP", "vera", {"required": {}}, "do the thing")
    ctx = RunContext(session_id="s", run_id="r", playbook="p", goal="the goal")
    # _task_summary is pure w.r.t. the checkpointer, so None is safe here.
    text = BasePlaybook(None)._task_summary("some_state", spec, ctx)
    assert "the goal" in text
    assert "Lessons from prior runs" not in text
