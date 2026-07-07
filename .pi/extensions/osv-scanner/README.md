# osv-scanner extension

Pi extension wrapping [Google OSV-Scanner](https://google.github.io/osv-scanner/)
for dependency / SBOM vulnerability scanning against the OSV database.

Part of the `sca` skill's Phase 4a tool-extension layer. Standalone: consumable
by any agent/tool-caller. Not wired into the sca orchestrator.

## Tool

- **`osv_scanner_scan`** — scan a directory, lockfile, or SBOM.
  - `target` (string, required): path to scan.
  - `timeout` (number, optional): ms, default 120000.

Returns normalized JSON: `{ success, tool, version, target, total_findings, raw_output }`.
If the binary is not on PATH, returns a graceful non-throwing message with the
pinned version and an install hint.

## Config

Ships `osv-scanner.toml` (our own tuned config, not vendored upstream), passed
via `--config`.

## Install

Pinned version: **v2.4.0** (see `.pi/skills/sca/scripts/tool_manifest.py`).

```
brew install osv-scanner
# or
go install github.com/google/osv-scanner/v2/cmd/osv-scanner@v2.4.0
```

## License

osv-scanner is Apache-2.0 (`permissive_embed`). This extension only invokes the
binary as a subprocess (array-form `execFileSync`, never a shell string).

## Notes

- CLI flags are PROBABLE-confidence (binary not installed here to verify against):
  `osv-scanner scan source --config <toml> --format json <target>`.
- PATH resolution is trusted (v1 assumption, matches semgrep's approach).
