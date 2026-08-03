"""Evidence-grounded, open-ended target profile fixtures."""

from pathlib import Path

import json

import pytest

from orchestration.code_artifacts import detect_target_profile, validate_target_profile


def test_unconventionally_named_gates_are_evidenced_not_dropped(tmp_path):
    """A repo whose only gate is ``make ci`` must yield an evidenced verification
    command, not an unverified profile.

    Bitter-Lesson audit AG-5/BL-5: the profile's word list and the code playbook's
    advisory word list had drifted apart, so ``ci`` was visible to the advisory path
    but invisible here — turning a keyword gap into a spurious human clarification
    interrupt. Both now share ``VERIFICATION_COMMAND_HINT_RE``.
    """
    (tmp_path / "pyproject.toml").write_text("[project]\nname='app'\n")
    (tmp_path / "Makefile").write_text("ci:\n\tpython -m pytest -q\n")
    profile = detect_target_profile(str(tmp_path))
    assert "make ci" in profile["verification_commands"]
    assert profile["status"] == "selected"
    assert not validate_target_profile(profile, require_selected=True)


def test_verification_vocabulary_is_shared_with_the_code_playbook(tmp_path):
    """One vocabulary, imported by both call sites — they cannot drift again."""
    from orchestration.code_artifacts import VERIFICATION_COMMAND_HINT_RE
    from orchestration.playbooks import code as code_mod

    assert code_mod.VERIFICATION_COMMAND_HINT_RE is VERIFICATION_COMMAND_HINT_RE
    # `ci` stays word-bounded: as a bare substring it would wrongly capture a
    # target like `capacity` and force an unrelated command into verification.
    assert VERIFICATION_COMMAND_HINT_RE.search("ci")
    assert not VERIFICATION_COMMAND_HINT_RE.search("capacity")


def test_greenfield_and_ambiguous_polyglot_clarify_without_fallback(tmp_path):
    greenfield = detect_target_profile(str(tmp_path))
    assert greenfield["status"] == "unverified"
    assert greenfield["languages"] == []
    assert validate_target_profile(greenfield, require_selected=True)

    (tmp_path / "pyproject.toml").write_text("[project]\nname='python-app'\n")
    (tmp_path / "package.json").write_text(json.dumps({"scripts": {"test": "vitest run"}}))
    (tmp_path / "Makefile").write_text("test:\n\tpytest -q\n")
    ambiguous = detect_target_profile(str(tmp_path))
    assert ambiguous["status"] == "unverified"
    assert set(ambiguous["languages"]) == {"Python", "JavaScript/TypeScript"}
    assert any("polyglot" in reason for reason in ambiguous["unverified_reasons"])


@pytest.mark.parametrize(
    ("signal", "content", "expected"),
    [
        ("pyproject.toml", "[project]\nname='x'\n", "Python"),
        ("package.json", '{"scripts":{"test":"vitest run"}}', "JavaScript/TypeScript"),
        ("go.mod", "module example.invalid/x\n", "Go"),
        ("Cargo.toml", "[package]\nname='x'\n", "Rust"),
        ("pom.xml", "<project/>", "Java"),
        ("service.csproj", "<Project/>", "C#"),
    ],
)
def test_language_fixtures_select_only_their_evidenced_profile(tmp_path, signal, content, expected):
    (tmp_path / signal).write_text(content)
    (tmp_path / "Makefile").write_text("test:\n\ttrue\n")
    profile = detect_target_profile(str(tmp_path), selected_language=expected)
    assert profile["status"] == "selected"
    assert profile["languages"] == [expected]
    if expected in {"Go", "Rust", "Java", "C#"}:
        assert "Python" not in profile["languages"]
        assert "JavaScript/TypeScript" not in profile["languages"]
    assert validate_target_profile(profile, require_selected=True) == []


def test_javascript_commands_follow_selected_lockfile_without_bun_fallback(tmp_path):
    (tmp_path / "package.json").write_text(
        json.dumps({"scripts": {"test": "vitest run", "lint": "eslint ."}})
    )
    (tmp_path / "package-lock.json").write_text("{}")
    profile = detect_target_profile(str(tmp_path), selected_language="TypeScript")
    assert profile["status"] == "selected"
    assert profile["verification_commands"] == ["npm run lint", "npm run test"]
    assert "bun" not in json.dumps(profile)


def test_package_scripts_without_lockfile_require_clarification(tmp_path):
    (tmp_path / "package.json").write_text(json.dumps({"scripts": {"test": "vitest run"}}))
    profile = detect_target_profile(str(tmp_path), selected_language="TypeScript")
    assert profile["status"] == "unverified"
    assert profile["verification_commands"] == []
    assert any("verification command" in reason for reason in profile["unverified_reasons"])


def test_selected_profile_requires_explicit_package_build_test_lint_type_slots(tmp_path):
    incomplete = {
        "schema_version": 1,
        "status": "selected",
        "languages": ["Zig"],
        "framework_runtime": ["framework-free"],
        "target_scope": ["src/"],
        "tooling": {"package": ["zig"], "build": ["zig build"]},
        "verification_commands": ["zig build test"],
        "conventions": [],
        "confidence": "CERTAIN",
        "source_evidence": ["explicit caller profile"],
        "unverified_reasons": [],
    }
    detected = detect_target_profile(str(tmp_path), explicit_profile=incomplete)
    assert detected["status"] == "unverified"
    assert any(
        "package/build/test/lint/type" in reason for reason in detected["unverified_reasons"]
    )


def test_unlisted_explicit_profile_round_trips_and_drives_commands(tmp_path):
    explicit = {
        "schema_version": 1,
        "status": "selected",
        "languages": ["Zig"],
        "framework_runtime": ["framework-free"],
        "target_scope": ["src/"],
        "tooling": {
            "package": ["zig"],
            "build": ["zig build"],
            "test": ["zig build test"],
            "lint": ["zig fmt --check src"],
            "type": [],
        },
        "verification_commands": ["zig build test", "zig fmt --check src"],
        "conventions": [
            {
                "name": "format",
                "value": "zig fmt",
                "source_evidence": "build.zig and repository CI",
            }
        ],
        "confidence": "CERTAIN",
        "source_evidence": ["caller-selected target profile", "build.zig"],
        "unverified_reasons": [],
    }
    assert detect_target_profile(str(tmp_path), explicit_profile=explicit) == explicit
    assert validate_target_profile(explicit, require_selected=True) == []


def test_default_verification_manifest_satisfies_its_own_validator(tmp_path):
    """The DEFAULT manifest builder must validate against the canonical validator.

    These drifted apart in production: the builder emitted schema_version 1 while
    ``validate_p0_verification_manifest`` required 2, and the builder never emitted
    ``evidence_class_map`` at all. Nothing compared the two, so every standalone P0
    run failed completion with "manifest has missing or stale fields" / "schema
    version is unsupported" / "evidence classes are incomplete" — the documented
    default invocation could never reach met=true.
    """
    from orchestration.code_artifacts import validate_p0_verification_manifest
    from orchestration.playbooks.code import _target_verification_manifest

    (tmp_path / "pyproject.toml").write_text("[project]\nname='app'\n")
    (tmp_path / "Makefile").write_text("test:\n\tpytest -q\n\nlint:\n\truff check .\n")
    profile = detect_target_profile(str(tmp_path))
    assert profile["verification_commands"], "fixture must evidence commands"

    criteria_count = 3
    manifest = _target_verification_manifest(profile, criteria_count)
    errors = validate_p0_verification_manifest(manifest, criteria_count=criteria_count)
    assert errors == [], errors


def test_default_manifest_never_claims_command_proof_for_judgment_dimensions(tmp_path):
    """A passing test suite does not demonstrate absence of duplication/complexity.

    The validator hard-requires judgment-only for those two dimensions; this asserts
    the builder does not regress into laundering a green suite into command evidence
    for qualities no command can prove.
    """
    from orchestration.playbooks.code import _target_verification_manifest

    (tmp_path / "pyproject.toml").write_text("[project]\nname='app'\n")
    (tmp_path / "Makefile").write_text("test:\n\tpytest -q\n")
    manifest = _target_verification_manifest(detect_target_profile(str(tmp_path)), 2)
    classes = manifest["evidence_class_map"]
    assert classes["quality:harmful_duplication_avoidance"] == "judgment-only"
    assert classes["quality:unnecessary_complexity_avoidance"] == "judgment-only"
    assert classes["quality:security"] == "judgment-only"
    assert classes["quality:target_idiom"] == "judgment-only"
    # Regression freedom is exactly what a full suite run demonstrates.
    assert classes["quality:regression_freedom"] == "command-verifiable"
    assert classes["criterion:1"] == "command-verifiable"


def _git_init(root):
    import subprocess

    for args in (
        ["git", "init", "-q"],
        ["git", "add", "-A"],
        ["git", "-c", "user.email=t@l", "-c", "user.name=t", "commit", "-qm", "base"],
    ):
        subprocess.run(args, cwd=str(root), check=True, capture_output=True)


def test_standalone_run_self_establishes_a_valid_pre_edit_baseline(tmp_path):
    """A standalone run must produce its OWN immutable pre-edit baseline.

    `eval_baseline` previously had no default, so absent a caller-supplied
    `immutable_eval_baseline` completion was refused outright. Since
    `ideal_state_from_goal` emits schema_version 2, EVERY documented invocation is P0
    and could never reach met=true, with nothing documenting the requirement. The run
    now captures the baseline from the target's own verification commands.
    """
    from orchestration.code_artifacts import validate_eval_baseline
    from orchestration.playbooks.code import (
        _capture_pre_edit_eval_baseline,
        _target_verification_manifest,
        _target_scope_manifest,
    )

    (tmp_path / "pyproject.toml").write_text("[project]\nname='app'\n")
    (tmp_path / "Makefile").write_text("test:\n\t@true\n")
    _git_init(tmp_path)

    profile = detect_target_profile(str(tmp_path))
    manifest = _target_verification_manifest(profile, 2)
    scope = _target_scope_manifest(profile, "run-baseline")
    drift = {"schema_version": 1, "matrix_id": "m", "version": 1}

    baseline = _capture_pre_edit_eval_baseline(str(tmp_path), manifest, scope, drift)
    assert baseline.get("status") != "unverified", baseline.get("reason")
    assert validate_eval_baseline(baseline) == []
    # The recorded command must be one the manifest actually selects, and
    # regression_freedom must select it (validate_p0_completion enforces both).
    assert baseline["command_argv"] in manifest["checks"].values()
    matching = [n for n, a in manifest["checks"].items() if a == baseline["command_argv"]]
    assert set(matching) & set(manifest["quality_dimension_map"]["regression_freedom"])
    # Raw evidence must live outside the target tree and be owner-only.
    raw = Path(baseline["raw_output_ref"])
    assert tmp_path.resolve() not in raw.resolve().parents
    assert raw.stat().st_mode & 0o077 == 0


def test_pre_edit_baseline_is_unverified_rather_than_fatal_without_git(tmp_path):
    """No git worktree => explicitly unverified (completion still refuses), never a raise."""
    from orchestration.playbooks.code import (
        _capture_pre_edit_eval_baseline,
        _target_verification_manifest,
        _target_scope_manifest,
    )

    (tmp_path / "pyproject.toml").write_text("[project]\nname='app'\n")
    (tmp_path / "Makefile").write_text("test:\n\t@true\n")
    profile = detect_target_profile(str(tmp_path))
    manifest = _target_verification_manifest(profile, 1)
    scope = _target_scope_manifest(profile, "run-nogit")
    drift = {"schema_version": 1, "matrix_id": "m", "version": 1}
    baseline = _capture_pre_edit_eval_baseline(str(tmp_path), manifest, scope, drift)
    assert baseline["status"] == "unverified"
    assert "git worktree" in baseline["reason"]


def test_pre_edit_baseline_records_a_failing_target_honestly(tmp_path):
    """A pre-existing failure is a legitimate baseline, not a capture error."""
    from orchestration.code_artifacts import validate_eval_baseline
    from orchestration.playbooks.code import (
        _capture_pre_edit_eval_baseline,
        _target_verification_manifest,
        _target_scope_manifest,
    )

    (tmp_path / "pyproject.toml").write_text("[project]\nname='app'\n")
    (tmp_path / "Makefile").write_text("test:\n\t@exit 1\n")
    _git_init(tmp_path)
    profile = detect_target_profile(str(tmp_path))
    manifest = _target_verification_manifest(profile, 1)
    scope = _target_scope_manifest(profile, "run-red")
    drift = {"schema_version": 1, "matrix_id": "m", "version": 1}
    baseline = _capture_pre_edit_eval_baseline(str(tmp_path), manifest, scope, drift)
    assert validate_eval_baseline(baseline) == []
    result = baseline["normalized_outcomes"]["results"][0]
    assert result["status"] == "fail" and result["exit_status"] != 0
