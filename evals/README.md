# Penny Evaluation System

**Status: under construction.** This is the home of the new evaluation system —
a from-scratch build covering prompt architecture, agents, skills, and the rest
of the stack. `make evals` is currently a placeholder that points here.

## Retired legacy surface (2026-08-21)

The old behavioral ratchet was retired when this directory was created:

- `scripts/system/evals/` — scorecard/ratchet runner (compat, invariants, retrieval, trajectory sections)
- `scripts/system/trajectory/` — Oracle-fixture replay harness
- `scripts/system/tests/test_eval_invariants.py`
- `docs/agents|humans/capabilities/behavioral-ratchet/` — feature pages

The runner's live stores (HTTP memory hub, `.penny/orchestration-v2.db`,
observability DB) remain authoritative and are the natural read surfaces for
the new system.

## Preserved assets

`fixtures/trajectory-fixtures.json` — Oracle-authored behavioral-regression
fixtures (task + reference output + PASS BAR + expected_route), authored
2026-07-07 while the calibration bar was set. Curation rule carried over: a
failing fixture is the eval doing its job — never delete to go green.
