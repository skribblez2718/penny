# Verify Completion

Ensure all cognitive functions completed successfully.

## Instructions

Review the execution of all skills and verify:

1. **All Required Skills Executed**
   - Check each skill in the sequence was invoked or correctly skipped
   - Verify no skills were missed

2. **Output Quality**
   - Each skill produced expected output
   - Memory files were created and contain valid content
   - No critical errors occurred

3. **Task Objectives Met**
   - The original task requirements have been addressed
   - All deliverables are present
   - Quality standards were applied

### Verification Checklist

For each skill in sequence:

- [ ] Skill was invoked OR skip condition was correctly applied
- [ ] Skill completed without critical errors
- [ ] Output memory file exists and has content
- [ ] Output is relevant to the task

Overall verification:

- [ ] All required cognitive functions were executed
- [ ] Final output addresses the original request
- [ ] No unresolved errors or blockers remain

### Failure Handling

If verification fails:

1. **Missing Skill Execution**
   - Identify the missing skill
   - Invoke it now with appropriate context
   - Re-verify

2. **Quality Issues**
   - If output quality is poor, invoke orchestrate-validation
   - Apply corrections as needed
   - Re-verify

3. **Unmet Objectives**
   - Identify gaps between output and requirements
   - Determine if additional skills are needed
   - Execute additional skills if necessary

### Output Requirements

Produce a verification report:

```
VERIFICATION REPORT
===================

Skills Executed: {count}
Skills Skipped: {count}
Skills Failed: {count}

Skill Status:
1. orchestrate-{name}: [SUCCESS | SKIPPED | FAILED] - {notes}
2. orchestrate-{name}: [SUCCESS | SKIPPED | FAILED] - {notes}
...

Overall Status: [COMPLETE | PARTIAL | FAILED]

Issues Found: {list of issues or "None"}

Recommendations: {next steps if any}
```
