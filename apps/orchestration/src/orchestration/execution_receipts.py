"""Trusted execution receipts and deterministic redaction.

Receipts are signed by the TypeScript execution owner with a per-process HMAC key
that is passed only to orchestration subprocesses. Agent subprocesses receive no
signing capability. Python validates signatures, same-run/obligation binding,
command identity, timestamps, successful status, and redacted output integrity.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Mapping, Sequence

RECEIPT_SCHEMA_VERSION = 1
RECEIPT_HMAC_ENV = "PENNY_RECEIPT_HMAC_KEY"

_RECEIPT_KEYS = frozenset(
    {
        "schema_version",
        "receipt_id",
        "run_id",
        "state_id",
        "obligation_id",
        "argv",
        "working_directory",
        "executor_identity",
        "execution_owner_identity",
        "started_at",
        "ended_at",
        "exit_status",
        "output_artifact_ref",
        "output_digest",
        "output_excerpt",
        "integrity_state",
        "redaction_state",
        "signature_algorithm",
        "signature",
    }
)
_SECRET_NAME = re.compile(
    r"(?i)(?:secret|token|password|passwd|api[_-]?key|credential|private[_-]?key)"
)
_INLINE_SECRET = re.compile(
    r"(?i)(\b(?:secret|token|password|passwd|api[_-]?key|credential|private[_-]?key)\b\s*[:=]\s*)([^\s,;]+)"
)
_FLAG_SECRET = re.compile(
    r"(?i)(--(?:secret|token|password|passwd|api-key|credential|private-key))(?:=|\s+)([^\s]+)"
)
_BEARER_SECRET = re.compile(r"(?i)(\bBearer\s+)[A-Za-z0-9._~+/=-]+")


def canonical_json(value: Any) -> bytes:
    """Encode JSON deterministically for receipt signatures and digests."""
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def sha256_json(value: Any) -> str:
    """Return a SHA-256 digest of canonical JSON."""
    return hashlib.sha256(canonical_json(value)).hexdigest()


def _contains_unredacted_secret(text: str) -> bool:
    for pattern in (_INLINE_SECRET, _FLAG_SECRET, _BEARER_SECRET):
        for match in pattern.finditer(text):
            if match.group(match.lastindex or 0) != "[REDACTED]":
                return True
    return False


def _parse_utc(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        return None
    return parsed


def configured_secret_values(
    explicit_values: Sequence[str] = (), env: Mapping[str, str] | None = None
) -> tuple[str, ...]:
    """Return redactable configured values without persisting names or values.

    Values shorter than four characters are ignored to avoid destructive replacement
    of ordinary flags/text. The receipt signing key itself is always included.
    """
    environment = env if env is not None else os.environ
    values = [value for value in explicit_values if isinstance(value, str) and len(value) >= 4]
    for name, value in environment.items():
        if _SECRET_NAME.search(name) and isinstance(value, str) and len(value) >= 4:
            values.append(value)
    return tuple(sorted(set(values), key=len, reverse=True))


def redact_sensitive_output(text: str, secret_values: Sequence[str] = ()) -> str:
    """Return deterministic terminal-safe output with configured/common secrets removed."""
    redacted = str(text)
    for value in configured_secret_values(secret_values):
        redacted = redacted.replace(value, "[REDACTED]")
    redacted = _INLINE_SECRET.sub(r"\1[REDACTED]", redacted)
    redacted = _FLAG_SECRET.sub(r"\1=[REDACTED]", redacted)
    redacted = _BEARER_SECRET.sub(r"\1[REDACTED]", redacted)
    return "".join(
        (
            character
            if character in "\n\t"
            or (ord(character) >= 0x20 and ord(character) not in range(0x7F, 0xA0))
            else f"\\u{ord(character):04x}"
        )
        for character in redacted
    )


def receipt_signing_key(env: Mapping[str, str] | None = None) -> bytes | None:
    """Load a valid owner-provided key from an orchestration-only environment."""
    raw = (env if env is not None else os.environ).get(RECEIPT_HMAC_ENV, "")
    if not isinstance(raw, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", raw):
        return None
    return bytes.fromhex(raw)


def sign_receipt(receipt: Mapping[str, Any], key: bytes) -> str:
    """Sign a receipt mapping, excluding its signature field."""
    unsigned = {name: deepcopy(value) for name, value in receipt.items() if name != "signature"}
    return hmac.new(key, canonical_json(unsigned), hashlib.sha256).hexdigest()


def build_receipt(
    *,
    receipt_id: str,
    run_id: str,
    state_id: str,
    obligation_id: str,
    argv: Sequence[str],
    working_directory: str,
    executor_identity: str,
    execution_owner_identity: str,
    started_at: str,
    ended_at: str,
    exit_status: int,
    output_artifact_ref: str,
    output: str,
    key: bytes,
    secret_values: Sequence[str] = (),
) -> dict[str, Any]:
    """Build a signed receipt containing only redacted output evidence."""
    redacted = redact_sensitive_output(output, secret_values)
    receipt: dict[str, Any] = {
        "schema_version": RECEIPT_SCHEMA_VERSION,
        "receipt_id": receipt_id,
        "run_id": run_id,
        "state_id": state_id,
        "obligation_id": obligation_id,
        "argv": list(argv),
        "working_directory": working_directory,
        "executor_identity": executor_identity,
        "execution_owner_identity": execution_owner_identity,
        "started_at": started_at,
        "ended_at": ended_at,
        "exit_status": exit_status,
        "output_artifact_ref": output_artifact_ref,
        "output_digest": hashlib.sha256(redacted.encode("utf-8")).hexdigest(),
        "output_excerpt": redacted,
        "integrity_state": "intact",
        "redaction_state": "redacted",
        "signature_algorithm": "hmac-sha256",
        "signature": "",
    }
    receipt["signature"] = sign_receipt(receipt, key)
    return receipt


def validate_execution_receipt(  # noqa: C901 - cryptographic receipt validation
    value: Any,
    *,
    run_id: str,
    obligation_id: str,
    key: bytes | None = None,
    allowed_working_root: str | None = None,
) -> tuple[bool, str]:
    """Validate the full positive receipt oracle. Unknown/missing fields fail closed."""
    if not isinstance(value, dict):
        return False, "execution receipt must be an object"
    if frozenset(value) != _RECEIPT_KEYS:
        return False, "execution receipt has missing, unknown, or stale fields"
    if value.get("schema_version") != RECEIPT_SCHEMA_VERSION:
        return False, "unsupported execution receipt schema version"
    for field in (
        "receipt_id",
        "run_id",
        "state_id",
        "obligation_id",
        "working_directory",
        "executor_identity",
        "execution_owner_identity",
        "output_artifact_ref",
    ):
        if not isinstance(value.get(field), str) or not value[field]:
            return False, f"execution receipt {field} must be non-empty"
    if value.get("run_id") != run_id:
        return False, "execution receipt is bound to a different run"
    if value.get("obligation_id") != obligation_id:
        return False, "execution receipt is bound to a different obligation"
    if value.get("executor_identity") == value.get("execution_owner_identity"):
        return False, "execution owner must be distinct from the command executor"
    argv = value.get("argv")
    if not isinstance(argv, list) or not argv or any(not isinstance(item, str) for item in argv):
        return False, "execution receipt argv must be a non-empty string array"
    if any("\x00" in item or "\n" in item or "\r" in item for item in argv):
        return False, "execution receipt argv contains an unsafe control character"
    working_directory = str(value.get("working_directory"))
    from pathlib import Path

    if not Path(working_directory).is_absolute():
        return False, "execution receipt working directory must be canonical and absolute"
    if allowed_working_root:
        root = Path(allowed_working_root).resolve()
        candidate = Path(working_directory).resolve()
        if candidate != root and root not in candidate.parents:
            return False, "execution receipt working directory is outside the selected target"
    started = _parse_utc(value.get("started_at"))
    ended = _parse_utc(value.get("ended_at"))
    if started is None or ended is None or ended < started:
        return False, "execution receipt timestamps are missing, invalid, or reordered"
    if type(value.get("exit_status")) is not int or value["exit_status"] != 0:
        return False, "execution receipt exit status is not successful"
    if value.get("integrity_state") != "intact":
        return False, "execution receipt output integrity is not intact"
    if value.get("redaction_state") != "redacted":
        return False, "execution receipt redaction state is not valid"
    if value.get("signature_algorithm") != "hmac-sha256":
        return False, "execution receipt signature algorithm is unsupported"
    if not isinstance(value.get("signature"), str) or not re.fullmatch(
        r"[0-9a-f]{64}", value["signature"]
    ):
        return False, "execution receipt signature encoding is invalid"
    excerpt = value.get("output_excerpt")
    digest = value.get("output_digest")
    if not isinstance(excerpt, str) or not excerpt:
        return False, "execution receipt has no redacted output evidence"
    if digest != hashlib.sha256(excerpt.encode("utf-8")).hexdigest():
        return False, "execution receipt output digest is tampered"
    if _contains_unredacted_secret(excerpt):
        return False, "execution receipt contains an unredacted sensitive-output pattern"
    verification_key = key or receipt_signing_key()
    if verification_key is None:
        return False, "execution-owner verification key is unavailable"
    expected = sign_receipt(value, verification_key)
    if not hmac.compare_digest(str(value.get("signature", "")), expected):
        return False, "execution receipt signature is invalid or tampered"
    return True, ""


def receipt_payload_digest(receipt: Mapping[str, Any]) -> str:
    """Digest helper for registry/import tests."""
    return sha256_json(receipt)
