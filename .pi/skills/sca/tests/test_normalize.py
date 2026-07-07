"""
Unit tests for sca normalize.py (Phase 5) — findings normalization layer.

parse_sarif / parse_json / parse_jsonl each turn a real tool's output shape
into a list of NormalizedFinding records with a unified schema. Fixtures here
are grounded in the ACTUAL shapes the sca tool extensions produce:

  - semgrep SARIF 2.1.0 (runs[].results[] with locations/region + rule props),
  - semgrep native JSON (`{"results": [{check_id, path, start, extra{...}}]}`,
    matching .pi/extensions/semgrep/index.ts include_findings mapping),
  - gitleaks flat JSON array (PascalCase records with File/StartLine/RuleID/...
    Description, matching .pi/extensions/gitleaks/index.ts raw_output report).

CRITICAL discipline exercised here:
  * confidence and severity are INDEPENDENT fields — a parser never derives one
    from the other; the default confidence is a constant, not a function of
    severity.
  * a gitleaks record carries the raw secret in its Match/Secret keys (raw
    INPUT), but the resulting NormalizedFinding must NEVER copy that plaintext
    into any output field. The obviously-fake AWS example key
    'AKIAIOSFODNN7EXAMPLE' appears ONLY on the raw-input side below.

No network, no subprocess, no real tool binaries.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import normalize as norm  # noqa: E402
from normalize import (  # noqa: E402
    NormalizedFinding,
    parse_sarif,
    parse_json,
    parse_jsonl,
    parse_osv_scanner_json,
)


# Obviously-fake, non-functional AWS example key (AWS's own documented sample).
# Used ONLY as raw INPUT to prove the plaintext never reaches an output field.
FAKE_AWS_KEY = "AKIAIOSFODNN7EXAMPLE"


# ── Fixtures grounded in real tool shapes ────────────────────────────────


def _semgrep_sarif():
    """A faithful, trimmed-down capture of REAL ``semgrep scan --sarif`` output.

    Captured 2026-07-01 with real installed semgrep (OSS 1.163.0) from:

        semgrep scan --sarif \\
          --config rules/custom/ssrf-allowlist.yaml \\
          rules/custom/ssrf-allowlist.js

    Real-shape facts this fixture preserves (and that the OLD invented fixture
    got wrong, per Carren's live repro):
      * SEVERITY lives on ``driver.rules[].defaultConfiguration.level`` and is
        joined to a result by matching ``result.ruleId`` to the rule's ``id``.
        There is NO ``level`` field on the per-result object.
      * CWE data lives in ``driver.rules[].properties.tags`` as freeform
        strings like "CWE-918: Server-Side Request Forgery (SSRF)" — NOT in a
        structured ``properties.cwe`` field.
      * driver.name is "Semgrep OSS" (real), not "semgrep".
    Trimmed to a single result for test clarity; shape is otherwise verbatim.
    """
    return {
        "version": "2.1.0",
        "$schema": (
            "https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/"
            "sarif-schema-2.1.0.json"
        ),
        "runs": [
            {
                "invocations": [
                    {"executionSuccessful": True, "toolExecutionNotifications": []}
                ],
                "results": [
                    {
                        "fingerprints": {"matchBasedId/v1": "requires login"},
                        "locations": [
                            {
                                "physicalLocation": {
                                    "artifactLocation": {
                                        "uri": "rules/custom/ssrf-allowlist.js",
                                        "uriBaseId": "%SRCROOT%",
                                    },
                                    "region": {
                                        "endColumn": 39,
                                        "endLine": 10,
                                        "snippet": {
                                            "text": "  const r = await fetch(req.query.url);"
                                        },
                                        "startColumn": 19,
                                        "startLine": 10,
                                    },
                                }
                            }
                        ],
                        "message": {
                            "text": (
                                "Possible SSRF (Server-Side Request Forgery): a "
                                "server-side HTTP request is issued to a URL/host "
                                "derived from user input with no visible allowlist "
                                "/ domain-check guard."
                            )
                        },
                        "properties": {},
                        "ruleId": "rules.custom.ssrf-allowlist",
                    }
                ],
                "tool": {
                    "driver": {
                        "name": "Semgrep OSS",
                        "semanticVersion": "1.163.0",
                        "rules": [
                            {
                                "id": "rules.custom.ssrf-allowlist",
                                "name": "rules.custom.ssrf-allowlist",
                                "defaultConfiguration": {"level": "warning"},
                                "properties": {
                                    "precision": "very-high",
                                    "tags": [
                                        "CWE-918: Server-Side Request Forgery (SSRF)",
                                        "LOW CONFIDENCE",
                                        "OWASP-A10:2021 - Server-Side Request Forgery (SSRF)",
                                        "security",
                                    ],
                                },
                                "shortDescription": {
                                    "text": "Semgrep Finding: rules.custom.ssrf-allowlist"
                                },
                            }
                        ],
                    }
                },
            }
        ],
    }


def _semgrep_native_json():
    """semgrep native `--json` output shape (results[].extra.*)."""
    return {
        "results": [
            {
                "check_id": "javascript.lang.security.audit.sqli",
                "path": "src/db/login.js",
                "start": {"line": 10, "col": 3},
                "end": {"line": 10, "col": 40},
                "extra": {
                    "severity": "ERROR",
                    "message": "SQL injection via string concatenation",
                    "lines": "db.query('SELECT * FROM u WHERE id=' + id)",
                    "metadata": {
                        "cwe": ["CWE-89: SQL Injection"],
                        "owasp": ["A03:2021 - Injection"],
                        "asvs": ["V5.3.4"],
                    },
                },
            }
        ],
        "errors": [],
    }


def _gitleaks_array():
    """gitleaks flat JSON array report shape (PascalCase). The Match/Secret
    fields carry the raw (fake) secret — raw INPUT only."""
    return [
        {
            "Description": "AWS Access Key",
            "StartLine": 5,
            "EndLine": 5,
            "StartColumn": 19,
            "EndColumn": 38,
            "Match": f"aws_key={FAKE_AWS_KEY}",
            "Secret": FAKE_AWS_KEY,
            "File": "config/prod.env",
            "SymlinkFile": "",
            "Commit": "0000000000000000000000000000000000000000",
            "Entropy": 3.5,
            "RuleID": "aws-access-token",
            "Tags": [],
            "Fingerprint": "config/prod.env:aws-access-token:5",
        }
    ]


# ── NormalizedFinding schema ─────────────────────────────────────────────


class TestSchema:
    def test_required_and_default_fields(self):
        f = NormalizedFinding(
            id="F-1",
            tool="semgrep",
            rule_id="r",
            title="t",
            description="d",
            file="a.js",
            line=1,
            severity="ERROR",
            confidence="low",
            evidence_basis="inferred",
        )
        # optional / defaulted fields
        assert f.column is None
        assert f.linked_sr_ids == []
        assert f.linked_t_ids == []
        assert f.cwe_ids == []
        assert f.asvs_references == []
        assert f.api_top10_2023_mapping == []
        assert f.status == "open"
        assert f.cvss_4_0_vector is None
        assert f.cvss_4_0_score is None
        assert f.analyst_notes is None

    def test_list_defaults_are_independent_instances(self):
        a = NormalizedFinding(
            id="a", tool="t", rule_id="r", title="x", description="y",
            file="f", line=1, severity="LOW", confidence="low",
            evidence_basis="unknown",
        )
        b = NormalizedFinding(
            id="b", tool="t", rule_id="r", title="x", description="y",
            file="f", line=2, severity="LOW", confidence="low",
            evidence_basis="unknown",
        )
        a.cwe_ids.append("CWE-1")
        assert b.cwe_ids == []  # no shared mutable default

    def test_confidence_independent_from_severity(self):
        # A CRITICAL-severity finding can legitimately hold LOW confidence.
        f = NormalizedFinding(
            id="c", tool="t", rule_id="r", title="x", description="y",
            file="f", line=1, severity="CRITICAL", confidence="low",
            evidence_basis="inferred",
        )
        assert f.severity == "CRITICAL"
        assert f.confidence == "low"
        assert f.severity != f.confidence


# ── parse_sarif ──────────────────────────────────────────────────────────


class TestParseSarif:
    def test_extracts_core_fields(self):
        findings = parse_sarif(_semgrep_sarif())
        assert len(findings) == 1
        f = findings[0]
        assert isinstance(f, NormalizedFinding)
        assert f.tool == "Semgrep OSS"  # real driver.name
        assert f.rule_id == "rules.custom.ssrf-allowlist"
        assert f.file == "rules/custom/ssrf-allowlist.js"
        assert f.line == 10
        assert f.column == 19
        assert "SSRF" in f.description
        # Severity is resolved via the rule-lookup join against
        # driver.rules[].defaultConfiguration.level, NOT a per-result field.
        assert f.severity == "warning"

    def test_severity_resolved_from_default_configuration_level(self):
        # Carren regression: real SARIF has NO per-result `level`; severity must
        # be resolved by joining result.ruleId -> rule.defaultConfiguration.level
        # and must NOT fall back to the "unknown" default for a rule that has a
        # real level.
        f = parse_sarif(_semgrep_sarif())[0]
        assert f.severity == "warning"
        assert f.severity != norm.DEFAULT_SEVERITY

    def test_severity_falls_back_to_unknown_when_no_level(self):
        # No defaultConfiguration on the rule and no per-result level -> honest
        # "unknown" fallback (never invented).
        doc = _semgrep_sarif()
        del doc["runs"][0]["tool"]["driver"]["rules"][0]["defaultConfiguration"]
        f = parse_sarif(doc)[0]
        assert f.severity == norm.DEFAULT_SEVERITY

    def test_pulls_cwe_from_rule_tags(self):
        # Carren regression: real CWE data lives in properties.tags as freeform
        # strings (e.g. "CWE-918: ..."), not a structured properties.cwe field.
        f = parse_sarif(_semgrep_sarif())[0]
        assert "CWE-918" in f.cwe_ids

    def test_pulls_cwe_from_legacy_properties_cwe_fallback(self):
        # Some producers (or older shapes) still use a structured properties.cwe.
        # The parser merges those in as a fallback alongside tag-derived CWEs.
        doc = _semgrep_sarif()
        rule = doc["runs"][0]["tool"]["driver"]["rules"][0]
        rule["properties"]["cwe"] = ["CWE-79: Cross-site Scripting"]
        f = parse_sarif(doc)[0]
        assert "CWE-918" in f.cwe_ids  # from tags (real shape)
        assert "CWE-79" in f.cwe_ids   # from legacy properties.cwe (fallback)

    def test_confidence_is_constant_default_not_severity(self):
        f = parse_sarif(_semgrep_sarif())[0]
        # default confidence must not equal the (very different) severity value
        assert f.confidence == norm.DEFAULT_CONFIDENCE
        assert f.confidence != f.severity

    def test_empty_runs_returns_empty(self):
        assert parse_sarif({"version": "2.1.0", "runs": []}) == []

    def test_malformed_input_returns_empty_no_crash(self):
        assert parse_sarif(None) == []
        assert parse_sarif({}) == []
        assert parse_sarif("not a dict") == []
        assert parse_sarif({"runs": "nonsense"}) == []

    def test_result_missing_location_is_skipped_gracefully(self):
        doc = _semgrep_sarif()
        doc["runs"][0]["results"][0]["locations"] = []
        findings = parse_sarif(doc)
        # no location -> line unknown; parser must not crash. It may drop the
        # finding or default the line; either way it must return a list.
        assert isinstance(findings, list)


# ── parse_json ───────────────────────────────────────────────────────────


class TestParseJsonSemgrep:
    def test_extracts_semgrep_native_shape(self):
        findings = parse_json(_semgrep_native_json(), "semgrep")
        assert len(findings) == 1
        f = findings[0]
        assert f.tool == "semgrep"
        assert f.rule_id == "javascript.lang.security.audit.sqli"
        assert f.file == "src/db/login.js"
        assert f.line == 10
        assert f.column == 3
        assert f.severity == "ERROR"
        assert "SQL injection" in f.description
        assert "CWE-89" in f.cwe_ids
        assert "V5.3.4" in f.asvs_references

    def test_empty_results_returns_empty(self):
        assert parse_json({"results": []}, "semgrep") == []

    def test_malformed_returns_empty_no_crash(self):
        assert parse_json(None, "semgrep") == []
        assert parse_json({"results": "nope"}, "semgrep") == []
        assert parse_json("garbage", "semgrep") == []


class TestParseJsonGitleaks:
    def test_extracts_gitleaks_flat_array(self):
        findings = parse_json(_gitleaks_array(), "gitleaks")
        assert len(findings) == 1
        f = findings[0]
        assert f.tool == "gitleaks"
        assert f.rule_id == "aws-access-token"
        assert f.file == "config/prod.env"
        assert f.line == 5
        assert f.column == 19
        assert f.evidence_basis == "observed"  # an actual secret was matched

    def test_raw_secret_never_copied_into_any_output_field(self):
        f = parse_json(_gitleaks_array(), "gitleaks")[0]
        # The plaintext (fake) secret must not leak into ANY string field.
        for value in (
            f.id, f.tool, f.rule_id, f.title, f.description, f.file,
            f.severity, f.confidence, f.evidence_basis, f.status,
            f.analyst_notes or "",
        ):
            assert FAKE_AWS_KEY not in str(value)

    def test_empty_array_returns_empty(self):
        assert parse_json([], "gitleaks") == []

    def test_malformed_returns_empty_no_crash(self):
        assert parse_json(None, "gitleaks") == []
        assert parse_json({"not": "a list"}, "gitleaks") == []


# ── parse_jsonl ──────────────────────────────────────────────────────────


class TestParseJsonl:
    def test_parses_gitleaks_records_one_per_line(self):
        import json

        rec = _gitleaks_array()[0]
        text = json.dumps(rec) + "\n" + json.dumps(rec) + "\n"
        findings = parse_jsonl(text, "gitleaks")
        assert len(findings) == 2
        assert all(f.rule_id == "aws-access-token" for f in findings)

    def test_blank_and_whitespace_lines_ignored(self):
        import json

        rec = _gitleaks_array()[0]
        text = "\n" + json.dumps(rec) + "\n   \n"
        findings = parse_jsonl(text, "gitleaks")
        assert len(findings) == 1

    def test_malformed_line_skipped_not_crash(self):
        import json

        rec = _gitleaks_array()[0]
        text = "{ this is not json\n" + json.dumps(rec) + "\n"
        findings = parse_jsonl(text, "gitleaks")
        assert len(findings) == 1  # bad line dropped, good line kept

    def test_empty_text_returns_empty(self):
        assert parse_jsonl("", "gitleaks") == []
        assert parse_jsonl(None, "gitleaks") == []


# ── generic (unknown tool) parsing ───────────────────────────────────────


class TestGenericParsing:
    def test_generic_dict_with_results(self):
        data = {
            "results": [
                {
                    "rule_id": "custom.rule",
                    "file": "src/x.py",
                    "line": 7,
                    "col": 2,
                    "message": "generic issue",
                    "severity": "WARNING",
                    "cwe": ["CWE-22: Path Traversal"],
                }
            ]
        }
        findings = parse_json(data, "mytool")
        assert len(findings) == 1
        f = findings[0]
        assert f.tool == "mytool"
        assert f.rule_id == "custom.rule"
        assert f.file == "src/x.py"
        assert f.line == 7
        assert f.column == 2
        assert f.evidence_basis == "unknown"
        assert "CWE-22" in f.cwe_ids

    def test_generic_flat_list(self):
        data = [
            {"ruleId": "r", "path": "a.py", "line": 1, "description": "d"}
        ]
        findings = parse_json(data, "othertool")
        assert len(findings) == 1
        assert findings[0].tool == "othertool"

    def test_generic_no_findings_array(self):
        assert parse_json({"weird": 1}, "mytool") == []
        assert parse_json(42, "mytool") == []

    def test_generic_record_without_location_dropped(self):
        data = [{"ruleId": "r", "description": "no file/line here"}]
        assert parse_json(data, "mytool") == []

    def test_generic_non_dict_record_skipped(self):
        data = ["not-a-dict", {"ruleId": "r", "path": "a.py", "line": 3}]
        findings = parse_json(data, "mytool")
        assert len(findings) == 1

    def test_jsonl_generic_tool(self):
        import json

        rec = {"ruleId": "r", "path": "a.py", "line": 4, "description": "d"}
        text = json.dumps(rec) + "\n"
        findings = parse_jsonl(text, "mytool")
        assert len(findings) == 1
        assert findings[0].tool == "mytool"

    def test_jsonl_semgrep_result_per_line(self):
        import json

        rec = _semgrep_native_json()["results"][0]
        text = json.dumps(rec) + "\n"
        findings = parse_jsonl(text, "semgrep")
        assert len(findings) == 1
        assert findings[0].rule_id == "javascript.lang.security.audit.sqli"


# ── defensive / edge branches ────────────────────────────────────────────


class TestDefensiveBranches:
    def test_semgrep_result_without_location_dropped(self):
        doc = _semgrep_native_json()
        del doc["results"][0]["path"]
        assert parse_json(doc, "semgrep") == []

    def test_semgrep_non_dict_result_skipped(self):
        doc = {"results": ["nope", _semgrep_native_json()["results"][0]]}
        assert len(parse_json(doc, "semgrep")) == 1

    def test_gitleaks_record_without_location_dropped(self):
        arr = _gitleaks_array()
        del arr[0]["File"]
        assert parse_json(arr, "gitleaks") == []

    def test_gitleaks_non_dict_record_skipped(self):
        arr = ["nope", _gitleaks_array()[0]]
        assert len(parse_json(arr, "gitleaks")) == 1

    def test_gitleaks_wrapper_dict_with_findings_key(self):
        wrapped = {"findings": _gitleaks_array()}
        assert len(parse_json(wrapped, "gitleaks")) == 1

    def test_sarif_run_and_result_non_dict_skipped(self):
        doc = _semgrep_sarif()
        doc["runs"].insert(0, "not-a-run")
        doc["runs"][1]["results"].insert(0, "not-a-result")
        findings = parse_sarif(doc)
        assert len(findings) == 1

    def test_sarif_message_as_plain_string(self):
        doc = _semgrep_sarif()
        doc["runs"][0]["results"][0]["message"] = "plain string message"
        f = parse_sarif(doc)[0]
        assert f.description == "plain string message"

    def test_sarif_pulls_asvs_and_api_from_properties(self):
        doc = _semgrep_sarif()
        doc["runs"][0]["tool"]["driver"]["rules"][0]["properties"]["asvs"] = [
            "V5.1.3"
        ]
        doc["runs"][0]["tool"]["driver"]["rules"][0]["properties"]["api"] = [
            "API1:2023"
        ]
        f = parse_sarif(doc)[0]
        assert "V5.1.3" in f.asvs_references
        assert "API1:2023" in f.api_top10_2023_mapping

    def test_helpers_coercion_edges(self):
        assert norm._as_int("nope", default=None) is None
        assert norm._as_int(None) is None
        assert norm._as_int("12") == 12
        assert norm._extract_cwes(None) == []
        assert norm._extract_cwes(123) == []
        assert norm._extract_cwes("CWE-79: x") == ["CWE-79"]
        # duplicates collapsed
        assert norm._extract_cwes(["CWE-79", "CWE-79"]) == ["CWE-79"]
        assert norm._as_str_list(None) == []
        assert norm._as_str_list("one") == ["one"]
        assert norm._as_str_list([1, 2]) == ["1", "2"]
        assert norm._as_str_list({"a": 1}) == []

    def test_per_record_parsers_reject_non_dict(self):
        assert norm._finding_from_semgrep_result("x") is None
        assert norm._finding_from_gitleaks_record(42) is None
        assert norm._finding_from_generic_record(None, "t") is None

    def test_parse_sarif_runs_not_a_list(self):
        assert parse_sarif({"runs": "nope"}) == []


# ── osv-scanner (deeply-nested real shape) ─────────────────────────────
#
# The real osv-scanner JSON is results[].packages[].vulnerabilities[] (NOT flat
# records), and each vulnerability's `severity` is a LIST of {type, score}
# CVSS-vector objects. See test_baseline_scan.py for the end-to-end regression;
# here we cover the parser's shape-walking + defensive branches directly.


def _osv_min(vector_type="CVSS_V3",
             vector="CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"):
    return {
        "results": [
            {
                "source": {"path": "requirements.txt"},
                "packages": [
                    {
                        "package": {"name": "pkg", "version": "1.0.0"},
                        "vulnerabilities": [
                            {
                                "id": "GHSA-abcd",
                                "summary": "boom",
                                "severity": [
                                    {"type": vector_type, "score": vector}
                                ],
                            }
                        ],
                    }
                ],
            }
        ]
    }


class TestParseOsvScannerJson:
    def test_walks_real_nested_shape(self):
        findings = parse_osv_scanner_json(_osv_min())
        assert len(findings) == 1
        f = findings[0]
        assert f.tool == "osv-scanner"
        assert f.rule_id == "GHSA-abcd"
        assert f.file == "requirements.txt"
        assert f.severity == "critical"  # 9.8 via real cvss library
        # dependency-level finding: package label folded into description.
        assert "pkg@1.0.0" in f.description

    def test_cvss_v4_vector_parses(self):
        v4 = "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H"
        f = parse_osv_scanner_json(_osv_min("CVSS_V4", v4))[0]
        assert f.severity == "critical"

    def test_cvss_v2_legacy_vector_parses(self):
        # Legacy CVSS v2 vectors have no "CVSS:" prefix.
        f = parse_osv_scanner_json(
            _osv_min("CVSS_V2", "AV:N/AC:L/Au:N/C:C/I:C/A:C")
        )[0]
        assert f.severity in norm.CANONICAL_TIERS

    def test_unparseable_vector_yields_unknown(self):
        f = parse_osv_scanner_json(_osv_min("CVSS_V3", "not-a-vector"))[0]
        assert f.severity == "unknown"

    def test_non_dict_input_is_empty(self):
        assert parse_osv_scanner_json(["nope"]) == []
        assert parse_osv_scanner_json(None) == []

    def test_results_not_a_list_is_empty(self):
        assert parse_osv_scanner_json({"results": "nope"}) == []
        assert parse_osv_scanner_json({}) == []

    def test_defensive_branches_skip_malformed_members(self):
        payload = {
            "results": [
                "not-a-dict",
                {"source": "not-a-dict", "packages": "nope"},
                {
                    "source": {"path": "go.mod"},
                    "packages": [
                        "not-a-dict",
                        {"package": "not-a-dict", "vulnerabilities": "nope"},
                        {
                            "package": {"name": "ok", "version": "2.0"},
                            "vulnerabilities": [
                                "not-a-dict",
                                {"id": "GHSA-ok", "summary": "real one"},
                            ],
                        },
                    ],
                },
            ]
        }
        findings = parse_osv_scanner_json(payload)
        assert [f.rule_id for f in findings] == ["GHSA-ok"]
        assert findings[0].severity == "unknown"  # no severity list present

    def test_cwe_ids_extracted_from_database_specific(self):
        payload = _osv_min()
        vuln = payload["results"][0]["packages"][0]["vulnerabilities"][0]
        vuln["database_specific"] = {"cwe_ids": ["CWE-79", "CWE-89"]}
        f = parse_osv_scanner_json(payload)[0]
        assert "CWE-79" in f.cwe_ids and "CWE-89" in f.cwe_ids

    def test_finding_not_dropped_when_source_path_missing(self):
        # Silent-data-loss guard: a vuln with no source path is STILL emitted
        # (empty file), never dropped.
        payload = _osv_min()
        payload["results"][0]["source"] = {}
        f = parse_osv_scanner_json(payload)[0]
        assert f.file == ""
        assert f.rule_id == "GHSA-abcd"


# ── deterministic ids ─────────────────────────────────────────────


class TestDeterministicIds:
    def test_same_input_yields_same_id(self):
        a = parse_json(_semgrep_native_json(), "semgrep")[0]
        b = parse_json(_semgrep_native_json(), "semgrep")[0]
        assert a.id == b.id

    def test_different_findings_get_different_ids(self):
        s = parse_json(_semgrep_native_json(), "semgrep")[0]
        g = parse_json(_gitleaks_array(), "gitleaks")[0]
        assert s.id != g.id
