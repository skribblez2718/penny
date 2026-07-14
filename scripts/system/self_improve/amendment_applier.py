"""Apply approved amendments to their target file + git commit.

An amendment is auto-applied once a human has APPROVED its concrete diff — the
review-and-approve step IS the human-in-the-loop, so applying the exact approved
change to any file (Domain Guidance prompts, config, docs, code, or the rest of
SYSTEM.md) adds no safety, only toil. Guardrails that keep approval meaningful:

  * R1 concrete diffs only — an empty old_text/new_text is refused (nothing
    concrete was approved, nothing verbatim can be applied);
  * R2 verbatim + drift-safe — old_text must still match the file or the change
    fails closed (never a blind splice);
  * R3 immutable security block is human-only — any change that touches a
    `<system_directives>` / `<system_boundary>` region (or the SECURITY
    DIRECTIVES / SECURITY REINFORCEMENT sentinels) is refused even with approval,
    so the self-improvement loop can never edit its own security frame. This
    includes an ADD (append) to any file that carries the frame — appending lands
    after `</system_boundary>`, so an anchored MODIFY is required instead;
  * R4 the trajectory ratchet still gates apply; every apply is git-committed;
  * R5 post-apply INVARIANT + rollback (#22) — the immutable blocks must be
    BYTE-IDENTICAL after apply. If any change altered the frame in a way the R3
    pre-check missed, OR any change failed partway, the file is rolled back to its
    exact pre-apply content (apply is atomic). Belt-and-suspenders behind R3.
"""

import subprocess
import os
import sys
from pathlib import Path
from typing import Dict, Any, Optional


def _trajectory_ok() -> "tuple[bool, str]":
    """Pre-apply behavioral-regression gate. Fail-open if the guard is
    unavailable (never block an apply because the ratchet isn't set up)."""
    try:
        traj = str(Path(__file__).resolve().parents[1] / "trajectory")
        if traj not in sys.path:
            sys.path.insert(0, traj)
        from guard import check_no_regression  # type: ignore[import-not-found]

        return check_no_regression()
    except Exception:  # noqa: BLE001
        return True, "trajectory guard unavailable (skipped)"


# The immutable security frame. These blocks (and the bare sentinels) stay
# human-only even for an APPROVED amendment — the loop must never be able to
# reword, remove, or edit inside its own security directives.
_SECURITY_SENTINELS = (
    "<system_directives>",
    "</system_directives>",
    "<system_boundary>",
    "</system_boundary>",
    "SECURITY DIRECTIVES (IMMUTABLE",
    "SECURITY REINFORCEMENT",
)

_PROTECTED_TAG_PAIRS = (
    ("<system_directives>", "</system_directives>"),
    ("<system_boundary>", "</system_boundary>"),
)


def _protected_spans(content: str) -> "list[tuple[int, int]]":
    """Character spans of the immutable security blocks in ``content`` (open tag
    through close tag, inclusive). An unclosed open tag protects to end-of-file
    so a truncated block cannot be edited through the gap."""
    spans: list[tuple[int, int]] = []
    for open_tag, close_tag in _PROTECTED_TAG_PAIRS:
        start = 0
        while True:
            i = content.find(open_tag, start)
            if i == -1:
                break
            j = content.find(close_tag, i + len(open_tag))
            end = (j + len(close_tag)) if j != -1 else len(content)
            spans.append((i, end))
            start = end
    return spans


def _protected_text(content: str) -> str:
    """(#22) The concatenated text of every immutable security-block region — the
    invariant that must be byte-identical before and after any apply. Position-
    independent: edits ELSEWHERE (which shift offsets) leave this string unchanged;
    any edit to a block's content, or a newly injected block, changes it."""
    return "\x00".join(content[s:e] for s, e in _protected_spans(content))


def _rollback(target_file: str, original: str) -> None:
    """Restore the target to its exact pre-apply content (best-effort)."""
    try:
        Path(target_file).write_text(original, encoding="utf-8")
    except OSError:
        pass


def _touches_security_block(content: str, change: Dict[str, str]) -> bool:
    """True if a change would add, remove, reword, or edit INSIDE the immutable
    security-directives block — refused even for an APPROVED amendment."""
    old_text = change.get("old_text", "") or ""
    new_text = change.get("new_text", "") or ""
    # 0) An ADD appends to EOF; on a file that carries the immutable frame that
    #    would place content after </system_boundary>. Require an anchored MODIFY.
    if (change.get("action") or "ADD").upper() == "ADD" and _protected_spans(content):
        return True
    # 1) The payload must not introduce / remove / reword a security sentinel.
    for sentinel in _SECURITY_SENTINELS:
        if sentinel in old_text or sentinel in new_text:
            return True
    # 2) A MODIFY/REMOVE whose matched region sits inside a protected span.
    if old_text:
        spans = _protected_spans(content)
        idx = content.find(old_text)
        while idx != -1:
            end = idx + len(old_text)
            if any(idx < s_end and end > s_start for s_start, s_end in spans):
                return True
            idx = content.find(old_text, idx + 1)
    return False


def _concrete_diff_error(change: Dict[str, str]) -> Optional[str]:
    """None if the change carries a concrete, appliable diff; else the reason it
    does not. An empty diff means nothing concrete was approved."""
    action = (change.get("action") or "ADD").upper()
    old_text = change.get("old_text", "") or ""
    new_text = change.get("new_text", "") or ""
    if action == "ADD":
        if not new_text:
            return "ADD change has empty new_text — nothing to add"
    elif action == "MODIFY":
        if not old_text:
            return "MODIFY change has empty old_text — no anchor to replace"
        if not new_text:
            return "MODIFY change has empty new_text — no replacement text"
    elif action == "REMOVE":
        if not old_text:
            return "REMOVE change has empty old_text — no text to remove"
    else:
        return f"unknown action {action!r}"
    return None


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

    target_file = amendment.get("target_file", "")
    if not target_file:
        return {"success": False, "error": "amendment has no target_file", "committed": False}
    if not os.path.exists(target_file):
        return {
            "success": False,
            "error": f"Target file not found: {target_file}",
            "committed": False,
        }

    changes = amendment.get("changes", [])
    if not changes:
        return {"success": False, "error": "amendment has no changes to apply", "committed": False}

    # R1 — concrete diffs only. Approval authorizes applying the EXACT approved
    # text; an empty old_text/new_text means nothing concrete was approved and
    # nothing verbatim can be applied (this is what wedged the legacy
    # CODE_CHANGE amendments at APPROVED forever).
    for change in changes:
        err = _concrete_diff_error(change)
        if err:
            return {
                "success": False,
                "error": f"Refused: {err} — approval requires a concrete diff",
                "committed": False,
            }

    # R3 — the immutable security-directives block is human-only, even for an
    # APPROVED amendment. Approval lets Penny edit any file (Domain Guidance,
    # config, docs, code, or the rest of SYSTEM.md), but she must never be able
    # to edit her own security frame.
    try:
        current = Path(target_file).read_text(encoding="utf-8")
    except OSError as exc:
        return {"success": False, "error": f"could not read target: {exc}", "committed": False}
    for change in changes:
        if _touches_security_block(current, change):
            return {
                "success": False,
                "error": (
                    "Refused: change touches the immutable security-directives block "
                    "(<system_directives>/<system_boundary>) — human-only, even with approval"
                ),
                "committed": False,
            }
    # #22: snapshot the pre-apply content (for atomic rollback) and the immutable
    # frame (for the R5 post-apply invariant).
    original = current
    before_protected = _protected_text(current)

    # R4 — behavioral-regression gate: don't layer a new change on top of an
    # unacknowledged drift below Oracle-era quality (see scripts/system/trajectory/).
    traj_ok, traj_msg = _trajectory_ok()
    if not traj_ok:
        return {"success": False, "error": f"Refused: {traj_msg}", "committed": False}

    # Apply changes — verbatim; _write_file_change fails closed when old_text no
    # longer matches (the file drifted since the diff was approved).
    applied = 0
    failed = 0
    for change in changes:
        if _write_file_change(target_file, change):
            applied += 1
        else:
            failed += 1

    if failed > 0:
        _rollback(target_file, original)  # atomic — undo any partial writes
        return {
            "success": False,
            "error": (
                f"{failed} of {applied + failed} changes failed to apply "
                "(old_text no longer matches the file?) — rolled back"
            ),
            "committed": False,
        }

    # R5 (#22) — post-apply INVARIANT: the immutable security blocks must be
    # byte-identical after apply. If a change altered the frame in a way the R3
    # pre-check missed, roll back to the exact pre-apply content and refuse.
    try:
        after = Path(target_file).read_text(encoding="utf-8")
    except OSError as exc:
        _rollback(target_file, original)
        return {"success": False, "error": f"could not re-read target: {exc}", "committed": False}
    if _protected_text(after) != before_protected:
        _rollback(target_file, original)
        return {
            "success": False,
            "error": (
                "Refused: applying this amendment would alter the immutable "
                "security-directives block — rolled back (human-only)"
            ),
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
