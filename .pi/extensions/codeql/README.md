# codeql extension

Pi extension wrapping [GitHub CodeQL CLI](https://docs.github.com/en/code-security/codeql-cli)
for static analysis. **Opt-in only.**

Part of the `sca` skill's Phase 4a tool-extension layer. Standalone; not wired
into the sca orchestrator.

## ⚠️ Opt-in gate

`codeql` is the only tool with `enabled_by_default=False` in `tool_manifest.py`.
The `codeql_scan` tool takes a **required** `confirm_opt_in: boolean`. As the
very first action, `execute()` checks it:

- If not `true` → returns a **static, informational** license notice and does
  nothing else (no binary detection, no subprocess, no network).
- If `true` → proceeds to normal not-installed / installed handling.

The license notice is a **static surfacing** of the CodeQL CLI terms — it is
**not** a live GitHub repository-visibility or entitlement check (resolved PRD
nit N2). This extension performs no network calls.

## Tool

- **`codeql_scan`**
  - `confirm_opt_in` (boolean, required): must be `true` to run.
  - `target` (string, required): source directory to analyze.
  - `timeout` (number, optional): ms, default 600000.

Returns normalized JSON: `{ success, tool, version, target, total_findings, raw_output }`.

## Config

Ships `codeql-config.yml` (our own tuned config, not vendored), passed to
`codeql database create --codescanning-config`.

## License

GitHub CodeQL CLI terms (`LicenseRef-GitHub-CodeQL-Terms`): free for open-source
and academic use; private-repo analysis requires GitHub Advanced Security /
Enterprise. PROBABLE — verify upstream terms before relying on this.

## Install

Pinned version: **v2.25.6** (see `tool_manifest.py`).

## Notes

- codeql is a two-step tool (`database create` → `database analyze`). CLI flags
  are PROBABLE-confidence (not verified against a live binary):
  - `codeql database create <db> --source-root <target> --language=javascript-typescript --codescanning-config <config>`
  - `codeql database analyze <db> codeql/javascript-queries --format=sarifv2.1.0 --output=<sarif>`
