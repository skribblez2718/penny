# njsscan extension

Pi extension wrapping [njsscan](https://github.com/ajinabraham/njsscan) for
Node.js SAST (insecure code pattern detection).

Part of the `sca` skill's Phase 4a tool-extension layer. Standalone; not wired
into the sca orchestrator.

## ⚠️ License — COPYLEFT, INVOKE-ONLY

njsscan is **LGPL-3.0-only**. This extension contains **zero vendored source
code** from njsscan — it only invokes an externally-installed `njsscan` binary as
a subprocess (`tool_manifest.py: license_tier=copyleft_invoke_only`).

License classification is PROBABLE and **must be re-verified** against the
upstream LICENSE at real provisioning time (Carren N3).

## Tool

- **`njsscan_scan`** — scan a Node.js project.
  - `target` (string, required): directory path to scan.
  - `timeout` (number, optional): ms, default 120000.

Returns normalized JSON: `{ success, tool, version, target, total_findings, raw_output }`.
Not-installed returns a graceful message with the pinned version + install hint.

## Config

Ships `.njsscan` — **authored by this extension** (a small tuned default), NOT
njsscan's vendored upstream config. njsscan auto-discovers a `.njsscan` file from
the scan root; wiring our bundled config into arbitrary targets is deferred (we
never mutate the target).

## Install

Pinned version: **v0.4.3** (see `tool_manifest.py`).

```
pip install njsscan==0.4.3
```

## Notes

- CLI flags are PROBABLE-confidence (not verified against a live binary):
  `njsscan --json <target>`.
