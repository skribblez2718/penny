# eslint-security extension

Pi extension wrapping ESLint with two security plugins for JS/TS security
linting.

Part of the `sca` skill's Phase 4a tool-extension layer. Standalone; not wired
into the sca orchestrator.

## ⚠️ License — COMBINED ENTRY, INVOKE-ONLY

This extension covers two npm plugins with **different licenses**:

| Plugin | License | Treatment |
|--------|---------|-----------|
| `eslint-plugin-security` | MIT | permissive |
| `eslint-plugin-no-unsanitized` | MPL-2.0 (weak copyleft) | **copyleft invoke-only** |

The extension contains **zero vendored source** from either plugin — it only
invokes an externally-installed `eslint` with both plugins present in the target
project's environment (`tool_manifest.py: license_tier=copyleft_invoke_only`).
The MPL-2.0 classification is PROBABLE and must be re-verified at provisioning.

## Tool

- **`eslint_security_scan`** — lint a file or directory.
  - `target` (string, required): path to lint.
  - `timeout` (number, optional): ms, default 120000.

Returns normalized JSON: `{ success, tool, version, target, total_findings, raw_output }`.
Not-installed returns a graceful message with the pinned version + install hint.

## Config

Ships `eslint.config.security.mjs` — a flat config wiring both plugins active,
passed via `--config`. Config only (no vendored plugin source).

## Install

Pinned version: **v4.0.1** (eslint-plugin-security; binary: `eslint`; see
`tool_manifest.py`).

```
npm install -D eslint eslint-plugin-security eslint-plugin-no-unsanitized
```

## Notes

- CLI flags are PROBABLE-confidence (not verified against a live binary):
  `eslint --config <config> --format json --no-error-on-unmatched-pattern <target>`.
- Exit code 1 is treated as "findings found" (success-with-findings), not failure.
