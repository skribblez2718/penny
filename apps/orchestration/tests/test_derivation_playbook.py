"""Tests for the derivation skill (DerivationPlaybook) on the engine.

Two phases:
  * the UNCHANGED single-agent review flow reached via the manifest.json fast
    path (start -> annie dispatch -> complete), the three verdicts,
    unknown-verdict -> terminal error, and the fail-loud SUMMARY contract;
  * the net-new, verify-only ``gathering`` phase reached when ``sources`` is a
    directory: the echo dynamic fan, multi-round batching, sharding, manifest
    round-trip, provenance drawer, the guardrail (no raw source text in the
    reviewing task), the license/bucket fail-safe, and the hard-fail paths.

The directory-path tests use REAL ``tmp_path`` corpora (migration mandate).
"""

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from orchestration.checkpointer import Checkpointer
from orchestration.contracts import validate_summary_contract
from orchestration.playbooks import PLAYBOOKS, get_playbook
from orchestration.playbooks import derivation as deriv
from orchestration.playbooks.derivation import (
    REVIEW_CONTRACT,
    DerivationPlaybook,
    build_provenance_content,
)

SID, RID = "sess-deriv", "run-deriv"
GOAL = "review lesson 3 for derivation against its sources"

CLEAN = {
    "verdict": "INDEPENDENT",
    "confidence": "PROBABLE",
    "prefilter": {"status": "clean", "max_overlap_ratio": 0.01},
    "dimensions": [{"id": f"D{i}", "verdict": "clear", "note": ""} for i in range(1, 8)],
    "flagged": [],
    "matched_sources": [],
    "fixes": [],
    "drawer_id": "drawer_x",
}

FLAGGED = {
    "verdict": "NEEDS_REVISION",
    "confidence": "PROBABLE",
    "prefilter": {"status": "flag", "max_overlap_ratio": 0.2},
    "dimensions": [{"id": "D3", "verdict": "concern", "note": "structure mirrors src A"}],
    "flagged": ["D3"],
    "matched_sources": [
        {
            "id": "srcA",
            "origin": "arXiv:1907.09415",
            "license": "unknown",
            "dimensions": ["D3"],
            "note": "same section order",
        }
    ],
    "fixes": ["reorder from a multi-source synthesis, not srcA's sequence"],
}


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


# ---------------------------------------------------------------------------
# Fixtures: a manifest.json FILE (fast path) and a real directory corpus.
# ---------------------------------------------------------------------------


def _manifest_file(tmp_path: Path) -> Path:
    """A prefilter.py-compatible manifest.json FILE — the fast path to reviewing."""
    src = tmp_path / "src.md"
    src.write_text("# Source\n\nSome content.\n", encoding="utf-8")
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            [
                {
                    "id": "src.md",
                    "path": str(src),
                    "origin": "src.md",
                    "license": "MIT",
                    "bucket": "docs",
                }
            ]
        ),
        encoding="utf-8",
    )
    return manifest


def _manifest_constraints(tmp_path: Path, **extra) -> dict:
    c = {
        "content": str(tmp_path / "lesson3.md"),
        "sources": str(_manifest_file(tmp_path)),
        "skeleton": str(tmp_path / "skeleton.md"),
        "provenance": str(tmp_path / "prov.md"),
    }
    (tmp_path / "lesson3.md").write_text("# Lesson 3\n\n## Topic\n\nAuthored.\n", encoding="utf-8")
    c.update(extra)
    return c


def _corpus(tmp_path: Path, files: dict[str, str], *, workdir: Path | None = None, **extra) -> dict:
    """Create a real directory corpus and return derivation constraints for it."""
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    for name, body in files.items():
        p = corpus / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body, encoding="utf-8")
    content = tmp_path / "lesson3.md"
    content.write_text("# Lesson 3\n\n## Independence\n\nOriginal prose here.\n", encoding="utf-8")
    c = {
        "content": str(content),
        "sources": str(corpus),
        "gather_workdir": str(workdir if workdir is not None else tmp_path / "workdir"),
    }
    c.update(extra)
    return c


def _start(cp, constraints):
    return DerivationPlaybook(cp).start(
        session_id=SID, run_id=RID, goal=GOAL, constraints=constraints
    )


def _step(cp, agent, result):
    return DerivationPlaybook(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)


def _gather_summary(**over) -> dict:
    base = {
        "gather_complete": True,
        "license": "MIT",
        "license_confidence": "CERTAIN",
        "license_evidence": "SPDX-License-Identifier: MIT",
        "bucket": "docs",
        "bucket_confidence": "PROBABLE",
        "bucket_evidence": "arXiv:2101.00001",
        "outline": [{"level": 1, "title": "Intro", "line": 1}],
        "confidence": "PROBABLE",
    }
    base.update(over)
    return base


def _fanin(directive, summary_for) -> list:
    """Build a __parallel__ fan-in result list from a fan-out directive."""
    return [
        {
            "branch_id": t["branch_id"],
            "agent": t["agent"],
            "exitCode": 0,
            "summary": summary_for(t["branch_id"]),
        }
        for t in directive["tasks"]
    ]


def _run_gather(cp, directive, summary_for=lambda bid: _gather_summary()) -> dict:
    """Drive the gather fan (possibly multi-round) until it leaves 'gathering'."""
    d = directive
    for _ in range(64):
        assert d["action"] == "invoke_agents_parallel", d
        d = _step(cp, "__parallel__", _fanin(d, summary_for))
        if d["action"] != "invoke_agents_parallel":
            return d
    raise AssertionError("gather did not converge")


# -- registry ---------------------------------------------------------------


def test_registered():
    assert get_playbook("derivation") is DerivationPlaybook
    assert "derivation" in PLAYBOOKS


# ---------------------------------------------------------------------------
# Fast path — sources is a manifest.json FILE (UNCHANGED behavior).
# ---------------------------------------------------------------------------


def test_manifest_file_routes_straight_to_reviewing(cp, tmp_path):
    d = _start(cp, _manifest_constraints(tmp_path))
    assert d["action"] == "invoke_agent"
    assert d["agent"] == "annie"
    assert d["state_id"] == "reviewing"
    ts = d["task_summary"]
    assert "OUTPUT FORMAT" in ts and "SUMMARY:{" in ts
    for key in ("verdict", "prefilter", "dimensions", "matched_sources", "flagged", "fixes"):
        assert f'"{key}"' in ts


def test_independent_verdict_completes(cp, tmp_path):
    _start(cp, _manifest_constraints(tmp_path))
    d = _step(cp, "annie", CLEAN)
    assert d["action"] == "complete"
    res = d["result"]
    assert res["verdict"] == "INDEPENDENT"
    assert res["independent"] is True
    assert res["flagged"] == []
    assert res["session_room"] == f"skills/derivation-{SID}"


def test_fast_path_result_has_empty_gather_manifest_path(cp, tmp_path):
    _start(cp, _manifest_constraints(tmp_path))
    res = _step(cp, "annie", CLEAN)["result"]
    # The ONE new optional key is present and EMPTY on the fast path.
    assert res["gather_manifest_path"] == ""


def test_needs_revision_completes_not_independent(cp, tmp_path):
    _start(cp, _manifest_constraints(tmp_path))
    d = _step(cp, "annie", FLAGGED)
    assert d["action"] == "complete"
    res = d["result"]
    assert res["verdict"] == "NEEDS_REVISION"
    assert res["independent"] is False
    assert res["flagged"] == ["D3"]
    assert res["matched_sources"] and res["matched_sources"][0]["id"] == "srcA"


def test_unknown_verdict_is_terminal_error(cp, tmp_path):
    _start(cp, _manifest_constraints(tmp_path))
    d = _step(cp, "annie", dict(CLEAN, verdict="MAYBE"))
    assert d["action"] == "error"


# ---------------------------------------------------------------------------
# Fail-loud REVIEW contract (unchanged).
# ---------------------------------------------------------------------------


def test_contract_accepts_clean_and_flagged():
    ok, msg = validate_summary_contract("DERIVATION_REVIEW", REVIEW_CONTRACT, CLEAN)
    assert ok, msg
    ok2, msg2 = validate_summary_contract("DERIVATION_REVIEW", REVIEW_CONTRACT, FLAGGED)
    assert ok2, msg2


def test_contract_rejects_missing_prefilter():
    bad = {k: v for k, v in CLEAN.items() if k != "prefilter"}
    ok, _ = validate_summary_contract("DERIVATION_REVIEW", REVIEW_CONTRACT, bad)
    assert not ok


def test_contract_rejects_empty_evidence():
    bad = dict(CLEAN, dimensions=[])
    ok, _ = validate_summary_contract("DERIVATION_REVIEW", REVIEW_CONTRACT, bad)
    assert not ok


def test_contract_rejects_flagged_without_fix_or_source():
    ok, _ = validate_summary_contract("DERIVATION_REVIEW", REVIEW_CONTRACT, dict(FLAGGED, fixes=[]))
    assert not ok
    ok2, _ = validate_summary_contract(
        "DERIVATION_REVIEW", REVIEW_CONTRACT, dict(FLAGGED, matched_sources=[])
    )
    assert not ok2


# ---------------------------------------------------------------------------
# Directory sources -> gathering fan -> reviewing.
# ---------------------------------------------------------------------------


def test_directory_sources_auto_routes_to_gathering(cp, tmp_path):
    d = _start(cp, _corpus(tmp_path, {"a.md": "# A\n\nbody a\n", "b.txt": "B license MIT\n"}))
    assert d["action"] == "invoke_agents_parallel"
    assert d["state_id"] == "gathering"
    assert all(t["agent"] == "echo" for t in d["tasks"])
    assert len(d["tasks"]) == 2  # one branch per scannable file


def test_gather_then_reviewing_completes(cp, tmp_path):
    d = _start(cp, _corpus(tmp_path, {"a.md": "# A\n\nbody\n", "b.rst": "B\n=\n\nbody\n"}))
    d = _run_gather(cp, d)
    assert d["action"] == "invoke_agent" and d["agent"] == "annie"
    assert d["state_id"] == "reviewing"
    # The reviewing task references the gather-built manifest PATH.
    assert "manifest.json" in d["task_summary"]
    res = _step(cp, "annie", CLEAN)["result"]
    assert res["verdict"] == "INDEPENDENT"
    assert res["gather_manifest_path"].endswith("manifest.json")
    assert Path(res["gather_manifest_path"]).is_file()


def test_gather_never_sets_verdict_before_reviewing(cp, tmp_path):
    d = _start(cp, _corpus(tmp_path, {"a.md": "# A\n\nbody\n"}))
    _run_gather(cp, d)
    ctx = cp.load(RID).context
    # Gather ran, but no verdict exists until annie renders one.
    assert ctx.extras["derivation"].get("gather", {}).get("ran") is True
    assert "verdict" not in ctx.extras["derivation"]


# ---------------------------------------------------------------------------
# Manifest: prefilter.py round-trip, workdir isolation + permissions.
# ---------------------------------------------------------------------------


def _load_prefilter():
    sd = Path(__file__).resolve().parents[3] / ".pi" / "skills" / "derivation" / "scripts"
    sys.path.insert(0, str(sd))
    import prefilter  # type: ignore

    return prefilter


def test_gather_manifest_is_prefilter_compatible(cp, tmp_path):
    d = _start(cp, _corpus(tmp_path, {"a.md": "# A\n\nbody\n", "b.md": "# B\n\nbody\n"}))
    _run_gather(cp, d)
    mpath = Path(cp.load(RID).context.extras["derivation"]["gather_manifest_path"])
    entries = json.loads(mpath.read_text(encoding="utf-8"))
    assert isinstance(entries, list) and len(entries) == 2
    # prefilter.load_corpus reads {id, path|url, origin, license, bucket} — no changes.
    prefilter = _load_prefilter()
    corpus = prefilter.load_corpus(mpath)
    assert {e["id"] for e in corpus} == {"a.md", "b.md"}
    assert all("license" in e and "bucket" in e for e in corpus)


def test_manifest_written_to_workdir_not_into_sources(cp, tmp_path):
    c = _corpus(tmp_path, {"a.md": "# A\n\nbody\n"})
    before = set(p.name for p in Path(c["sources"]).rglob("*"))
    d = _start(cp, c)
    _run_gather(cp, d)
    mpath = Path(cp.load(RID).context.extras["derivation"]["gather_manifest_path"])
    after = set(p.name for p in Path(c["sources"]).rglob("*"))
    assert before == after  # nothing written into the caller's sources dir
    assert not str(mpath).startswith(str(Path(c["sources"]).resolve()))
    # Permissions: 0o600 manifest inside a 0o700 workdir (not world/group-writable).
    assert stat.S_IMODE(os.stat(mpath).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(mpath.parent).st_mode) == 0o700


def test_gather_workdir_override_is_honored(cp, tmp_path):
    wd = tmp_path / "custom_workdir"
    d = _start(cp, _corpus(tmp_path, {"a.md": "# A\n\nbody\n"}, workdir=wd))
    _run_gather(cp, d)
    mpath = Path(cp.load(RID).context.extras["derivation"]["gather_manifest_path"])
    assert mpath == (wd / "manifest.json").resolve()


def test_gather_workdir_inside_sources_is_rejected(cp, tmp_path):
    c = _corpus(tmp_path, {"a.md": "# A\n\nbody\n"})
    c["gather_workdir"] = str(Path(c["sources"]) / "nested")  # inside the corpus
    d = _start(cp, c)
    d = _step(cp, "__parallel__", _fanin(d, lambda bid: _gather_summary()))
    assert d["action"] == "error"
    assert "sources" in d["errors"][0]


# ---------------------------------------------------------------------------
# License / bucket fail-safe + the per-entry invariant.
# ---------------------------------------------------------------------------


def test_unsupported_license_is_downgraded_to_unknown(cp, tmp_path):
    d = _start(cp, _corpus(tmp_path, {"a.md": "# A\n\nbody\n"}))
    # A crafted branch claims MIT/CERTAIN with NO evidence snippet.
    _run_gather(
        cp,
        d,
        lambda bid: _gather_summary(
            license="MIT", license_confidence="CERTAIN", license_evidence=""
        ),
    )
    gather = cp.load(RID).context.extras["derivation"]["gather"]
    entry = json.loads(Path(gather["manifest_path"]).read_text())[0]
    assert entry["license"] == "unknown"  # fail-safe: unknown => restricted
    assert any("downgraded to 'unknown'" in w for w in gather["warnings"])


def test_bucket_without_evidence_is_cleared(cp, tmp_path):
    d = _start(cp, _corpus(tmp_path, {"a.md": "# A\n\nbody\n"}))
    _run_gather(cp, d, lambda bid: _gather_summary(bucket="textbook", bucket_evidence=""))
    entry = json.loads(
        Path(cp.load(RID).context.extras["derivation"]["gather"]["manifest_path"]).read_text()
    )[0]
    assert entry["bucket"] == ""  # never fabricated without a marker


def test_every_manifest_entry_satisfies_license_invariant(cp, tmp_path):
    d = _start(
        cp,
        _corpus(
            tmp_path,
            {
                "a.md": "# A\n",
                "b.md": "# B\n",
                "c.txt": "C\n",
            },
        ),
    )

    def summ(bid):
        # Mix: grounded MIT, ungrounded (downgraded), and unknown.
        return {
            "u0": _gather_summary(),
            "u1": _gather_summary(license="Apache-2.0", license_evidence=""),
            "u2": _gather_summary(
                license="unknown", license_evidence="", bucket="", bucket_evidence=""
            ),
        }[bid]

    _run_gather(cp, d, summ)
    entries = json.loads(
        Path(cp.load(RID).context.extras["derivation"]["gather"]["manifest_path"]).read_text()
    )
    for e in entries:
        assert "license" in e and "license_confidence" in e
        assert e["license"] == "unknown" or e["license_evidence"].strip()


# ---------------------------------------------------------------------------
# Multi-round batching + sharding + completeness.
# ---------------------------------------------------------------------------


def test_multi_round_batching_covers_all_files(cp, tmp_path):
    files = {f"s{i}.md": f"# S{i}\n\nbody\n" for i in range(6)}
    # width 3, budget 3: two rounds (3 + 3) — affordable, full coverage.
    d = _start(cp, _corpus(tmp_path, files, max_fan_width=3, max_iterations=3))
    first_batch = len(d["tasks"])
    assert first_batch == 3  # bounded by the fan width, not the corpus size
    d = _run_gather(cp, d)
    assert d["action"] == "invoke_agent" and d["state_id"] == "reviewing"
    entries = json.loads(
        Path(cp.load(RID).context.extras["derivation"]["gather"]["manifest_path"]).read_text()
    )
    assert {e["id"] for e in entries} == set(files)  # 100% coverage before reviewing


def test_iteration_budget_exhausted_before_coverage_is_terminal(cp, tmp_path):
    files = {f"s{i}.md": f"# S{i}\n" for i in range(6)}
    # width 1, budget 3: rounds 0..3 inventory only 4 of 6 -> terminal error.
    d = _start(cp, _corpus(tmp_path, files, max_fan_width=1, max_iterations=3))
    for _ in range(10):
        if d["action"] != "invoke_agents_parallel":
            break
        d = _step(cp, "__parallel__", _fanin(d, lambda bid: _gather_summary()))
    assert d["action"] == "error"
    assert "budget exhausted" in d["errors"][0]
    # Never a partial-corpus pass-through: reviewing was never entered.
    assert "verdict" not in cp.load(RID).context.extras.get("derivation", {})


def test_large_file_is_sharded_and_merged_to_one_entry(cp, tmp_path):
    big = "# Big\n\n" + ("x" * 500)
    d = _start(
        cp, _corpus(tmp_path, {"big.md": big, "small.md": "# Small\n"}, gather_shard_bytes=100)
    )
    # big.md (>100 bytes) shards into multiple branches; small.md is one.
    assert len(d["tasks"]) > 2

    def summ(bid):
        # Only the first shard carries the license marker (top of file).
        return _gather_summary(
            license_evidence="LICENSE: MIT", outline=[{"level": 1, "title": "Big", "line": 1}]
        )

    d = _run_gather(cp, d, summ)
    entries = json.loads(
        Path(cp.load(RID).context.extras["derivation"]["gather"]["manifest_path"]).read_text()
    )
    ids = [e["id"] for e in entries]
    assert ids.count("big.md") == 1  # shards merged back to a single entry
    assert set(ids) == {"big.md", "small.md"}


# ---------------------------------------------------------------------------
# Zero-file corpus + non-directory sources.
# ---------------------------------------------------------------------------


def test_zero_scannable_files_hard_fails(cp, tmp_path):
    empty = tmp_path / "corpus"
    empty.mkdir()
    (empty / "readme.pdf").write_bytes(b"not text")  # non-scannable extension
    d = _start(
        cp,
        {
            "content": str(tmp_path / "c.md"),
            "sources": str(empty),
            "gather_workdir": str(tmp_path / "wd"),
        },
    )
    assert d["action"] == "error"
    assert "zero scannable files" in d["errors"][0]


def test_nonexistent_sources_takes_reviewing_fast_path(cp, tmp_path):
    # Neither a directory nor a manifest file -> unchanged fast path to reviewing
    # (annie escalates on the missing input, preserving the old contract).
    d = _start(cp, {"content": str(tmp_path / "c.md"), "sources": "/nonexistent/path"})
    assert d["action"] == "invoke_agent" and d["state_id"] == "reviewing"


# ---------------------------------------------------------------------------
# URL-only unresolved entries (never fetched).
# ---------------------------------------------------------------------------


def test_url_only_manifest_entry_recorded_unresolved(cp, tmp_path):
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    (corpus / "local.md").write_text("# Local\n\nbody\n", encoding="utf-8")
    # A manifest.json at the corpus root declares a URL-only source (no local path).
    (corpus / "manifest.json").write_text(
        json.dumps([{"id": "remote", "url": "https://example.com/paper.pdf"}]),
        encoding="utf-8",
    )
    d = _start(
        cp,
        {
            "content": str(tmp_path / "c.md"),
            "sources": str(corpus),
            "gather_workdir": str(tmp_path / "wd"),
        },
    )
    # Only the LOCAL file gets an echo branch — the URL-only entry is never fetched.
    assert {t["branch_id"] for t in d["tasks"]}  # at least the local file
    assert all("example.com" not in t["task_summary"] for t in d["tasks"])
    d = _run_gather(cp, d)
    entries = json.loads(
        Path(cp.load(RID).context.extras["derivation"]["gather"]["manifest_path"]).read_text()
    )
    remote = next(e for e in entries if e["id"] == "remote")
    assert remote["unresolved"] is True
    assert remote["license"] == "unknown"  # never read => cannot ground a license
    assert next(e for e in entries if e["id"] == "local.md")["unresolved"] is False


# ---------------------------------------------------------------------------
# Guardrail: the reviewing task text never contains raw source prose.
# ---------------------------------------------------------------------------


def test_reviewing_task_never_contains_raw_source_text(cp, tmp_path):
    secret = "Zorptmelon quibbles fantastically over the aubergine parliament."
    d = _start(cp, _corpus(tmp_path, {"a.md": f"# A\n\n{secret}\n"}))
    # The fan-out task text is a pointer (path only) — never the body prose.
    for t in d["tasks"]:
        assert secret not in t["task_summary"]
    # Drive gather with outlines that are headings only (no body prose).
    d = _run_gather(
        cp,
        d,
        lambda bid: _gather_summary(
            license_evidence="LICENSE MIT", outline=[{"level": 1, "title": "A", "line": 1}]
        ),
    )
    assert d["action"] == "invoke_agent" and d["agent"] == "annie"
    # The rendered reviewing task carries the manifest PATH + heading pointers only.
    assert secret not in d["task_summary"]
    # And the manifest on disk holds no raw body prose either.
    manifest_text = Path(
        cp.load(RID).context.extras["derivation"]["gather"]["manifest_path"]
    ).read_text()
    assert secret not in manifest_text


def test_symlink_escaping_corpus_is_not_inventoried(cp, tmp_path):
    outside = tmp_path / "outside.md"
    outside.write_text("# Outside\n\nescaped\n", encoding="utf-8")
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    (corpus / "inside.md").write_text("# Inside\n", encoding="utf-8")
    try:
        (corpus / "escape.md").symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks not supported on this platform")
    d = _start(
        cp,
        {
            "content": str(tmp_path / "c.md"),
            "sources": str(corpus),
            "gather_workdir": str(tmp_path / "wd"),
        },
    )
    hints = " ".join(t["task_summary"] for t in d["tasks"])
    assert "inside.md" in hints
    assert str(outside) not in hints  # the symlink escaping the corpus is skipped


# ---------------------------------------------------------------------------
# Provenance drawer: content builder + non-fatal failure surfaced as a warning.
# ---------------------------------------------------------------------------


def test_provenance_content_lists_every_source_call():
    entries = [
        {
            "id": "a.md",
            "license": "MIT",
            "license_confidence": "CERTAIN",
            "license_evidence": "SPDX MIT",
            "bucket": "docs",
            "bucket_confidence": "PROBABLE",
            "bucket_evidence": "arXiv",
            "unresolved": False,
        },
        {
            "id": "remote",
            "license": "unknown",
            "license_confidence": "UNCERTAIN",
            "license_evidence": "",
            "bucket": "",
            "bucket_confidence": "UNCERTAIN",
            "bucket_evidence": "",
            "unresolved": True,
        },
    ]
    content = build_provenance_content(SID, entries)
    assert f"{SID} Gather Provenance" in content
    assert "a.md" in content and "MIT (CERTAIN)" in content and "SPDX MIT" in content
    assert "remote" in content and "unresolved: true" in content


def test_provenance_drawer_failure_is_non_fatal_warning(cp, tmp_path, monkeypatch):
    # Force the drawer write to "fail" — the run must still complete and record a
    # warning, never silently and never fatally.
    monkeypatch.setattr(deriv, "_write_provenance_drawer", lambda ctx, entries: False)
    d = _start(cp, _corpus(tmp_path, {"a.md": "# A\n\nbody\n"}))
    d = _run_gather(cp, d)
    assert d["action"] == "invoke_agent" and d["agent"] == "annie"
    warnings = cp.load(RID).context.extras["derivation"]["gather"]["warnings"]
    assert any("provenance drawer" in w for w in warnings)
    # The run still reaches a verdict (gather failure did not block reviewing).
    res = _step(cp, "annie", CLEAN)["result"]
    assert res["verdict"] == "INDEPENDENT"


# ---------------------------------------------------------------------------
# outline.py — the deterministic structural-outline extractor (its own unit tests).
# ---------------------------------------------------------------------------


def _outline_mod():
    sd = Path(__file__).resolve().parents[3] / ".pi" / "skills" / "derivation" / "scripts"
    sys.path.insert(0, str(sd))
    import outline  # type: ignore

    return outline


def test_outline_extracts_atx_headings():
    o = _outline_mod()
    sections = o.extract_outline("# Title\n\nbody\n\n## Sub\n\nmore\n### Deep\n")
    assert [(s["level"], s["title"]) for s in sections] == [(1, "Title"), (2, "Sub"), (3, "Deep")]


def test_outline_extracts_setext_and_rst_underlines():
    o = _outline_mod()
    sections = o.extract_outline("Big Title\n=========\n\nSub\n---\n")
    assert [(s["level"], s["title"]) for s in sections] == [(1, "Big Title"), (2, "Sub")]


def test_outline_titles_are_body_free():
    o = _outline_mod()
    text = "# Heading\n\nThis is protected body prose that must not appear.\n"
    titles = o.section_titles(o.extract_outline(text))
    assert titles == ["Heading"]
    assert "protected body prose" not in " ".join(titles)


def test_outline_cli_emits_json(tmp_path):
    o = _outline_mod()
    f = tmp_path / "doc.md"
    f.write_text("# One\n\nbody\n## Two\n", encoding="utf-8")
    script = Path(o.__file__)
    out = subprocess.run(
        [sys.executable, str(script), "--path", str(f)],
        capture_output=True,
        text=True,
        check=True,
    )
    report = json.loads(out.stdout)
    assert report["status"] == "ok"
    assert report["section_count"] == 2
    assert [s["title"] for s in report["sections"]] == ["One", "Two"]
