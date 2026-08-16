#!/usr/bin/env python3
"""Manifest-bound public-repository boundary scan.

The selected versioned manifest is the single source of truth for scoped tracked
paths, operator/downstream leak patterns and fixtures, evidence-authorized generic
cases, writable paths, and the out-of-scope report-only boundary. In-scope matches
fail unless the exact manifest authorizes a generic source case. Out-of-scope
matches are always reported and never mutated.
"""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from fnmatch import fnmatch
from pathlib import Path
from typing import Any, Mapping

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MANIFEST = Path(__file__).with_name("public_boundary_manifest.json")


@dataclass(frozen=True)
class LeakMatch:
    path: str
    line: int
    pattern_id: str
    reason: str
    in_scope: bool
    resolved_generic: bool
    source_evidence: str
    excerpt: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "line": self.line,
            "pattern_id": self.pattern_id,
            "reason": self.reason,
            "in_scope": self.in_scope,
            "resolved_generic": self.resolved_generic,
            "source_evidence": self.source_evidence,
            "excerpt": self.excerpt,
        }


def load_manifest(path: str | Path = DEFAULT_MANIFEST) -> dict[str, Any]:
    decoded = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(decoded, dict):
        raise ValueError("scope/leak manifest must be a JSON object")
    manifest: dict[str, Any] = decoded
    # Import lazily so this standalone script remains usable before workspace install.
    try:
        from orchestration.scope_preservation import validate_scope_manifest
    except ImportError:
        source = ROOT / "apps" / "orchestration" / "src"
        sys.path.insert(0, str(source))
        from orchestration.scope_preservation import validate_scope_manifest
    errors = validate_scope_manifest(manifest)
    if errors:
        raise ValueError("invalid scope/leak manifest: " + "; ".join(errors))
    return manifest


def _git_paths(root: Path, *arguments: str) -> list[str]:
    process = subprocess.run(
        ["git", "ls-files", "-z", *arguments],
        cwd=root,
        capture_output=True,
        check=True,
        shell=False,
    )
    return sorted(
        item.decode("utf-8", "surrogateescape") for item in process.stdout.split(b"\0") if item
    )


def _tracked_paths(root: Path) -> list[str]:
    return _git_paths(root)


def _untracked_non_ignored_paths(root: Path) -> list[str]:
    return _git_paths(root, "--others", "--exclude-standard")


def _tracked_and_selected_paths(
    root: Path, selected_patterns: list[str], ignored_patterns: list[str]
) -> list[str]:
    """Include every non-ignored untracked file selected by the manifest.

    ``Path.glob("**")`` can yield directories without recursively yielding their
    files, which let a repository-wide scope miss nested new files. Git's own
    untracked/non-ignored inventory is both complete and aligned with the public
    repository boundary.
    """

    paths = set(_tracked_paths(root))
    for relative in _untracked_non_ignored_paths(root):
        if _matches_any(relative, selected_patterns) and not _matches_any(
            relative, ignored_patterns
        ):
            paths.add(relative)
    return sorted(paths)


def _matches_any(path: str, patterns: list[str]) -> bool:
    return any(fnmatch(path, pattern) for pattern in patterns)


def _generic_authorization(
    manifest: Mapping[str, Any], path: str, pattern_id: str
) -> tuple[bool, str]:
    for allowed in manifest.get("allowed_generic_cases", []):
        if not isinstance(allowed, dict):
            continue
        allowed_path = str(allowed.get("path", ""))
        allowed_pattern = str(allowed.get("pattern_id", ""))
        evidence = str(allowed.get("source_evidence", "")).strip()
        if evidence and fnmatch(path, allowed_path) and allowed_pattern in {"*", pattern_id}:
            return True, evidence
    return False, ""


def validate_fixtures(manifest: Mapping[str, Any]) -> list[str]:
    """Execute the selected manifest's synthetic leak-pattern fixtures."""
    needles = {
        str(pattern["id"]): "".join(str(part) for part in pattern["pattern_parts"])
        for pattern in manifest.get("leak_patterns", [])
        if isinstance(pattern, dict)
        and isinstance(pattern.get("id"), str)
        and isinstance(pattern.get("pattern_parts"), list)
    }
    errors: list[str] = []
    for fixture in manifest.get("leak_fixtures", []):
        if not isinstance(fixture, dict):
            continue
        fixture_id = str(fixture.get("id", "<unknown>"))
        pattern_id = fixture.get("pattern_id")
        text = fixture.get("text")
        text_parts = fixture.get("text_parts")
        if (
            not isinstance(text, str)
            and isinstance(text_parts, list)
            and all(isinstance(part, str) for part in text_parts)
        ):
            text = "".join(text_parts)
        if not isinstance(text, str) and isinstance(pattern_id, str):
            text = needles.get(pattern_id, "")
        matched = {
            candidate_id
            for candidate_id, needle in needles.items()
            if needle and isinstance(text, str) and needle in text
        }
        if fixture.get("expected") == "allowed-generic" and matched:
            errors.append(
                f"leak fixture {fixture_id!r} falsely classifies generic text as {sorted(matched)}"
            )
        elif fixture.get("expected") == "unresolved-unless-authorized":
            if not isinstance(pattern_id, str) or pattern_id not in matched:
                errors.append(f"leak fixture {fixture_id!r} does not trigger its selected pattern")
    return errors


def scan_manifest(root: str | Path, manifest: Mapping[str, Any]) -> list[LeakMatch]:
    """Read tracked plus selected untracked files and return all match records."""
    project = Path(root).resolve()
    in_scope_patterns = [str(item) for item in manifest["in_scope_tracked_paths"]]
    ignored_patterns = [str(item) for item in manifest["ignored_runtime_outputs"]]
    matches: list[LeakMatch] = []
    for relative in _tracked_and_selected_paths(project, in_scope_patterns, ignored_patterns):
        if _matches_any(relative, ignored_patterns):
            continue
        path = project / relative
        if not path.is_file():
            continue
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            continue
        in_scope = _matches_any(relative, in_scope_patterns)
        for pattern in manifest["leak_patterns"]:
            pattern_id = str(pattern["id"])
            needle = "".join(str(part) for part in pattern["pattern_parts"])
            reason = str(pattern["reason"])
            if not needle:
                continue
            authorized, evidence = _generic_authorization(manifest, relative, pattern_id)
            for line_number, line in enumerate(lines, start=1):
                if needle not in line:
                    continue
                matches.append(
                    LeakMatch(
                        path=relative,
                        line=line_number,
                        pattern_id=pattern_id,
                        reason=reason,
                        in_scope=in_scope,
                        resolved_generic=authorized,
                        source_evidence=evidence,
                        excerpt=line[:240],
                    )
                )
    return matches


def main() -> int:
    try:
        manifest = load_manifest()
        fixture_errors = validate_fixtures(manifest)
        matches = scan_manifest(ROOT, manifest)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print(f"ERROR: public-boundary scan unavailable: {exc}")
        return 1

    unresolved = [match for match in matches if match.in_scope and not match.resolved_generic]
    for error in fixture_errors:
        print(f"ERROR: {error}")
    out_of_scope = [match for match in matches if not match.in_scope]
    generic = [match for match in matches if match.in_scope and match.resolved_generic]

    print(
        f"public-boundary manifest={manifest['manifest_id']} v{manifest['version']} "
        f"in_scope_unresolved={len(unresolved)} generic={len(generic)} "
        f"out_of_scope_reported={len(out_of_scope)}"
    )
    for match in unresolved:
        print(
            f"UNRESOLVED in-scope {match.path}:{match.line} [{match.pattern_id}] "
            f"{match.reason}: {match.excerpt}"
        )
    for match in generic:
        print(
            f"AUTHORIZED-GENERIC {match.path}:{match.line} [{match.pattern_id}] "
            f"evidence={match.source_evidence}"
        )
    for match in out_of_scope:
        print(
            f"REPORT-ONLY out-of-scope {match.path}:{match.line} [{match.pattern_id}] "
            f"{match.reason}"
        )

    if fixture_errors or unresolved:
        print("FAIL: selected leak fixtures or in-scope public-boundary scan are unresolved")
        return 1
    print("PASS: selected in-scope corpus has zero unresolved public-boundary matches")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
