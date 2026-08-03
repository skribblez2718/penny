# Code Reference

The code skill runs on the shared orchestration engine as `CodeMachine`
(`orchestration.playbooks.code`). Full graph: `resources/flow.html`.

### P0 Wire Semantics

Schema-v2 runs select digest-bound, schema-versioned artifacts for the IDEAL STATE, target profile, Piper plan, exactly six quality dimensions (security, production readiness, target idiom, harmful duplication avoidance, unnecessary complexity avoidance, regression freedom), findings, execution receipts, coverage, release evidence, structured result, and outcome. Every dependent stage receives the same selected artifact references; fresh-process recovery retains them. A legacy field absent from durable evidence is explicitly unverified.

Both criteria and plan gates use complete, non-truncated structural questionnaire transport and bind trusted human approval to the selected artifact ID/version/digest. Plain `user_response` is not approval authority. Unresolved findings block `result.met`; a human-accepted residual risk requires a complete human acceptance artifact and remains permanent in result/outcome.

A command-verifiable coverage entry accepts only a successful, intact, safely redacted, same-run execution receipt. A judgment-only entry accepts only an independent disposition. Final verification plus 100% coverage and all six satisfied dimensions is the only public success/complete path; otherwise the P0 terminal action is `incomplete` with the full structured result. Release compares the immutable full-eval baseline and dirty preservation artifact and runs the named contract/drift matrix.

### States
| State | Description | Agent |
|-------|-------------|-------|
| intake | Resolve IDEAL_STATE + run server detection | — |
| exploring | Map impacted files, patterns, integration points | echo |
| analyzing | Security surface, integration/dependency risks | annie |
| checking_criteria | Judgment-only evaluation of selected IDEAL_STATE criteria | carren |
| criteria_gate | HITL: P0 trusted refine/accept exact artifact; legacy-only skip | *(user)* |
| refining_criteria | Author a complete changed criteria proposal from structured gate data | piper |
| planning | Implementation plan, build order, per-tier test strategy | piper |
| plan_gate | HITL: approve / refine / deny plan | *(user)* |
| implementing | Write code + tests to satisfy the IDEAL STATE (sequencing is the model's call) | skribble |
| verifying | Run every configured verification tier | skribble |
| learning | Judge output-vs-IDEAL-STATE gap | carren |
| unknown / awaiting_clarification | Escalation: UNCERTAIN confidence at any working state (exploring…learning), or a stalled/repeated-strategy retry at learning; awaiting_clarification resumes at exploring | *(user)* |
| complete / error | Terminal | — |

### Key Transitions
| Transition | From | To | Guard |
|------------|------|-----|-------|
| criteria_ok | checking_criteria | planning | gap == false |
| criteria_gap | checking_criteria | criteria_gate | gap == true |
| criteria_refined | criteria_gate | refining_criteria | user supplies exact refinement instruction |
| criteria_revision_applied | refining_criteria | checking_criteria | candidate valid, changed, and committed |
| criteria_revision_rejected | refining_criteria | criteria_gate | invalid / unchanged / stale candidate |
| criteria_reask | criteria_gate | criteria_gate | missing instruction or invalid ledger |
| plan_approved | plan_gate | implementing | user approves |
| plan_denied | plan_gate | error | user denies |
| verify_done | verifying | learning | normal verify |
| learn_retry | learning | implementing | gap && within budget |
| learn_final_verify | learning | verifying | gap == false (final battery) |
| learn_exhausted | learning | internal complete | gap && budget spent; P0 emits public incomplete with result.met=false |
| final_verify_pass | verifying | complete | final verify passed |
| final_verify_fail | verifying | learning | final verify failed (regression) |
| plan_refine | plan_gate | planning | user refines → re-plan |
| to_unknown | any working state (including refining_criteria and learning) | unknown | UNCERTAIN / stalled retry |
| escalate | unknown | awaiting_clarification | request user clarification |
| clarify | awaiting_clarification | exploring | user clarified |
| abort | any non-terminal state | error | unrecoverable |

## Subagents Used

| Name | State(s) | Expected Output |
|------|----------|-----------------|
| echo | exploring | Structured SUMMARY |
| annie | analyzing | Structured SUMMARY |
| carren | checking_criteria, learning | Structured judgment SUMMARY |
| piper | refining_criteria, planning | Structured authoring SUMMARY |
| skribble | implementing, verifying | Structured SUMMARY |

## Mempalace Integration

### Context Sources
- `skills/code-<session_id>` — Session-specific context

### Learning Outputs
- `penny/skills` — Session summary

## Error Handling

- Max iterations: configurable via constraints
- Error states log to stderr and mempalace
