# sca — Test-lane contract (honest coverage)

This document formalizes the test-lane contract **exactly as it was actually
built**. It does not change any test behaviour; it describes and justifies the
lanes that already exist. The guiding rule, applied to test infrastructure the
same way it is applied to runtime report generation, is: **never fabricate
confidence.** A test lane is only worth what it actually verifies.

## The lanes at a glance

| Lane | Marker filter | Live tools? | When it runs | Current result |
|------|---------------|-------------|--------------|----------------|
| **Fast lane** (default) | `not e2e and not slow and not network and not integration` | **No** — fully mocked | Every `make test` | **596 passed, 21 deselected, 95% coverage** |
| **Slow / live lane** | `slow` (opt-in) | Yes — real semgrep, real Docker | Manual / CI opt-in | Skips gracefully when the tool is absent |
| **Integration lane** | `integration` (opt-in) | Yes — real repo scan | Manual / local-only | Skips gracefully without a real clone |
| **e2e / network** | `e2e`, `network` | Varies | Manual | Excluded from fast lane |

The fast-lane filter is the **exact** filter the root `Makefile` applies
(`PYTEST_MARKERS ?= not e2e and not slow and not network and not integration`);
no Makefile changes were needed — it already picks up `.pi/skills/sca/tests`
generically.

## Real, verified fast-lane numbers

Run against `.pi/skills/sca/tests` with the exact `make test` marker filter and
`--cov=.pi/skills/sca/scripts`:

```
596 passed, 21 deselected
TOTAL coverage: 95%
```

The original architecture decision set an **≥ 80%** fast-lane coverage floor.
The real number is **95%** — it comfortably exceeds the floor, and this is the
measured value, not an asserted minimum. Per-module coverage ranges from 89%
(`baseline_scan.py`, whose real-tool branches are exercised by the opt-in slow
lane) to 100% (`cvss4_map.py`, `input_validator.py`, `provisioning.py`,
`redact.py`, `tool_manifest.py`).

The fast lane is **fully mocked**: no live tools, no LLM/provider, no network,
no subprocess, no Docker (`tests/conftest.py` states this contract, and it is
enforced by the marker split below).

## What the fast lane deliberately EXCLUDES — and why

### Real-semgrep tests live in the SLOW lane (an honest correction)

The real, non-mocked end-to-end semgrep tests
(`tests/test_baseline_scan.py::TestBaselineScanRealE2E`,
`tests/test_targeted_scan.py::TestTargetedScanRealE2E`,
`tests/test_orchestrate.py::TestAugmentationLoopRealE2E`) are marked **both**
`@pytest.mark.slow` **and** `@pytest.mark.requires_semgrep`. Because the fast
lane excludes `slow`, these tests are **not** in the default fast lane — they are
opt-in via the slow lane.

> **Honesty note / deviation from the phase spec.** The Phase 11 spec's success
> criteria anticipated that real-semgrep tests would be *inside* the fast lane
> (marked `requires_semgrep` only). The build is actually **stricter**: the fast
> lane is 100% mocked, and every real-semgrep test also carries `slow`, moving it
> to the opt-in lane. We document reality rather than re-marking tests to fit the
> spec — re-marking would change already-approved test behaviour, which is
> explicitly forbidden for this phase. Confirmed mechanically:
> `pytest -m "requires_semgrep and not slow"` collects **0 tests**;
> `pytest -m "requires_semgrep"` collects **13 tests, all also `slow`**
> (the 13th is the opt-in NodeGoat integration test added in Phase 11,
> which also carries `requires_semgrep` since it drives a real scan).

Whichever lane they sit in, these live semgrep tests are **deliberate and
Carren-approved**, and they are NOT re-mocked, because they caught two real bugs
during this build that a mock would have sailed straight past:

1. **SARIF severity-mapping bug (Phase 6a).** A textbook OS command injection
   (`exec('ls ' + userInput)`, CWE-78) was scoring **CVSS 2.4 / LOW** instead of
   **CVSS 8.8 / HIGH**. Real semgrep SARIF puts severity on the *rule*
   (`defaultConfiguration.level`), not the per-result object; the parser was
   reading the wrong place. Now guarded by
   `test_real_command_injection_is_high_cvss_8_8_not_low`, which runs live
   semgrep and asserts the finding scores 8.8/HIGH.
2. **osv-scanner nested-shape data-loss bug (Phase 6a).** A generic flat-record
   parser silently dropped **every** dependency finding, because the real
   osv-scanner shape is deeply nested
   (`results[].packages[].vulnerabilities[]`), not flat records — making a real
   "N CVEs" scan look identical to a clean scan. Now `normalize.py`'s dedicated
   `parse_osv_scanner_json` walks the real shape and is verified against it.

A mock would have asserted the buggy behaviour was "correct." The live tests are
the reason we know it isn't. That is the whole point of this contract: **the fast
lane gives us speed and determinism; the slow lane gives us ground truth against
the real tools.** Both are kept; neither is faked.

### Docker verification-sandbox tests (no `requires_docker` marker exists)

The P10 Docker sandbox tests (`tests/test_sandbox.py` and
`tests/test_orchestrate.py`'s live sandbox tests) are marked `@pytest.mark.slow`
(real container-per-test overhead) plus a **runtime `skipif`** guard:

```python
requires_docker = pytest.mark.skipif(
    not _docker_really_works(), reason="real Docker daemon not available"
)
```

There is **no `requires_docker` pytest marker** — Docker gating is done with a
`skipif` that actually tries to run a trivial container (`_docker_really_works()`
via `shutil.which("docker")` + a real run), plus an image-presence check. This
means the tests skip gracefully in any environment without Docker, and never
appear in the fast lane (they carry `slow`). The registered markers are exactly:
`slow`, `integration`, `network`, `e2e`, `requires_semgrep`, `requires_scanner`,
`requires_llm` (see `pytest.ini` / `conftest.py`).

### Tools that are not installed skip gracefully

For tools whose exact CLI output shapes are PROBABLE-confidence and which are not
installed in this dev environment (osv-scanner, gitleaks, trufflehog, trivy,
retire.js, njsscan, eslint plugins, codeql), the deterministic scan code
*degrades* rather than fails: a missing OPTIONAL tool is recorded as a coverage
gap, and the mocked fast-lane tests assert exactly that honest degradation. Live
tests for those tools would carry `requires_scanner` and skip when absent. No
test in any lane attempts to install or download a tool.

## Integration lane — the NodeGoat benchmark

`tests/nodegoat/` contains an opt-in benchmark that scores the pipeline against
OWASP NodeGoat, a known-vulnerable app:

- `benchmark.py` — pure, deterministic `compute_benchmark_metrics(...)`
  (TP/FP/FN + precision/recall/F1). No I/O, no network.
- `test_benchmark.py` — **fast-lane** unit tests proving the metric math with
  synthetic (non-NodeGoat) fixtures. These run in the default lane and are part
  of the 596.
- `ground-truth.json` — an **honest, empty template**. It contains no fabricated
  NodeGoat `file:line` locations; real entries must be populated by someone who
  has actually cloned and inspected the real repo (see `tests/nodegoat/README.md`).
- `test_nodegoat_integration.py` — marked `integration` + `slow` +
  `requires_semgrep`. It **skips gracefully** unless a real clone exists at
  `$SCA_NODEGOAT_PATH` (default `~/src/NodeGoat`) AND the ground truth is
  populated AND semgrep is installed. It **never** clones or downloads NodeGoat.

Because the shipped ground truth is empty and no clone is assumed, this test
skips in every environment today — while `compute_benchmark_metrics` remains
fully proven correct by the synthetic-fixture unit tests. This mirrors the same
discipline used everywhere else: the *machinery* is tested; the *real-world data*
is only ever real when someone genuinely verifies it.

## Running each lane

```bash
cd /path/to/penny && source .venv/bin/activate

# Fast lane (default) — fully mocked
python -m pytest .pi/skills/sca/tests -p no:cacheprovider \
  -m "not e2e and not slow and not network and not integration" -q

# Slow / live lane — real semgrep + real Docker (auto-skips what's absent)
python -m pytest .pi/skills/sca/tests -p no:cacheprovider -m "slow" -rs -q

# NodeGoat benchmark integration (needs a real local clone + populated truth)
export SCA_NODEGOAT_PATH="$HOME/src/NodeGoat"
python -m pytest .pi/skills/sca/tests/nodegoat/test_nodegoat_integration.py \
  -m "integration" -rs -q
```
