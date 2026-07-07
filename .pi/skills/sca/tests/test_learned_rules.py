"""Cross-run persistence for sca augment rules (self-improving SAST).

persist_learned_rules validates P9-authored rules and persists them to the shared
``.pi/extensions/semgrep/rules/learned/sca/`` dir; the SCA preset now includes
that dir so FUTURE runs load accumulated rules. The flywheel test uses REAL
semgrep to prove a persisted rule loads and fires on the next scan.
"""

import shutil
import subprocess

import baseline_scan
import sca_domain

VALID_RULE = (
    "rules:\n"
    "  - id: sca-learned-eval-usage\n"
    "    languages: [javascript]\n"
    "    message: eval on user input\n"
    "    severity: WARNING\n"
    "    pattern: eval($X)\n"
)


def _result(*rules):
    return {"new_rules": list(rules)}


def _rule(filename, content):
    return {"filename": filename, "yaml_content": content}


# ---------------------------------------------------------------------------
# persist gates
# ---------------------------------------------------------------------------

def test_persist_valid_rule_to_learned_sca(tmp_path):
    meta = {}
    written = sca_domain.persist_learned_rules(
        meta, _result(_rule("eval.yaml", VALID_RULE)), dest_dir=tmp_path
    )
    assert len(written) == 1
    assert (tmp_path / "eval.yaml").exists()
    assert meta["augment_rules_persisted"] == written
    assert not meta.get("augment_persist_errors")


def test_persist_rejects_semgrep_invalid_rule(tmp_path):
    bad = "rules:\n  - id: sca-learned-broken\n    languages: [javascript]\n"  # no message/pattern
    written = sca_domain.persist_learned_rules({}, _result(_rule("broken.yaml", bad)), dest_dir=tmp_path)
    assert written == []
    assert not (tmp_path / "broken.yaml").exists()


def test_persist_rejects_non_semgrep_yaml(tmp_path):
    written = sca_domain.persist_learned_rules(
        {}, _result(_rule("x.yaml", "foo: bar\n")), dest_dir=tmp_path
    )
    assert written == []


def test_persist_per_run_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(sca_domain, "_semgrep_validates", lambda c: True)
    monkeypatch.setattr(sca_domain, "_MAX_PERSIST_RULES", 2)
    meta = {}
    rules = [_rule(f"r{i}.yaml", VALID_RULE) for i in range(3)]
    written = sca_domain.persist_learned_rules(meta, _result(*rules), dest_dir=tmp_path)
    assert len(written) == 2
    assert any("exceeds per-run cap" in e for e in meta["augment_persist_errors"])


# ---------------------------------------------------------------------------
# future runs load learned/sca via the SCA preset
# ---------------------------------------------------------------------------

def test_preset_includes_learned_sca_when_present(tmp_path, monkeypatch):
    (tmp_path / "learned" / "sca").mkdir(parents=True)
    (tmp_path / "learned" / "sca" / "eval.yaml").write_text(VALID_RULE)
    monkeypatch.setattr(baseline_scan, "_rules_base_discovery", lambda: tmp_path)
    paths = baseline_scan.default_semgrep_config_paths()
    assert str(tmp_path / "learned" / "sca") in paths


def test_flywheel_learned_rule_loaded_by_run_semgrep(tmp_path, monkeypatch):
    # Persist a rule to a tmp rules tree's learned/sca, exactly as production would.
    base = tmp_path / "rules"
    learned = base / "learned" / "sca"
    sca_domain.persist_learned_rules({}, _result(_rule("eval.yaml", VALID_RULE)), dest_dir=learned)
    monkeypatch.setattr(baseline_scan, "_rules_base_discovery", lambda: base)

    paths = baseline_scan.default_semgrep_config_paths()
    assert any(p.endswith("learned/sca") for p in paths)

    target = tmp_path / "app.js"
    target.write_text("eval(location.hash);\n")
    semgrep = shutil.which("semgrep")
    assert semgrep, "semgrep must be installed for the flywheel test"
    findings, gap = baseline_scan.run_semgrep(semgrep, str(target), paths, subprocess.run)
    assert gap is None, gap
    assert any("sca-learned-eval-usage" in str(f) for f in (findings or [])), findings
