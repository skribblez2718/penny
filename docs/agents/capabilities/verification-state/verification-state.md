# Verification — Evidence-grounded VERIFY, enforced by the engine

## What

Verification is an **engine capability**, not a per-skill FSM branch. A playbook
declares a VERIFY state whose SUMMARY contract requires a verdict plus captured
evidence; the shared orchestration engine (`apps/orchestration/`) validates that
SUMMARY before the run advances. A verifier cannot PASS on a bare assertion, and
a failing final verify completes the run **honestly** with `met=False` — never a
fabricated pass.

## Why

A verify step that self-reports "PASS" with no artifact is a false positive. The
engine closes that gap two ways: it rejects an empty/malformed VERIFY SUMMARY
(fail-loud, the run does not advance on a default), and — where the state opts in
— it requires named evidence fields to be present and non-empty, so the verdict
is backed by real command output (test results, scan output, an executed-PoC
transcript).

## Rules

1. **Verification lives in the engine.** `contracts.validate_summary_contract`
   is the gatekeeper. Penny never hand-rolls a `needs_verification()` guard or a
   `_validate_summary` helper in a skill directory — those do not exist.
2. **Evidence is non-empty or the SUMMARY is rejected.** A contract may declare
   `contract["evidence"]` naming required fields that must additionally pass a
   non-empty check (`[]`, `""`, `{}`, `0`, `False`, `None` all fail).
3. **Exhaustion is honest.** When the retry budget (`ctx.max_iterations`) is
   spent, the run completes with `met=False`. A FINAL verify that fails loops
   back to `learning`; it does not complete as if it passed.
4. **VERDICT vocabulary is closed.** VERIFY reports `PASS` / `FAIL`; routing
   rejects unknown verdicts.

## Procedure

### Contract validation (engine)

Every state SUMMARY is checked against `spec.summary_contract` by
`validate_summary_contract(name, contract, summary)` (`contracts.py`):

- required fields must be present and correctly typed (a `bool` never satisfies
  an `int` field);
- optional fields, if present, are type-checked;
- each field named in `contract["evidence"]` must be present **and non-empty**.

Malformed or empty SUMMARYs fail loud — the engine does not synthesize a default
and does not advance the machine.

### Concrete example — `RESEARCH_VALIDATE`

The current research playbook's `validating` state (`apps/orchestration/src/orchestration/playbooks/research.py`) declares a `RESEARCH_VALIDATE` contract with required `verdict`, `issues`, and non-empty `evidence` fields. Vera must return captured claim-to-source checks; a bare `PASS` with an empty evidence list is rejected by the engine.

```python
RESEARCH_VALIDATE = PrimitiveSpec(
    "RESEARCH_VALIDATE",
    "vera",
    _c(
        {"verdict": str, "issues": list, "evidence": list},
        evidence=["evidence"],
    ),
    "Verify every material claim is grounded in a cited source.",
)
```

### Routing on the verdict

`route_after` for research validation records the verdict and unsupported claims, then routes:

- pass: `validate_pass` → `report_writing`;
- researchable evidence gap: `validate_research` → `researching` within the research-round budget;
- grounding issue with existing evidence: `validate_revise` → `synthesizing` within the revision budget;
- exhausted budget: `validate_exhausted` → `report_writing`, with unresolved claims surfaced.

### Honest exhaustion + escalation

Research validation loops are bounded by iteration and research-round budgets. Exhaustion does not manufacture a grounded verdict: the report is still delivered with `grounded: false` and the unresolved claims listed. A stalled loop escalates instead of burning budget: `progress_check` can drive an escalatable state to `unknown` → `awaiting_clarification`.

## Constraints

- **Verification and approval are separate.** Evidence validation is a verifier state. High-stakes human sign-off is a planned gate (`GATE_STATES` + `gate_questions` / `route_user`), a separate engine seam.
- **State is durable.** Verify verdict, gaps, and iteration digests live in
  `ctx` and are checkpointed by run_id; there is no `--state` argv, no
  `/tmp/<skill>-<session_id>.json`, no `extract_state`/`restore_state`.
  A run interrupted mid-verify re-issues that step on recover.

## Verification

- [ ] An empty/malformed VERIFY SUMMARY is rejected by
      `validate_summary_contract`; the run does not advance.
- [ ] A `PASS` verdict with empty `evidence` fails the evidence check.
- [ ] Exhausted validation surfaces unresolved claims instead of fabricating grounding.
- [ ] A stalled/repeated-strategy loop escalates to `awaiting_clarification`.

## Files

| File                                                         | Purpose                                                                            |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `apps/orchestration/src/orchestration/contracts.py`          | `validate_summary_contract`, `_is_nonempty`, the `evidence` grounding rule         |
| `apps/orchestration/src/orchestration/engine.py`             | invokes contract validation before routing; escalation + honest-exhaustion routing |
| `apps/orchestration/src/orchestration/playbooks/research.py` | `RESEARCH_VALIDATE` and its evidence-seeking/re-grounding routes                   |
| `apps/orchestration/tests/test_contracts.py`                 | Contract-validation and evidence-grounding tests                                   |
| `apps/orchestration/tests/test_research_playbook.py`         | Research validation routing, honest exhaustion, and escalation tests               |
