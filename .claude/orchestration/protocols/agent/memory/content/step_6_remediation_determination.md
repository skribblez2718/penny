# Remediation Determination

## Instructions

1. **Check Retry Limits**
   - How many remediation_loops have occurred?
   - If > 3, recommend abort or escalate regardless of impasse type

2. **Apply Response Matrix**

   | Impasse Type | Primary Remediation | Fallback |
   |--------------|---------------------|----------|
   | CONFLICT | Invoke clarification | Escalate to user |
   | MISSING-KNOWLEDGE | Invoke research with specific queries | Create Unknown entries |
   | TIE | Invoke analysis for trade-off evaluation | Escalate to user |
   | NO-CHANGE | Re-invoke same agent with enhanced context | Escalate if 2nd retry fails |
   | NONE | Continue to next phase/agent | N/A |

3. **Determine Action**
   - **CONTINUE:** No impasse detected, proceed normally
   - **RE-INVOKE:** Re-run same agent with enhanced context
   - **INVOKE-OTHER:** Invoke different agent (clarification, research, analysis)
   - **ESCALATE:** Request user input
   - **ABORT:** Task cannot proceed, terminate workflow

4. **Confidence Threshold**
   - Confidence >= 0.7: Take action
   - Confidence < 0.7: Default to CONTINUE (conservative)

## Remediation Context

If recommending re-invocation or different agent:
- Specify exact agent to invoke
- Specify phase context
- Provide enhanced context highlighting the gap

## Completion Criteria

- [ ] Retry limits checked
- [ ] Response matrix applied for detected impasse
- [ ] Action determined with rationale
- [ ] Target agent specified if applicable
- [ ] Enhanced context prepared if re-invoking
- [ ] Ready to proceed to Output Generation
