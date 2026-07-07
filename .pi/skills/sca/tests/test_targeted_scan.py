"""
Tests for targeted_scan.py (Phase 7 — P7_TARGETED_SCAN tool execution).

P7 mirrors P2_BASELINE_SCAN's 'tool'-kind architecture (Phase 6a) but is
semgrep-ONLY, best-effort, and MERGES/DEDUPES its findings against P2's already
-persisted baseline findings rather than treating them as a separate set. It
also establishes the re-entrant hook (a well-known, initially-empty
``{output_dir}/targeted/custom-rules/`` directory) the future P9 augmentation
loop (Phase 8) will populate.

Coverage strategy (same discipline as test_baseline_scan.py):
  * The REAL semgrep path is exercised LIVE (NOT mocked) against a small fixture
    that trips BOTH a bundled base-preset rule (detect-child-process) AND a
    hand-placed custom targeted rule (dangerousCustomSink) — proving the
    directory-pickup + merge/dedup mechanism end to end.
  * The merge/dedup accounting, prior-findings resolution, and idempotency are
    ALSO exercised deterministically via an injected subprocess_run returning
    canned SARIF, so those branches never depend on semgrep's exact output.
  * Graceful degradation (semgrep unavailable) is exercised via an injected
    which_fn (mirroring Phase 6a) — P7 must NEVER block the pipeline.
"""

import json
from dataclasses import asdict
from pathlib import Path

import pytest

import baseline_scan
import normalize
import targeted_scan
from targeted_scan import (
    execute_targeted_scan,
    _gather_targeted_rule_files,
    _resolve_targeted_rules_dir,
    _is_within,
    _load_prior_findings,
    _finding_from_dict,
    TARGETED_RULES_SUBPATH,
)


# ── fixtures / helpers ──────────────────────────────────────────────────────


# A custom targeted semgrep rule that flags a call the base preset does NOT
# know about — so any finding it produces is GENUINELY NEW (not part of P2's
# preset), proving the targeted-rules-directory pickup mechanism.
CUSTOM_RULE_YAML = """\
rules:
  - id: sca-p7-targeted-custom-sink
    languages: [javascript]
    severity: WARNING
    message: "Targeted custom rule flagged a dangerous sink."
    pattern: dangerousCustomSink(...)
"""

MALFORMED_RULE_YAML = "this: is: not: valid: semgrep: rules:\n  - [broken\n"


@pytest.fixture
def vuln_repo(tmp_path):
    """A tiny source tree tripping BOTH a base-preset rule and a custom rule.

    * ``cp.exec('ls ' + userInput)`` trips the bundled
      javascript-lang/security/detect-child-process rule (base preset, CWE-78).
    * ``dangerousCustomSink(userInput)`` trips ONLY the hand-placed custom
      targeted rule (genuinely new; not in the base preset).
    """
    repo = tmp_path / "vuln-repo"
    repo.mkdir()
    (repo / "vuln.js").write_text(
        "const cp = require('child_process');\n"
        "function run(userInput) {\n"
        "  cp.exec('ls ' + userInput);\n"
        "  dangerousCustomSink(userInput);\n"
        "}\n"
        "module.exports = { run };\n"
    )
    return repo


def _narrow_config_paths():
    """A small subset of the SCA preset (fast, offline, still real semgrep)."""
    base = baseline_scan._rules_base_discovery()
    assert base is not None, "bundled semgrep rules base not found"
    paths = []
    for rel in ("javascript-lang/security", "javascript-audit", "custom"):
        p = base / rel
        if p.is_dir():
            paths.append(str(p))
    return paths


def _place_custom_rule(output_dir, name="custom.yml", content=CUSTOM_RULE_YAML):
    """Place a rule file in the well-known targeted-rules directory."""
    rules_dir = Path(output_dir) / TARGETED_RULES_SUBPATH
    rules_dir.mkdir(parents=True, exist_ok=True)
    (rules_dir / name).write_text(content)
    return rules_dir


class _FakeCompleted:
    def __init__(self, stdout="", returncode=0, stderr=""):
        self.stdout = stdout
        self.returncode = returncode
        self.stderr = stderr


def _sarif_two_findings():
    """Minimal real-shape SARIF with TWO results (ruleA@line3, ruleB@line10)."""
    return {
        "version": "2.1.0",
        "runs": [
            {
                "tool": {
                    "driver": {
                        "name": "Semgrep OSS",
                        "rules": [
                            {
                                "id": "r.alpha",
                                "defaultConfiguration": {"level": "error"},
                                "properties": {"tags": ["CWE-78"]},
                            },
                            {
                                "id": "r.beta",
                                "defaultConfiguration": {"level": "warning"},
                                "properties": {"tags": []},
                            },
                        ],
                    }
                },
                "results": [
                    {
                        "ruleId": "r.alpha",
                        "message": {"text": "alpha issue"},
                        "locations": [
                            {
                                "physicalLocation": {
                                    "artifactLocation": {"uri": "a.js"},
                                    "region": {"startLine": 3, "startColumn": 3},
                                }
                            }
                        ],
                    },
                    {
                        "ruleId": "r.beta",
                        "message": {"text": "beta issue"},
                        "locations": [
                            {
                                "physicalLocation": {
                                    "artifactLocation": {"uri": "b.js"},
                                    "region": {"startLine": 10, "startColumn": 5},
                                }
                            }
                        ],
                    },
                ],
            }
        ],
    }


def _fake_semgrep_env(tmp_path, sarif_doc):
    """Return (which_fn, subprocess_run) that fake a real semgrep install."""
    fake_bin = tmp_path / "semgrep"
    fake_bin.write_text("#!/bin/sh\n")

    def which_fn(binary):
        return str(fake_bin) if binary == "semgrep" else None

    def subprocess_run(cmd, **kwargs):
        if "--version" in cmd:
            return _FakeCompleted(stdout="1.158.0", returncode=0)
        return _FakeCompleted(stdout=json.dumps(sarif_doc), returncode=0)

    return which_fn, subprocess_run


def _all_missing_which(_binary):
    return None


# ── unit: helpers (no semgrep) ──────────────────────────────────────────────


class TestTargetedRulesDirHelpers:
    def test_resolve_dir_is_within_output_dir(self, tmp_path):
        out = tmp_path / "out"
        rules_dir = _resolve_targeted_rules_dir(str(out))
        assert rules_dir is not None
        assert _is_within(out.resolve(), rules_dir)
        assert rules_dir.name == "custom-rules"

    def test_nonexistent_dir_gathers_zero_rules(self, tmp_path):
        out = tmp_path / "out"
        rules_dir = _resolve_targeted_rules_dir(str(out))
        # directory does not exist yet (first-ever run) -> zero rules, no crash
        assert _gather_targeted_rule_files(rules_dir, out.resolve()) == []

    def test_gather_only_yaml_rule_files(self, tmp_path):
        out = tmp_path / "out"
        rules = _place_custom_rule(str(out), name="a.yml")
        (rules / "b.yaml").write_text(CUSTOM_RULE_YAML)
        (rules / "notes.txt").write_text("ignore me")
        (rules / "README.md").write_text("# ignore")
        found = _gather_targeted_rule_files(
            _resolve_targeted_rules_dir(str(out)), out.resolve()
        )
        assert len(found) == 2
        assert all(p.endswith((".yml", ".yaml")) for p in found)

    def test_containment_rejects_symlink_escape(self, tmp_path):
        # A targeted-rules dir that symlinks OUTSIDE output_dir must be refused
        # (no path-traversal escape), consistent with the containment discipline.
        out = tmp_path / "out"
        (out / "targeted").mkdir(parents=True)
        outside = tmp_path / "outside"
        outside.mkdir()
        link = out / "targeted" / "custom-rules"
        link.symlink_to(outside, target_is_directory=True)
        assert _resolve_targeted_rules_dir(str(out)) is None

    def test_escaping_rules_dir_is_recorded_as_gap_not_crash(self, tmp_path):
        # End-to-end: a targeted-rules dir that symlinks OUTSIDE output_dir is
        # refused (containment) and recorded as a coverage gap; the scan still
        # completes with prior findings carried forward (semgrep forced-absent).
        out = tmp_path / "out"
        (out / "targeted").mkdir(parents=True)
        outside = tmp_path / "outside"
        outside.mkdir()
        (out / "targeted" / "custom-rules").symlink_to(
            outside, target_is_directory=True
        )
        result = execute_targeted_scan(
            str(tmp_path / "src"),
            str(out),
            "sess-escape",
            prior_findings=[],
            which_fn=_all_missing_which,
        )
        assert result["blocked"] is False
        assert result["completed"] is True
        assert result["targeted_rules_dir"] is None
        gap_tools = {g["tool"] for g in result["coverage_gaps"]}
        assert "targeted-rules" in gap_tools

    def test_is_within(self, tmp_path):
        base = tmp_path / "base"
        assert _is_within(base, base / "x" / "y")
        assert _is_within(base, base)
        assert not _is_within(base, tmp_path / "other")

    def test_finding_from_dict_roundtrips(self):
        f = normalize.parse_sarif(_sarif_two_findings())[0]
        rebuilt = _finding_from_dict(asdict(f))
        assert rebuilt is not None
        assert rebuilt.id == f.id
        assert (rebuilt.tool, rebuilt.rule_id, rebuilt.file, rebuilt.line) == (
            f.tool, f.rule_id, f.file, f.line
        )

    def test_finding_from_dict_rejects_junk(self):
        assert _finding_from_dict("nope") is None
        assert _finding_from_dict({"id": "x"}) is None  # missing required fields


class TestPriorFindingsResolution:
    def test_no_prior_files_is_empty(self, tmp_path):
        assert _load_prior_findings(str(tmp_path / "out")) == []

    def test_reads_baseline_when_no_targeted(self, tmp_path):
        out = tmp_path / "out"
        (out / "baseline").mkdir(parents=True)
        (out / "baseline" / "findings.json").write_text(
            json.dumps({"findings": [{"id": "F-base"}]})
        )
        prior = _load_prior_findings(str(out))
        assert prior == [{"id": "F-base"}]

    def test_prefers_targeted_over_baseline_when_present(self, tmp_path):
        out = tmp_path / "out"
        (out / "baseline").mkdir(parents=True)
        (out / "targeted").mkdir(parents=True)
        (out / "baseline" / "findings.json").write_text(
            json.dumps({"findings": [{"id": "F-base"}]})
        )
        (out / "targeted" / "findings.json").write_text(
            json.dumps({"findings": [{"id": "F-accumulated"}]})
        )
        prior = _load_prior_findings(str(out))
        assert prior == [{"id": "F-accumulated"}]


# ── merge / dedup accounting (deterministic, injected subprocess) ────────────


class TestMergeDedupAccounting:
    def test_new_findings_merged_with_empty_prior(self, tmp_path):
        which_fn, run = _fake_semgrep_env(tmp_path, _sarif_two_findings())
        result = execute_targeted_scan(
            str(tmp_path / "src"),
            str(tmp_path / "out"),
            "sess-merge1",
            prior_findings=[],
            which_fn=which_fn,
            subprocess_run=run,
            semgrep_config_paths=["/fake/rules"],
        )
        assert result["blocked"] is False
        assert result["completed"] is True
        assert result["semgrep_available"] is True
        assert result["prior_findings_count"] == 0
        assert len(result["findings"]) == 2

    def test_overlapping_prior_finding_deduped_not_double_counted(self, tmp_path):
        # Build a prior (P2) finding set that DUPLICATES one of the two scan
        # findings; merge must collapse it to ONE, keeping the other as new.
        overlap = asdict(normalize.parse_sarif(_sarif_two_findings())[0])
        which_fn, run = _fake_semgrep_env(tmp_path, _sarif_two_findings())
        result = execute_targeted_scan(
            str(tmp_path / "src"),
            str(tmp_path / "out"),
            "sess-merge2",
            prior_findings=[overlap],
            which_fn=which_fn,
            subprocess_run=run,
            semgrep_config_paths=["/fake/rules"],
        )
        # prior(1) + new(2) with 1 overlap -> 2 total (NOT a naive 3).
        assert result["prior_findings_count"] == 1
        assert len(result["findings"]) == 2
        rule_ids = sorted(f["rule_id"] for f in result["findings"])
        assert rule_ids == ["r.alpha", "r.beta"]

    def test_absent_p2_baseline_treated_as_empty_prior(self, tmp_path):
        # No prior_findings passed AND no baseline/findings.json on disk: P7
        # still runs and produces its own findings (empty prior, not an error).
        which_fn, run = _fake_semgrep_env(tmp_path, _sarif_two_findings())
        result = execute_targeted_scan(
            str(tmp_path / "src"),
            str(tmp_path / "out"),
            "sess-noprior",
            which_fn=which_fn,
            subprocess_run=run,
            semgrep_config_paths=["/fake/rules"],
        )
        assert result["prior_findings_count"] == 0
        assert len(result["findings"]) == 2

    def test_idempotent_rerun_does_not_grow_findings(self, tmp_path):
        # Running P7 twice with UNCHANGED rules must NOT grow an ever-larger set
        # (idempotency by content-derived id + dedup, not a re-run guard).
        which_fn, run = _fake_semgrep_env(tmp_path, _sarif_two_findings())
        out = tmp_path / "out"
        first = execute_targeted_scan(
            str(tmp_path / "src"), str(out), "sess-idem",
            which_fn=which_fn, subprocess_run=run,
            semgrep_config_paths=["/fake/rules"],
        )
        assert len(first["findings"]) == 2
        # Second call resolves prior from the persisted targeted/findings.json.
        second = execute_targeted_scan(
            str(tmp_path / "src"), str(out), "sess-idem",
            which_fn=which_fn, subprocess_run=run,
            semgrep_config_paths=["/fake/rules"],
        )
        assert second["prior_findings_count"] == 2
        assert len(second["findings"]) == 2  # collapsed, not 4


# ── graceful degradation (semgrep unavailable) ──────────────────────────────


class TestGracefulDegradation:
    def test_semgrep_unavailable_does_not_block(self, tmp_path):
        result = execute_targeted_scan(
            str(tmp_path / "src"),
            str(tmp_path / "out"),
            "sess-degrade",
            prior_findings=[],
            which_fn=_all_missing_which,
        )
        assert result["blocked"] is False
        assert result["completed"] is True
        assert result["semgrep_available"] is False
        gap_tools = {g["tool"] for g in result["coverage_gaps"]}
        assert "semgrep" in gap_tools

    def test_degradation_carries_prior_findings_forward_unchanged(self, tmp_path):
        prior = asdict(normalize.parse_sarif(_sarif_two_findings())[0])
        result = execute_targeted_scan(
            str(tmp_path / "src"),
            str(tmp_path / "out"),
            "sess-degrade2",
            prior_findings=[prior],
            which_fn=_all_missing_which,
        )
        assert len(result["findings"]) == 1
        assert result["findings"][0]["rule_id"] == prior["rule_id"]
        # Still persisted (the merged==prior set), never a blocking error.
        assert Path(result["findings_path"]).exists()

    def test_degradation_persists_artifacts(self, tmp_path):
        out = tmp_path / "out"
        result = execute_targeted_scan(
            str(tmp_path / "src"), str(out), "sess-degrade3",
            prior_findings=[], which_fn=_all_missing_which,
        )
        assert Path(result["findings_path"]).name == "findings.json"
        assert Path(result["coverage_path"]).name == "coverage.md"
        assert result["mempalace"]["room"] == "sess-degrade3-p7-targeted-findings"
        assert result["mempalace"]["wing"] == "wing_sca"


# ── REAL semgrep end-to-end (NOT mocked) ────────────────────────────────────


@pytest.mark.slow
@pytest.mark.requires_semgrep
class TestTargetedScanRealE2E:
    def test_real_base_and_targeted_rules_both_fire(self, vuln_repo, tmp_path):
        out = tmp_path / "out"
        _place_custom_rule(str(out))
        result = execute_targeted_scan(
            str(vuln_repo),
            str(out),
            "sess-p7-real",
            prior_findings=[],
            semgrep_config_paths=_narrow_config_paths(),
        )
        assert result["blocked"] is False
        assert result["semgrep_available"] is True
        assert result["targeted_rule_files"], "custom rule should be picked up"
        rule_ids = [f["rule_id"] for f in result["findings"]]
        # base preset finding:
        assert any("child-process" in r for r in rule_ids)
        # genuinely-new targeted-rule finding:
        assert any("custom-sink" in r for r in rule_ids)

    def test_real_overlapping_p2_finding_deduped_new_survives(
        self, vuln_repo, tmp_path
    ):
        out = tmp_path / "out"
        _place_custom_rule(str(out))
        # Pass A: capture the real base-preset (child-process) finding, which we
        # then inject as a stubbed P2 baseline result for Pass B.
        pass_a = execute_targeted_scan(
            str(vuln_repo), str(out), "sess-p7-a",
            prior_findings=[], semgrep_config_paths=_narrow_config_paths(),
        )
        child = [f for f in pass_a["findings"] if "child-process" in f["rule_id"]]
        assert child, "expected a base-preset child-process finding"
        injected_p2 = [child[0]]

        # Pass B: the injected P2 finding OVERLAPS P7's own base-preset finding
        # -> must collapse to ONE; the custom-sink finding survives as NEW.
        out_b = tmp_path / "outB"
        _place_custom_rule(str(out_b))
        pass_b = execute_targeted_scan(
            str(vuln_repo), str(out_b), "sess-p7-b",
            prior_findings=injected_p2,
            semgrep_config_paths=_narrow_config_paths(),
        )
        child_b = [
            f for f in pass_b["findings"] if "child-process" in f["rule_id"]
        ]
        custom_b = [
            f for f in pass_b["findings"] if "custom-sink" in f["rule_id"]
        ]
        assert len(child_b) == 1, "overlapping P2 finding must dedupe to one"
        assert len(custom_b) >= 1, "genuinely-new targeted finding must survive"

    def test_real_reentrancy_second_pass_picks_up_new_rule(
        self, vuln_repo, tmp_path
    ):
        out = tmp_path / "out"
        # First pass: targeted-rules dir is EMPTY -> only base-preset findings.
        first = execute_targeted_scan(
            str(vuln_repo), str(out), "sess-p7-re",
            prior_findings=[], semgrep_config_paths=_narrow_config_paths(),
        )
        assert not any(
            "custom-sink" in f["rule_id"] for f in first["findings"]
        )
        first_child = [
            f for f in first["findings"] if "child-process" in f["rule_id"]
        ]
        assert len(first_child) == 1

        # Now author a new rule into the directory (simulating P9's future
        # rule-authoring) and re-enter P7. prior is resolved from the CURRENT
        # accumulated targeted/findings.json (not the original baseline).
        _place_custom_rule(str(out))
        second = execute_targeted_scan(
            str(vuln_repo), str(out), "sess-p7-re",
            semgrep_config_paths=_narrow_config_paths(),
        )
        assert any("custom-sink" in f["rule_id"] for f in second["findings"])
        # Re-entrancy must not duplicate the pre-existing child-process finding.
        second_child = [
            f for f in second["findings"] if "child-process" in f["rule_id"]
        ]
        assert len(second_child) == 1

    def test_real_persists_merged_findings_and_coverage(self, vuln_repo, tmp_path):
        out = tmp_path / "out"
        _place_custom_rule(str(out))
        result = execute_targeted_scan(
            str(vuln_repo), str(out), "sess-p7-persist",
            prior_findings=[], semgrep_config_paths=_narrow_config_paths(),
        )
        fpath = Path(result["findings_path"])
        cpath = Path(result["coverage_path"])
        assert fpath.exists() and fpath.parent.name == "targeted"
        assert fpath.name == "findings.json"
        assert cpath.exists() and cpath.name == "coverage.md"
        doc = json.loads(fpath.read_text())
        assert doc["findings"]
        assert result["mempalace"]["room"] == "sess-p7-persist-p7-targeted-findings"
        assert result["mempalace"]["wing"] == "wing_sca"

    def test_real_malformed_rule_does_not_crash_phase(self, vuln_repo, tmp_path):
        # A malformed rule file must be recorded as a coverage gap, NOT crash
        # the phase; the base-preset findings must still survive.
        out = tmp_path / "out"
        _place_custom_rule(str(out), name="bad.yml", content=MALFORMED_RULE_YAML)
        result = execute_targeted_scan(
            str(vuln_repo), str(out), "sess-p7-bad",
            prior_findings=[], semgrep_config_paths=_narrow_config_paths(),
        )
        assert result["blocked"] is False
        assert result["completed"] is True
        # base preset still produced its finding despite the bad targeted rule
        assert any(
            "child-process" in f["rule_id"] for f in result["findings"]
        )
        # the bad targeted-rule scan is recorded as a coverage gap
        gap_blob = " ".join(g["reason"] for g in result["coverage_gaps"])
        assert "targeted" in gap_blob.lower() or "semgrep" in gap_blob.lower()

    def test_real_empty_targeted_dir_is_not_an_error(self, vuln_repo, tmp_path):
        # No custom-rules dir created at all: base preset still runs, zero
        # additional rules, no crash.
        out = tmp_path / "out"
        result = execute_targeted_scan(
            str(vuln_repo), str(out), "sess-p7-empty",
            prior_findings=[], semgrep_config_paths=_narrow_config_paths(),
        )
        assert result["blocked"] is False
        assert result["targeted_rule_files"] == []
        assert any(
            "child-process" in f["rule_id"] for f in result["findings"]
        )
