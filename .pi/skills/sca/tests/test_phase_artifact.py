"""
Regression tests for durable phase artifacts (F4).

Rich agent-phase outputs (P4 architecture / P6 threat model / P8 triage) used to
live ONLY in mempalace plus a checkpointer copy that ``capture_phase_result``
silently truncates to ``{_summary, _truncated}`` once it exceeds the store cap.
With mempalace down, that load-bearing detail was unrecoverable.

``write_phase_artifact`` makes disk the durable source of truth: the COMPLETE
result is written to ``{output_dir}/phases/<phase>.json`` regardless of size,
so the detail survives a mempalace outage.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import sca_domain  # noqa: E402


def test_write_phase_artifact_persists_full_result(tmp_path):
    out = tmp_path / "sca-out"
    meta = {"output_dir": str(out)}
    big = {"components": [f"c{i}" for i in range(500)], "detail": "x" * 9000}

    path = sca_domain.write_phase_artifact(meta, "P4_ARCHITECTURE", big)

    assert path
    p = Path(path)
    assert p.exists() and p.parent.name == "phases"
    assert json.loads(p.read_text(encoding="utf-8")) == big  # full, not truncated


def test_disk_artifact_is_complete_even_when_checkpointer_copy_truncates(tmp_path):
    # The two paths diverge on purpose: the checkpointer copy is size-bounded
    # (and truncates); the on-disk artifact is complete (F4).
    meta = {"output_dir": str(tmp_path / "o")}
    # Many entries (not one long string): _bound_stored_value caps per-string
    # length but not entry COUNT, so the bounded copy still exceeds the store
    # cap and collapses to a truncated summary.
    big = {f"component_{i}": f"detail for component {i}" for i in range(800)}

    sca_domain.capture_phase_result(meta, "P6_THREAT_MODEL", big)
    assert meta["phase_results"]["P6_THREAT_MODEL"].get("_truncated") is True

    path = sca_domain.write_phase_artifact(meta, "P6_THREAT_MODEL", big)
    assert json.loads(Path(path).read_text(encoding="utf-8")) == big


def test_write_phase_artifact_noop_without_output_dir():
    assert sca_domain.write_phase_artifact({}, "P4", {"a": 1}) is None
    assert sca_domain.write_phase_artifact({"output_dir": ""}, "P4", {"a": 1}) is None


def test_write_phase_artifact_ignores_non_dict_and_empty():
    assert sca_domain.write_phase_artifact({"output_dir": "/x"}, "P4", "nope") is None
    assert sca_domain.write_phase_artifact({"output_dir": "/x"}, "P4", {}) is None


def test_write_phase_artifact_sanitizes_phase_name(tmp_path):
    meta = {"output_dir": str(tmp_path / "o")}
    path = sca_domain.write_phase_artifact(meta, "P8/../weird name", {"a": 1})
    assert path is not None
    p = Path(path)
    # Written safely inside the phases dir — no traversal, no spaces/slashes.
    assert p.parent.name == "phases"
    assert "/" not in p.name and " " not in p.name
