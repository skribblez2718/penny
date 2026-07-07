"""
Unit tests for sca redact.py (Phase 5) — secrets redaction discipline.

Two never-plaintext primitives:
  redact_for_report(text)     partial-mask secret-shaped substrings for a
                              human-facing report (short prefix/suffix only).
  hash_for_mempalace(secret)  'sha256:'+hexdigest for inter-agent/mempalace
                              communication — the plaintext is NEVER written.

CRITICAL fixture discipline: every secret value used here is OBVIOUSLY FAKE and
non-functional:
  * FAKE_AWS_KEY = AWS's own documented example key (contains 'EXAMPLE'),
  * FAKE_JWT = a hand-built JWT with a 'FAKE' payload/signature,
  * FAKE_HEX  = a repeating 'deadbeef' pattern (clearly not a real token).
Each appears ONLY as raw INPUT. Assertions prove it never survives verbatim in
report/hashed output beyond the deliberately-disclosed prefix/suffix.

No network, no subprocess.
"""

import hashlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import redact as rd  # noqa: E402
from redact import redact_for_report, hash_for_mempalace, _mask  # noqa: E402


# Obviously-fake, non-functional secret placeholders (raw INPUT only).
FAKE_AWS_KEY = "AKIAIOSFODNN7EXAMPLE"  # AWS's documented sample key
FAKE_JWT = (
    "eyJhbGciOiJIUzI1NiJ9"
    ".eyJzdWIiOiJGQUtFLU5PVC1SRUFMIn0"
    ".FAKESIGNATUREFAKESIGNATUREFAKESIGNATURE"
)
FAKE_HEX = "deadbeef" * 5  # 40 hex chars, obviously a fake token


# ── redact_for_report: AWS access key ────────────────────────────────────


class TestRedactAwsKey:
    def test_masks_aws_key_never_full_value(self):
        text = f"leaked key: {FAKE_AWS_KEY} in config"
        out = redact_for_report(text)
        assert FAKE_AWS_KEY not in out  # full value never survives
        # only the short disclosed prefix/suffix remain
        assert out.startswith("leaked key: AKIA")
        assert out.endswith("MPLE in config")
        assert "****" in out

    def test_prefix_and_suffix_are_short(self):
        out = redact_for_report(FAKE_AWS_KEY)
        # the disclosed portions are only the first/last 4 chars
        assert "AKIA" in out and "MPLE" in out
        # the interior of the key must be gone
        assert "IOSFODNN7EXA" not in out


# ── redact_for_report: JWT ───────────────────────────────────────────────


class TestRedactJwt:
    def test_masks_jwt_never_full_value(self):
        text = f"Authorization: Bearer {FAKE_JWT}"
        out = redact_for_report(text)
        assert FAKE_JWT not in out
        assert "****" in out

    def test_jwt_signature_not_disclosed(self):
        out = redact_for_report(FAKE_JWT)
        assert "FAKESIGNATUREFAKESIGNATUREFAKESIGNATURE" not in out


# ── redact_for_report: generic high-entropy token ────────────────────────


class TestRedactGenericToken:
    def test_masks_long_hex_token(self):
        text = f"token={FAKE_HEX};"
        out = redact_for_report(text)
        assert FAKE_HEX not in out
        assert "****" in out

    def test_mask_fully_stars_a_very_short_token(self):
        # Defensive branch: a token too short to safely split is fully starred
        # (no prefix/suffix disclosed at all).
        assert _mask("abcd") == "****"
        assert _mask("") == ""


# ── redact_for_report: benign / no-secret inputs ─────────────────────────


class TestRedactBenign:
    def test_plain_prose_unchanged(self):
        text = "The quick brown fox jumps over the lazy dog."
        assert redact_for_report(text) == text

    def test_short_structured_value_unchanged(self):
        # short ids / hashes below the entropy-length threshold are left alone
        text = "commit abc1234 fixed the bug in v1.2.3"
        assert redact_for_report(text) == text

    def test_empty_and_none_safe(self):
        assert redact_for_report("") == ""
        assert redact_for_report(None) is None

    def test_idempotent_on_already_masked(self):
        once = redact_for_report(f"key {FAKE_AWS_KEY} end")
        twice = redact_for_report(once)
        assert once == twice  # masking a masked string changes nothing further
        assert FAKE_AWS_KEY not in twice


# ── hash_for_mempalace ───────────────────────────────────────────────────


class TestHashForMempalace:
    def test_prefixed_sha256_hexdigest(self):
        out = hash_for_mempalace(FAKE_AWS_KEY)
        assert out.startswith("sha256:")
        expected = hashlib.sha256(FAKE_AWS_KEY.encode("utf-8")).hexdigest()
        assert out == "sha256:" + expected

    def test_never_returns_plaintext(self):
        for secret in (FAKE_AWS_KEY, FAKE_JWT, FAKE_HEX):
            out = hash_for_mempalace(secret)
            assert secret not in out

    def test_deterministic(self):
        assert hash_for_mempalace(FAKE_AWS_KEY) == hash_for_mempalace(FAKE_AWS_KEY)

    def test_non_string_rejected(self):
        with pytest.raises((TypeError, ValueError)):
            hash_for_mempalace(1234)


# ── end-to-end "no verbatim secret survives" guarantee ───────────────────


class TestNoVerbatimSecretSurvives:
    def test_all_processed_outputs_free_of_raw_secret(self):
        # Feed each fake secret through BOTH primitives and assert the raw value
        # never appears verbatim in any produced output (the grep-style check
        # required by the IDEAL_STATE, expressed as an assertion).
        for secret in (FAKE_AWS_KEY, FAKE_JWT, FAKE_HEX):
            report_out = redact_for_report(f"value is {secret} here")
            hash_out = hash_for_mempalace(secret)
            assert secret not in report_out
            assert secret not in hash_out
