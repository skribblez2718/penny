"""
Unit tests for sca tool_manifest.py (Phase 3).

The tool manifest is the single source of truth for the 9 tools the sca skill
provisions/dispatches. It is PURE DATA plus a few lookup helpers — no network,
no subprocess, no filesystem. These tests pin the architecture decisions:

  - required tools = {semgrep, osv-scanner, gitleaks}; everything else optional
  - codeql is opt-in (enabled_by_default is False)
  - trufflehog / njsscan are the two copyleft_invoke_only tools, both flagged
    for license re-verification at real provisioning time (Carren N3)
  - npm audit is permanently EXCLUDED — no entry, no code path, anywhere in
    scripts/ ever shells out to it (subsumed by osv-scanner)

See /tmp/sca-phase3-ideal-state.json success_criteria #1, #2, #9.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import tool_manifest as tm  # noqa: E402
from tool_manifest import (  # noqa: E402
    ToolSpec,
    TIER_REQUIRED,
    TIER_OPTIONAL,
    LICENSE_PERMISSIVE_EMBED,
    LICENSE_COPYLEFT_INVOKE_ONLY,
    LICENSE_NOT_APPLICABLE_EXISTING_EXTENSION,
    UnknownToolError,
    all_tools,
    get_tool,
    tool_names,
    required_tools,
    optional_tools,
    copyleft_tools,
)


SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
NOTICE_FILE = Path(__file__).resolve().parent.parent / "NOTICE"

EXPECTED_TOOLS = {
    "semgrep",
    "osv-scanner",
    "gitleaks",
    "trivy",
    "trufflehog",
    "njsscan",
    "retire.js",
    "eslint-plugin-security",
    "codeql",
}

EXPECTED_REQUIRED = {"semgrep", "osv-scanner", "gitleaks"}

# Canonical per-tool license_tier taxonomy (Phase 3, Carren fix pass):
#   - semgrep is NOT vendored by this skill (it is Penny's pre-existing
#     .pi/extensions/semgrep), so its license_tier is honestly
#     not_applicable_existing_extension rather than pretending it is
#     freely-embeddable permissive software (its SPDX is LGPL-2.1-only).
#   - eslint-plugin-security is a combined entry that also covers
#     eslint-plugin-no-unsanitized (MPL-2.0 weak copyleft); it is treated
#     conservatively as copyleft_invoke_only (matching the guard's existing
#     enforcement) with real source_signatures so the guard can flag it.
EXPECTED_LICENSE_TIERS = {
    "semgrep": LICENSE_NOT_APPLICABLE_EXISTING_EXTENSION,
    "osv-scanner": LICENSE_PERMISSIVE_EMBED,
    "gitleaks": LICENSE_PERMISSIVE_EMBED,
    "trivy": LICENSE_PERMISSIVE_EMBED,
    "trufflehog": LICENSE_COPYLEFT_INVOKE_ONLY,
    "njsscan": LICENSE_COPYLEFT_INVOKE_ONLY,
    "retire.js": LICENSE_PERMISSIVE_EMBED,
    "eslint-plugin-security": LICENSE_COPYLEFT_INVOKE_ONLY,
    "codeql": LICENSE_PERMISSIVE_EMBED,
}

EXPECTED_PINNED = {
    "osv-scanner": "v2.4.0",
    "gitleaks": "v8.30.1",
    "trivy": "v0.72.0",
    "trufflehog": "v3.95.7",
    "njsscan": "v0.4.3",
    "retire.js": "v5.4.3",
    "eslint-plugin-security": "v4.0.1",
    "codeql": "v2.25.6",
}


# ── Manifest completeness & shape ────────────────────────────────────────


class TestManifestCompleteness:
    def test_all_nine_tools_present(self):
        assert set(tool_names()) == EXPECTED_TOOLS
        assert len(all_tools()) == 9

    def test_every_entry_is_a_toolspec(self):
        for spec in all_tools():
            assert isinstance(spec, ToolSpec)

    def test_tool_names_are_unique(self):
        names = tool_names()
        assert len(names) == len(set(names))

    def test_every_tool_has_valid_tier(self):
        for spec in all_tools():
            assert spec.tier in (TIER_REQUIRED, TIER_OPTIONAL)

    def test_every_tool_has_valid_license_tier(self):
        for spec in all_tools():
            assert spec.license_tier in (
                LICENSE_PERMISSIVE_EMBED,
                LICENSE_COPYLEFT_INVOKE_ONLY,
                LICENSE_NOT_APPLICABLE_EXISTING_EXTENSION,
            )

    def test_every_tool_declares_spdx_and_confidence(self):
        for spec in all_tools():
            assert isinstance(spec.spdx_license, str) and spec.spdx_license
            # Declared, never asserted CERTAIN without upstream verification.
            assert spec.license_confidence in ("PROBABLE", "POSSIBLE", "UNCERTAIN")


# ── Tier assignments (architecture decision) ─────────────────────────────


class TestTiers:
    def test_required_tools_exactly_match_decision(self):
        assert {s.name for s in required_tools()} == EXPECTED_REQUIRED

    def test_optional_tools_are_the_complement(self):
        assert {s.name for s in optional_tools()} == (
            EXPECTED_TOOLS - EXPECTED_REQUIRED
        )

    def test_required_and_optional_partition_the_manifest(self):
        req = {s.name for s in required_tools()}
        opt = {s.name for s in optional_tools()}
        assert req.isdisjoint(opt)
        assert req | opt == EXPECTED_TOOLS


# ── Pinned versions ──────────────────────────────────────────────────────


class TestPinnedVersions:
    @pytest.mark.parametrize("name,version", sorted(EXPECTED_PINNED.items()))
    def test_pinned_version_matches_spec(self, name, version):
        assert get_tool(name).pinned_version == version

    def test_semgrep_sourced_from_existing_extension(self):
        semgrep = get_tool("semgrep")
        assert semgrep.tier == TIER_REQUIRED
        assert semgrep.source == "existing-extension"


# ── CodeQL opt-in ────────────────────────────────────────────────────────


class TestCodeqlOptIn:
    def test_codeql_disabled_by_default(self):
        assert get_tool("codeql").enabled_by_default is False

    def test_only_codeql_is_disabled_by_default(self):
        disabled = [s.name for s in all_tools() if not s.enabled_by_default]
        assert disabled == ["codeql"]


# ── Copyleft / license tiers ─────────────────────────────────────────────


class TestLicenseTiers:
    def test_copyleft_invoke_only_tool_set(self):
        # trufflehog + njsscan (AGPL/LGPL binaries) plus the combined eslint
        # entry (covers eslint-plugin-no-unsanitized, MPL-2.0 weak copyleft)
        # which is treated conservatively as invoke-only.
        assert {s.name for s in copyleft_tools()} == {
            "trufflehog",
            "njsscan",
            "eslint-plugin-security",
        }

    def test_copyleft_tools_flagged_for_reverification(self):
        for spec in copyleft_tools():
            # Every copyleft tool must carry a re-verification obligation
            # (Carren N3 for trufflehog/njsscan; pending-legal-review for the
            # MPL-2.0 eslint plugin). All must be re-verified at install time.
            assert spec.license_note
            assert "re-verify" in spec.license_note.lower()

    def test_copyleft_tools_have_source_signatures(self):
        # A copyleft_invoke_only tool with EMPTY source_signatures is invisible
        # to the build guard (it could never be flagged if vendored).
        for spec in copyleft_tools():
            assert spec.source_signatures, (
                f"{spec.name} is copyleft_invoke_only but has no "
                "source_signatures; the guard could never detect it"
            )

    def test_trufflehog_and_njsscan_spdx_declared(self):
        assert get_tool("trufflehog").license_tier == LICENSE_COPYLEFT_INVOKE_ONLY
        assert get_tool("njsscan").license_tier == LICENSE_COPYLEFT_INVOKE_ONLY

    def test_every_tool_license_tier_matches_taxonomy(self):
        for spec in all_tools():
            assert spec.license_tier == EXPECTED_LICENSE_TIERS[spec.name], (
                f"{spec.name} license_tier drifted from the canonical taxonomy"
            )

    def test_semgrep_is_not_applicable_existing_extension(self):
        # semgrep is not vendored by sca (it is the pre-existing extension), so
        # classifying it permissive_embed ("may be embedded freely") would be
        # factually wrong for its LGPL-2.1-only license.
        semgrep = get_tool("semgrep")
        assert semgrep.license_tier == LICENSE_NOT_APPLICABLE_EXISTING_EXTENSION
        assert semgrep.source == "existing-extension"

    def test_eslint_plugin_no_unsanitized_conservatively_copyleft(self):
        # eslint-plugin-no-unsanitized (MPL-2.0) is covered by the combined
        # eslint entry; it must be invoke-only with real signatures.
        eslint = get_tool("eslint-plugin-security")
        assert eslint.license_tier == LICENSE_COPYLEFT_INVOKE_ONLY
        assert eslint.source_signatures
        assert any(
            "no-unsanitized" in sig for sig in eslint.source_signatures
        )


# ── Lookup helpers / edge cases ──────────────────────────────────────────


class TestLookup:
    def test_get_tool_returns_matching_spec(self):
        assert get_tool("gitleaks").name == "gitleaks"

    def test_get_tool_unknown_raises_clear_error(self):
        with pytest.raises(UnknownToolError):
            get_tool("this-tool-does-not-exist")

    def test_unknown_tool_error_is_key_or_value_error_subclass(self):
        # Callers should be able to catch it broadly.
        assert issubclass(UnknownToolError, (KeyError, ValueError, LookupError))


# ── npm audit exclusion (permanent) ──────────────────────────────────────


class TestNpmAuditExclusion:
    def test_no_npm_tool_entry_exists(self):
        for name in tool_names():
            assert "npm" not in name.lower()

    def test_no_scripts_file_references_npm_audit(self):
        # No code path in the skill ever shells out to `npm audit`; the
        # exclusion rationale lives in NOTICE, not in executable code.
        for py in SCRIPTS_DIR.glob("*.py"):
            text = py.read_text(encoding="utf-8").lower()
            assert "npm audit" not in text
            assert "npm-audit" not in text

    def test_manifest_module_makes_no_subprocess_calls(self):
        # Fast-lane discipline: pure-data module never imports subprocess.
        text = (SCRIPTS_DIR / "tool_manifest.py").read_text(encoding="utf-8")
        assert "subprocess" not in text


# ── NOTICE drift guard ───────────────────────────────────────────────────


class TestNoticeInSync:
    def test_notice_file_exists(self):
        assert NOTICE_FILE.is_file()

    def test_every_manifest_tool_appears_in_notice(self):
        text = NOTICE_FILE.read_text(encoding="utf-8")
        for name in tool_names():
            assert name in text, f"{name} missing from NOTICE"

    def test_notice_records_key_policies(self):
        text = NOTICE_FILE.read_text(encoding="utf-8").lower()
        # npm audit exclusion rationale.
        assert "npm" in text and "exclud" in text
        # copyleft re-verify caveat.
        assert "re-verif" in text
        # TOFU hash-lock policy.
        assert "tool-lock.json" in text
        # CodeQL opt-in / private-repo notice.
        assert "codeql" in text and "private" in text
