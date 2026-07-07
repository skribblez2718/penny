"""
Opt-in, local-only NodeGoat integration test (Phase 11).

This is the ONE test that WOULD exercise the real sca deterministic scan against
a real OWASP NodeGoat clone and score it against the ground-truth catalogue. It
is deliberately gated so it NEVER runs by default and NEVER touches the network:

  * marked ``integration`` + ``slow`` + ``requires_semgrep`` -> excluded from the
    default fast lane (`make test` selects
    `not e2e and not slow and not network and not integration`).
  * skips gracefully unless ALL of these hold:
      1. a real NodeGoat clone exists at ``$SCA_NODEGOAT_PATH`` (documented
         expected path; defaults to ``~/src/NodeGoat``),
      2. ``ground-truth.json`` has been populated with verified entries,
      3. the real semgrep binary is installed.
  * it NEVER clones or downloads NodeGoat — cloning is a real network operation
    this build has consistently kept out of its test suite. If the clone is
    absent, the test SKIPS with a clear message pointing at the README.

Because the shipped ``ground-truth.json`` is an honest empty template, this test
skips in every environment today. It becomes a real end-to-end benchmark the
moment someone (a) clones NodeGoat locally and (b) populates verified ground
truth — see ``README.md`` in this directory.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

import pytest

# Import the sibling benchmark harness and the skill's real baseline scanner.
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))
sys.path.insert(0, str(_HERE.parent.parent / "scripts"))

import benchmark  # noqa: E402


def _nodegoat_clone_path() -> Path:
    """The documented expected clone path (env override, else ~/src/NodeGoat)."""
    env = os.environ.get("SCA_NODEGOAT_PATH")
    if env:
        return Path(env).expanduser()
    return Path.home() / "src" / "NodeGoat"


def _clone_present(path: Path) -> bool:
    """True only if a plausible real NodeGoat clone exists at ``path``.

    Checks for the clone directory plus a couple of NodeGoat-characteristic
    files. Never fetches anything — a missing clone simply means 'skip'.
    """
    if not path.is_dir():
        return False
    # NodeGoat is a Node app with a package.json and an app/ directory.
    return (path / "package.json").is_file() and (path / "app").is_dir()


@pytest.mark.integration
@pytest.mark.slow
@pytest.mark.requires_semgrep
class TestNodeGoatBenchmarkIntegration:
    def test_pipeline_against_real_nodegoat_clone(self, tmp_path):
        clone = _nodegoat_clone_path()

        if shutil.which("semgrep") is None:
            pytest.skip("semgrep not installed — cannot run the real scan")

        if not _clone_present(clone):
            pytest.skip(
                f"no NodeGoat clone at {clone} — set $SCA_NODEGOAT_PATH to a real "
                "clone (this harness never clones NodeGoat itself; see "
                "tests/nodegoat/README.md)"
            )

        ground_truth = benchmark.load_ground_truth(_HERE / "ground-truth.json")
        if not ground_truth:
            pytest.skip(
                "ground-truth.json is the honest empty template — populate it "
                "with verified NodeGoat entries first (see tests/nodegoat/README.md)"
            )

        # Real, deterministic baseline scan against the real clone. (A full
        # end-to-end run would also drive the LLM agent phases; the deterministic
        # scan is the machine-checkable core we benchmark here.)
        from baseline_scan import execute_baseline_scan  # noqa: WPS433

        out = tmp_path / "nodegoat-out"
        result = execute_baseline_scan(
            str(clone),
            str(out),
            "sess-nodegoat-benchmark",
        )
        assert result["blocked"] is False, "baseline scan was hard-blocked"

        metrics = benchmark.compute_benchmark_metrics(
            ground_truth,
            result.get("findings", []),
            line_tolerance=2,
        )

        # We assert the harness produced a sane, complete metrics dict. We do
        # NOT hard-assert a precision/recall FLOOR here: the achievable score
        # depends on which tools are installed and how complete the (human-
        # populated) ground truth is. Recording the number is the deliverable;
        # a threshold would be a separate, deliberately-set policy decision.
        assert metrics["ground_truth_count"] == len(ground_truth)
        assert metrics["true_positives"] + metrics["false_negatives"] == len(
            ground_truth
        )
        assert 0.0 <= metrics["precision"] <= 1.0
        assert 0.0 <= metrics["recall"] <= 1.0
        assert 0.0 <= metrics["f1"] <= 1.0
        print(f"\nNodeGoat benchmark metrics: {metrics}")
