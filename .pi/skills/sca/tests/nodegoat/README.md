# NodeGoat benchmark harness

A local-only, opt-in benchmark that scores the `sca` pipeline against a
**known-vulnerable** application — OWASP [NodeGoat](https://github.com/OWASP/NodeGoat),
a deliberately-vulnerable Node/Express app with a well-understood catalogue of
planted flaws.

## What's here

| File | Purpose |
|------|---------|
| `benchmark.py` | Pure scoring: `compute_benchmark_metrics(ground_truth, discovered_findings)` → TP/FP/FN + precision/recall/F1. No network, no subprocess, no filesystem. |
| `test_benchmark.py` | Fast-lane unit tests of the scoring math using **synthetic** (non-NodeGoat) fixtures. |
| `ground-truth.json` | The ground-truth catalogue. **Currently an honest, empty template** (see below). |
| `test_nodegoat_integration.py` | Opt-in/local-only integration test that runs the real pipeline against a real NodeGoat clone. **Skips gracefully** when no clone exists. |

## Why `ground-truth.json` is empty

This codebase enforces a **"never fabricate confidence"** discipline everywhere a
claim is made — the runtime report generator refuses to invent findings, and the
same rule applies to benchmark infrastructure. Populating `ground-truth.json`
with specific `file:line` vulnerability locations recalled from training data,
**without genuinely verifying each one against the real repository in this
session**, would violate that discipline.

So the committed template is intentionally empty. An empty ground truth honestly
scores every discovered finding as a false positive (precision 0, recall 0) —
the correct "we have not verified any ground truth yet" outcome — rather than a
plausible-but-invented set of locations that would give a false sense of rigour.

`compute_benchmark_metrics` itself is **fully unit-tested and correct**
independent of this file: `test_benchmark.py` proves the precision/recall/F1 math
with synthetic fixtures. The empty ground truth blocks nothing except the
optional real-repo integration measurement.

## How to populate it (honestly)

1. Clone the real repository **yourself** (this harness never clones or downloads
   anything):

   ```bash
   git clone https://github.com/OWASP/NodeGoat ~/src/NodeGoat
   ```

2. Inspect it and record each vulnerability you can genuinely verify. Add one
   object per entry to the `entries` array, following `_entry_schema_example`,
   and record **how** you verified it in `_verified_by` (e.g.
   `"inspected NodeGoat @ <commit-sha> on <date>"`). NodeGoat also ships a
   tutorial/solutions guide that documents its planted flaws — cite it.

3. Set `"verification_status"` to something like
   `"VERIFIED_PARTIAL (<n> entries, <who>, <date>)"`.

## Running the benchmark

Fast-lane unit tests (always run, no clone needed):

```bash
cd /path/to/penny && source .venv/bin/activate
python -m pytest .pi/skills/sca/tests/nodegoat/test_benchmark.py -q
```

Opt-in integration measurement (needs a real clone **and** a populated
ground truth; otherwise skips):

```bash
export SCA_NODEGOAT_PATH="$HOME/src/NodeGoat"   # documented expected path
python -m pytest .pi/skills/sca/tests/nodegoat/test_nodegoat_integration.py \
  -m "integration" -q
```

The integration test **never** attempts to fetch NodeGoat — consistent with
every prior phase's discipline of keeping all real-network operations explicitly
opt-in and local-only.
