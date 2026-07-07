"""Persistent learned-rule writer — the self-improving-SAST flywheel.

The REFLECT phase (carren) proposes new semgrep rules for genuine detection gaps
this run exposed (a vuln annie/vera confirmed that the deterministic scanner
missed). This module validates each proposed rule and persists it to semgrep's
own rules home so that EVERY FUTURE jsa run loads it and catches that pattern
deterministically — the scanner gets permanently more robust each run.

Storage route (one centralized location per tool):
    .pi/extensions/semgrep/rules/learned/jsa/<rule>.yaml
- Under semgrep's single rules tree (the tool's own home), in a dedicated
  ``learned/`` category (distinct from vendored ``vendor/`` and hand-authored
  ``custom/``), namespaced per skill (``jsa/``).
- ``scanners._run_semgrep`` passes the whole ``rules/`` tree as ``--config``, so
  these are auto-loaded by future runs (verified by test).

Safety gates (a bad rule must NEVER break a future scan):
    1. entry is a dict with a non-blank ``filename`` and ``yaml_content``
    2. filename extension is .yml/.yaml
    3. yaml parses and declares a ``rules:`` list (a real semgrep rule)
    4. path-traversal containment within the learned dir
    5. ``semgrep --validate`` passes (checked in a temp file BEFORE it is
       persisted into the rules tree)
Every per-rule failure is recorded and skipped; the function never raises.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any

try:
    import yaml as _yaml
except Exception:  # noqa: BLE001 — pyyaml optional; degrade to a parse-skip
    _yaml = None

_RULE_EXTENSIONS = (".yml", ".yaml")
# Bound how many rules one reflect pass can add, so a runaway agent can't flood
# the shared rules tree. Overflow is reported, never silently dropped.
MAX_LEARNED_RULES_PER_RUN = 20
VALIDATE_TIMEOUT = 60


def learned_rules_dir() -> Path | None:
    """Resolve ``.pi/extensions/semgrep/rules/learned/jsa`` by walking up from
    this file (mirrors ``scanners._rules_base``). Returns None if the semgrep
    extension's rules tree can't be found."""
    here = Path(__file__).resolve().parent
    for anc in [here, *here.parents][:6]:
        base = anc / ".pi" / "extensions" / "semgrep" / "rules"
        if base.is_dir():
            return base / "learned" / "jsa"
    return None


def _yaml_is_semgrep_rule(content: Any) -> bool:
    """True if ``content`` parses as YAML declaring a non-empty ``rules:`` list."""
    if not isinstance(content, str) or not content.strip():
        return False
    if _yaml is None:  # environment without pyyaml — defer to semgrep --validate
        return True
    try:
        doc = _yaml.safe_load(content)
    except Exception:  # noqa: BLE001
        return False
    return isinstance(doc, dict) and isinstance(doc.get("rules"), list) and bool(doc["rules"])


def _semgrep_validate(yaml_content: str) -> bool:
    """Run ``semgrep --validate`` on the rule in a TEMP file (never in the rules
    tree). Returns True only on rc 0. Absent semgrep -> accept (parse gate already
    ran); a validation crash -> reject (fail closed)."""
    from scanners import _semgrep_bin

    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as tf:
        tf.write(yaml_content)
        tmp = tf.name
    try:
        res = subprocess.run(
            [_semgrep_bin(), "--validate", "--config", tmp, "--metrics=off"],
            capture_output=True, text=True, timeout=VALIDATE_TIMEOUT,
        )
        return res.returncode == 0
    except FileNotFoundError:
        return True  # semgrep not installed; the parse gate is our best effort
    except Exception:  # noqa: BLE001
        return False
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _safe_name(filename: str) -> str:
    """Sanitize to a bare, safe basename ending in .yaml."""
    name = os.path.basename(filename.strip())
    name = "".join(c for c in name if c.isalnum() or c in "._-")
    if not name:
        name = "rule.yaml"
    if not name.endswith(_RULE_EXTENSIONS):
        name += ".yaml"
    return name


def write_learned_rules(new_rules: Any, dest_dir: str | os.PathLike | None = None) -> dict:
    """Validate and persist carren's proposed rules. ``new_rules`` is a list of
    ``{"filename": str, "yaml_content": str, ...}``. Returns
    ``{"written": [paths], "rejected": [{filename, reason}], "dir": str}``.
    Never raises.
    """
    result: dict = {"written": [], "rejected": [], "dir": ""}
    if not isinstance(new_rules, list):
        return result

    base = Path(dest_dir) if dest_dir is not None else learned_rules_dir()
    if base is None:
        result["rejected"].append({"filename": "*", "reason": "learned-rules dir unresolved"})
        return result
    result["dir"] = str(base)
    # Resolve the containment root WITHOUT creating it — created lazily only when
    # a rule passes every gate, so an all-rejected run leaves no empty config dir.
    base_resolved = base.resolve()
    entries = [e for e in new_rules if isinstance(e, dict)]
    if len(entries) > MAX_LEARNED_RULES_PER_RUN:
        for e in entries[MAX_LEARNED_RULES_PER_RUN:]:
            result["rejected"].append(
                {"filename": e.get("filename", "?"),
                 "reason": f"exceeds per-run cap of {MAX_LEARNED_RULES_PER_RUN}"}
            )
        entries = entries[:MAX_LEARNED_RULES_PER_RUN]

    for entry in entries:
        filename = entry.get("filename")
        content = entry.get("yaml_content")
        if not isinstance(filename, str) or not filename.strip():
            result["rejected"].append({"filename": str(filename), "reason": "missing/blank filename"})
            continue
        ext = os.path.splitext(filename)[1].lower()
        if ext not in _RULE_EXTENSIONS:
            result["rejected"].append({"filename": filename, "reason": "not a .yml/.yaml rule file"})
            continue
        if not _yaml_is_semgrep_rule(content):
            result["rejected"].append({"filename": filename, "reason": "yaml_content is not a semgrep rule (no rules: list)"})
            continue

        candidate = (base / _safe_name(filename)).resolve()
        try:
            contained = str(candidate).startswith(str(base_resolved) + os.sep)
        except Exception:  # noqa: BLE001
            contained = False
        if not contained:
            result["rejected"].append({"filename": filename, "reason": "path-traversal: escapes learned dir"})
            continue
        if not _semgrep_validate(content):
            result["rejected"].append({"filename": filename, "reason": "semgrep --validate failed"})
            continue
        try:
            base.mkdir(parents=True, exist_ok=True)  # lazy: only when a rule lands
            candidate.write_text(content, encoding="utf-8")
        except OSError as exc:
            result["rejected"].append({"filename": filename, "reason": f"write failed: {exc}"})
            continue
        result["written"].append(str(candidate))

    return result
