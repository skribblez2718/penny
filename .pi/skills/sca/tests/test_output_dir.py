"""
Regression tests for output-dir safety (F5).

The OLD guard walked UP the directory tree looking for ``.pi`` / ``.git`` /
``AGENTS.md`` markers with no stop boundary, so ANY ``output_dir`` under ``$HOME``
(which contains ``~/.pi``) was declared "inside the project tree" and silently
redirected to ``/tmp`` — discarding the caller's requested delivery location.

These tests pin the corrected, ``PROJECT_ROOT``-bounded behavior:

  * a requested output_dir OUTSIDE PROJECT_ROOT is HONORED verbatim, even when
    it lives under a directory that itself contains a ``.pi`` marker (the exact
    thing that used to trigger the false redirect);
  * a requested output_dir genuinely INSIDE PROJECT_ROOT is redirected AND the
    redirect is disclosed (``redirected=True``, non-empty ``reason``) — never
    silent;
  * with ``PROJECT_ROOT`` unset, resolution falls back sanely and still honors
    an obviously-outside path.

No dependency on the real ``$HOME``: ``PROJECT_ROOT`` is injected via arg /
monkeypatch and every path is built under ``tmp_path``.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import sca_domain  # noqa: E402


def test_output_dir_outside_project_root_is_honored(tmp_path):
    # A home-like tree that CONTAINS a `.pi` marker — the precise condition that
    # used to trigger the false "inside project" redirect — but is OUTSIDE the
    # Penny project root.
    home = tmp_path / "home" / "user"
    (home / ".pi").mkdir(parents=True)
    requested = home / "pentests" / "acme" / "acme-sca"
    project_root = tmp_path / "projects" / "penny"
    (project_root / ".pi").mkdir(parents=True)

    res = sca_domain.resolve_output_dir(
        str(requested), str(tmp_path / "repo"), project_root=str(project_root)
    )

    assert res.redirected is False
    assert res.reason == ""
    assert res.path == os.path.abspath(str(requested))


def test_output_dir_inside_project_root_is_redirected_and_disclosed(tmp_path):
    project_root = tmp_path / "projects" / "penny"
    (project_root / ".pi").mkdir(parents=True)
    requested = project_root / "sca-out"  # genuinely inside Penny's own tree
    target = tmp_path / "some" / "repo"

    res = sca_domain.resolve_output_dir(
        str(requested), str(target), project_root=str(project_root)
    )

    assert res.redirected is True
    assert res.reason  # non-empty, operator-visible disclosure
    # Redirected to the deterministic /tmp default, NOT the requested path.
    assert res.path == sca_domain.default_output_dir(str(target))
    assert res.path != os.path.abspath(str(requested))


def test_env_project_root_bounds_the_guard(tmp_path, monkeypatch):
    project_root = tmp_path / "penny"
    (project_root / ".pi").mkdir(parents=True)
    monkeypatch.setenv("PROJECT_ROOT", str(project_root))

    inside = project_root / "out"
    outside = tmp_path / "elsewhere" / "out"

    r_in = sca_domain.resolve_output_dir(str(inside), str(tmp_path / "repo"))
    r_out = sca_domain.resolve_output_dir(str(outside), str(tmp_path / "repo"))

    assert r_in.redirected is True
    assert r_out.redirected is False
    assert r_out.path == os.path.abspath(str(outside))


def test_project_root_unset_falls_back_and_honors_outside_path(tmp_path, monkeypatch):
    monkeypatch.delenv("PROJECT_ROOT", raising=False)

    # Fallback resolves to the real Penny repo root (this file lives at
    # …/<root>/.pi/skills/sca/tests/). An obviously-outside path must be honored.
    outside = tmp_path / "totally" / "outside"
    res = sca_domain.resolve_output_dir(str(outside), str(tmp_path / "repo"))
    assert res.redirected is False
    assert res.path == os.path.abspath(str(outside))

    # And a path built INSIDE the resolved fallback root IS redirected.
    root = sca_domain._resolve_project_root()
    assert root, "the skill must live inside a repo that has .pi"
    inside = Path(root) / "sca-out-probe-xyz"
    res_in = sca_domain.resolve_output_dir(str(inside), str(tmp_path / "repo"))
    assert res_in.redirected is True


def test_safe_output_dir_wrapper_is_backward_compatible(tmp_path, monkeypatch):
    project_root = tmp_path / "penny"
    (project_root / ".pi").mkdir(parents=True)
    monkeypatch.setenv("PROJECT_ROOT", str(project_root))

    outside = tmp_path / "outside" / "out"
    # The legacy wrapper returns just the path (a str); outside path honored.
    got = sca_domain.safe_output_dir(str(outside), str(tmp_path / "repo"))
    assert got == os.path.abspath(str(outside))
