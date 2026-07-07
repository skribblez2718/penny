# trivy extension

Pi extension wrapping [Trivy](https://trivy.dev/) for filesystem vulnerability,
misconfiguration, and secret scanning.

Part of the `sca` skill's Phase 4a tool-extension layer. Standalone; not wired
into the sca orchestrator.

## Tool

- **`trivy_scan`** — scan a filesystem path.
  - `target` (string, required): path to scan.
  - `timeout` (number, optional): ms, default 180000.

Returns normalized JSON: `{ success, tool, version, target, total_findings, raw_output }`.
Not-installed returns a graceful message with the pinned version + install hint.

## Config

Ships `trivy.yaml` (main config) and `trivy-secret.yaml` (secret-scanner rules),
both our own tuned configs (not vendored). `trivy.yaml` references
`trivy-secret.yaml` via `secret.config`.

## Install

Pinned version: **v0.72.0** (see `tool_manifest.py`).

```
brew install trivy
```

## License

Apache-2.0 (`permissive_embed`). This extension only invokes the binary as a
subprocess (array-form `execFileSync`, never a shell string).

## Notes

- CLI flags are PROBABLE-confidence (not verified against a live binary):
  `trivy fs --config <trivy.yaml> --format json <target>`.
- `secret.config` path resolution is relative to trivy's cwd — verify at provisioning time.
