"""
Tests for baseline_scan.py (Phase 6a — P2_BASELINE_SCAN tool execution).

Coverage strategy:
  * The BLOCKING path (all 3 required tools missing) is tested deterministically
    via an injected which_fn (matching provisioning.py's injectable pattern) so
    it never depends on actually uninstalling semgrep.
  * The REAL semgrep path is exercised LIVE against a small fixture with a
    deliberately-flagged vulnerable pattern — NOT mocked (semgrep is genuinely
    installed in this dev env).
  * Tool PRESENCE is host-dependent: osv-scanner/gitleaks may or may not be
    installed on a given host. Tests that depend on presence either inject a
    which_fn / subprocess_run for determinism, or adapt to the real host state
    via shutil.which (see the presence-aware coverage-gap test). The real
    osv-scanner CLI+parsing was REAL-VERIFIED against osv-scanner 2.4.0 (see
    TestOsvScannerRealLockfileIntegration below, which runs the real binary
    against a real lodash lockfile and auto-skips when osv-scanner is absent).
  * osv-scanner/gitleaks output-parsing branches are ALSO covered
    deterministically by injecting a fake subprocess_run that returns canned
    JSON in their real (verified) shapes.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

import baseline_scan
import normalize
from baseline_scan import (
    execute_baseline_scan,
    default_semgrep_config_paths,
    run_osv_scanner,
    run_gitleaks,
    run_semgrep,
)


# ── fixtures / helpers ──────────────────────────────────────────────────────


@pytest.fixture
def vuln_repo(tmp_path):
    """A tiny source tree with a deliberately-flagged vulnerable JS pattern.

    child_process.exec on concatenated input reliably trips the bundled
    javascript-lang/security/detect-child-process rule (CWE-78).
    """
    repo = tmp_path / "vuln-repo"
    repo.mkdir()
    (repo / "vuln.js").write_text(
        "const cp = require('child_process');\n"
        "function run(userInput) {\n"
        "  cp.exec('ls ' + userInput);\n"
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


def _all_missing_which(_binary):
    return None


# Auto-skip guard for the opt-in REAL osv-scanner integration test, mirroring
# the requires_docker skipif pattern in test_sandbox.py / test_orchestrate.py:
# gate on the binary actually being resolvable so the test skips gracefully on
# any tool-less host and never fails the fast lane.
requires_osv_scanner = pytest.mark.skipif(
    shutil.which("osv-scanner") is None,
    reason="osv-scanner binary not installed — real integration test skipped",
)


# ── BLOCKING path: all 3 required tools missing ─────────────────────────────


class TestAllToolsMissingBlocks:
    def test_all_missing_returns_blocked(self, tmp_path):
        result = execute_baseline_scan(
            str(tmp_path / "src"),
            str(tmp_path / "out"),
            "sess-block",
            which_fn=_all_missing_which,
        )
        assert result["blocked"] is True
        assert result["completed"] is False
        assert set(result["missing_required"]) == {
            "semgrep",
            "osv-scanner",
            "gitleaks",
        }

    def test_blocked_error_names_tools_and_setup(self, tmp_path):
        result = execute_baseline_scan(
            str(tmp_path / "src"),
            str(tmp_path / "out"),
            "sess-block2",
            which_fn=_all_missing_which,
        )
        err = " ".join(result["errors"]).lower()
        assert "semgrep" in err
        assert "osv-scanner" in err
        assert "gitleaks" in err
        assert "make setup" in err

    def test_blocked_persists_nothing(self, tmp_path):
        out = tmp_path / "out"
        execute_baseline_scan(
            str(tmp_path / "src"),
            str(out),
            "sess-block3",
            which_fn=_all_missing_which,
        )
        # No baseline artifacts written on a hard block.
        assert not (out / "baseline").exists()


# ── REAL semgrep end-to-end (NOT mocked) ────────────────────────────────────


@pytest.mark.slow
@pytest.mark.requires_semgrep
class TestBaselineScanRealE2E:
    def test_real_semgrep_finds_and_normalizes(self, vuln_repo, tmp_path):
        out = tmp_path / "out"
        result = execute_baseline_scan(
            str(vuln_repo),
            str(out),
            "sess-real",
            semgrep_config_paths=_narrow_config_paths(),
        )
        # Not blocked: semgrep is genuinely installed.
        assert result["blocked"] is False
        assert "semgrep" in result["available"]
        # At least one real finding came back, normalized.
        assert len(result["findings"]) >= 1
        f = result["findings"][0]
        assert f["tool"]  # normalized schema
        assert f["file"].endswith("vuln.js")
        assert f["cvss_4_0_vector"] is not None
        # CVSS score is a real-library number (or None only on malformed vector).
        assert f["cvss_4_0_score"] is not None

    def test_real_command_injection_is_high_cvss_8_8_not_low(
        self, vuln_repo, tmp_path
    ):
        # LIVE, NON-MOCKED end-to-end confirmation of the Phase 6a fix. The
        # exec('ls ' + userInput) pattern trips the bundled
        # javascript-lang/security/detect-child-process rule at level="error"
        # (a textbook OS command injection, CWE-78). Before the fix this scored
        # CVSS 2.4 (LOW); after the fix it must score CVSS 8.8 (HIGH).
        import cvss4_map

        result = execute_baseline_scan(
            str(vuln_repo),
            str(tmp_path / "out"),
            "sess-cmdinj",
            semgrep_config_paths=_narrow_config_paths(),
        )
        assert result["blocked"] is False
        cmd_inj = [
            f for f in result["findings"]
            if "child-process" in f["rule_id"] or "CWE-78" in f.get("cwe_ids", [])
        ]
        assert cmd_inj, "expected the detect-child-process finding"
        f = cmd_inj[0]
        assert f["severity"] == "error"  # raw SARIF level, preserved verbatim
        assert f["cvss_4_0_score"] == 8.8  # HIGH, not the old broken 2.4/LOW
        assert f["cvss_4_0_vector"] == cvss4_map.VERIFIED_VECTORS["high"]

    def test_real_run_records_missing_tools_as_coverage_gaps(
        self, vuln_repo, tmp_path
    ):
        # PRESENCE-AWARE: this test must be honest on ANY host regardless of
        # which required tools happen to be installed. We determine each tool's
        # ACTUAL availability (shutil.which at test time) and assert the correct
        # behaviour for that reality:
        #   * an ABSENT required tool must surface as a "not installed" coverage
        #     gap (degraded, but not a hard block since semgrep ran);
        #   * a PRESENT tool must NOT surface as an "absent/not installed" gap
        #     (it may still record a DIFFERENT, accurate gap — e.g. a
        #     real osv-scanner finding no dependency lockfile under a JS-only
        #     fixture — which is legitimate coverage honesty, not an
        #     absence).
        import shutil

        result = execute_baseline_scan(
            str(vuln_repo),
            str(tmp_path / "out"),
            "sess-real2",
            semgrep_config_paths=_narrow_config_paths(),
        )
        gaps_by_tool = {g["tool"]: g["reason"] for g in result["coverage_gaps"]}
        for tool in ("semgrep", "osv-scanner", "gitleaks"):
            present = shutil.which(tool) is not None
            if present:
                assert tool in result["available"], (
                    f"{tool} is on PATH but not marked available"
                )
                # A present tool is never an ABSENT/not-installed gap.
                assert "not installed" not in gaps_by_tool.get(tool, "").lower()
            else:
                assert tool in result["missing_required"]
                assert tool in gaps_by_tool
                assert "not installed" in gaps_by_tool[tool].lower()
        # semgrep genuinely runs on the JS fixture and finds a real match, so
        # on any host where it is installed it is never a coverage gap at all.
        if shutil.which("semgrep") is not None:
            assert "semgrep" not in gaps_by_tool

    def test_real_run_persists_findings_and_coverage(self, vuln_repo, tmp_path):
        out = tmp_path / "out"
        result = execute_baseline_scan(
            str(vuln_repo),
            str(out),
            "sess-real3",
            semgrep_config_paths=_narrow_config_paths(),
        )
        fpath = Path(result["findings_path"])
        cpath = Path(result["coverage_path"])
        assert fpath.exists() and fpath.name == "findings.json"
        assert cpath.exists() and cpath.name == "coverage.md"
        doc = json.loads(fpath.read_text())
        assert doc["findings"]
        # Coverage honesty: the degraded tools are visibly recorded.
        cov = cpath.read_text()
        assert "osv-scanner" in cov and "gitleaks" in cov
        # mempalace summary drawer stub was produced with the right room.
        assert result["mempalace"]["room"] == "sess-real3-p2-baseline-findings"
        assert result["mempalace"]["wing"] == "wing_sca"

    def test_real_run_clean_scan_has_no_semgrep_gap(self, tmp_path):
        # A JS-free dir: semgrep runs and finds nothing. That must NOT be a
        # coverage gap for semgrep (a tool that ran and found nothing != absent).
        clean = tmp_path / "clean"
        clean.mkdir()
        (clean / "readme.txt").write_text("hello\n")
        result = execute_baseline_scan(
            str(clean),
            str(tmp_path / "out"),
            "sess-clean",
            semgrep_config_paths=_narrow_config_paths(),
        )
        gap_tools = {g["tool"] for g in result["coverage_gaps"]}
        assert "semgrep" not in gap_tools
        assert result["findings"] == []


# ── osv-scanner / gitleaks parse branches (real shapes; injected subprocess) ─


class _FakeCompleted:
    def __init__(self, stdout="", returncode=0, stderr=""):
        self.stdout = stdout
        self.returncode = returncode
        self.stderr = stderr


# The REAL osv-scanner JSON shape is deeply nested:
#   results[] (one per scanned source, e.g. a lockfile)
#     .source.path                    -> the lockfile path
#     .packages[]                     -> one per affected dependency
#       .package{name,version,ecosystem}
#       .vulnerabilities[]            -> the actual CVE-level findings
#         .id / .summary / .details
#         .severity[]                 -> a LIST of {type, score} CVSS-vector
#                                        objects (NOT a plain word), e.g.
#                                        {"type":"CVSS_V3","score":"CVSS:3.1/..."}
# This shape is grounded in the SAME schema the Phase 4a TS extension parses
# (.pi/extensions/osv-scanner/index.ts countFindings walks
# results[].packages[].vulnerabilities[]) and osv-scanner's public JSON schema.
# The shape is REAL-VERIFIED against osv-scanner 2.4.0 (see
# TestOsvScannerRealLockfileIntegration, which parses real binary output).
def _real_osv_payload() -> dict:
    """A real-shaped osv-scanner payload carrying THREE vulnerabilities."""
    return {
        "results": [
            {
                "source": {"path": "package-lock.json", "type": "lockfile"},
                "packages": [
                    {
                        "package": {
                            "name": "lodash",
                            "version": "4.17.4",
                            "ecosystem": "npm",
                        },
                        "vulnerabilities": [
                            {
                                "id": "GHSA-jf85-cpcp-j695",
                                "aliases": ["CVE-2018-3721"],
                                "summary": "Prototype Pollution in lodash",
                                "details": "lodash before 4.17.5 is vulnerable.",
                                "severity": [
                                    {
                                        "type": "CVSS_V3",
                                        "score": (
                                            "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/"
                                            "S:U/C:H/I:H/A:H"
                                        ),
                                    }
                                ],
                                "database_specific": {"cwe_ids": ["CWE-1321"]},
                            },
                            {
                                "id": "GHSA-p6mc-m468-83gw",
                                "summary": "Prototype pollution in lodash merge",
                                "details": "merge/mergeWith are affected.",
                                "severity": [
                                    {
                                        "type": "CVSS_V3",
                                        "score": (
                                            "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/"
                                            "S:U/C:H/I:H/A:H"
                                        ),
                                    }
                                ],
                            },
                        ],
                    },
                    {
                        "package": {
                            "name": "minimist",
                            "version": "0.0.8",
                            "ecosystem": "npm",
                        },
                        "vulnerabilities": [
                            {
                                "id": "GHSA-vh95-rmgr-6w4m",
                                "summary": "Prototype Pollution in minimist",
                                "severity": [
                                    {
                                        "type": "CVSS_V3",
                                        "score": (
                                            "CVSS:3.1/AV:N/AC:H/PR:H/UI:R/"
                                            "S:U/C:L/I:N/A:N"
                                        ),
                                    }
                                ],
                            }
                        ],
                    },
                ],
            }
        ]
    }


class TestOsvScannerParsing:
    def test_generic_parser_drops_real_shape_silently(self):
        # RED-STATE WITNESS (the exact bug Carren caught): the generic
        # parse_json fallback expects FLAT records and never descends into
        # results[].packages[].vulnerabilities[], so every real finding is
        # silently dropped and NO error is raised -> a real "3 CVEs" scan looks
        # identical to a clean one. The dedicated parser (below) fixes this.
        assert normalize.parse_json(_real_osv_payload(), "osv-scanner") == []

    def test_real_nested_shape_produces_one_finding_per_vuln(self):
        # (a) real-shaped multi-vulnerability payload -> correct NUMBER of
        # findings (3), not zero.
        findings = normalize.parse_osv_scanner_json(_real_osv_payload())
        assert len(findings) == 3
        rule_ids = {f.rule_id for f in findings}
        assert rule_ids == {
            "GHSA-jf85-cpcp-j695",
            "GHSA-p6mc-m468-83gw",
            "GHSA-vh95-rmgr-6w4m",
        }
        # source lockfile path is carried through as the finding's file.
        assert all(f.file == "package-lock.json" for f in findings)
        assert all(f.tool == "osv-scanner" for f in findings)

    def test_severity_derived_from_cvss_vector_list_not_word(self):
        # OSV severity is a LIST of CVSS-vector objects; the parser must derive
        # a usable canonical tier from the vector (via the real cvss library),
        # never treat the list as a word or fabricate confidence.
        by_id = {
            f.rule_id: f
            for f in normalize.parse_osv_scanner_json(_real_osv_payload())
        }
        # CVSS:3.1/.../C:H/I:H/A:H with AC:L -> 9.8 -> critical.
        assert by_id["GHSA-jf85-cpcp-j695"].severity == "critical"
        # AC:H variant -> lower score band (still high).
        assert by_id["GHSA-p6mc-m468-83gw"].severity in {"high", "medium"}
        # minimist vector -> low.
        assert by_id["GHSA-vh95-rmgr-6w4m"].severity == "low"

    def test_unparseable_severity_falls_back_to_unknown_not_fabricated(self):
        payload = {
            "results": [
                {
                    "source": {"path": "go.mod"},
                    "packages": [
                        {
                            "package": {"name": "x", "version": "1.0.0"},
                            "vulnerabilities": [
                                {"id": "GHSA-nosev", "summary": "no severity"}
                            ],
                        }
                    ],
                }
            ]
        }
        findings = normalize.parse_osv_scanner_json(payload)
        assert len(findings) == 1
        # Never fabricate a tier when none can be derived.
        assert findings[0].severity == "unknown"

    def test_osv_scanner_parses_real_nested_shape_via_runner(self, tmp_path):
        def fake_run(cmd, **kwargs):
            return _FakeCompleted(
                stdout=json.dumps(_real_osv_payload()), returncode=1
            )

        findings, gap = run_osv_scanner("osv-scanner", str(tmp_path), fake_run)
        assert gap is None
        assert len(findings) == 3

    def test_osv_scanner_missing_binary_is_gap(self, tmp_path):
        def fake_run(cmd, **kwargs):
            raise FileNotFoundError("osv-scanner")

        findings, gap = run_osv_scanner("osv-scanner", str(tmp_path), fake_run)
        assert findings is None
        assert gap["tool"] == "osv-scanner"

    def test_osv_scanner_clean_returns_empty_not_gap(self, tmp_path):
        def fake_run(cmd, **kwargs):
            return _FakeCompleted(stdout="", returncode=0)

        findings, gap = run_osv_scanner("osv-scanner", str(tmp_path), fake_run)
        assert findings == []
        assert gap is None

    def test_osv_scanner_rc128_no_lockfile_is_accurate_coverage_gap(
        self, tmp_path
    ):
        # REAL osv-scanner 2.4.0 semantics (verified against the binary): rc=128
        # + empty stdout == "no package sources found" (no dependency lockfile/
        # manifest under the target; stderr shows "0 Extract calls"). This is a
        # coverage gap, NOT a tool crash. The reason must be ACCURATE ("no
        # lockfiles/manifests to scan") and must NOT use the old
        # crash-implying "exited rc=128 with no output" wording that reads like
        # a transient failure a caller might retry.
        def fake_run(cmd, **kwargs):
            return _FakeCompleted(
                stdout="",
                returncode=128,
                stderr="No package sources found, --help for usage information.",
            )

        findings, gap = run_osv_scanner(
            "osv-scanner", str(tmp_path), fake_run
        )
        assert findings is None
        assert gap["tool"] == "osv-scanner"
        reason = gap["reason"]
        # Accurate, non-scary no-lockfile disclosure that names the target.
        assert "no dependency lockfiles/manifests to scan" in reason
        assert str(tmp_path) in reason
        assert "dependency-CVE coverage was not performed" in reason
        # Must NOT be the old misleading crash-implying message.
        assert "exited rc=128 with no output" not in reason

    def test_osv_scanner_rc1_with_real_shape_still_parses_findings(
        self, tmp_path
    ):
        # rc=1 == vulnerabilities found; JSON on stdout parses to findings.
        def fake_run(cmd, **kwargs):
            return _FakeCompleted(
                stdout=json.dumps(_real_osv_payload()), returncode=1
            )

        findings, gap = run_osv_scanner(
            "osv-scanner", str(tmp_path), fake_run
        )
        assert gap is None
        assert len(findings) == 3

    def test_osv_scanner_other_nonzero_rc_is_genuine_failure_with_rc(
        self, tmp_path
    ):
        # A non-{0,1,128} rc with no JSON is a GENUINE failure gap that names
        # the actual rc (distinct from the rc=128 no-lockfile coverage gap).
        def fake_run(cmd, **kwargs):
            return _FakeCompleted(stdout="", returncode=3, stderr="boom")

        findings, gap = run_osv_scanner(
            "osv-scanner", str(tmp_path), fake_run
        )
        assert findings is None
        assert "rc=3" in gap["reason"]
        assert "no dependency lockfiles" not in gap["reason"]


class TestOsvScannerCoverageGapRegression:
    """End-to-end (injected subprocess) proof that a genuinely-run osv-scanner
    returning REAL-shaped findings is NOT recorded as a coverage gap, and that
    its findings survive the full execute_baseline_scan pipeline (dedup + CVSS).
    """

    def _run_osv_only(self, tmp_path, payload, session):
        fake_bin = tmp_path / "osv-scanner"
        fake_bin.write_text("#!/bin/sh\n")

        def only_osv(binary):
            # osv-scanner present; semgrep/gitleaks absent (-> coverage gaps).
            return str(fake_bin) if binary == "osv-scanner" else None

        def fake_run(cmd, **kwargs):
            if "--version" in cmd:
                return _FakeCompleted(stdout="osv-scanner v2.4.0", returncode=0)
            return _FakeCompleted(stdout=json.dumps(payload), returncode=1)

        return execute_baseline_scan(
            str(tmp_path / "src"),
            str(tmp_path / "out"),
            session,
            which_fn=only_osv,
            subprocess_run=fake_run,
            semgrep_config_paths=["/fake/rules"],
        )

    def test_real_findings_survive_pipeline_and_are_counted(self, tmp_path):
        # (a) real-shaped payload -> correct nonzero finding count end-to-end.
        result = self._run_osv_only(
            tmp_path, _real_osv_payload(), "sess-osv-real"
        )
        assert result["blocked"] is False
        assert len(result["findings"]) == 3
        # Every surviving finding got a real-library CVSS vector + score.
        for f in result["findings"]:
            assert f["cvss_4_0_vector"] is not None
            assert f["cvss_4_0_score"] is not None

    def test_osv_not_a_gap_when_it_ran_and_found_findings(self, tmp_path):
        # (b) coverage_gaps must NOT list osv-scanner when it genuinely ran and
        # returned real findings; the genuinely-absent tools remain gaps.
        result = self._run_osv_only(
            tmp_path, _real_osv_payload(), "sess-osv-gap"
        )
        gap_tools = {g["tool"] for g in result["coverage_gaps"]}
        assert "osv-scanner" not in gap_tools
        assert "semgrep" in gap_tools
        assert "gitleaks" in gap_tools
        assert "osv-scanner" in result["available"]

    def test_canonical_cvss_tier_does_not_crash_on_non_string(self):
        # (c) canonical_cvss_tier must treat any non-string severity (a list of
        # CVSS-vector objects, a dict, or None) as unrecognized and fall through
        # to the safe fallback path -- never raise. This directly hardens the
        # OSV path, whose native severity IS a list.
        import cvss4_map

        osv_severity_list = [
            {"type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}
        ]
        for bad in (osv_severity_list, {"type": "CVSS_V3"}, None, 3.7, ["x"]):
            tier = cvss4_map.canonical_cvss_tier(bad)  # must NOT raise
            # Falls through to the conservative LOW fallback downstream.
            assert cvss4_map.suggest_cvss4_vector(tier) == (
                cvss4_map.VERIFIED_VECTORS["low"]
            )


@pytest.mark.slow
@pytest.mark.network
@pytest.mark.requires_scanner
@requires_osv_scanner
class TestOsvScannerRealLockfileIntegration:
    """Opt-in REAL end-to-end guard for the osv-scanner path.

    Runs the ACTUAL osv-scanner binary (real-verified 2.4.0) against a fixture
    that DOES contain a real ``package-lock.json`` pinning a known-vulnerable
    dependency (lodash 4.17.15), then asserts parse_osv_scanner_json yields
    >=1 real dependency finding with a real GHSA/CVE rule_id and a non-empty
    severity. This is the genuine end-to-end guard that would have caught the
    rc=128 regression class (a lockfile-present scan must reach rc=1 + parsed
    findings, never a coverage gap).

    OPT-IN + NETWORK: osv-scanner queries osv.dev, so this test carries
    ``slow`` + ``network`` + ``requires_scanner`` and an explicit auto-skip
    guard — it is excluded from the hermetic fast lane and skips gracefully
    (never fails) when osv-scanner is absent.
    """

    @pytest.fixture
    def lodash_lockfile_repo(self, tmp_path):
        repo = tmp_path / "dep-repo"
        repo.mkdir()
        # A minimal but REAL npm lockfile pinning lodash 4.17.15 (a version with
        # publicly-known advisories in the OSV database). No secrets involved.
        lockfile = {
            "name": "sca-osv-integration-fixture",
            "version": "1.0.0",
            "lockfileVersion": 1,
            "dependencies": {
                "lodash": {
                    "version": "4.17.15",
                    "resolved": (
                        "https://registry.npmjs.org/lodash/-/"
                        "lodash-4.17.15.tgz"
                    ),
                    "integrity": (
                        "sha512-8xOcRHvCjnocdS5cpwXQXVzmmh5e5+saE2QGoeQmbKm"
                        "RS6J3VQppPOIt0MnmE+4xlZoumy0GPG0D0MVIQbNA1A=="
                    ),
                }
            },
        }
        (repo / "package-lock.json").write_text(json.dumps(lockfile, indent=2))
        return repo

    def test_real_osv_scanner_finds_lodash_vuln(self, lodash_lockfile_repo):
        binary = shutil.which("osv-scanner")
        assert binary is not None  # guarded by the skipif, defensive
        findings, gap = run_osv_scanner(
            binary, str(lodash_lockfile_repo), subprocess.run
        )
        # A lockfile IS present -> osv-scanner reaches rc=1 with parseable JSON,
        # never the rc=128 no-lockfile coverage gap.
        assert gap is None, f"unexpected coverage gap: {gap}"
        assert findings is not None
        assert len(findings) >= 1
        # Real advisory identifiers + a non-empty derived severity.
        assert any(
            f.rule_id.startswith(("GHSA-", "CVE-")) for f in findings
        ), [f.rule_id for f in findings]
        assert any(f.severity for f in findings)
        # Coverage honesty: findings are tied to the real lockfile source.
        assert all(f.tool == "osv-scanner" for f in findings)


class TestGitleaksParsing:
    def test_gitleaks_parses_report_file(self, tmp_path):
        # gitleaks writes a JSON report to --report-path; our fake writes that
        # file, mimicking the real binary's behaviour.
        record = [
            {
                "RuleID": "aws-access-token",
                "File": "config.js",
                "StartLine": 3,
                "StartColumn": 12,
                "Description": "AWS Access Token",
                "Match": "AKIA_SECRET_DO_NOT_LEAK",
                "Secret": "AKIA_SECRET_DO_NOT_LEAK",
            }
        ]

        def fake_run(cmd, **kwargs):
            # find the --report-path argument and write the report there
            idx = cmd.index("--report-path")
            Path(cmd[idx + 1]).write_text(json.dumps(record))
            return _FakeCompleted(stdout="", returncode=1)

        findings, gap = run_gitleaks("gitleaks", str(tmp_path), fake_run)
        assert gap is None
        assert len(findings) == 1
        assert findings[0].rule_id == "aws-access-token"
        # SECURITY: the raw secret is never copied into the normalized finding.
        blob = json.dumps(findings[0].__dict__)
        assert "AKIA_SECRET_DO_NOT_LEAK" not in blob

    def test_gitleaks_missing_binary_is_gap(self, tmp_path):
        def fake_run(cmd, **kwargs):
            raise FileNotFoundError("gitleaks")

        findings, gap = run_gitleaks("gitleaks", str(tmp_path), fake_run)
        assert findings is None
        assert gap["tool"] == "gitleaks"

    def test_gitleaks_empty_report_is_clean(self, tmp_path):
        def fake_run(cmd, **kwargs):
            idx = cmd.index("--report-path")
            Path(cmd[idx + 1]).write_text("")
            return _FakeCompleted(stdout="", returncode=0)

        findings, gap = run_gitleaks("gitleaks", str(tmp_path), fake_run)
        assert findings == []
        assert gap is None


# ── SEVERITY -> CVSS regression (Phase 6a live-verified bug) ─────────────
#
# RED STATE (observed live before this fix): a SARIF-sourced finding's severity
# is a raw SARIF `level` string {error, warning, note}. baseline_scan called
# suggest_cvss4_vector(finding.severity) directly, but that function only knows
# {critical, high, medium, low} and conservatively falls back to LOW for
# anything else -- so EVERY semgrep finding got CVSS 2.4 (LOW) regardless of
# true severity. Penny reproduced this live: a textbook OS command injection
# (exec('ls ' + userInput), semgrep rule level="error") was scored CVSS 2.4/LOW.
#
# GREEN STATE (this fix): baseline_scan runs finding.severity through
# cvss4_map.canonical_cvss_tier() first, so level="error" -> "high" (CVSS 8.8),
# level="warning" -> "medium" (CVSS 5.3), level="note" -> "low" (CVSS 2.4).
# Vectors/scores below reuse cvss4_map.VERIFIED_VECTORS verbatim (no new vectors
# invented) and match the verified Phase 5 vector table.


def _sarif_with_level(level: str) -> dict:
    """Minimal REAL-shape semgrep SARIF doc with one result at ``level``.

    Severity lives on driver.rules[].defaultConfiguration.level and is joined to
    the result by ruleId -- exactly the shape Phase 5's parse_sarif consumes.
    """
    return {
        "version": "2.1.0",
        "runs": [
            {
                "tool": {
                    "driver": {
                        "name": "Semgrep OSS",
                        "rules": [
                            {
                                "id": "r.cmd-injection",
                                "defaultConfiguration": {"level": level},
                                "properties": {"tags": ["CWE-78: OS Command Injection"]},
                            }
                        ],
                    }
                },
                "results": [
                    {
                        "ruleId": "r.cmd-injection",
                        "message": {"text": "exec on concatenated user input"},
                        "locations": [
                            {
                                "physicalLocation": {
                                    "artifactLocation": {"uri": "vuln.js"},
                                    "region": {"startLine": 3, "startColumn": 3},
                                }
                            }
                        ],
                    }
                ],
            }
        ],
    }


class TestSarifSeverityToCvssRegression:
    """Injected-subprocess regression: SARIF level -> correct CVSS, via the
    full execute_baseline_scan path (which now normalizes severity)."""

    def _run_with_sarif(self, tmp_path, sarif_doc, session):
        import cvss4_map

        # check_tool_installed treats a tool as installed only when which_fn
        # returns a path to a REAL file, so point at a dummy on-disk binary.
        fake_bin = tmp_path / "semgrep"
        fake_bin.write_text("#!/bin/sh\n")

        def only_semgrep(binary):
            # semgrep present; osv-scanner/gitleaks absent (-> coverage gaps).
            return str(fake_bin) if binary == "semgrep" else None

        def fake_run(cmd, **kwargs):
            # version probe -> short string; scan -> our canned SARIF.
            if "--version" in cmd:
                return _FakeCompleted(stdout="1.163.0", returncode=0)
            return _FakeCompleted(stdout=json.dumps(sarif_doc), returncode=0)

        result = execute_baseline_scan(
            str(tmp_path / "src"),
            str(tmp_path / "out"),
            session,
            which_fn=only_semgrep,
            subprocess_run=fake_run,
            semgrep_config_paths=["/fake/rules"],
        )
        return result, cvss4_map

    def test_level_error_maps_to_high_cvss_8_8_not_low(self, tmp_path):
        result, cvss4_map = self._run_with_sarif(
            tmp_path, _sarif_with_level("error"), "sess-sev-error"
        )
        assert result["blocked"] is False
        assert len(result["findings"]) == 1
        f = result["findings"][0]
        assert f["severity"] == "error"  # native SARIF level preserved verbatim
        # The fix: NOT the old broken LOW (2.4); now HIGH (8.8).
        assert f["cvss_4_0_vector"] == cvss4_map.VERIFIED_VECTORS["high"]
        assert f["cvss_4_0_score"] == 8.8
        assert f["cvss_4_0_score"] != 2.4

    def test_level_warning_maps_to_medium_cvss_5_3(self, tmp_path):
        result, cvss4_map = self._run_with_sarif(
            tmp_path, _sarif_with_level("warning"), "sess-sev-warn"
        )
        f = result["findings"][0]
        assert f["severity"] == "warning"
        assert f["cvss_4_0_vector"] == cvss4_map.VERIFIED_VECTORS["medium"]
        assert f["cvss_4_0_score"] == 5.3

    def test_level_note_maps_to_low_cvss_2_4(self, tmp_path):
        result, cvss4_map = self._run_with_sarif(
            tmp_path, _sarif_with_level("note"), "sess-sev-note"
        )
        f = result["findings"][0]
        assert f["severity"] == "note"
        assert f["cvss_4_0_vector"] == cvss4_map.VERIFIED_VECTORS["low"]
        assert f["cvss_4_0_score"] == 2.4


class TestSemgrepRunnerBranches:
    def test_semgrep_no_config_is_gap(self, tmp_path):
        findings, gap = run_semgrep(
            "semgrep", str(tmp_path), [], lambda *a, **k: _FakeCompleted()
        )
        assert findings is None
        assert gap["tool"] == "semgrep"

    def test_semgrep_timeout_is_gap(self, tmp_path):
        import subprocess

        def fake_run(cmd, **kwargs):
            raise subprocess.TimeoutExpired(cmd, 1)

        findings, gap = run_semgrep(
            "semgrep", str(tmp_path), ["/rules"], fake_run
        )
        assert findings is None
        assert "timed out" in gap["reason"]

    def test_semgrep_crash_with_no_output_is_gap(self, tmp_path):
        def fake_run(cmd, **kwargs):
            return _FakeCompleted(stdout="", returncode=2, stderr="boom")

        findings, gap = run_semgrep(
            "semgrep", str(tmp_path), ["/rules"], fake_run
        )
        assert findings is None
        assert "rc=2" in gap["reason"]

    def test_semgrep_clean_empty_output_is_not_gap(self, tmp_path):
        def fake_run(cmd, **kwargs):
            return _FakeCompleted(stdout="", returncode=0)

        findings, gap = run_semgrep(
            "semgrep", str(tmp_path), ["/rules"], fake_run
        )
        assert findings == []
        assert gap is None

    def test_semgrep_malformed_sarif_is_gap(self, tmp_path):
        def fake_run(cmd, **kwargs):
            return _FakeCompleted(stdout="{not json", returncode=0)

        findings, gap = run_semgrep(
            "semgrep", str(tmp_path), ["/rules"], fake_run
        )
        assert findings is None
        assert "not valid JSON" in gap["reason"]


class TestDefaultConfigPaths:
    def test_default_config_paths_resolve(self):
        # In-repo the bundled rules exist; default preset should resolve some.
        paths = default_semgrep_config_paths()
        assert isinstance(paths, list)
        assert all(Path(p).is_dir() for p in paths)

    def test_default_config_paths_empty_when_no_base(self, monkeypatch):
        monkeypatch.setattr(baseline_scan, "_rules_base_discovery", lambda: None)
        assert default_semgrep_config_paths() == []


# ── extra branch coverage ──────────────────────────────────────────


class TestToolVersion:
    def test_version_probe_success(self, tmp_path):
        def fake_run(cmd, **kwargs):
            return _FakeCompleted(stdout="semgrep 1.2.3\nextra\n", returncode=0)

        assert baseline_scan._tool_version("semgrep", fake_run) == "semgrep 1.2.3"

    def test_version_probe_uses_stderr_fallback(self):
        def fake_run(cmd, **kwargs):
            return _FakeCompleted(stdout="", stderr="v9.9\n", returncode=0)

        assert baseline_scan._tool_version("x", fake_run) == "v9.9"

    def test_version_probe_failure_returns_none(self):
        def fake_run(cmd, **kwargs):
            raise OSError("nope")

        assert baseline_scan._tool_version("x", fake_run) is None


class TestMoreRunnerBranches:
    def test_semgrep_missing_binary_is_gap(self, tmp_path):
        def fake_run(cmd, **kwargs):
            raise FileNotFoundError("semgrep")

        findings, gap = run_semgrep("semgrep", str(tmp_path), ["/r"], fake_run)
        assert findings is None
        assert "not found" in gap["reason"]

    def test_osv_timeout_is_gap(self, tmp_path):
        import subprocess

        def fake_run(cmd, **kwargs):
            raise subprocess.TimeoutExpired(cmd, 1)

        findings, gap = run_osv_scanner("osv-scanner", str(tmp_path), fake_run)
        assert findings is None
        assert "timed out" in gap["reason"]

    def test_osv_crash_no_output_is_gap(self, tmp_path):
        def fake_run(cmd, **kwargs):
            return _FakeCompleted(stdout="", returncode=2)

        findings, gap = run_osv_scanner("osv-scanner", str(tmp_path), fake_run)
        assert findings is None
        assert "rc=2" in gap["reason"]

    def test_osv_malformed_json_is_gap(self, tmp_path):
        def fake_run(cmd, **kwargs):
            return _FakeCompleted(stdout="{bad", returncode=0)

        findings, gap = run_osv_scanner("osv-scanner", str(tmp_path), fake_run)
        assert findings is None
        assert "not valid JSON" in gap["reason"]

    def test_gitleaks_timeout_is_gap(self, tmp_path):
        import subprocess

        def fake_run(cmd, **kwargs):
            raise subprocess.TimeoutExpired(cmd, 1)

        findings, gap = run_gitleaks("gitleaks", str(tmp_path), fake_run)
        assert findings is None
        assert "timed out" in gap["reason"]

    def test_gitleaks_malformed_report_is_gap(self, tmp_path):
        def fake_run(cmd, **kwargs):
            idx = cmd.index("--report-path")
            Path(cmd[idx + 1]).write_text("{not json")
            return _FakeCompleted(stdout="", returncode=1)

        findings, gap = run_gitleaks("gitleaks", str(tmp_path), fake_run)
        assert findings is None
        assert "not valid JSON" in gap["reason"]
