# System compliance checks

`check_compliance.py` runs each Python test owner from the live pytest `testpaths`
configuration in an isolated subprocess. It independently inventories matching test
files before invoking pytest, then validates the bounded JSON evidence emitted by
`pytest_execution_report.py`.

## Pytest execution evidence

The `penny.pytest-execution-evidence.v2` report is a closed schema. It records:

- collected files and node IDs;
- one terminal `call` outcome, or a terminal `setup` failure/skip, per selected node;
- phase failures and their filenames;
- skipped, xfailed, xpassed, and deselected nodes;
- collection skips and errors; and
- whether collection completed or was truncated.

The compliance check rejects malformed evidence, duplicate or unknown entries,
filesystem inventory mismatches, omitted terminal outcomes, deselection, collection
errors or truncation, setup-only xfails, and XPASS results. A protected suite must run
at least one non-skipped call-phase test. A setup skip therefore cannot make a file or
suite count as executed.

## Explicit skip exceptions

A platform-dependent skip is accepted only when its exact normalized node ID and exact
pytest reason are configured in `pyproject.toml`:

```toml
[[tool.penny.compliance.allowed_pytest_skips]]
node_id = "tests/test_platform.py::test_platform_behavior"
reason = "requires the target platform"
```

Glob patterns are not accepted. Every observed skip remains visible in the structured
`EVIDENCE` output, including whether it matched the configuration. An unknown reason,
unconfigured skip, deselection, or suite in which every test skipped still fails.

Install the frozen development environment, then run the checker from `$PROJECT_ROOT` with the project interpreter. Using an ambient `python` can select unrelated global packages and produce false dependency failures.

```bash
make setup-dev
.venv/bin/python scripts/system/checks/check_compliance.py
```
