"""Apply approved amendments to Domain Guidance files.

Handles file modification, git commit, and safety validation.
Only operates on Domain Guidance and Config targets — never SYSTEM.md.
"""

import subprocess
import os
from typing import Dict, Any


def _is_domain_guidance(target_file: str) -> bool:
    """True only for Domain Guidance prompts (.pi/skills/*/assets/prompts/*).

    The one place amendments are allowed to write. Everything else — SYSTEM.md,
    AGENTS.md, .pi/agents/* personas — is the human-authored identity tier.
    """
    if not target_file:
        return False
    norm = os.path.normpath(target_file).replace(os.sep, "/")
    return ".pi/skills/" in ("/" + norm) and "/assets/prompts/" in norm


def _repo_root(target_file: str) -> str:
    """Repo root for git operations — walk up from the target until .git.

    Git must run from the repo root with an absolute pathspec: the old code
    used the prompts directory as cwd with a repo-relative pathspec, which
    made ``git add .pi/skills/...`` fail ("pathspec did not match") AFTER the
    file had already been modified — a dirty tree and no commit.
    """
    path = os.path.dirname(os.path.abspath(target_file))
    while path != os.path.dirname(path):
        if os.path.isdir(os.path.join(path, ".git")):
            return path
        path = os.path.dirname(path)
    return os.path.abspath(".")


def _build_commit_message(amendment: Dict[str, Any]) -> str:
    """Build descriptive git commit message from amendment."""
    lines = [
        f"self-improve({amendment['amendment_id']}): Update {amendment['target_file'].split('/')[-1]}",
        "",
    ]
    for i, change in enumerate(amendment.get("changes", []), 1):
        rationale = change.get("rationale", "")
        if len(rationale) > 200:
            rationale = rationale[:197] + "..."
        lines.append(f"Change {i}: {change['action']} — {rationale}")
    lines.append("")
    lines.append("Evidence:")
    for ev in amendment.get("evidence", [])[:5]:
        lines.append(f"- {ev}")
    msg = "\n".join(lines)
    return msg[:500] if len(msg) > 500 else msg


def _write_file_change(target_file: str, change: Dict[str, str]) -> bool:
    """Apply a single change to a file.

    ADD    → append new_text to end of file
    MODIFY → replace old_text with new_text
    REMOVE → delete old_text (new_text must be empty or"")
    """
    if not os.path.exists(target_file):
        return False

    with open(target_file, "r", encoding="utf-8") as f:
        content = f.read()

    action = change.get("action", "ADD")
    old_text = change.get("old_text", "")
    new_text = change.get("new_text", "")

    if action == "ADD":
        if new_text not in content:
            content += new_text
            with open(target_file, "w", encoding="utf-8") as f:
                f.write(content)
            return True
        return True  # already present — idempotent

    if action == "MODIFY":
        # Idempotent: if the replacement text is already in the file, this
        # change landed on a previous run (e.g. apply succeeded but the drawer
        # status-flip failed and the operator re-ran). Without this check a
        # re-run whose old_text still matches elsewhere would splice new_text
        # into an unrelated section, and one whose old_text is gone would
        # wedge the amendment at APPROVED forever.
        if new_text and new_text in content:
            return True
        if old_text in content:
            content = content.replace(old_text, new_text, 1)
            with open(target_file, "w", encoding="utf-8") as f:
                f.write(content)
            return True
        return False

    if action == "REMOVE":
        if old_text in content:
            content = content.replace(old_text, "", 1)
            with open(target_file, "w", encoding="utf-8") as f:
                f.write(content)
            return True
        return False

    return False


def apply_amendment(  # noqa: C901 (linear validate-then-apply guard chain)
    amendment: Dict[str, Any], git_commit: bool = True
) -> Dict[str, Any]:
    """Apply an approved amendment to its target file.

    Returns {"success": bool, "error": str or None, "committed": bool}.
    """
    # Validation
    if amendment.get("status") != "APPROVED":
        return {
            "success": False,
            "error": f"Amendment {amendment.get('amendment_id')} not approved (status: {amendment.get('status')})",
            "committed": False,
        }

    if amendment.get("target_layer") == "REJECTED_UNIVERSAL":
        return {
            "success": False,
            "error": "Cannot apply amendment to REJECTED_UNIVERSAL target. SYSTEM.md changes must be authored by humans.",
            "committed": False,
        }

    target_file = amendment.get("target_file", "")

    # Mechanically enforce the identity/procedural boundary: amendments may only
    # edit Domain Guidance prompts (.pi/skills/*/assets/prompts/*). SYSTEM.md,
    # AGENTS.md and agent personas are the identity tier — human-authored only.
    if not _is_domain_guidance(target_file):
        return {
            "success": False,
            "error": (
                f"Refused: {target_file} is outside Domain Guidance "
                "(.pi/skills/*/assets/prompts/). Identity-tier files are human-only."
            ),
            "committed": False,
        }

    if not os.path.exists(target_file):
        return {
            "success": False,
            "error": f"Target file not found: {target_file}",
            "committed": False,
        }

    # Apply changes
    applied = 0
    failed = 0
    for change in amendment.get("changes", []):
        if _write_file_change(target_file, change):
            applied += 1
        else:
            failed += 1

    if failed > 0:
        return {
            "success": False,
            "error": f"{failed} of {applied + failed} changes failed to apply",
            "committed": False,
        }

    # Git commit
    committed = False
    if git_commit:
        try:
            msg = _build_commit_message(amendment)
            root = _repo_root(target_file)
            pathspec = os.path.abspath(target_file)
            subprocess.run(
                ["git", "add", pathspec],
                check=True,
                capture_output=True,
                text=True,
                cwd=root,
            )
            staged = subprocess.run(
                ["git", "diff", "--cached", "--quiet", "--", pathspec],
                capture_output=True,
                cwd=root,
            )
            if staged.returncode == 0:
                # Nothing staged — the change was already committed on a prior
                # run; committing would error and wedge the re-run.
                committed = False
            else:
                subprocess.run(
                    ["git", "commit", "-m", msg],
                    check=True,
                    capture_output=True,
                    text=True,
                    cwd=root,
                )
                committed = True
        except subprocess.CalledProcessError as e:
            return {
                "success": False,
                "error": f"Git commit failed: {e.stderr or e.stdout}",
                "committed": False,
            }

    return {
        "success": True,
        "error": None,
        "committed": committed,
    }
