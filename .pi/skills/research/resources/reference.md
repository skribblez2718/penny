# Research Reference

## State Machine

### States
| State | Description | Entry Action |
|-------|-------------|--------------|
| intake | Initial state | Detect mode from query, validate goal |
| planning | Decompose query | Run Piper agent with research context |
| critiquing_plan | Validate plan quality | Run Carren agent (deep only) |
| researching | Gather evidence | Run parallel Echo agents per sub-query |
| validating | Cross-check findings | Run Vera agent (deep only) |
| synthesizing | Generate report | Run Synthia agent |
| critiquing_report | Validate synthesis | Run Carren agent (deep only) |
| unknown | Uncertainty detected | Escalate to user for clarification |
| awaiting_clarification | Waiting for user | Store user response, resume |
| complete | Research done | Store outcome, return report metadata |
| error | Terminal failure | Log error, return diagnostics |

### Transitions
| Transition | From | To | Condition |
|------------|------|-----|-----------|
| start | intake | planning | has_goal AND not quick |
| quick_research | intake | researching | is_quick_mode |
| plan_done | planning | critiquing_plan | is_deep_mode |
| plan_to_research | planning | researching | is_standard_mode |
| critique_pass | critiquing_plan | researching | critique_approved |
| critique_revise | critiquing_plan | revising_plan | has_issues |
| revise_plan | revising_plan | planning | — |
| research_done | researching | validating | is_deep_mode |
| research_to_synth | researching | synthesizing | is_standard_mode |
| validate_done | validating | synthesizing | validation_complete |
| quick_to_synth | researching | synthesizing | is_quick_mode |
| synthesize_done | synthesizing | critiquing_report | is_deep_mode |
| synth_to_complete | synthesizing | complete | not deep |
| report_pass | critiquing_report | complete | report_critique_approved |
| report_revise | critiquing_report | revising_report | report_has_issues |
| revise_report | revising_report | synthesizing | — |

## Mempalace Room Organization

**Room:** `skills/research-{session_id}`

| Drawer | Written By | Content |
|--------|-----------|---------|
| `{sid} state` | Orchestrator | FSM state blob |
| `{sid} plan` | Piper | Sub-queries, scope, rationale |
| `{sid} echo-{n}` | Echo | Findings for sub-query N |
| `{sid} validation` | Vera | Validation report, conflicts |
| `{sid} synthesis` | Synthia | Final report |
| `{sid} critique-plan` | Carren | Plan critique verdict |
| `{sid} critique-report` | Carren | Report critique verdict |

## Error Handling

| Error Type | Behavior |
|-----------|----------|
| Agent SUMMARY malformed | Log error, retry once, then transition to error |
| Agent SUMMARY empty | Log error, transition to error |
| Parallel task failure | Mark task failed, continue with remaining tasks if ≥1 succeeded |
| All parallel tasks fail | Transition to unknown → questionnaire → resume |
| State restore failure | Redirect to planning with error context preserved |
| Mempalace write failure | Log error, transition to error |
