"""
sca Skill — Secrets redaction discipline (Phase 5).

Standalone, importable. NOTHING here is wired into orchestrate.py yet. No
network, no subprocess.

Two never-plaintext primitives:

  redact_for_report(text) -> str
      Partial-mask secret-shaped substrings for a HUMAN-FACING report, showing
      only a short prefix/suffix (e.g. 'AKIA****...****MPLE'). Never the full
      value. Recognized shapes (well-known, deliberately simple):
        * AWS access key id     AKIA[0-9A-Z]{16}
        * JWT                    eyJ<b64url>.<b64url>.<b64url>
        * generic high-entropy   32+ char base64/hex-looking token

  hash_for_mempalace(secret_value) -> str
      Return 'sha256:' + hex digest. Used for ANY inter-agent / mempalace
      communication about a detected secret. The actual plaintext is NEVER
      written to mempalace by this phase. Deterministic (same input -> same
      hash) so downstream dedup on hashed secrets is possible.

HEURISTIC LIMITATION (documented, security-reviewed): redaction is pattern
based, so FALSE POSITIVES are possible (a long non-secret base64 config value
may be masked). That is the SAFE failure direction and is accepted. A FALSE
NEGATIVE (a real secret shown in full) is the dangerous direction and is what
the shapes above guard against. redact_for_report on a string with NO secret
returns it UNCHANGED.
"""

from __future__ import annotations

import hashlib
import re


# ── secret-shaped patterns (ordered most-specific first) ─────────────────

# AWS access key id: literal AKIA prefix + 16 uppercase alnum chars (20 total).
_AWS_ACCESS_KEY = re.compile(r"AKIA[0-9A-Z]{16}")

# JWT: three base64url segments separated by dots, starting with the standard
# '{"alg"...' header prefix 'eyJ'.
_JWT = re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")

# Generic high-entropy token: a 32+ char run of base64/hex-looking characters.
_HIGH_ENTROPY = re.compile(r"\b[A-Za-z0-9+/=_-]{32,}\b")

# How many leading/trailing characters of a detected secret to disclose.
_KEEP = 4


def _mask(token: str) -> str:
    """Return a partial mask of ``token`` disclosing only a short prefix/suffix.

    Tokens too short to safely split (<= 2*_KEEP) are fully starred.
    """
    if len(token) <= _KEEP * 2:
        return "*" * len(token)
    return f"{token[:_KEEP]}****...****{token[-_KEEP:]}"


def redact_for_report(text):
    """Partial-mask any secret-shaped substrings in ``text`` for reporting.

    Returns ``text`` unchanged when it contains no secret-shaped substring
    (and passes through non-string inputs like ``None`` untouched). Applies the
    most-specific patterns first (AWS, JWT) before the generic high-entropy
    catch-all, so a value is masked by the tightest matching rule.
    """
    if not isinstance(text, str) or not text:
        return text

    def _repl(match: "re.Match") -> str:
        return _mask(match.group(0))

    text = _AWS_ACCESS_KEY.sub(_repl, text)
    text = _JWT.sub(_repl, text)
    text = _HIGH_ENTROPY.sub(_repl, text)
    return text


def hash_for_mempalace(secret_value: str) -> str:
    """Return ``'sha256:' + hexdigest`` of ``secret_value`` (deterministic).

    The plaintext is NEVER returned or persisted — only the one-way digest.
    Raises ``TypeError`` for non-string input (a caller must hash a real
    string, never accidentally pass through an object).
    """
    if not isinstance(secret_value, str):
        raise TypeError(
            f"hash_for_mempalace requires a str secret_value, got "
            f"{type(secret_value).__name__}"
        )
    digest = hashlib.sha256(secret_value.encode("utf-8")).hexdigest()
    return "sha256:" + digest
