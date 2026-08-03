"""Shared fixtures for the self-improvement tests."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import compression_loop  # noqa: E402


@pytest.fixture
def drafting_enabled(monkeypatch):
    """Stand in for the diff model so ``run_compression_loop`` yields amendments.

    An amendment now exists ONLY when the model drafts a real anchored diff —
    there is deliberately no template fallback, so without a drafter the loop
    correctly returns []. Tests that exercise DOWNSTREAM behaviour (dedup,
    universal-learning rejection, multi-pattern handling, applier wiring) need
    an amendment to exist, so they opt into this fixture.

    Deliberately opt-in, not autouse: a blanket patch would mask the guarantee
    that no machine-authored prompt text is ever produced when drafting is off.
    """

    def _draft(learning, evidence, target_file, *, runner=None):
        return {
            "action": "ADD",
            "old_text": "",
            "new_text": "\n\nPrefer an explicit timeout over the default.\n",
            "rationale": "model-drafted (test fixture)",
        }

    monkeypatch.setattr(compression_loop, "draft_change", _draft)
    return _draft
