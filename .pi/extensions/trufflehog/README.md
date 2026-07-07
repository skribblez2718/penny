# trufflehog extension

Pi extension wrapping [TruffleHog](https://github.com/trufflesecurity/trufflehog)
for verified-secret scanning.

Part of the `sca` skill's Phase 4a tool-extension layer. Standalone; not wired
into the sca orchestrator.

## ⚠️ License — COPYLEFT, INVOKE-ONLY

trufflehog is **AGPL-3.0-only**. This extension contains **zero vendored source
code** from trufflehog — it only invokes an externally-installed `trufflehog`
binary as a subprocess. Committing trufflehog source into this repo would create
AGPL distribution obligations and is forbidden
(`tool_manifest.py: license_tier=copyleft_invoke_only`).

License classification is PROBABLE and **must be re-verified** against the
upstream LICENSE at real provisioning time (Carren N3).

## Tool

- **`trufflehog_scan`** — scan a filesystem path.
  - `target` (string, required): path to scan.
  - `timeout` (number, optional): ms, default 180000.

Returns normalized JSON: `{ success, tool, version, target, total_findings, raw_output }`.
Not-installed returns a graceful message with the pinned version + install hint.

## Config

**No bundled config** (architecture decision: invoke-only).

## Install

Pinned version: **v3.95.7** (see `tool_manifest.py`).

```
brew install trufflehog
```

## Notes

- CLI flags are PROBABLE-confidence (not verified against a live binary):
  `trufflehog filesystem <target> --json --no-update`. Output is JSONL.
