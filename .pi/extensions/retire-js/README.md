# retire-js extension

Pi extension wrapping [retire.js](https://retirejs.github.io/retire.js/) for
detecting known-vulnerable JavaScript library versions.

Part of the `sca` skill's Phase 4a tool-extension layer. Standalone; not wired
into the sca orchestrator.

## Tool

- **`retire_js_scan`** — scan a JS/Node project.
  - `target` (string, required): directory path to scan.
  - `timeout` (number, optional): ms, default 120000.

Returns normalized JSON: `{ success, tool, version, target, total_findings, raw_output }`.
Not-installed returns a graceful message with the pinned version + install hint.

## Config

**No bundled config** (architecture decision: invoke-only, uses retire.js's
built-in advisory repository).

## Install

Pinned version: **v5.4.3** (binary name: `retire`; see `tool_manifest.py`).

```
npm install -g retire@5.4.3
```

## License

Apache-2.0 (`permissive_embed`). This extension only invokes the binary as a
subprocess (array-form `execFileSync`, never a shell string).

## Notes

- CLI flags are PROBABLE-confidence (not verified against a live binary):
  `retire --path <target> --outputformat json`.
- Exit code 13 is treated as "vulnerabilities found" (success-with-findings).
