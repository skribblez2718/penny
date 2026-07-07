# gitleaks extension

Pi extension wrapping [gitleaks](https://github.com/gitleaks/gitleaks) for
secret / credential scanning of directories and git repositories.

Part of the `sca` skill's Phase 4a tool-extension layer. Standalone; not wired
into the sca orchestrator.

## Tool

- **`gitleaks_scan`** — scan a directory or repository.
  - `target` (string, required): path to scan.
  - `timeout` (number, optional): ms, default 120000.

Returns normalized JSON: `{ success, tool, version, target, total_findings, raw_output }`.
Not-installed returns a graceful message with the pinned version + install hint.

## Config

Ships `.gitleaks.toml` (extends gitleaks' default ruleset, adds an allowlist),
passed via `--config`.

## Install

Pinned version: **v8.30.1** (see `tool_manifest.py`).

```
brew install gitleaks
```

## License

MIT (`permissive_embed`). This extension only invokes the binary as a subprocess
(array-form `execFileSync`, never a shell string).

## Notes

- CLI flags are PROBABLE-confidence (not verified against a live binary):
  `gitleaks detect --source <target> --no-banner --config <toml> --report-format json --report-path <tmp>`.
  Note: `detect` is deprecated in newer gitleaks in favour of `dir`/`git`; revisit at provisioning time.
- Exit code 1 is treated as "secrets found" (success-with-findings), not failure.
