# Code Reference

The code skill runs on the shared orchestration engine as `CodeMachine`
(`orchestration.playbooks.code`). Full graph: `resources/flow.mmd`.

### States
| State | Description | Agent |
|-------|-------------|-------|
| intake | Resolve IDEAL_STATE + run server detection | — |
| exploring | Map impacted files, patterns, integration points | echo |
| analyzing | Security surface, integration/dependency risks | annie |
| checking_criteria | Judge IDEAL_STATE criteria quality | carren |
| criteria_gate | HITL: refine / accept / skip criteria | *(user)* |
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
| plan_approved | plan_gate | implementing | user approves |
| plan_denied | plan_gate | error | user denies |
| verify_done | verifying | learning | normal verify |
| learn_retry | learning | implementing | gap && within budget |
| learn_final_verify | learning | verifying | gap == false (final battery) |
| learn_exhausted | learning | complete | gap && budget spent (met=False) |
| final_verify_pass | verifying | complete | final verify passed |
| final_verify_fail | verifying | learning | final verify failed (regression) |
| criteria_refined | criteria_gate | checking_criteria | user refines → re-run carren |
| plan_refine | plan_gate | planning | user refines → re-plan |
| to_unknown | any working state (exploring…learning) | unknown | UNCERTAIN / stalled retry |
| escalate | unknown | awaiting_clarification | request user clarification |
| clarify | awaiting_clarification | exploring | user clarified |
| abort | any non-terminal state | error | unrecoverable |

## Subagents Used

| Name | State(s) | Expected Output |
|------|----------|-----------------|
| echo | exploring | Structured SUMMARY |
| annie | analyzing | Structured SUMMARY |
| carren | checking_criteria, learning | Structured SUMMARY |
| piper | planning | Structured SUMMARY |
| skribble | implementing, verifying | Structured SUMMARY |

## Mempalace Integration

### Context Sources
- `skills/code-<session_id>` — Session-specific context

### Learning Outputs
- `penny/skills` — Session summary

## Error Handling

- Max iterations: configurable via constraints
- Error states log to stderr and mempalace
