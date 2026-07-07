"""Tests for the self-improving-SAST rule writer + the full flywheel.

The flywheel test uses REAL semgrep (on PATH): it writes a validated learned rule
and proves the NEXT scan loads it and fires — i.e. the scanner got more robust.
The gate tests confirm a malformed/unsafe rule can never land in the rules tree.
"""

import scanners
import learned_rules
from fsm import JSAState, sast_scan_handler

VALID_RULE = (
    "rules:\n"
    "  - id: jsa-learned-dom-xss-innerhtml\n"
    "    languages: [javascript]\n"
    "    message: user input into innerHTML (DOM XSS)\n"
    "    severity: WARNING\n"
    "    pattern: $EL.innerHTML = $X\n"
)


def _rule(filename, content):
    return {"filename": filename, "yaml_content": content}


# ---------------------------------------------------------------------------
# Write gates
# ---------------------------------------------------------------------------

def test_valid_rule_is_validated_and_persisted(tmp_path):
    # Real semgrep --validate runs here.
    res = learned_rules.write_learned_rules([_rule("dom_xss-innerhtml.yaml", VALID_RULE)], dest_dir=tmp_path)
    assert len(res["written"]) == 1
    assert res["rejected"] == []
    assert (tmp_path / "dom_xss-innerhtml.yaml").exists()


def test_reject_non_yaml_extension(tmp_path):
    res = learned_rules.write_learned_rules([_rule("rule.txt", VALID_RULE)], dest_dir=tmp_path)
    assert res["written"] == []
    assert res["rejected"][0]["reason"].startswith("not a .yml")


def test_reject_non_semgrep_yaml(tmp_path):
    res = learned_rules.write_learned_rules([_rule("x.yaml", "foo: bar\n")], dest_dir=tmp_path)
    assert res["written"] == []
    assert "not a semgrep rule" in res["rejected"][0]["reason"]


def test_reject_unparseable_yaml(tmp_path):
    res = learned_rules.write_learned_rules([_rule("x.yaml", "rules: [unclosed\n")], dest_dir=tmp_path)
    assert res["written"] == []


def test_reject_semgrep_invalid_rule(tmp_path):
    # Parses + has a rules: list, but the rule is missing message/pattern ->
    # semgrep --validate rejects it, so it never lands in the tree.
    bad = "rules:\n  - id: jsa-learned-broken\n    languages: [javascript]\n"
    res = learned_rules.write_learned_rules([_rule("broken.yaml", bad)], dest_dir=tmp_path)
    assert res["written"] == []
    assert "semgrep --validate failed" in res["rejected"][0]["reason"]
    assert not (tmp_path / "broken.yaml").exists()


def test_path_traversal_filename_is_sanitized_and_contained(tmp_path, monkeypatch):
    monkeypatch.setattr(learned_rules, "_semgrep_validate", lambda c: True)
    res = learned_rules.write_learned_rules(
        [_rule("../../evil.yaml", VALID_RULE)], dest_dir=tmp_path
    )
    # Sanitized to a bare basename inside the learned dir — nothing escapes.
    assert len(res["written"]) == 1
    written = res["written"][0]
    assert written.endswith("/evil.yaml")
    assert str(tmp_path.resolve()) in written
    assert not (tmp_path.parent / "evil.yaml").exists()


def test_per_run_cap_reported_not_silently_dropped(tmp_path, monkeypatch):
    monkeypatch.setattr(learned_rules, "_semgrep_validate", lambda c: True)
    monkeypatch.setattr(learned_rules, "MAX_LEARNED_RULES_PER_RUN", 2)
    rules = [_rule(f"r{i}.yaml", VALID_RULE) for i in range(3)]
    res = learned_rules.write_learned_rules(rules, dest_dir=tmp_path)
    assert len(res["written"]) == 2
    assert any("exceeds per-run cap" in r["reason"] for r in res["rejected"])


# ---------------------------------------------------------------------------
# The flywheel: a persisted learned rule is loaded + fires on the NEXT scan
# ---------------------------------------------------------------------------

def test_learned_rule_is_loaded_by_future_sast_scan(tmp_path, monkeypatch):
    # Stand up a rules tree with a learned rule under learned/jsa/, exactly as the
    # writer would persist it.
    rules_tree = tmp_path / "rules"
    learned_dir = rules_tree / "learned" / "jsa"
    res = learned_rules.write_learned_rules(
        [_rule("dom_xss-innerhtml.yaml", VALID_RULE)], dest_dir=learned_dir
    )
    assert len(res["written"]) == 1

    # Point the scanner's rules base at our tree (no registry rules, for a clean
    # assertion that the LEARNED rule is what fired).
    monkeypatch.setattr(scanners, "_rules_base", lambda: rules_tree)
    monkeypatch.setattr(scanners, "JSA_REGISTRY_RULES", [])
    monkeypatch.setattr(scanners, "_jsluice_bin", lambda: None)

    st = JSAState(target_url="https://x", output_dir=str(tmp_path / "out"))
    st.ensure_dirs()
    (st.js_dir / "app.js").write_text("el.innerHTML = location.hash;\n")

    st = sast_scan_handler(st)
    rule_ids = [f["rule_id"] for f in st.sast_findings]
    assert any("jsa-learned-dom-xss-innerhtml" in rid for rid in rule_ids), rule_ids
