# SCA Skill — Source-Code Security Audit

## What

The sca skill performs a deep, gated security review of a local source tree: charter and scope, repository census, business-context and architecture reconstruction, derived security requirements, a STRIDE/LINDDUN threat model, targeted scanning, triage, deep dive, exploitability verification, fix verification, and a final report. It runs on the shared orchestration engine as `ScaPlaybook` (`apps/orchestration/src/orchestration/playbooks/sca.py`), a `BasePlaybook` subclass; `scripts/orchestrate.py` is a ~5-line delegate.

## Why

A credible security audit must be grounded in real evidence at every step and must never fabricate exploitability. The skill front-loads deterministic scanning, threads model-reasoned context through six human gates, and gates its conclusions on executed, non-destructive proof-of-concept scripts — so a "verified" finding means a PoC actually ran, not that a model asserted a severity.

## Procedure

### Invocation

```
skill({ skill_name: "sca", goal: "Audit this service",
        constraints: { target_path: "/path/to/repo" } })
```

Target must be a local path (URL targets are rejected). Optional: `out_of_scope`, `augment_cap` (default 3), `dual_verify` + `reverify_model` (Rec 5 second-verifier), `max_fan_width`.

### Engine states (`SCAMachine`)

Strictly-sequential 13-phase pipeline: `charter (P0) → census (P1) → baseline_scan (P2, TOOL) → context (P3) → architecture (P4) → requirements (P5) → threat_model (P6) → targeted_scan (P7, TOOL) → triage (P8) → deep_dive (P9) → verification (P10) → fix_verification (P11) → report (P12) → complete`, with human gates after charter/context/threat/triage, before verification, and at the report. `baseline_scan`/`targeted_scan` are deterministic `TOOL_STATES`.

### Bitter-Lesson / atomic-loops compliance

- **Grounded verification** (Rec 4, already on the leverage spine): `SCA_VERIFICATION` requires a `run_pocs` batch (executed, non-destructive; legitimately empty with a coverage note when nothing is safely exploitable); `SCA_TRIAGE`/`SCA_DEEP_DIVE` carry an `evidence_basis`. Evidence flows to `ctx.verify_evidence` and the outcome ledger. Verifiers prefer executed-over-asserted (the vera prompts state the evidence-tier hierarchy).
- **Budget, not magic number.** `augment_cap` (`constraints.augment_cap`, default 3) bounds the deep-dive rule-augmentation loop — a tunable Budget, honestly exhausted.
- **Recall.** `_task_summary` seeds the first agent directive with distilled lessons from prior runs (advisory).
- **HITL.** Six deny-by-default human gates guard the irreversible/consequential transitions.
- **Verifier-gaming hardening (Rec 5).** Optional dual-verify (`constraints.dual_verify`, default off): after the first single-shot PoC batch executes, a SECOND independent verifier (`reverification`, on `constraints.reverify_model` via `model_for_state`) produces and executes its OWN non-destructive PoC batch, so a single verifier's miss or fabrication is challenged; both results feed the report and agreement is recorded (`dual_verify_agreed`). Defense-in-depth, not a solved problem — the browser/PoC oracle + executed-over-asserted discipline remain the primary defense.

### Agents

echo (charter/census, READ-ONLY confirmation), synthia (context/architecture/requirements reconstruction), tabitha (threat model), annie (triage/deep-dive, evidence-based), vera (exploitability + fix verification, executed PoC oracle), skribble (report, real-data-only). Per-state domain guidance in `.pi/skills/sca/assets/prompts/*.md` (named via `skill_context`).

## Constraints

- Read-only on the target during analysis; verification PoCs run once each in a locked-down sandbox and are non-destructive.
- Run state is durable in the `run_id`-keyed checkpointer; crash-resume re-issues the pending step.
- The mempalace wing is `wing_sca`; rooms are `<session_id>-<phase>`.

## Verification

- [ ] Playbook tests pass: `python3 -m pytest apps/orchestration/tests/test_sca_playbook.py`
- [ ] `SCA_VERIFICATION` requires a `run_pocs` list (empty-with-note allowed); `evidence_basis` present on triage/deep-dive
- [ ] Recall lessons render in the first directive
- [ ] `resources/flow.mmd` matches `SCAMachine` transition-for-transition

## Files

| File | Purpose |
|------|---------|
| `apps/orchestration/src/orchestration/playbooks/sca.py` | `ScaPlaybook` FSM |
| `.pi/skills/sca/assets/prompts/*.md` | Per-state domain guidance |
| `.pi/skills/sca/resources/flow.mmd` | State diagram |
| `research/atomic-loop-components/prds/sca-skill-revamp.md` | Compliance PRD |
