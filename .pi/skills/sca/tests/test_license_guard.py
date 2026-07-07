"""
Unit tests for sca license_guard.py (Phase 3).

build_guard(scan_paths) heuristically detects EMBEDDED copyleft tool SOURCE
(trufflehog=AGPL, njsscan=LGPLv3) — as opposed to merely INVOKING the tool as
a separate binary — and FAILS (ok=False) when such source is vendored/committed.
This prevents accidental AGPL/LGPL source embedding that would create
distribution obligations.

Fixture trees are created under tmp_path (never committed). Cases:
  - clean/empty tree              -> ok=True
  - invoke-only, binary-only tree -> ok=True (no source signatures present)
  - dir NAMED after a copyleft tool but docs/config only -> ok=True (no false
    positive on directory names)
  - tree with simulated vendored copyleft SOURCE -> ok=False, violation listed

No network, no subprocess, no real tool binaries.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from license_guard import build_guard  # noqa: E402


# ── Passing (clean / invoke-only) cases ──────────────────────────────────


class TestGuardPasses:
    def test_empty_tree_passes(self, tmp_path):
        ok, violations = build_guard([str(tmp_path)])
        assert ok is True
        assert violations == []

    def test_nonexistent_path_is_skipped_not_error(self, tmp_path):
        ok, violations = build_guard([str(tmp_path / "does-not-exist")])
        assert ok is True
        assert violations == []

    def test_permissive_source_passes(self, tmp_path):
        # Ordinary project source that happens to CALL the tools is fine.
        (tmp_path / "runner.py").write_text(
            "import subprocess\n"
            "subprocess.run(['trufflehog', 'filesystem', '.'])\n"
            "subprocess.run(['njsscan', '.'])\n"
        )
        ok, violations = build_guard([str(tmp_path)])
        assert ok is True
        assert violations == []

    def test_invoke_only_binary_tree_passes(self, tmp_path):
        # A vendored *binary* (opaque bytes, no source extension) is invoke-only
        # and must NOT trip the guard.
        binp = tmp_path / "bin" / "trufflehog"
        binp.parent.mkdir(parents=True)
        binp.write_bytes(bytes(range(256)) * 32)  # non-utf8 binary blob
        ok, violations = build_guard([str(tmp_path)])
        assert ok is True
        assert violations == []

    def test_dir_named_after_tool_with_docs_only_passes(self, tmp_path):
        # Directory NAMED 'trufflehog' but containing only docs/config -> no
        # source signature -> must not false-positive.
        d = tmp_path / "trufflehog"
        d.mkdir()
        (d / "README.md").write_text("# trufflehog usage notes\nWe invoke it.\n")
        (d / "config.yaml").write_text("trufflehog:\n  enabled: true\n")
        ok, violations = build_guard([str(tmp_path)])
        assert ok is True
        assert violations == []


# ── Failing (embedded copyleft source) cases ─────────────────────────────


class TestGuardFails:
    def test_embedded_trufflehog_go_source_fails(self, tmp_path):
        # Simulated vendored AGPL Go source of trufflehog.
        src = tmp_path / "vendor" / "trufflehog" / "engine.go"
        src.parent.mkdir(parents=True)
        src.write_text(
            "package trufflehog\n\n"
            'import "github.com/trufflesecurity/trufflehog/v3/pkg/engine"\n\n'
            "func Scan() {}\n"
        )
        ok, violations = build_guard([str(tmp_path)])
        assert ok is False
        assert violations
        assert any("trufflehog" in v for v in violations)
        assert any("engine.go" in v for v in violations)

    def test_embedded_njsscan_py_source_fails(self, tmp_path):
        src = tmp_path / "third_party" / "njsscan" / "core.py"
        src.parent.mkdir(parents=True)
        src.write_text(
            "from njsscan import NJSScan\n\n"
            "class NJSScan:\n    pass\n"
        )
        ok, violations = build_guard([str(tmp_path)])
        assert ok is False
        assert any("njsscan" in v for v in violations)

    def test_embedded_eslint_no_unsanitized_js_source_fails(self, tmp_path):
        # Simulated vendored MPL-2.0 source of eslint-plugin-no-unsanitized.
        src = tmp_path / "vendor" / "eslint-plugin-no-unsanitized" / "index.js"
        src.parent.mkdir(parents=True)
        src.write_text(
            "// eslint-plugin-no-unsanitized\n"
            "module.exports = {\n"
            "  rules: { 'no-unsanitized/method': require('./lib/method') }\n"
            "};\n"
        )
        ok, violations = build_guard([str(tmp_path)])
        assert ok is False
        assert any("eslint-plugin-security" in v for v in violations)
        assert any("index.js" in v for v in violations)

    def test_reports_all_violations(self, tmp_path):
        t = tmp_path / "vendor" / "trufflehog.go"
        t.parent.mkdir(parents=True)
        t.write_text('import "github.com/trufflesecurity/trufflehog/v3"\n')
        n = tmp_path / "vendor" / "njsscan_main.py"
        n.write_text("import njsscan\n")
        ok, violations = build_guard([str(tmp_path)])
        assert ok is False
        assert len(violations) >= 2

    def test_multiple_scan_paths(self, tmp_path):
        clean = tmp_path / "clean"
        clean.mkdir()
        (clean / "ok.py").write_text("print('hi')\n")
        dirty = tmp_path / "dirty"
        dirty.mkdir()
        (dirty / "th.go").write_text("package trufflehog\n")
        ok, violations = build_guard([str(clean), str(dirty)])
        assert ok is False
        assert any("trufflehog" in v for v in violations)

    def test_signature_only_matches_source_extensions(self, tmp_path):
        # A .md file merely mentioning the import path is documentation, not
        # embedded source -> must not fail.
        (tmp_path / "notes.md").write_text(
            "trufflehog lives at github.com/trufflesecurity/trufflehog\n"
        )
        ok, violations = build_guard([str(tmp_path)])
        assert ok is True


# ── DoS / max-depth pruning guardrail (Carren coverage gap) ──────────────


class TestGuardDepthLimit:
    def test_deep_violation_below_limit_is_pruned_not_scanned(
        self, tmp_path, monkeypatch
    ):
        # Bury a real violation far below a small depth limit; the pruning
        # guardrail must stop descending and the guard must not hang/blow up.
        import license_guard as lg

        monkeypatch.setattr(lg, "_MAX_DEPTH", 3)
        deep = tmp_path
        for i in range(12):  # well past _MAX_DEPTH
            deep = deep / f"level{i}"
        deep.mkdir(parents=True)
        (deep / "buried.go").write_text("package trufflehog\n")

        ok, violations = build_guard([str(tmp_path)])
        # Pruned before reaching the buried file -> not scanned -> clean.
        assert ok is True
        assert violations == []

    def test_shallow_violation_still_detected_under_depth_limit(
        self, tmp_path, monkeypatch
    ):
        # A violation ABOVE the limit is still detected (limit only prunes deep).
        import license_guard as lg

        monkeypatch.setattr(lg, "_MAX_DEPTH", 3)
        (tmp_path / "shallow.go").write_text("package trufflehog\n")
        ok, violations = build_guard([str(tmp_path)])
        assert ok is False
        assert any("trufflehog" in v for v in violations)


# ── Input robustness ─────────────────────────────────────────────────────


class TestGuardInputs:
    def test_empty_scan_paths_list_passes(self):
        ok, violations = build_guard([])
        assert ok is True
        assert violations == []

    def test_file_path_as_scan_target(self, tmp_path):
        f = tmp_path / "th.go"
        f.write_text("package trufflehog\n")
        ok, violations = build_guard([str(f)])
        assert ok is False
        assert any("trufflehog" in v for v in violations)
